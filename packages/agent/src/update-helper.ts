// `scopebond-agent update-helper` (internal): installs a signed update once the agent that downloaded it has exited. The
// agent copies its own signed executable into the updates folder and starts that copy detached with this command (the
// installer replaces the installed file, so the helper cannot run from it). Every value reaches it as an environment
// variable (installHelper in native-update.ts). In order:
//
//   1. the native tray is closed (it would start the old agent again, and the installer replaces its file);
//   2. it waits for the old agent to exit;
//   3. the installer is checked again (INSTALLER_CHECK_SCRIPT: size, SHA-256, Authenticode signature and publisher), and
//      that check holds the file so it cannot change until msiexec is done;
//   4. Windows' own msiexec, by its full path, installs it quietly with a verbose log in the updates folder;
//   5. the outcome is written beside the installer, and the tray (or the agent, through autostart's launcher) starts again,
//      installed or not;
//   6. it waits for the new agent to answer with the new version; if it does not within the deadline, that version is
//      recorded as failed (not tried again for a day, and status and the tray say so).

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { win32 } from "node:path";
import { callAgent } from "./ipc.js";
import { startCommands } from "./autostart.js";
import { INSTALLER_CHECK_SCRIPT, powershellEnv, windowsTool, type InstallResult } from "./native-update.js";
import { recordFailedUpdate } from "./update.js";

/** How long the new agent has to answer with its version after the install. */
export const UPDATE_START_DEADLINE_MS = 3 * 60_000;

export interface HelperInput {
  pid: number; home: string; msi: string; version: string; previous: string; sha256: string; size: number; publisher: string;
  result: string; log: string; launcher: string; tray: string;
}

/** The helper's input from its environment, or null when something it needs is missing. */
export function helperInput(env: NodeJS.ProcessEnv = process.env): HelperInput | null {
  const need = (k: string) => (typeof env[k] === "string" && env[k] !== "" ? env[k] : null);
  const pid = Number(env.SB_PID), size = Number(env.SB_SIZE);
  const [home, msi, version, sha256, publisher, result, log] = ["SB_HOME", "SB_MSI", "SB_VERSION", "SB_SHA256", "SB_PUBLISHER", "SB_RESULT", "SB_LOG"].map(need);
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isSafeInteger(size) || size <= 0 || !home || !msi || !version || !sha256 || !publisher || !result || !log) return null;
  return { pid, home, msi, version, previous: env.SB_PREVIOUS ?? "", sha256, size, publisher, result, log, launcher: env.SB_LAUNCHER ?? "", tray: env.SB_TRAY ?? "" };
}

/** What the helper does to the computer, so the order and the decisions can be tested without installing anything. */
export interface HelperDeps {
  closeTray(tray: string): Promise<void>;
  waitForExit(pid: number, ms: number): Promise<void>;
  /** The check right before installing; when it passes, `release` lets go of the file. */
  check(input: HelperInput): Promise<{ ok: true; release: () => void } | { ok: false; reason: string }>;
  msiexec(args: string[]): Promise<{ code: number | null; error: string | null }>;
  startAgain(input: HelperInput): void;
  agentAnswers(home: string, version: string, ms: number): Promise<boolean>;
  now(): number;
}

/** taskkill by its full path in the system folder (the gateway's list of Windows tools does not name it). */
const taskkill = () => win32.join(win32.dirname(windowsTool("reg")), "taskkill.exe");

function run(program: string, args: string[], o: { verbatim?: boolean } = {}): Promise<{ code: number | null; error: string | null }> {
  return new Promise((resolve) => {
    try {
      const child = spawn(program, args, { stdio: "ignore", windowsHide: true, windowsVerbatimArguments: o.verbatim ?? false });
      child.on("error", (error) => resolve({ code: null, error: error.message }));
      child.on("exit", (code) => resolve({ code, error: null }));
    } catch (error) { resolve({ code: null, error: (error as Error).message }); }
  });
}

export const systemHelperDeps: HelperDeps = {
  async closeTray() {
    // Every tray of this user's: a tray left running would start the old agent again while msiexec replaces it.
    const user = process.env.USERNAME ? `${process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\` : ""}${process.env.USERNAME}` : null;
    await run(taskkill(), ["/F", "/IM", "scopebond-tray.exe", ...(user ? ["/FI", `USERNAME eq ${user}`] : [])]);
  },
  async waitForExit(pid, ms) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      try { process.kill(pid, 0); } catch { return; }
      await new Promise((r) => setTimeout(r, 250));
    }
  },
  check(input) {
    return new Promise((resolve) => {
      let out = "";
      let settled = false;
      const done = (value: Awaited<ReturnType<HelperDeps["check"]>>) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
      const child = spawn(windowsTool("powershell"), ["-NoProfile", "-NonInteractive", "-Command", INSTALLER_CHECK_SCRIPT], {
        stdio: ["pipe", "pipe", "ignore"], windowsHide: true,
        env: powershellEnv({ SB_MSI: input.msi, SB_SHA256: input.sha256, SB_SIZE: String(input.size), SB_PUBLISHER: input.publisher }),
      });
      const timer = setTimeout(() => { child.kill(); done({ ok: false, reason: "the installer check did not finish in time" }); }, 120_000);
      child.on("error", (error) => done({ ok: false, reason: `the installer could not be checked: ${error.message}` }));
      child.stdout?.on("data", (chunk: Buffer) => {
        out += chunk.toString("utf8");
        const line = out.split(/\r?\n/).find((l) => l.trim().startsWith("{"));
        if (!line) return;
        try {
          const r = JSON.parse(line) as { ok?: unknown; reason?: unknown };
          if (r.ok === true) done({ ok: true, release: () => { try { child.stdin?.end(); } catch { /* already gone */ } } });
          else done({ ok: false, reason: typeof r.reason === "string" ? r.reason : "the installer did not check out" });
        } catch { /* a partial line: wait for the rest */ }
      });
      child.on("exit", (code) => done({ ok: false, reason: `the installer check ended without an answer (exit ${code})` }));
    });
  },
  msiexec(args) {
    return run(windowsTool("msiexec"), args);
  },
  startAgain(input) {
    if (input.tray) {
      const child = spawn(input.tray, [], { detached: true, stdio: "ignore", windowsHide: true });
      child.on("error", () => { /* the next sign-in starts it */ });
      child.unref();
      return;
    }
    if (!input.launcher) return;
    let command: [string, string[]] | undefined;
    try { command = startCommands(input.launcher, "win32")[1]; } catch { return; }
    if (!command) return;
    const child = spawn(command[0], command[1], { detached: true, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true });
    child.on("error", () => { /* the next sign-in starts it */ });
    child.unref();
  },
  async agentAnswers(home, version, ms) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const status = await callAgent(home, "GET", "/status", undefined, 2_000) as { agent?: { version?: string } | null } | null;
      if (status?.agent?.version === `agent/${version}`) return true;
      await new Promise((r) => setTimeout(r, 2_000));
    }
    return false;
  },
  now: () => Date.now(),
};

function writeResult(file: string, result: InstallResult): void {
  try { writeFileSync(file, JSON.stringify(result), { mode: 0o600 }); } catch { /* the next start says it did not finish */ }
}

/** Run the helper: check, install, start again, and confirm the new agent answers. Returns what it recorded. */
export async function runUpdateHelper(input: HelperInput, deps: HelperDeps = systemHelperDeps, deadlineMs = UPDATE_START_DEADLINE_MS): Promise<InstallResult & { started: boolean | null }> {
  if (input.tray) await deps.closeTray(input.tray);
  await deps.waitForExit(input.pid, 60_000);
  const at = () => new Date(deps.now()).toISOString();
  let result: InstallResult;
  const checked = await deps.check(input);
  if (!checked.ok) {
    result = { at: at(), version: input.version, installed: false, reason: checked.reason, exit_code: null, log: null };
  } else {
    try {
      const ran = await deps.msiexec(["/i", input.msi, "/qn", "/norestart", "/l*v", input.log]);
      const installed = ran.code === 0 || ran.code === 3010;
      result = {
        at: at(), version: input.version, installed, exit_code: ran.code, log: input.log,
        reason: installed ? null : ran.error ? `msiexec could not start: ${ran.error}` : `msiexec ended with exit code ${ran.code} (log: ${input.log})`,
      };
    } finally { checked.release(); }
  }
  writeResult(input.result, result);
  // Installed or not, Scopebond starts again: the tray (which starts the agent), or the agent through its launcher.
  deps.startAgain(input);
  if (!result.installed) return { ...result, started: null };
  const started = await deps.agentAnswers(input.home, input.version, deadlineMs);
  if (!started) {
    recordFailedUpdate(input.home, input.version, deps.now(), `the Scopebond Agent ${input.version} was installed but did not start and answer within ${Math.round(deadlineMs / 60_000)} minutes (log: ${input.log})`);
  }
  return { ...result, started };
}
