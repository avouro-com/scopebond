// scopebond-agent: run, look at and control the Scopebond Agent for this user.
//
//   scopebond-agent setup <workspace-url> [--claude|--cursor|--codex] [--relogin]
//                                       one command to start: sign in, install, autostart, status
//   scopebond-agent run                 run in the foreground (what autostart starts)
//   scopebond-agent status [--json]     what the running agent reports, or why it is not running
//   scopebond-agent flush               deliver now
//   scopebond-agent repair              put the Scopebond hook back where agent settings lost it
//   scopebond-agent check               update check, hook upkeep and the end-to-end self-check, now
//   scopebond-agent autostart on|off    start with this user's sign-in, or stop doing so (off also stops it now)
//   scopebond-agent stop                stop the running agent (autostart still starts it at the next sign-in)
//   scopebond-agent uninstall [--purge] autostart off, stop, the hook's uninstall (tells the workspace); what the installer runs

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { hookSelfCommand, isEphemeralPath, userHome } from "@scopebond/hook";
import { computerStatus } from "./agent.js";
import { AGENT_LOG_ENV, autostartHealth, disableAutostart, enableAutostart, startNow } from "./autostart.js";
import { callAgent } from "./ipc.js";
import { agentCliPath } from "./self.js";
import { runSetup } from "./setup.js";
import { agentVersion } from "./update.js";
import { writeOutputTo } from "./log-file.js";
import { removeAppsEntry, writeAppsEntry } from "./apps-entry.js";
import { installKind } from "./native-update.js";
import { upkeepCommand } from "./upkeep.js";
import { AGENT_VERSION, startService, takeOver } from "./service.js";

let cmd = "help";
let rest: string[] = [];
// What a person types here: on Windows, PowerShell blocks the plain name's script shim.
const me = process.platform === "win32" ? "scopebond-agent.cmd" : "scopebond-agent";
const dir = process.env.SCOPEBOND_HOME ?? userHome();

function help(): void {
  const c = (sub: string) => `${me} ${sub}`.padEnd(me.length + 36);
  console.log(`Scopebond Agent — keeps this computer delivering to its Scopebond workspace.

  ${c("setup <workspace-url>")}sign in, install for this user, start with sign-in, show status
  ${c("run")}run in the foreground (what autostart starts)
  ${c("status [--json]")}what the agent reports about this computer
  ${c("flush")}deliver waiting records now
  ${c("repair")}put the Scopebond hook back where agent settings lost it
  ${c("check")}check for updates and run the end-to-end self-check now
  ${c("autostart on|off")}start with your sign-in, or stop doing so (off also stops it now)
  ${c("stop")}stop the running agent until the next sign-in
  ${c("uninstall [--purge]")}stop it, stop starting it, take the hook out and tell the workspace

The hook keeps deciding every action on its own; the agent only keeps delivery, rules and the
connection current. Home: ${dir}`);
}

/** Run one command (`argv` as after the program name). cli.ts, the npm program, calls this; so does the single executable. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  [cmd = "help", ...rest] = argv;
  switch (cmd) {
    case "run": {
      // A launcher or a handover names the log; the agent writes it itself (see log-file.ts).
      const log = process.env[AGENT_LOG_ENV];
      if (log) writeOutputTo(log);
      // Started by an agent that just updated itself: let it exit first.
      await takeOver(dir, agentCliPath());
      const service = await startService({ dir, onStopped: () => process.exit(0) });
      const stop = () => { void service.stop().finally(() => process.exit(0)); };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      return;
    }
    case "upkeep": {
      // Internal: the agent runs its local store upkeep through this, in a process of its own.
      upkeepCommand(dir, rest);
      return;
    }
    case "status": {
      const live = await callAgent(dir, "GET", "/status") as (ReturnType<typeof computerStatus> & { agent?: AgentReport | null }) | null;
      const status = { ...(live ?? { ...computerStatus(dir), agent: null }), autostart: autostartHealth(dir) };
      if (rest.includes("--json")) { console.log(JSON.stringify(status, null, 2)); return; }
      const d = status.delivery;
      console.log(`Scopebond Agent: ${live ? "running" : "not running"}`);
      console.log(`  state            ${live ? status.state : "not running: records wait on this computer until it runs"}`);
      console.log(`  connected        ${d.connected ? "yes" : "no"}`);
      console.log(`  waiting to send  ${d.pending} record(s)${d.oldest_pending_age_s !== null ? `, oldest ${Math.round(d.oldest_pending_age_s / 60)} min` : ""}`);
      if (d.last_error) console.log(`  last problem     ${d.last_error}`);
      console.log(`  version          ${status.agent?.version ?? AGENT_VERSION}`);
      console.log(`  autostart        ${status.autostart.detail}`);
      const check = status.agent?.last_maintenance?.selfCheck;
      if (check) console.log(`  self-check       ${check.ok ? "passed" : `failed: ${check.failed.join(", ")}`}`);
      if (!live) console.log(`\nStart it with: ${me} autostart on`);
      return;
    }
    case "flush":
    case "repair":
    case "check": {
      const answer = await callAgent(dir, "POST", `/${cmd === "check" ? "maintain" : cmd}`, {}, 6 * 60_000);
      if (!answer) { console.error(`The Scopebond Agent is not running. Start it with: ${me} autostart on`); process.exitCode = 1; return; }
      console.log(JSON.stringify(answer, null, 2));
      const updatedTo = (answer as { updatedTo?: unknown }).updatedTo;
      if (cmd === "check" && typeof updatedTo === "string") console.log(await afterUpdate(updatedTo));
      return;
    }
    case "setup": {
      const target = rest.find((a) => !a.startsWith("--"));
      let origin: string | null = null;
      try {
        const url = new URL(target ?? "");
        const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
        if (url.protocol === "https:" || (local && url.protocol === "http:")) origin = url.origin;
      } catch { origin = null; }
      if (!origin) {
        console.error(`usage: ${process.platform === "win32" ? "npx.cmd" : "npx"} -y @scopebond/agent@${agentVersion()} setup <workspace-url> [--claude|--cursor|--codex]`);
        console.error("The workspace URL is the address of your Scopebond workspace, for example https://cloud.scopebond.com.");
        process.exitCode = 1;
        return;
      }
      const harness = rest.includes("--cursor") ? "cursor" : rest.includes("--codex") ? "codex" : "claude";
      process.exitCode = await runSetup({ dir, origin, harness, relogin: rest.includes("--relogin"), version: agentVersion(), me });
      return;
    }
    case "stop": {
      console.log(await stopRunning() ? "Stopped the Scopebond Agent." : "The Scopebond Agent was not running.");
      return;
    }
    case "uninstall": {
      // What the Windows installer runs when Scopebond is removed (and anyone may run): stop and unregister the agent,
      // then the hook's own uninstall, which tells the workspace and takes the hook out of the coding agents' settings.
      // The Scopebond folder (keys, receipts) stays unless --purge.
      console.log(disableAutostart(dir));
      if (await stopRunning()) console.log("Stopped the running Scopebond Agent.");
      const listed = removeAppsEntry(dir);
      if (listed) console.log(listed);
      const [program, args] = hookSelfCommand(["uninstall", "--yes", ...(rest.includes("--purge") ? ["--purge"] : [])]);
      const removal = spawnSync(program, args, { stdio: "inherit", cwd: homedir(), env: { ...process.env, SCOPEBOND_HOME: dir } });
      process.exitCode = removal.status ?? 1;
      return;
    }
    case "autostart": {
      const on = rest[0] === "on";
      if (rest[0] !== "on" && rest[0] !== "off") { console.error(`usage: ${me} autostart on|off`); process.exitCode = 1; return; }
      if (on && isEphemeralPath(agentCliPath())) {
        // npx runs from a cache npm clears; an autostart entry pointing there would stop working.
        console.error(`Install the agent first so autostart has a stable path: ${process.platform === "win32" ? "npm.cmd" : "npm"} install -g @scopebond/agent`);
        process.exitCode = 1;
        return;
      }
      console.log(on ? enableAutostart(dir, agentCliPath()) : disableAutostart(dir));
      // An npm install is listed in Settings -> Apps from here on (the signed installer has its own entry).
      if (on && installKind() === "npm") {
        try { const listed = writeAppsEntry(dir, { version: agentVersion(), cli: agentCliPath() }); if (listed) console.log(listed); }
        catch (error) { console.error(`Could not list Scopebond in Settings -> Apps: ${(error as Error).message}`); }
      }
      if (!on) {
        // Off means off: an agent left running would keep going until sign-out, even after an uninstall.
        if (await stopRunning()) console.log("Stopped the running Scopebond Agent.");
        return;
      }
      // Turning autostart on also starts the agent now, so nobody has to sign out and in again.
      if (await callAgent(dir, "GET", "/status", undefined, 2_000)) { console.log("The Scopebond Agent is running."); return; }
      if (await startAndWait()) {
        console.log(`The Scopebond Agent is running${process.platform === "win32" ? "; its icon is in the taskbar tray (it may be under the ^ arrow)" : ""}.`);
        return;
      }
      console.log(`It starts at your next sign-in. To start it now: ${me} run`);
      return;
    }
    default:
      help();
      if (cmd !== "help" && cmd !== "--help") process.exitCode = 1;
  }
}

/** Start the agent through its autostart launcher and wait until it answers. Each way of starting it gets a few seconds;
 *  a headless console that never starts falls back to a hidden cmd.exe. Whether it answers. */
async function startAndWait(): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!startNow(dir, process.platform, attempt) && attempt > 0) break;
    for (let i = 0; i < (attempt === 0 ? 12 : 18); i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await callAgent(dir, "GET", "/status", undefined, 1_000)) return true;
    }
  }
  return false;
}

/** After `check` updated the agent: wait for the updated one to answer, start it if nothing does, and say which version runs. */
async function afterUpdate(version: string): Promise<string> {
  const running = async () => ((await callAgent(dir, "GET", "/status", undefined, 1_000)) as { agent?: AgentReport | null } | null)?.agent?.version ?? null;
  let seen: string | null = null;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1_000));
    seen = await running();
    if (seen === `agent/${version}`) return `The Scopebond Agent ${version} is running.`;
  }
  if (seen) return `The Scopebond Agent running now is ${seen.replace(/^agent\//, "")}, not ${version}. Restart it with: ${me} stop, then ${me} autostart on`;
  if (autostartHealth(dir).on && await startAndWait()) return "The updated agent had not started; it is running now.";
  return `The updated agent is not running. Start it with: ${me} autostart on`;
}

/** Ask the running agent to stop and wait until its control channel is gone. Whether one was running. */
async function stopRunning(): Promise<boolean> {
  if (!await callAgent(dir, "POST", "/stop", {}, 3_000)) return false;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (!await callAgent(dir, "GET", "/status", undefined, 1_000)) return true;
  }
  return true;
}

interface AgentReport { version?: string; last_maintenance?: { selfCheck?: { ok: boolean; failed: string[] } | null } | null }

