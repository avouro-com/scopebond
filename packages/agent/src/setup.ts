// `scopebond-agent setup <workspace-url>`: one command from nothing to a connected computer.
// It checks Node, signs this person in with a code (which puts the hook in the user-level agent
// settings), installs the agent for this user so autostart has a stable path, turns autostart on
// and ends with `status`. Run again, it repairs what is missing and duplicates nothing: an
// existing connection to the same workspace is kept, the same agent version is not reinstalled,
// and the hook entry and autostart are put back only where they are gone.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { loadConnection, nodeTooOldLines, readDeliveryState, type Harness } from "@scopebond/hook";
import { autostartHealth, enableAutostart, startNow } from "./autostart.js";
import { callAgent } from "./ipc.js";
import { compareVersions } from "./update.js";
import { repairHookEntries } from "./service.js";

export type SetupStep = "login" | "install_agent" | "autostart";

export interface SetupState {
  /** The workspace origin this computer's user-level connection points at, if any. */
  connectedTo: string | null;
  /** The workspace refused that connection's credential (it must sign in again). */
  credentialRefused: boolean;
  /** The agent version installed for this user with npm, if any. */
  installedVersion: string | null;
  /** Autostart is on and its launcher exists. */
  autostartOk: boolean;
}

/** What a setup run has to do, given what is already true. Pure, so a second run is provably a no-op
 *  (or a repair) rather than a second sign-in or install. */
export function setupPlan(state: SetupState, origin: string, version: string, relogin = false): SetupStep[] {
  const steps: SetupStep[] = [];
  if (relogin || state.connectedTo !== origin || state.credentialRefused) steps.push("login");
  const install = state.installedVersion === null || compareVersions(state.installedVersion, version) < 0;
  if (install) steps.push("install_agent");
  if (install || !state.autostartOk) steps.push("autostart");
  return steps;
}

export function nodeSupported(version = process.versions.node): boolean {
  const [major, minor] = version.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 13);
}

/** The folder npm puts global commands in: the prefix itself on Windows, <prefix>/bin elsewhere. */
export function globalBinDir(prefix: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? prefix : join(prefix, "bin");
}

/** Whether `dir` is on PATH (case-insensitive on Windows, ignoring a trailing separator). */
export function onPath(dir: string, pathEnv = process.env.PATH ?? process.env.Path ?? "", platform: NodeJS.Platform = process.platform): boolean {
  const norm = (p: string) => {
    let t = p.trim();
    while (t.endsWith("/") || t.endsWith("\\")) t = t.slice(0, -1); // a loop, not a regex: PATH entries are untrusted input
    return platform === "win32" ? t.toLowerCase().replace(/\//g, "\\") : t;
  };
  const target = norm(dir);
  return pathEnv.split(platform === "win32" ? ";" : ":").some((p) => p && norm(p) === target);
}

/** The PowerShell line that adds a folder to this user's PATH for new windows. */
export function addToPathCommand(dir: string): string {
  return `[Environment]::SetEnvironmentVariable("Path", [Environment]::GetEnvironmentVariable("Path", "User") + ";${dir}", "User")`;
}

function npm(args: string[]): { ok: boolean; out: string } {
  const win = process.platform === "win32";
  // npm on Windows is a .cmd file, which Node starts only through a shell; quote each argument for it.
  const r = spawnSync(win ? "npm.cmd" : "npm", win ? args.map((a) => `"${a}"`) : args, { encoding: "utf8", shell: win, windowsHide: true, timeout: 5 * 60_000 });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function globalAgent(): { prefix: string | null; cli: string | null; version: string | null } {
  const prefix = npm(["prefix", "-g"]);
  const root = npm(["root", "-g"]);
  if (!root.ok) return { prefix: null, cli: null, version: null };
  const dir = join(root.out.trim().split(/\r?\n/).pop() ?? "", "@scopebond", "agent");
  const cli = join(dir, "dist", "cli.js");
  let version: string | null = null;
  try { version = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: string }).version ?? null; } catch { /* not installed */ }
  return { prefix: prefix.ok ? prefix.out.trim().split(/\r?\n/).pop() ?? null : null, cli: existsSync(cli) ? cli : null, version };
}

/** The bundled hook's CLI, which this agent depends on at an exact version. */
function hookCli(): string {
  const index = createRequire(import.meta.url).resolve("@scopebond/hook");
  return join(dirname(index), "cli.js");
}

export interface SetupOptions { dir: string; origin: string; harness: Harness; relogin: boolean; version: string; me: string }

export async function runSetup(o: SetupOptions): Promise<number> {
  const say = (line: string) => console.log(line);
  if (!nodeSupported()) { for (const line of nodeTooOldLines(process.versions.node)) console.error(line); return 1; }
  const connection = loadConnection(o.dir);
  let connectedTo: string | null = null;
  try { connectedTo = connection ? new URL(connection.url).origin : null; } catch { connectedTo = null; }
  const global = globalAgent();
  const state: SetupState = {
    connectedTo,
    credentialRefused: readDeliveryState(o.dir).invalid_since != null,
    installedVersion: global.version,
    autostartOk: autostartHealth(o.dir).ok,
  };
  const steps = setupPlan(state, o.origin, o.version, o.relogin);
  say(`Setting up Scopebond for this user (${steps.length ? steps.join(", ").replace(/_/g, " ") : "nothing missing"}).`);

  // 1. Sign in with a code. The hook's own login prints the link and code and waits for approval.
  if (steps.includes("login")) {
    const flag = o.harness === "claude" ? "--claude" : `--${o.harness}`;
    const r = spawnSync(process.execPath, [hookCli(), "login", o.origin, flag], { stdio: "inherit", env: { ...process.env, SCOPEBOND_HOME: o.dir } });
    if (r.status !== 0) { console.error("Setup stopped: the sign-in did not finish. Run the same command again for a new code."); return 1; }
  } else {
    say(`✓ Already connected to ${o.origin} (to sign in again anyway, add --relogin).`);
    for (const fixed of repairHookEntries()) say(`✓ Put the Scopebond hook back in ${fixed.file}`);
  }

  // 2. The agent, installed for this user so autostart points at a path npm will not clear.
  let cli = global.cli;
  if (steps.includes("install_agent")) {
    const spec = process.env.SCOPEBOND_AGENT_INSTALL_SPEC || `@scopebond/agent@${o.version}`;
    say(`Installing the Scopebond Agent for this user: ${process.platform === "win32" ? "npm.cmd" : "npm"} install -g ${spec}`);
    const installed = npm(["install", "-g", spec, "--no-fund", "--no-audit"]);
    if (!installed.ok) { console.error(`Setup stopped: npm could not install the agent.\n${installed.out.slice(-1500)}`); return 1; }
    cli = globalAgent().cli;
    if (!cli) { console.error("Setup stopped: npm reported success but the agent is not in npm's global folder."); return 1; }
  } else say(`✓ The Scopebond Agent ${global.version} is installed for this user.`);
  const bin = global.prefix ? globalBinDir(global.prefix) : null;
  if (bin && !onPath(bin)) {
    say(`Note: npm's global folder ${bin} is not on PATH, so new terminals will not find ${o.me}.`);
    say(process.platform === "win32" ? `  Add it for your user (then open a new window): ${addToPathCommand(bin)}` : `  Add it to PATH in your shell profile: export PATH="${bin}:$PATH"`);
  }

  // 3. Autostart, and the agent running now.
  if (steps.includes("autostart") && cli) {
    say(enableAutostart(o.dir, cli));
  } else say("✓ The agent already starts with your sign-in.");
  if (cli && !await callAgent(o.dir, "GET", "/status", undefined, 2_000)) {
    const up = async (tries: number) => {
      for (let i = 0; i < tries; i++) { if (await callAgent(o.dir, "GET", "/status", undefined, 1_000)) return true; await new Promise((r) => setTimeout(r, 500)); }
      return false;
    };
    if (process.platform === "win32") {
      // The headless console first; where it does not start, the launcher through a hidden cmd.exe.
      if (!(startNow(o.dir, "win32", 0) && await up(12))) { startNow(o.dir, "win32", 1); await up(18); }
    } else {
      // No systemd user session (a container, WSL without systemd): run it detached until the next sign-in.
      if (!await up(10) && process.platform === "linux") spawn(process.execPath, [cli, "run"], { detached: true, stdio: "ignore", env: { ...process.env, SCOPEBOND_HOME: o.dir } }).unref();
      await up(20);
    }
  }

  // 4. Status, from the installed agent.
  say("");
  const status = spawnSync(process.execPath, [cli ?? process.argv[1], "status"], { stdio: "inherit", env: { ...process.env, SCOPEBOND_HOME: o.dir } });
  return status.status === 0 ? 0 : 1;
}
