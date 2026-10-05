// The resident loop: one cycle now, then one every interval, sooner after a change is asked for,
// backing off while the workspace is unreachable. Exactly one agent serves a Scopebond home: a
// second one finds the first answering and exits. Every six hours it asks the workspace which
// versions to run, and once a day it runs the end-to-end self-check.

import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hookCommand, hookVersion, loadConnection, userHarnessFile, writeHarnessConfig, type Harness } from "@scopebond/hook";
import { computerStatus, expectedHarnesses, missingHookEntries, runCycle, type CycleResult } from "./agent.js";
import { launcherPath } from "./autostart.js";
import { callAgent, startControl } from "./ipc.js";
import { runSelfCheck } from "./selfcheck.js";
import { flushReasons, queueReason } from "./override-reasons.js";
import { parseQuestion, serialized, systemPrompter, type Prompter } from "./prompt.js";
import { healthOf, type HealthLevel } from "./health.js";
import { notifyChange, startTray } from "./tray.js";
import { agentVersion, compareVersions, fetchClientVersion, installAgent, maintainHookEntries } from "./update.js";

export const AGENT_VERSION = `agent/${agentVersion()}`;
const INTERVAL_MS = 60_000;
const MAX_BACKOFF_MS = 15 * 60_000;
const UPDATE_EVERY_MS = 6 * 60 * 60 * 1000;
const SELF_CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
export const AFTER_PID_ENV = "SCOPEBOND_AGENT_AFTER_PID";

export interface ServiceOptions {
  dir: string; intervalMs?: number; fetchImpl?: typeof fetch; log?: (line: string) => void;
  /** Off in tests: the update check and self-check run only when asked. */
  maintenance?: boolean;
  /** Called after a successful update instead of restarting (tests). */
  onUpdated?: (version: string) => void;
  /** Shows the Scopebond window for an override (tests replace it). */
  prompter?: Prompter;
  /** The Windows tray icon (default on Windows; SCOPEBOND_AGENT_TRAY=off turns it off). */
  tray?: boolean;
  /** Called once the agent has stopped because `stop` (or `autostart off`) asked it to; the CLI exits. */
  onStopped?: () => void;
}

export interface Service {
  stop(): Promise<void>;
  cycleNow(): Promise<CycleResult>;
  maintainNow(): Promise<MaintenanceResult>;
  port: number;
}

export interface MaintenanceResult {
  at: number;
  policy: "recommended" | "hold" | "unknown";
  updatedTo: string | null;
  hookEntries: Array<{ harness: Harness; file: string; reason: string }>;
  selfCheck: Awaited<ReturnType<typeof runSelfCheck>>;
  error: string | null;
}

/** Put the Scopebond hook back into agent settings that lost it. A visible change: each one is
 *  logged and returned, and only settings of agents this computer has are touched. */
export function repairHookEntries(harnesses: Harness[] = expectedHarnesses()): Array<{ harness: Harness; file: string }> {
  const repaired: Array<{ harness: Harness; file: string }> = [];
  for (const harness of missingHookEntries(harnesses)) {
    const file = writeHarnessConfig(userHarnessFile(harness), harness, hookCommand(harness));
    repaired.push({ harness, file });
  }
  return repaired;
}

/** Start a fresh agent (the updated one) that waits for this process to exit, through the
 *  autostart launcher when there is one so it finds Node the same way sign-in does. */
export function spawnReplacement(dir: string): void {
  const launcher = launcherPath(dir);
  const cli = realpathSync(fileURLToPath(new URL("./cli.js", import.meta.url)));
  const env = { ...process.env, [AFTER_PID_ENV]: String(process.pid) };
  const [command, args] = existsSync(launcher)
    ? process.platform === "win32" ? ["cmd.exe", ["/d", "/c", launcher]] as const : ["/bin/sh", [launcher]] as const
    : [process.execPath, [cli, "run"]] as const;
  const child = spawn(command, [...args], { env, detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}

export async function startService(options: ServiceOptions): Promise<Service> {
  const log = options.log ?? ((line: string) => console.log(`${new Date().toISOString()} ${line}`));
  if (await callAgent(options.dir, "GET", "/status", undefined, 2_000)) throw new Error("a Scopebond Agent is already running for this computer");
  const interval = options.intervalMs ?? INTERVAL_MS;
  let last: CycleResult | null = null;
  let lastMaintenance: MaintenanceResult | null = null;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  let running: Promise<CycleResult> | null = null;
  let stopped = false;
  let lastSelfCheckAt = 0;

  const prompt = serialized(options.prompter ?? systemPrompter);
  let shownLevel: HealthLevel | null = null;
  const health = () => healthOf(computerStatus(options.dir), lastMaintenance?.selfCheck ?? null);
  const noticeHealth = () => { const h = health(); notifyChange(shownLevel, h); shownLevel = h.level; };
  const sendReasons = async () => {
    const connection = loadConnection(options.dir);
    if (!connection) return;
    try { const sent = await flushReasons(options.dir, connection, options.fetchImpl); if (sent) log(`sent ${sent} override reason(s) to the workspace`); }
    catch { /* they wait for the next cycle */ }
  };
  const cycle = async (): Promise<CycleResult> => {
    if (running) return running;
    running = runCycle({ dir: options.dir, fetchImpl: options.fetchImpl }).then(async (result) => {
      await sendReasons();
      try { noticeHealth(); } catch { /* status is best effort */ }
      last = result;
      failures = result.deliveryError ? failures + 1 : 0;
      if (result.delivered) log(`delivered ${result.delivered} record(s); ${result.pending} waiting`);
      if (result.deliveryError) log(`delivery problem: ${result.deliveryError}`);
      return result;
    }).finally(() => { running = null; });
    return running;
  };

  const maintain = async (forceSelfCheck = false): Promise<MaintenanceResult> => {
    const result: MaintenanceResult = { at: Date.now(), policy: "unknown", updatedTo: null, hookEntries: [], selfCheck: null, error: null };
    try {
      const connection = loadConnection(options.dir);
      const harnesses = expectedHarnesses();
      const target = connection ? await fetchClientVersion(connection, options.fetchImpl) : null;
      if (target) result.policy = target.policy;
      const current = agentVersion();
      if (target?.policy === "recommended" && target.agent && compareVersions(target.agent, current) > 0) {
        log(`updating the Scopebond Agent ${current} -> ${target.agent}`);
        const installed = await installAgent(target.agent);
        if (installed.ok) {
          result.updatedTo = target.agent;
          lastMaintenance = result;
          if (options.onUpdated) options.onUpdated(target.agent);
          else { spawnReplacement(options.dir); setTimeout(() => { void stop().finally(() => process.exit(0)); }, 500); }
          return result;
        }
        result.error = `update to ${target.agent} failed: ${installed.output.slice(-300)}`;
        log(result.error);
      }
      // Hook entries: under "recommended" they move to the newest hook named or carried; under "hold"
      // only broken ones are repaired, at the version they already name or the one the agent carries.
      const hookTarget = target?.policy === "recommended" && target.hook && compareVersions(target.hook, hookVersion()) > 0 ? target.hook : hookVersion();
      result.hookEntries = maintainHookEntries(harnesses, hookTarget, target?.policy !== "hold");
      for (const change of result.hookEntries) log(`${change.reason}: ${change.file}`);
      if (connection && (forceSelfCheck || Date.now() - lastSelfCheckAt >= SELF_CHECK_EVERY_MS)) {
        result.selfCheck = await runSelfCheck(options.dir, connection, harnesses, current, { fetchImpl: options.fetchImpl });
        lastSelfCheckAt = Date.now();
        log(`self-check ${result.selfCheck?.ok ? "passed" : `failed: ${result.selfCheck?.failed.join(", ") ?? "no result"}`}`);
      }
    } catch (error) { result.error = (error as Error).message; }
    lastMaintenance = result;
    return result;
  };

  const schedule = () => {
    if (stopped) return;
    const delay = failures ? Math.min(MAX_BACKOFF_MS, interval * 2 ** Math.min(failures, 6)) : interval;
    timer = setTimeout(() => { void cycle().finally(schedule); }, delay);
  };

  const control = await startControl(options.dir, `${AGENT_VERSION} hook/${hookVersion()}`, {
    "GET /status": () => ({ ...computerStatus(options.dir), health: health(), agent: { pid: process.pid, version: AGENT_VERSION, last_cycle: last, last_maintenance: lastMaintenance } }),
    "POST /flush": async () => ({ cycle: await cycle() }),
    "POST /repair": () => {
      const repaired = repairHookEntries();
      for (const r of repaired) log(`repaired the Scopebond hook entry in ${r.file}`);
      return { repaired };
    },
    "POST /maintain": async () => ({ maintenance: await maintain(true) }),
    // `scopebond-agent stop` and `autostart off`: answer first, then stop, so the caller hears back.
    "POST /stop": () => {
      log("stopping: asked to by this computer's user");
      setTimeout(() => { void stop().finally(() => options.onStopped?.()); }, 50);
      return { stopping: true };
    },
    // Warn mode: the hook asks; only the window answers. The caller learns the answer, never decides it.
    "POST /override": async (body) => {
      const question = parseQuestion(body);
      if (!question) return { decision: "unavailable" };
      log(`asking whether to allow "${question.title}"`);
      const answer = await prompt(question);
      log(`override ${answer.decision === "allow" ? "given" : answer.decision === "deny" ? "not given" : "not available"} for "${question.title}"`);
      if (answer.decision === "allow" && answer.reason) { queueReason(options.dir, question.action_id, answer.reason); void sendReasons(); }
      return answer;
    },
  });
  const tray = (options.tray ?? true) && process.env.SCOPEBOND_AGENT_TRAY !== "off" ? startTray(options.dir) : null;
  const stop = async () => {
    stopped = true;
    try { tray?.kill(); } catch { /* already gone */ }
    if (timer) clearTimeout(timer);
    if (maintenanceTimer) clearInterval(maintenanceTimer);
    await running?.catch(() => undefined);
    await control.close();
  };
  log(`Scopebond Agent ${agentVersion()} running for ${options.dir} (control on 127.0.0.1:${control.endpoint.port})`);
  await cycle();
  schedule();
  if (options.maintenance !== false) {
    // Shortly after start (so a fresh sign-in is not slowed), then every six hours.
    setTimeout(() => { if (!stopped) void maintain(); }, 2 * 60_000).unref?.();
    maintenanceTimer = setInterval(() => { if (!stopped) void maintain(); }, UPDATE_EVERY_MS);
    maintenanceTimer.unref?.();
  }
  return { port: control.endpoint.port, cycleNow: cycle, maintainNow: () => maintain(true), stop };
}
