// The resident loop: one cycle now, then one every interval, sooner after a change is asked for,
// backing off while the workspace is unreachable. Exactly one agent serves a Scopebond home: a
// second one finds the first answering and exits. Every six hours it asks the workspace which
// versions to run, and once a day it runs the end-to-end self-check.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hookVersion, loadConnection, userHarnessFile, writeHarnessConfig, type Harness } from "@scopebond/hook";
import { computerStatus, expectedHarnesses, missingHookEntries, runCycle, type CycleResult } from "./agent.js";
import { AGENT_LOG_ENV, launcherIsCurrent, launcherPath, refreshLauncher, startCommands } from "./autostart.js";
import { callAgent, startControl } from "./ipc.js";
import { runSelfCheck } from "./selfcheck.js";
import { flushReasons, queueReason } from "./override-reasons.js";
import { parseQuestion, serialized, systemPrompter, type Prompter } from "./prompt.js";
import { healthOf, type HealthLevel } from "./health.js";
import { notifyChange, startTray } from "./tray.js";
import { agentVersion, compareVersions, fetchClientVersion, installAgent, maintainHookEntries, maintainedHookCommand } from "./update.js";

export const AGENT_VERSION = `agent/${agentVersion()}`;
const INTERVAL_MS = 60_000;
const MAX_BACKOFF_MS = 15 * 60_000;
const UPDATE_EVERY_MS = 6 * 60 * 60 * 1000;
const SELF_CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
export const AFTER_PID_ENV = "SCOPEBOND_AGENT_AFTER_PID";
/** Set for a replacement started directly because the launcher is an older one: it rewrites the launcher once the old agent is gone. */
export const REFRESH_LAUNCHER_ENV = "SCOPEBOND_AGENT_REFRESH_LAUNCHER";
/** The exit code that asks a service manager to start the agent again (systemd's Restart=on-failure), used where a detached replacement would not survive. */
export const RESTART_EXIT_CODE = 75;

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
    const file = writeHarnessConfig(userHarnessFile(harness), harness, maintainedHookCommand(harness));
    repaired.push({ harness, file });
  }
  return repaired;
}

/** How the updated agent takes over from this one. */
export type Handover =
  | { kind: "spawn"; command: string; args: string[]; env: Record<string, string | undefined>; verbatim: boolean }
  | { kind: "service-restart" };

/** Decide how to start the updated agent. Through the autostart launcher when there is one, so it finds Node the same way
 *  sign-in does and is restarted after a crash. On Windows an older launcher cannot do it: it redirects the agent's output
 *  into agent.log, this agent's children inherit that handle, and the new launcher's own redirect then fails, which cmd
 *  takes for a clean exit. So under an older launcher the updated agent starts directly and rewrites the launcher once
 *  this one is gone. Under systemd a detached child is stopped with the service, so the service manager restarts it. */
export function handoverPlan(o: {
  dir: string; cli: string; pid: number; execPath: string; platform: NodeJS.Platform;
  env: Record<string, string | undefined>; launcherText: string | null;
}): Handover {
  if (o.platform === "linux" && o.env.INVOCATION_ID) return { kind: "service-restart" };
  const launcher = launcherPath(o.dir, o.platform);
  const env = { ...o.env, [AFTER_PID_ENV]: String(o.pid), [AGENT_LOG_ENV]: join(o.dir, "agent.log") };
  if (o.launcherText !== null && launcherIsCurrent(o.launcherText, o.platform)) {
    if (o.platform === "win32") {
      const [command, args] = startCommands(launcher, o.platform)[1];
      return { kind: "spawn", command, args, env, verbatim: true };
    }
    return { kind: "spawn", command: "/bin/sh", args: [launcher], env, verbatim: false };
  }
  return {
    kind: "spawn", command: o.execPath, args: ["--disable-warning=ExperimentalWarning", o.cli, "run"], verbatim: false,
    env: o.launcherText !== null ? { ...env, [REFRESH_LAUNCHER_ENV]: "1" } : env,
  };
}

/** Start the updated agent, which waits for this process to exit. Returns false when a service manager restarts it instead
 *  (this process then exits with RESTART_EXIT_CODE). */
export function spawnReplacement(dir: string, cli = realpathSync(fileURLToPath(new URL("./cli.js", import.meta.url)))): boolean {
  let launcherText: string | null = null;
  try { launcherText = readFileSync(launcherPath(dir), "utf8"); } catch { /* no autostart launcher */ }
  const plan = handoverPlan({ dir, cli, pid: process.pid, execPath: process.execPath, platform: process.platform, env: process.env, launcherText });
  if (plan.kind === "service-restart") return false;
  const child = spawn(plan.command, plan.args, { env: plan.env, detached: true, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: plan.verbatim });
  child.on("error", () => { /* the next sign-in starts it */ });
  child.unref();
  return true;
}

/** The first thing a starting agent does: wait for the agent it replaces to exit, then, when asked, rewrite the older launcher
 *  that agent ran under (by now nothing runs it). The handover variables are dropped, so a later restart waits for nothing. */
export async function takeOver(dir: string, cli: string, waitMs = 30_000): Promise<void> {
  const previous = Number(process.env[AFTER_PID_ENV]);
  const refresh = process.env[REFRESH_LAUNCHER_ENV] === "1";
  delete process.env[AFTER_PID_ENV];
  delete process.env[REFRESH_LAUNCHER_ENV];
  if (Number.isInteger(previous) && previous > 0) await waitForExit(previous, waitMs);
  if (!refresh) return;
  // The old launcher reads its last lines after its agent exits; give it a moment to finish before its file changes.
  await new Promise((r) => setTimeout(r, 2_000));
  try { if (refreshLauncher(dir, cli)) console.log(`${new Date().toISOString()} rewrote the autostart launcher for this version`); }
  catch (error) { console.log(`${new Date().toISOString()} could not rewrite the autostart launcher: ${(error as Error).message}`); }
}

export async function waitForExit(pid: number, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((r) => setTimeout(r, 250));
  }
}

export const AGENT_LOCK = "agent.lock";

/** How long a lock whose agent never answered on its local channel still counts as an agent starting up. */
export const AGENT_LOCK_STARTING_MS = 60_000;

/** Take the one-agent-per-home lock: created exclusively, or taken over when the agent named in it is
 *  gone. The caller has already found no agent answering on the local channel, so a lock older than
 *  AGENT_LOCK_STARTING_MS is left over even when its process id is alive: Windows reuses process ids
 *  soon after a restart, and a sign-in after a reboot must not find "already running". A newer lock
 *  is an agent still starting (or one whose id is not written yet): this start gives way.
 *  Returns the lock file, or null while another agent holds it. */
export function acquireAgentLock(dir: string, now = Date.now()): string | null {
  const file = join(dir, AGENT_LOCK);
  mkdirSync(dir, { recursive: true });
  const mine = `${process.pid} ${now}`;
  try { writeFileSync(file, mine, { flag: "wx" }); return file; } catch { /* held, or left behind */ }
  let text = "";
  let written = now;
  try { text = readFileSync(file, "utf8").trim(); written = statSync(file).mtimeMs; } catch { /* removed meanwhile */ }
  const [pidText, atText] = text.split(/\s+/);
  const holder = Number(pidText);
  const at = Number(atText);
  const since = Number.isFinite(at) && at > 0 ? at : written;
  const fresh = now - since < AGENT_LOCK_STARTING_MS;
  if (holder !== process.pid && fresh) {
    if (!(Number.isInteger(holder) && holder > 0)) return null; // being written by an agent starting this moment
    try { process.kill(holder, 0); return null; } catch { /* that agent is gone: take the lock over */ }
  }
  writeFileSync(file, mine);
  return file;
}

export function releaseAgentLock(file: string): void {
  try { if (readFileSync(file, "utf8").trim().split(/\s+/)[0] === String(process.pid)) rmSync(file, { force: true }); } catch { /* already gone */ }
}

export async function startService(options: ServiceOptions): Promise<Service> {
  const log = options.log ?? ((line: string) => console.log(`${new Date().toISOString()} ${line}`));
  if (await callAgent(options.dir, "GET", "/status", undefined, 2_000)) throw new Error("a Scopebond Agent is already running for this computer");
  // Two agents started within moments of each other (a slow first start, then a second start) both see
  // nobody answering yet: the lock file decides, so the second exits instead of orphaning the first.
  const lock = acquireAgentLock(options.dir);
  if (!lock) throw new Error("a Scopebond Agent is already running for this computer");
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
      // Hook entries first: under "recommended" they move to the newest hook named or carried; under "hold" only broken ones
      // are repaired, at the version they already name or the one the agent carries. Done before a self-update, so an update
      // whose handover fails never leaves the hook behind.
      const hookTarget = target?.policy === "recommended" && target.hook && compareVersions(target.hook, hookVersion()) > 0 ? target.hook : hookVersion();
      result.hookEntries = maintainHookEntries(harnesses, hookTarget, target?.policy !== "hold");
      for (const change of result.hookEntries) log(`${change.reason}: ${change.file}`);
      if (target?.policy === "recommended" && target.agent && compareVersions(target.agent, current) > 0) {
        log(`updating the Scopebond Agent ${current} -> ${target.agent}`);
        const installed = await installAgent(target.agent);
        if (installed.ok) {
          result.updatedTo = target.agent;
          lastMaintenance = result;
          if (options.onUpdated) options.onUpdated(target.agent);
          else {
            const code = spawnReplacement(options.dir) ? 0 : RESTART_EXIT_CODE;
            // Hand over: stop, then exit. A stop that never finishes (a tray or window child that will not close) must not
            // keep the old agent alive with the replacement waiting on it, so the exit has a hard deadline.
            setTimeout(() => { setTimeout(() => process.exit(code), 5_000).unref(); void stop().finally(() => process.exit(code)); }, 500);
          }
          return result;
        }
        result.error = `update to ${target.agent} failed: ${installed.output.slice(-300)}`;
        log(result.error);
      }
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
    releaseAgentLock(lock);
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
