// `scopebond-agent uninstall [--purge]`: what every way of removing the agent runs. A person runs it from a terminal after an
// npm install; the Settings -> Apps entry's script runs it before `npm uninstall -g` (apps-entry.ts); the signed installer's
// removal runs it as the person removing Scopebond, with no window, and keeps its output and exit code in the installer's log.
//
// It turns autostart off, stops the running agent, takes the Settings entry away, then runs the hook's own uninstall, which
// tells each workspace this computer is connected to and takes the hook out of the coding agents' settings (with --purge it
// also deletes the Scopebond folder). A workspace that could not be told is said, and the exit code is the hook's
// UNINSTALL_NOT_TOLD_EXIT (75) instead of 0; the notice waits a few seconds at most, so it never holds the removal up. The
// last line is one sentence about the Scopebond folder: that it stays and how to remove it, or that it was removed.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { hookSelfCommand, hookVersion, loadConnection, reportUninstall, uninstallReportLine, UNINSTALL_CALLER_ENV, UNINSTALL_NOT_TOLD_EXIT } from "@scopebond/hook";
import { disableAutostart as disableAutostartNow } from "./autostart.js";
import { removeAppsEntry as removeAppsEntryNow } from "./apps-entry.js";
import { folderSentence } from "./commands.js";
import type { InstallKind } from "./native-update.js";

/** How long the hook's uninstall may take before it is stopped. It tells each workspace within a few seconds; this is the
 *  backstop for a hook that hangs, so a removal never waits on it for long. */
export const HOOK_UNINSTALL_TIMEOUT_MS = 30_000;

/** What running the hook's uninstall came to: its exit code (null when it did not start or was stopped), and what it said. */
export interface HookRun { status: number | null; signal?: string | null; timedOut?: boolean; error?: Error; output?: string }

/** Runs the hook's uninstall with these arguments, environment and working folder. Tests pass their own. */
export type HookRunner = (args: string[], env: NodeJS.ProcessEnv, cwd: string, timeoutMs: number) => Promise<HookRun>;

/** Run the hook (`hookSelfCommand`) and collect what it says; stopped after `timeoutMs`. Never throws. */
export function spawnHook(
  args: string[], env: NodeJS.ProcessEnv, cwd: string, timeoutMs: number,
  command: (args: readonly string[]) => [string, string[]] = hookSelfCommand,
): Promise<HookRun> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let settled = false;
    let timedOut = false;
    const finish = (run: HookRun) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...run, timedOut, output: Buffer.concat(chunks).toString("utf8") });
    };
    let child: ReturnType<typeof spawn> | undefined;
    const timer = setTimeout(() => { timedOut = true; child?.kill(); }, Math.max(0, timeoutMs));
    try {
      const [program, programArgs] = command(args);
      child = spawn(program, programArgs, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      finish({ status: null, error: error as Error });
      return;
    }
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", (error) => finish({ status: null, error }));
    child.on("close", (status, signal) => finish({ status, signal }));
  });
}

export interface UninstallOptions {
  /** The Scopebond folder. */
  dir: string;
  purge: boolean;
  /** How the agent was installed (`installKind()`): names the way to remove the folder later. */
  kind: InstallKind;
  /** The agent's command as the person types it. */
  me: string;
  /** The platform whose installer the folder sentence names (default: this one). */
  platform?: NodeJS.Platform;
  /** Set (UNINSTALL_CALLER_ENV) when a program runs this for the person and says the folder sentence itself. */
  caller?: string;
  stopRunning: () => Promise<boolean>;
  say?: (line: string) => void;
  /** The environment and working folder the hook runs with (default: this process's, and the home folder). */
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  disableAutostart?: (dir: string) => string;
  removeAppsEntry?: (dir: string) => string | null;
  runHook?: HookRunner;
  fetchImpl?: typeof fetch;
}

/** Remove the agent from this computer for this user (see the top of this file). The exit code: 0, UNINSTALL_NOT_TOLD_EXIT
 *  when a workspace could not be told, else the failure's (1 when the hook's uninstall did not run or finish). */
export async function runUninstall(o: UninstallOptions): Promise<number> {
  const say = o.say ?? ((line: string) => console.log(line));
  const base = o.env ?? process.env;
  say((o.disableAutostart ?? disableAutostartNow)(o.dir));
  if (await o.stopRunning()) say("Stopped the running Scopebond Agent.");
  const listed = (o.removeAppsEntry ?? removeAppsEntryNow)(o.dir);
  if (listed) say(listed);
  // The hook names the folder last only when nobody else does; here the agent does (below).
  const env = { ...base, SCOPEBOND_HOME: o.dir, [UNINSTALL_CALLER_ENV]: "agent" };
  const run = await (o.runHook ?? spawnHook)(["uninstall", "--yes", ...(o.purge ? ["--purge"] : [])], env, o.cwd ?? homedir(), HOOK_UNINSTALL_TIMEOUT_MS);
  for (const line of (run.output ?? "").split("\n")) {
    const text = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (text) say(text);
  }
  let code: number;
  if (run.timedOut) {
    say(`The hook's uninstall did not finish within ${HOOK_UNINSTALL_TIMEOUT_MS / 1000} s and was stopped: the workspace may not have been told, and the hook may still be in the coding agents' settings. Run \`${o.me} uninstall\` again.`);
    code = 1;
  } else if (run.status === null) {
    say(`Could not run the hook's uninstall (${run.error?.message ?? run.signal ?? "it did not start"}): the hook may still be in the coding agents' settings. Run \`${o.me} uninstall\` again.`);
    // The workspace still hears about the removal: the agent tells it itself.
    const connection = loadConnection(o.dir);
    if (connection) say(uninstallReportLine(await reportUninstall(connection, { purge: o.purge, hookVersion: hookVersion() }, o.fetchImpl)));
    else say("this computer is not connected to a workspace, so there was none to tell");
    code = 1;
  } else if (run.status !== 0 && run.status !== UNINSTALL_NOT_TOLD_EXIT) {
    say(`The hook's uninstall stopped with exit code ${run.status} (see above). Run \`${o.me} uninstall\` again to finish.`);
    code = run.status;
  } else {
    code = run.status;
  }
  if (!o.caller) say(folderSentence(o.dir, { exists: existsSync(o.dir), purged: o.purge, kind: o.kind, me: o.me, platform: o.platform }));
  return code;
}
