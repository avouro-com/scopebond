#!/usr/bin/env node
// scopebond-agent: run, look at and control the Scopebond Agent for this user.
//
//   scopebond-agent run                 run in the foreground (what autostart starts)
//   scopebond-agent status [--json]     what the running agent reports, or why it is not running
//   scopebond-agent flush               deliver now
//   scopebond-agent repair              put the Scopebond hook back where agent settings lost it
//   scopebond-agent check               update check, hook upkeep and the end-to-end self-check, now
//   scopebond-agent autostart on|off    start with this user's sign-in, or stop doing so

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isEphemeralPath, userHome } from "@scopebond/hook";
import { computerStatus } from "./agent.js";
import { autostartHealth, disableAutostart, enableAutostart, startNow } from "./autostart.js";
import { callAgent } from "./ipc.js";
import { AFTER_PID_ENV, AGENT_VERSION, startService } from "./service.js";

const [cmd = "help", ...rest] = process.argv.slice(2);
// What a person types here: on Windows, PowerShell blocks the plain name's script shim.
const me = process.platform === "win32" ? "scopebond-agent.cmd" : "scopebond-agent";
const dir = process.env.SCOPEBOND_HOME ?? userHome();
const cliPath = realpathSync(fileURLToPath(import.meta.url));

function help(): void {
  const c = (sub: string) => `${me} ${sub}`.padEnd(me.length + 36);
  console.log(`Scopebond Agent — keeps this computer delivering to its Scopebond workspace.

  ${c("run")}run in the foreground (what autostart starts)
  ${c("status [--json]")}what the agent reports about this computer
  ${c("flush")}deliver waiting records now
  ${c("repair")}put the Scopebond hook back where agent settings lost it
  ${c("check")}check for updates and run the end-to-end self-check now
  ${c("autostart on|off")}start with your sign-in, or stop doing so

The hook keeps deciding every action on its own; the agent only keeps delivery, rules and the
connection current. Home: ${dir}`);
}

async function main(): Promise<void> {
  switch (cmd) {
    case "run": {
      // Started by an agent that just updated itself: let it exit first.
      const previous = Number(process.env[AFTER_PID_ENV]);
      if (Number.isInteger(previous) && previous > 0) await waitForExit(previous, 30_000);
      const service = await startService({ dir });
      const stop = () => { void service.stop().finally(() => process.exit(0)); };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
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
      return;
    }
    case "autostart": {
      const on = rest[0] === "on";
      if (rest[0] !== "on" && rest[0] !== "off") { console.error(`usage: ${me} autostart on|off`); process.exitCode = 1; return; }
      if (on && isEphemeralPath(cliPath)) {
        // npx runs from a cache npm clears; an autostart entry pointing there would stop working.
        console.error(`Install the agent first so autostart has a stable path: ${process.platform === "win32" ? "npm.cmd" : "npm"} install -g @scopebond/agent`);
        process.exitCode = 1;
        return;
      }
      console.log(on ? enableAutostart(dir, cliPath) : disableAutostart(dir));
      if (!on) return;
      // Turning autostart on also starts the agent now, so nobody has to sign out and in again.
      if (await callAgent(dir, "GET", "/status", undefined, 2_000)) { console.log("The Scopebond Agent is running."); return; }
      startNow(dir);
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 500));
        if (await callAgent(dir, "GET", "/status", undefined, 1_000)) {
          console.log(`The Scopebond Agent is running${process.platform === "win32" ? "; its icon is in the taskbar tray (it may be under the ^ arrow)" : ""}.`);
          return;
        }
      }
      console.log(`It starts at your next sign-in. To start it now: ${me} run`);
      return;
    }
    default:
      help();
      if (cmd !== "help" && cmd !== "--help") process.exitCode = 1;
  }
}

interface AgentReport { version?: string; last_maintenance?: { selfCheck?: { ok: boolean; failed: string[] } | null } | null }

async function waitForExit(pid: number, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((r) => setTimeout(r, 250));
  }
}

void main().catch((error) => { console.error((error as Error).message); process.exitCode = 1; });
