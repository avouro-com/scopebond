// The resident loop: one cycle now, then one every interval, sooner after a change is asked for,
// backing off while the workspace is unreachable. Exactly one agent serves a Scopebond home: a
// second one finds the first answering and exits. Every six hours it asks the workspace which
// versions to run, and once a day it runs the end-to-end self-check.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, uptime, userInfo } from "node:os";
import { join } from "node:path";
import {
  actOnBlocked, blockedQuestion, hookVersion, isSingleExecutable, isManaged, loadConnection, localActivity, MANAGED_DOC_FILE, endAllowance, noteUnresolvableHooks, readBlocked, readMeta, ruleReport, ruleName, ruleTitle,
  writeDeliveryState, userHarnessFile, writeHarnessConfig, type Harness, type RecentBlockRecord,
} from "@scopebond/hook";
import { ensurePrivateDir } from "@scopebond/gateway/node";
import { computerStatus, expectedHarnesses, missingHookEntries, runCycle, type CycleResult } from "./agent.js";
import { agentCliPath } from "./self.js";
import {
  clearUpdatePending, fetchVerifiedInstaller, installAfterExit, installerUnchanged, installKind, nativeTrayPath, readUpdatePending, removeOldHelpers, takeInstallResult, UPDATE_PENDING_MS,
  writeUpdatePending, type InstallKind,
} from "./native-update.js";
import { AGENT_LOG_ENV, launcherIsCurrent, launcherPath, refreshLauncher, retireLauncherRunValue, startCommands } from "./autostart.js";
import { callAgent, startControl } from "./ipc.js";
import { runSelfCheck } from "./selfcheck.js";
import { flushReasons, queueReason } from "./override-reasons.js";
import { parseQuestion, serialized, systemPrompter, type Prompter } from "./prompt.js";
import { livePrompt } from "./live-prompt.js";
import { healthOf, type HealthLevel } from "./health.js";
import { notifyChange, startTray } from "./tray.js";
import { sendAllowancesAndRequests } from "./allowance-sender.js";
import { allowedList, askedList, blockStates } from "./allowed-asked.js";
import { blockOutcome } from "./block-outcome.js";
import { checkResult, projectName, RECENT_BLOCKS_MAX, toolName, trayModel, type RecentBlock, type TrayModel } from "./tray-model.js";
import { fetchComputerSummary, openInBrowser, sameOrigin, type ComputerSummary } from "./summary.js";
import { startReconnect, type ReconnectStart } from "./reconnect.js";
import { connectWithInstallKey, FIRST_SIGNIN_FILE, installedKey, installedWorkspace, startFirstSignIn, type FirstSignIn, type RegistryReader } from "./signin.js";
import { migrateFromNpm, readMigration, npmRemovalCommand } from "./migrate.js";
import { enableAutostart } from "./autostart.js";
import {
  agentVersion, failedUpdate, fetchClientVersion, installAgent, maintainHookEntries, maintainedHookCommand, recentlyFailedUpdate, recordFailedUpdate, startCheck,
  updateTarget, type ClientVersion,
} from "./update.js";
import { runUpkeepApart, type UpkeepReport } from "./upkeep.js";
import { AWAKE_FILE, awakeSinceAtStart, readAwake, writeAwake } from "./awake.js";
import { withoutNodeInjection } from "./child-env.js";

export const AGENT_VERSION = `agent/${agentVersion()}`;
const INTERVAL_MS = 60_000;
const MAX_BACKOFF_MS = 15 * 60_000;
const UPDATE_EVERY_MS = 6 * 60 * 60 * 1000;
const SELF_CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
const SUMMARY_EVERY_MS = 5 * 60 * 1000;
/** The blocks asked what the workspace offers, newest first (each question reads the hook's files). */
const QUESTIONS_MAX = 50;
/** While a request to an admin asked in the last ANSWER_POLL_FOR_MS waits, the rules are checked this often. */
const ANSWER_POLL_MS = 10_000;
const ANSWER_POLL_FOR_MS = 10 * 60_000;

/** A request to an admin asked in the last 10 minutes and not answered yet. */
function requestWaiting(dir: string, now: number): boolean {
  try { return askedList(dir).some((r) => r.state === "waiting" && now - Date.parse(r.asked_at) < ANSWER_POLL_FOR_MS); }
  catch { return false; }
}
export const AFTER_PID_ENV = "SCOPEBOND_AGENT_AFTER_PID";
/** Left in the Scopebond folder when this computer's user stops the agent (`scopebond-agent stop`), and removed when it
 *  starts: the native tray then leaves it stopped instead of starting it again. */
export const STOPPED_FILE = "agent-stopped.json";
/** The person's tray settings: which notifications they want. "blocks": blocks and problems (the default for a new install);
 *  "problems": problems only (the default before, and for an install whose person never chose); "off". The older "all"
 *  meant blocks and problems too, and is read as "blocks". */
const TRAY_SETTINGS_FILE = "agent-settings.json";
type NotificationSetting = "blocks" | "problems" | "off";
export interface TraySettings { notifications: NotificationSetting }

const notificationSetting = (value: unknown): NotificationSetting | null =>
  value === "blocks" || value === "all" ? "blocks" : value === "problems" || value === "off" ? value : null;

export function readTraySettings(dir: string): TraySettings {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, TRAY_SETTINGS_FILE), "utf8")) as Partial<Record<keyof TraySettings, unknown>>;
    return { notifications: notificationSetting(parsed.notifications) ?? "problems" };
  } catch { return { notifications: "problems" }; }
}

export function writeTraySettings(dir: string, patch: unknown): TraySettings {
  const next = readTraySettings(dir);
  const value = notificationSetting((patch as { notifications?: unknown } | null)?.notifications);
  if (value) next.notifications = value;
  writeFileSync(join(dir, TRAY_SETTINGS_FILE), JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  return next;
}

/** On an agent's first start in a Scopebond folder (no agent has run there before), notifications default to blocks and
 *  problems; an install whose person never chose keeps problems only. Written once; the person's choice is never changed. */
export function settleTraySettings(dir: string, firstStart: boolean): void {
  if (existsSync(join(dir, TRAY_SETTINGS_FILE))) return;
  try { writeTraySettings(dir, { notifications: firstStart ? "blocks" : "problems" }); } catch { /* read as problems only */ }
}

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
  /** Confirms the newly installed agent starts and reports its version before this one hands over (tests replace it). */
  startCheck?: (version: string) => Promise<{ ok: boolean; output: string }>;
  /** Shows the Scopebond window for an override (tests replace it). */
  prompter?: Prompter;
  /** The Windows tray icon (default on Windows; SCOPEBOND_AGENT_TRAY=off turns it off). */
  tray?: boolean;
  /** Runs one local store upkeep pass (default: `scopebond-agent upkeep` in a child process; tests replace it). */
  upkeep?: (dir: string) => Promise<UpkeepReport>;
  /** Called once the agent has stopped because `stop` (or `autostart off`) asked it to; the CLI exits. */
  onStopped?: () => void;
  /** Each delivery request's time limit (default 30 s) and one cycle's (default 10 minutes). A cycle that runs past its
   *  limit is counted as a failure and the next one is scheduled; nothing waits on it. */
  deliveryTimeoutMs?: number;
  cycleLimitMs?: number;
  /** How this agent was installed (default: found out; tests name one). */
  installKind?: InstallKind;
  /** A signed install that was never connected starts its first sign-in by itself, once (default: on for a signed
   *  install, off from npm). */
  autoSignIn?: boolean;
  /** The first sign-in's workspace setting and side effects (tests replace them). */
  signIn?: { registry?: RegistryReader; open?: (url: string) => void; autostart?: () => string };
  /** A signed install takes over from an npm install of the agent before it starts (default on; tests turn it off). */
  migrate?: boolean;
}

/** The agent's own delivery problem, kept apart from a hook call's cut-off. */
function recordAgentError(dir: string, message: string): void {
  writeDeliveryState(dir, { last_error: message, last_status: null, last_error_source: "agent", last_error_at: Date.now() });
}

/** How long one delivery cycle may run before the agent stops waiting for it. */
const CYCLE_LIMIT_MS = 10 * 60_000;

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
  /** The local store's upkeep this pass: rows rewritten, receipts past retention removed, space returned. */
  store?: UpkeepReport;
  error: string | null;
}

/** Put the Scopebond hook back into agent settings that lost it. A visible change: each one is
 *  logged and returned, and only settings of agents this computer has are touched. */
export function repairHookEntries(harnesses: Harness[] = expectedHarnesses()): Array<{ harness: Harness; file: string }> {
  const repaired: Array<{ harness: Harness; file: string }> = [];
  for (const harness of missingHookEntries(harnesses)) {
    // A refused path for one coding agent is logged and the others are still repaired.
    try {
      const file = writeHarnessConfig(userHarnessFile(harness), harness, maintainedHookCommand(harness));
      repaired.push({ harness, file });
    } catch (error) {
      process.stderr.write(`Scopebond Agent: could not put the hook back for ${harness}: ${(error as Error).message}\n`);
    }
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
  /** The single executable: the program is the agent itself, with no cli.js and no Node options. */
  singleExecutable?: boolean;
  env: Record<string, string | undefined>; launcherText: string | null;
}): Handover {
  if (o.platform === "linux" && o.env.INVOCATION_ID) return { kind: "service-restart" };
  const launcher = launcherPath(o.dir, o.platform);
  const env = { ...withoutNodeInjection(o.env), [AFTER_PID_ENV]: String(o.pid), [AGENT_LOG_ENV]: join(o.dir, "agent.log") };
  if (o.launcherText !== null && launcherIsCurrent(o.launcherText, o.platform)) {
    if (o.platform !== "win32") return { kind: "spawn", command: "/bin/sh", args: [launcher], env, verbatim: false };
    let start: [string, string[]] | undefined;
    try { start = startCommands(launcher, o.platform)[1]; } catch { /* a launcher path cmd.exe would misread: start directly */ }
    if (start) return { kind: "spawn", command: start[0], args: start[1], env, verbatim: true };
  }
  return {
    kind: "spawn", command: o.execPath, args: o.singleExecutable ? ["run"] : ["--disable-warning=ExperimentalWarning", o.cli, "run"], verbatim: false,
    env: o.launcherText !== null ? { ...env, [REFRESH_LAUNCHER_ENV]: "1" } : env,
  };
}

/** Start the updated agent, which waits for this process to exit. Returns false when a service manager restarts it instead
 *  (this process then exits with RESTART_EXIT_CODE). */
export function spawnReplacement(dir: string, cli = agentCliPath()): boolean {
  let launcherText: string | null = null;
  try { launcherText = readFileSync(launcherPath(dir), "utf8"); } catch { /* no autostart launcher */ }
  const plan = handoverPlan({ dir, cli, pid: process.pid, execPath: process.execPath, platform: process.platform, env: process.env, launcherText, singleExecutable: isSingleExecutable() });
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
  // The agent being replaced stops serving (control channel closed, lock released) and then waits for this one to answer
  // before it exits, so it can go back to its own version if this one never starts. Unless the launcher must be rewritten
  // (nothing may still run it), its stopping is enough.
  if (Number.isInteger(previous) && previous > 0) await waitForExit(previous, waitMs, refresh ? undefined : () => !lockHeldBy(dir, previous));
  if (!refresh) return;
  // The old launcher reads its last lines after its agent exits; give it a moment to finish before its file changes.
  await new Promise((r) => setTimeout(r, 2_000));
  try { if (refreshLauncher(dir, cli)) console.log(`${new Date().toISOString()} rewrote the autostart launcher for this version`); }
  catch (error) { console.log(`${new Date().toISOString()} could not rewrite the autostart launcher: ${(error as Error).message}`); }
}

export async function waitForExit(pid: number, timeoutMs: number, released?: () => boolean): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try { process.kill(pid, 0); } catch { return; }
    if (released?.()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Whether the one-agent lock names `pid`. */
export function lockHeldBy(dir: string, pid: number): boolean {
  try { return readFileSync(join(dir, AGENT_LOCK), "utf8").trim().split(/\s+/)[0] === String(pid); } catch { return false; }
}

/** How long the agent that handed over waits for its replacement to answer before going back to its own version. */
export const HANDOVER_CONFIRM_MS = 3 * 60_000;

/** Wait until an agent other than this process answers on the local channel reporting `version`. */
export async function waitForAgentVersion(dir: string, version: string, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const status = await callAgent(dir, "GET", "/status", undefined, 2_000) as { agent?: { pid?: number; version?: string } | null } | null;
    if (status?.agent && status.agent.pid !== process.pid && status.agent.version === `agent/${version}`) return true;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return false;
}

export const AGENT_LOCK = "agent.lock";

/** How long a lock whose agent never answered on its local channel still counts as an agent starting up. */
const AGENT_LOCK_STARTING_MS = 60_000;

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

/** How the last signed update went, heard once when an agent starts: what the install helper recorded, or, when it recorded
 *  nothing, the update this agent's predecessor handed over. A version that was not installed, installed but is not the one
 *  now running, or whose helper never finished is recorded as failed, so it is not tried again for a day and status and
 *  the tray say so. */
export function noteUpdateOutcome(dir: string, log: (line: string) => void, running = agentVersion(), now = Date.now()): void {
  const installed = takeInstallResult(dir);
  const pending = readUpdatePending(dir);
  removeOldHelpers(dir);
  if (installed) {
    clearUpdatePending(dir);
    if (!installed.installed) {
      recordFailedUpdate(dir, installed.version, now, installed.reason ?? "it was not installed");
      log(`the update to ${installed.version} was not installed: ${installed.reason ?? "unknown"}`);
    } else if (installed.version !== running) {
      const why = `the installer reported ${installed.version} installed, but the agent that started is ${running}${installed.log ? ` (log: ${installed.log})` : ""}`;
      recordFailedUpdate(dir, installed.version, now, why);
      log(`the update to ${installed.version} did not take: ${why}`);
    } else log(`the Scopebond Agent ${installed.version} was installed`);
    return;
  }
  if (!pending) return;
  // Installed, and its result already read by an earlier start of this version.
  if (pending.version === running) { clearUpdatePending(dir); return; }
  // Still under way (the helper waits for the old agent and runs msiexec), unless it has been far too long.
  if (now >= pending.at && now - pending.at < UPDATE_PENDING_MS) return;
  clearUpdatePending(dir);
  recordFailedUpdate(dir, pending.version, now, "the update helper did not finish");
  log(`the update to ${pending.version} did not finish: its helper never reported back`);
}

export async function startService(options: ServiceOptions): Promise<Service> {
  const log = options.log ?? ((line: string) => console.log(`${new Date().toISOString()} ${line}`));
  const kind = options.installKind ?? installKind();
  const nativeTray = process.platform === "win32" ? nativeTrayPath() : null;
  // The signed install takes over from an npm install of the agent first: the npm agent is stopped and its sign-in entry
  // retired before this one looks for a running agent or takes the lock, so the npm one never keeps it from starting.
  if (kind !== "npm" && options.migrate !== false && process.platform === "win32") await migrateFromNpm(options.dir, kind, nativeTray, log);
  if (await callAgent(options.dir, "GET", "/status", undefined, 2_000)) throw new Error("a Scopebond Agent is already running for this computer");
  // Two agents started within moments of each other (a slow first start, then a second start) both see
  // nobody answering yet: the lock file decides, so the second exits instead of orphaning the first.
  const lock = acquireAgentLock(options.dir);
  if (!lock) throw new Error("a Scopebond Agent is already running for this computer");
  // Everything the agent and the hook keep in the folder: readable by this user alone (made so once, on the first start).
  const unprotected = ensurePrivateDir(options.dir);
  if (unprotected) log(`the folder ${options.dir} could not be made readable by this user alone: ${unprotected}`);
  rmSync(join(options.dir, STOPPED_FILE), { force: true });
  // What the install helper of a signed update recorded before this start (installAfterExit).
  noteUpdateOutcome(options.dir, log);
  // No agent has run in this folder before (it writes its wake time from its first cycle): a new install.
  settleTraySettings(options.dir, !existsSync(join(options.dir, AWAKE_FILE)));
  const interval = options.intervalMs ?? INTERVAL_MS;
  let last: CycleResult | null = null;
  let lastMaintenance: MaintenanceResult | null = null;
  // The last self-check's result: kept until another self-check runs, so a failure stays until a check passes (upkeep that
  // runs no self-check does not clear it).
  let lastSelfCheck: MaintenanceResult["selfCheck"] = null;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  let running: Promise<CycleResult> | null = null;
  let cycleStartedAt: number | null = null;
  const cycleLimit = options.cycleLimitMs ?? CYCLE_LIMIT_MS;
  let stopped = false;
  let lastSelfCheckAt = 0;
  // Time asleep never counts as records waiting. A gap between cycles longer than the schedule allows means the
  // computer slept (or the agent was stopped); waiting is counted again from the next cycle. The wake time is kept across
  // restarts of the agent alone (awake.ts), so a restart never hides a backlog; after a long gap the waiting records decide.
  const allowedGapMs = Math.max(3 * interval, 5 * 60_000);
  const startedAt = Date.now();
  let oldestPendingAt: number | null = null;
  try {
    const age = computerStatus(options.dir, startedAt).delivery.oldest_pending_age_s;
    oldestPendingAt = age === null ? null : startedAt - age * 1000;
  } catch { /* no store yet: nothing waiting */ }
  let awakeSince = awakeSinceAtStart({ saved: readAwake(options.dir), now: startedAt, uptimeMs: uptime() * 1000, allowedGapMs, oldestPendingAt });
  let lastCycleAt = 0;
  // A long step the person should see as "working" (an update), or null.
  let working: string | null = null;
  // The workspace's own summary for the tray (names, links, open reviews), refreshed every five minutes; null when the
  // workspace does not answer it (a self-hosted gateway), and the tray simply leaves those rows out.
  // A sign-in started from the tray (or, once, by a signed install's first start), while it waits for approval; and what
  // stops it when the agent stops (the hook's sign-in child, or the first sign-in this agent runs itself).
  let reconnecting: ReconnectStart | null = null;
  let endSignIn: (() => void) | null = null;
  // The workspace's last version answer: the tray offers Update now from it, per kind of install.
  let lastTarget: ClientVersion | null = null;
  let summary: ComputerSummary | null = null;
  let summaryAt = 0;
  const refreshSummary = async () => {
    summaryAt = Date.now();
    const connection = loadConnection(options.dir);
    summary = connection ? await fetchComputerSummary(connection, options.fetchImpl) : null;
  };

  // The Scopebond window, one at a time; and the hook's questions, asked in the tray first when one is listening (the window
  // is their fallback).
  const windowPrompt = serialized(options.prompter ?? systemPrompter);
  const live = livePrompt({ fallback: windowPrompt });
  const prompt = serialized(live.prompter);
  let shownLevel: HealthLevel | null = null;
  const health = () => healthOf(computerStatus(options.dir), lastSelfCheck);
  const noticeHealth = () => { const h = health(); notifyChange(shownLevel, h); shownLevel = h.level; };
  const sendReasons = async () => {
    const connection = loadConnection(options.dir);
    if (!connection) return;
    try { const sent = await flushReasons(options.dir, connection, options.fetchImpl); if (sent) log(`sent ${sent} override reason(s) to the workspace`); }
    catch { /* they wait for the next cycle */ }
    // Allowances a person made here, and their requests to an admin.
    try {
      const sent = await sendAllowancesAndRequests(options.dir, connection, options.fetchImpl);
      if (sent.allowances || sent.requests || sent.ended) log(`sent ${sent.allowances} allowance(s), ${sent.ended} stopped allowance(s) and ${sent.requests} request(s) to the workspace`);
    } catch { /* they wait for the next cycle */ }
  };
  const cycle = async (): Promise<CycleResult> => {
    if (running) return running;
    const started = Date.now();
    const allowedGap = failures ? MAX_BACKOFF_MS + 5 * 60_000 : allowedGapMs;
    if (lastCycleAt && started - lastCycleAt > allowedGap) awakeSince = started;
    lastCycleAt = started;
    writeAwake(options.dir, { awake_since: awakeSince, last_cycle_at: started });
    cycleStartedAt = started;
    // A cycle that does not finish within its limit is left behind (its requests time out on their own), counted as
    // a failure, and the loop goes on. Nothing — the next cycle, Send now, stop — waits on it.
    let limitTimer: ReturnType<typeof setTimeout> | undefined;
    const overrun = new Promise<CycleResult>((resolve) => {
      limitTimer = setTimeout(() => resolve({ at: started, connected: true, delivered: 0, pending: computerStatus(options.dir).delivery.pending,
        deliveryError: `a delivery cycle did not finish within ${Math.round(cycleLimit / 1000)} s`, rules: "skipped", missingHookEntries: [], requested: null, more: false }), cycleLimit);
      limitTimer.unref?.();
    });
    const work = runCycle({ dir: options.dir, fetchImpl: options.fetchImpl, deliveryTimeoutMs: options.deliveryTimeoutMs });
    running = Promise.race([work, overrun]).then(async (result) => {
      if (limitTimer) clearTimeout(limitTimer);
      if (result.deliveryError?.startsWith("a delivery cycle did not finish")) recordAgentError(options.dir, result.deliveryError);
      await sendReasons();
      try { noticeHealth(); } catch { /* status is best effort */ }
      last = result;
      failures = result.deliveryError ? failures + 1 : 0;
      if (result.delivered) log(`delivered ${result.delivered} record(s); ${result.pending} waiting`);
      if (result.deliveryError) log(`delivery problem: ${result.deliveryError}`);
      // Asked from the workspace's computer page. Send again now (the cycle sent before its rules check), or run the
      // self-check; each once.
      if (result.requested === "flush") { log("the workspace asked this computer to send now"); setTimeout(() => { void cycle(); }, 0); }
      // A long queue: this cycle's sending time ran out, so the next one starts right away instead of at the next interval.
      else if (result.more && !stopped) setTimeout(() => { void cycle(); }, 1_000);
      if (result.requested === "self_check") { log("the workspace asked this computer to check now"); setTimeout(() => { void maintain(true); }, 0); }
      if (result.connected && Date.now() - summaryAt > SUMMARY_EVERY_MS) void refreshSummary();
      return result;
    }).finally(() => { running = null; cycleStartedAt = null; });
    return running;
  };

  const maintain = async (forceSelfCheck = false): Promise<MaintenanceResult> => {
    const result: MaintenanceResult = { at: Date.now(), policy: "unknown", updatedTo: null, hookEntries: [], selfCheck: null, error: null };
    try {
      const connection = loadConnection(options.dir);
      const harnesses = expectedHarnesses();
      const target = connection ? await fetchClientVersion(connection, options.fetchImpl) : null;
      if (target) { result.policy = target.policy; lastTarget = target; }
      const current = agentVersion();
      // Hook entries first: always the hook this agent carries, by its path (never a version the workspace names, and never
      // an npx form resolved at run time). Under "hold" only broken ones are repaired. After an update the new agent pins
      // them to the hook it carries at its own first upkeep.
      // Codex and Cursor send nothing between actions, so a hook entry of theirs that cannot start is kept as a gap the
      // workspace hears of, before the repair below (the actions in between ran unchecked either way).
      const outage = noteUnresolvableHooks(options.dir, harnesses.filter((h) => h === "codex" || h === "cursor"));
      if (outage.recorded.length) log(`hook entry cannot start for ${outage.recorded.join(", ")}: kept as a gap for the workspace`);
      result.hookEntries = maintainHookEntries(harnesses, target?.policy !== "hold");
      for (const change of result.hookEntries) log(`${change.reason}: ${change.file}`);
      // The npm install follows the workspace's `agent`; the signed install its `native_agent` only (updateTarget).
      const newer = updateTarget(target, kind, current);
      const pending = readUpdatePending(options.dir);
      if (newer && kind === "per-machine") {
        // Installed for every user: the organisation that deployed it updates it.
        log(`the workspace recommends the Scopebond Agent ${newer}; this install is updated by your organization`);
      } else if (newer && recentlyFailedUpdate(options.dir, newer)) {
        log(`the Scopebond Agent ${newer} did not install or start here earlier; staying on ${current} for now`);
      } else if (newer && kind === "per-user" && pending && pending.version === newer && Date.now() - pending.at < UPDATE_PENDING_MS) {
        log(`the update to ${newer} is under way`);
      } else if (newer && kind === "per-user") {
        log(`updating the Scopebond Agent ${current} -> ${newer} (signed installer)`);
        const verified = await fetchVerifiedInstaller(newer, { dir: options.dir, fetchImpl: options.fetchImpl });
        if (verified.ok && installerUnchanged(verified)) {
          if (options.onUpdated) {
            result.updatedTo = newer;
            lastMaintenance = result;
            options.onUpdated(newer);
            return result;
          }
          // The installer replaces this file, so a copy of this executable installs it after this agent has exited, checks
          // it again, starts the tray (which starts the agent) or the agent again, and checks the new one answers.
          try {
            installAfterExit(verified, process.pid, existsSync(launcherPath(options.dir)) ? launcherPath(options.dir) : null, nativeTray, { dir: options.dir, previous: current });
            writeUpdatePending(options.dir, newer);
            result.updatedTo = newer;
            lastMaintenance = result;
            setTimeout(() => { setTimeout(() => process.exit(0), 5_000).unref(); void stop().finally(() => process.exit(0)); }, 500);
            return result;
          } catch (error) {
            recordFailedUpdate(options.dir, newer, Date.now(), `the update helper could not start: ${(error as Error).message}`);
            result.error = `update to ${newer} could not start its installer: ${(error as Error).message}; nothing was installed`;
          }
        } else {
          // Tried again at the next check: a download or a release not yet complete can pass then.
          result.error = `update to ${newer} could not be verified: ${verified.ok ? "the installer changed after it was checked" : verified.reason}; nothing was installed`;
        }
        log(result.error);
      } else if (newer && kind === "npm") {
        log(`updating the Scopebond Agent ${current} -> ${newer}`);
        const installed = await installAgent(newer, { fetchImpl: options.fetchImpl });
        const started = installed.ok ? await (options.startCheck ?? startCheck)(newer) : null;
        if (installed.ok && started?.ok) {
          result.updatedTo = newer;
          lastMaintenance = result;
          if (options.onUpdated) options.onUpdated(newer);
          else handOver(newer, current);
          return result;
        }
        if (installed.ok) {
          // Installed, but the new program does not start: put the running version back.
          recordFailedUpdate(options.dir, newer);
          const back = await installAgent(current, { provenance: false });
          result.error = `the Scopebond Agent ${newer} did not start (${(started?.output ?? "").slice(-200)}); ${back.ok ? `went back to ${current}` : `going back to ${current} failed: ${back.output.slice(-200)}`}`;
        } else result.error = `update to ${newer} failed: ${installed.output.slice(-300)}`;
        log(result.error);
      }
      // The local store: older rows rewritten, acknowledged receipts past the retention window removed, space returned.
      // The agent may rewrite the whole file once (the hook never does that during a tool call).
      try {
        // In a process of its own: a pass is synchronous SQLite work for up to 30 s, and the agent keeps answering meanwhile.
        result.store = await (options.upkeep ?? runUpkeepApart)(options.dir);
        const kept = result.store;
        if (kept && (kept.migrated || kept.receiptsRemoved || kept.stateRemoved || kept.pagesFreed)) {
          log(`local store: ${kept.migrated} row(s) rewritten, ${kept.receiptsRemoved} receipt(s) past retention removed, ${kept.stateRemoved} finished check record(s) removed, ${kept.pagesFreed} page(s) returned`);
        }
      } catch (error) { log(`local store upkeep failed: ${(error as Error).message}`); }
      if (connection && (forceSelfCheck || Date.now() - lastSelfCheckAt >= SELF_CHECK_EVERY_MS)) {
        result.selfCheck = await runSelfCheck(options.dir, connection, harnesses, current, { fetchImpl: options.fetchImpl });
        lastSelfCheck = result.selfCheck;
        lastSelfCheckAt = Date.now();
        log(`self-check ${result.selfCheck?.ok ? "passed" : `failed: ${result.selfCheck?.failed.join(", ") ?? "no result"}`}`);
      }
    } catch (error) { result.error = (error as Error).message; }
    lastMaintenance = result;
    return result;
  };

  // A request was just sent: check for the answer every 10 seconds from now (schedule picks the shorter wait).
  // Only a waiting timer is moved: a cycle under way schedules the next one itself when it ends.
  let timerWaiting = false;
  const pollAnswers = () => {
    if (stopped || !timerWaiting) return;
    if (timer) clearTimeout(timer);
    schedule();
  };
  const schedule = () => {
    if (stopped) return;
    // While a request to an admin waits (asked in the last 10 minutes), the rules are checked every 10 seconds, so an answer
    // shows in the tray at once; then at the usual interval.
    const delay = failures ? Math.min(MAX_BACKOFF_MS, interval * 2 ** Math.min(failures, 6))
      : requestWaiting(options.dir, Date.now()) ? Math.min(interval, ANSWER_POLL_MS) : interval;
    timerWaiting = true;
    timer = setTimeout(() => { timerWaiting = false; void cycle().finally(schedule); }, delay);
  };

  // A block under a rule a person may allow or ask about can be acted on afterwards, from the tray: what the workspace offers
  // for it now (the same checks the Scopebond window makes), in plain words with the rule's name, the project and the tool.
  // Each block has one outcome (block-outcome.ts): Unblock…, Ask an admin…, or a sentence saying why it stays blocked or
  // where the person's request stands. A block a request or an allowance in force already covers offers nothing more.
  const actionable = (blocks: RecentBlockRecord[], now: number): RecentBlock[] => {
    const known = new Map(readBlocked(options.dir).map((b) => [b.id, b]));
    const states = blockStates(options.dir, now);
    const workspace = summary?.workspace_name ?? null;
    let asked = 0;
    return blocks.map((b) => {
      const item = b.action_id ? known.get(b.action_id) : undefined;
      const rule = b.rule ?? item?.rule ?? null;
      const request = states.requestFor(b.action_id, rule, item?.action_key ?? null);
      const allowed = !request && states.allowedFor(rule, item?.action_key ?? null);
      // What the workspace offers, for the newest QUESTIONS_MAX blocks not acted on (each question reads the hook's files).
      const q = item && !item.acted && b.action_id && !request && !allowed && asked++ < QUESTIONS_MAX ? blockedQuestion(options.dir, b.action_id, now) : null;
      const offers = q ? {
        once: q.offers.allow, fifteen: q.offers.fifteen, always: q.offers.always, always_days: q.offers.always ? q.always_days : null,
        always_needs_admin: q.offers.always && q.always_needs_admin, ask: q.offers.ask, reviewed: q.reviewed,
      } : null;
      const what = b.what ?? b.summary;
      const ruleTitleText = ruleTitle(rule) ?? b.rule_title ?? ruleName(rule);
      const tool = toolName(b.harness ?? item?.harness ?? null);
      const outcome = blockOutcome({
        offers, clause: b.clause ?? null, rule, kind: b.kind ?? null, verdict: b.verdict ?? null, request, allowed,
        workspace, tool, what, rule_title: ruleTitleText, action_id: b.action_id,
      });
      return {
        action_id: b.action_id, summary: b.summary, at: b.at, rule, can_act: Boolean(q), acted: item?.acted ?? (request ? "asked" : allowed ? "allowed" : null),
        what, action_text: item?.summary ?? b.action_text ?? b.summary, rule_title: ruleTitleText,
        project: projectName(b.repository) ?? b.project ?? null, tool,
        offers,
        reason_min: q ? q.reason_min : null,
        tries: b.tries ?? 1, first_at: b.first_at ?? b.at, group_id: b.group_id ?? b.action_id,
        ...outcome,
        request,
      };
    });
  };

  const trayState = (): TrayModel => {
    const now = Date.now();
    const status = computerStatus(options.dir);
    const meta = readMeta(options.dir);
    const report = ruleReport(options.dir);
    const modes = report ? Object.values(report).map(([mode]) => mode) : [];
    const activity = localActivity(options.dir, { limit: RECENT_BLOCKS_MAX });
    const model = trayModel({
      status, health: health(), now, awakeSince, working,
      rules: report ? { checked_at: meta.checked_at ? Date.parse(meta.checked_at) : null, managed: isManaged(options.dir), block: modes.filter((m) => m === "enforce").length, monitor: modes.filter((m) => m === "monitor").length } : null,
      today: activity?.today ?? null,
      recentBlocks: actionable(activity?.recent_blocks ?? [], now),
      version: { agent: agentVersion(), hook: hookVersion(), policy: lastMaintenance?.policy ?? "unknown", ...offeredVersions(), failedUpdate: failedUpdate(options.dir) },
      workspace: summary ? { name: summary.workspace_name, environment: summary.environment_name, computer_url: summary.computer_url } : null,
      openReviews: summary?.open_reviews ?? 0,
      computerName: hostname(),
      canReconnect: true,
      // A signed install signs in for the first time from the tray; an npm one from a terminal.
      canSignIn: kind !== "npm",
      signingIn: reconnecting,
      notice: migrationNotice(),
      canAsk: workspaceLetsAsk(options.dir),
    });
    // What the person let through and asked an admin, for the tray's Allowed and Requests lists.
    return { ...model, allowed: allowedList(options.dir, now), asked: askedList(options.dir) };
  };
  /** What this install can update to, for the tray: from npm, the workspace's agent and hook (as its rules check said);
   *  the signed install, only the signed build the workspace names (the hook is inside it); for every user, nothing. */
  const offeredVersions = (): { recommendedAgent: string | null; recommendedHook: string | null } => {
    if (kind === "per-machine") return { recommendedAgent: null, recommendedHook: null };
    if (kind === "per-user") return { recommendedAgent: lastTarget?.policy === "recommended" ? lastTarget.native_agent : null, recommendedHook: null };
    const meta = readMeta(options.dir);
    return { recommendedAgent: meta.recommended?.agent ?? null, recommendedHook: meta.recommended?.hook ?? null };
  };
  /** After taking over from an npm install, for a week, while the npm package is still there: how to remove it. */
  const migrationNotice = (): string | null => {
    if (kind === "npm") return null;
    const moved = readMigration(options.dir);
    if (!moved?.package_dir || Date.now() - moved.at > 7 * 24 * 60 * 60 * 1000 || !existsSync(moved.package_dir)) return null;
    return `The Scopebond Agent installed with npm is no longer used. To remove it, run: ${npmRemovalCommand()}`;
  };

  // Sign in: again, for the workspace this computer is connected to (the hook's own sign-in); or, for a signed install
  // never connected, for the first time, to the workspace the installer named (else Scopebond Cloud). The tray shows the
  // code; asked again while it waits, it opens the approval page again and gives the same code.
  let signInOrigin: string | null = null;
  const signIn = async (by: string): Promise<ReconnectStart | { connected: true } | { error: string }> => {
    if (reconnecting) {
      if (signInOrigin && sameOrigin(reconnecting.verification_url, signInOrigin)) (options.signIn?.open ?? openInBrowser)(reconnecting.verification_url);
      return reconnecting;
    }
    const connection = loadConnection(options.dir);
    working = connection ? "Signing in again…" : "Signing in…";
    try {
      if (connection || kind === "npm") {
        const result = await startReconnect(options.dir, (ok) => {
          reconnecting = null; endSignIn = null;
          log(ok ? "signed in again" : "the sign-in did not finish");
          if (ok) void cycle();
        }, undefined, options.signIn?.open);
        if ("error" in result) return { error: result.error };
        reconnecting = result.started;
        signInOrigin = connection ? new URL(connection.url).origin : null;
        endSignIn = () => { try { result.child.kill(); } catch { /* already gone */ } };
        log(`signing in again: waiting for approval of code ${result.started.user_code}`);
        return result.started;
      }
      const workspace = installedWorkspace(options.signIn?.registry);
      if ("error" in workspace) { log(`cannot sign in: ${workspace.error}`); return { error: workspace.error }; }
      log(`signing in for the first time (${by}) to ${workspace.origin}, ${workspace.from === "default" ? "Scopebond Cloud (the installer named no workspace)" : `named in ${workspace.from}`}`);
      // Autostart as setup turns it on: the tray's sign-in entry beside the native tray, else the launcher. Only the signed
      // executable itself does it (a test names its own).
      const autostart = options.signIn?.autostart ?? (isSingleExecutable() ? () => enableAutostart(options.dir, agentCliPath()) : undefined);
      // A company-wide install was given an install key: connect with it, no code. If the key is not accepted, the person signs
      // in with a code as usual.
      const key = installedKey(options.signIn?.registry);
      if (key) {
        log(`connecting with the install key named in ${key.from}`);
        const keyed = await connectWithInstallKey(options.dir, workspace.origin, key.key, { fetchImpl: options.fetchImpl, autostart });
        if (keyed.ok) {
          for (const line of keyed.lines) log(`first sign-in: ${line}`);
          void cycle(); void refreshSummary();
          return { connected: true };
        }
        log(`the install key did not connect this computer: ${keyed.error}; signing in with a code instead`);
      }
      const first: FirstSignIn | { error: string } = await startFirstSignIn(options.dir, workspace.origin, {
        fetchImpl: options.fetchImpl, open: options.signIn?.open, autostart,
        onDone: (outcome) => {
          reconnecting = null; endSignIn = null;
          if (!outcome.ok) { log(`the first sign-in did not finish: ${outcome.error}`); return; }
          for (const line of outcome.lines) log(`first sign-in: ${line}`);
          void cycle(); void refreshSummary();
        },
      });
      if ("error" in first) { log(`the first sign-in could not start: ${first.error}`); return { error: first.error }; }
      reconnecting = first.started;
      signInOrigin = workspace.origin;
      endSignIn = () => first.cancel();
      log(`signing in: waiting for approval of code ${first.started.user_code}`);
      return first.started;
    } finally { working = null; }
  };

  const control = await startControl(options.dir, `${AGENT_VERSION} hook/${hookVersion()}`, {
    // What the tray draws, and the person's tray settings.
    "GET /tray": () => ({ tray: { ...trayState(), pending: live.current() }, settings: readTraySettings(options.dir) }),
    // The live prompt: the tray waits here for the hook's question (the one waiting now, at once when it is not the one the
    // tray last saw), says when the person opened it (then no window opens for it), and sends the person's answer, which
    // the hook's waiting call receives. Checked as the window's answer would be; only the person at the computer sees the
    // tray's panel.
    "POST /override/wait": async (body) => {
      const seen = typeof (body as { seen?: unknown } | null)?.seen === "string" ? String((body as { seen: string }).seen) : null;
      return { question: await live.wait(seen, 20_000) };
    },
    "POST /override/open": (body) => {
      const id = (body as { action_id?: unknown } | null)?.action_id;
      return { opened: typeof id === "string" && live.open(id) };
    },
    "POST /override/answer": (body) => {
      const waiting = live.current();
      let os_user: string | undefined;
      try { os_user = userInfo().username; } catch { /* not known: the hook uses its own */ }
      const done = live.answer(body, os_user);
      if (!done.ok) return { outcome: done.outcome, text: done.text };
      const outcome = done.choice === "ask" ? "asked" as const : done.choice === "always" && waiting?.offers.always_needs_admin ? "proposed" as const : "allowed" as const;
      log(`question under "${waiting?.rule_title ?? "a rule"}", answered in the tray: ${outcome} (${done.choice})`);
      if (outcome === "asked") pollAnswers();
      return { outcome, choice: done.choice, text: answerText(outcome, done.choice, done.always_days, summary?.workspace_name ?? null, !!loadConnection(options.dir), done.reviewed) };
    },
    "POST /settings": (body) => ({ settings: writeTraySettings(options.dir, body) }),
    // "Check now" always says what it found.
    // It checks the rules and packs again now (a whole cycle) and runs the self-check; it never installs an update (that is
    // "Update now").
    "POST /check": async () => {
      let error: string | null = null;
      try {
        const cycled = await cycle();
        if (cycled.rules === "refused" || cycled.rules === "unavailable") error = "the rules could not be checked; this computer keeps its last rules";
      } catch (e) { error = (e as Error).message; }
      const connection = loadConnection(options.dir);
      let selfCheck: MaintenanceResult["selfCheck"] = null;
      if (connection) {
        try {
          selfCheck = await runSelfCheck(options.dir, connection, expectedHarnesses(), agentVersion(), { fetchImpl: options.fetchImpl });
          lastSelfCheck = selfCheck;
          lastSelfCheckAt = Date.now();
        } catch (e) { error = error ?? (e as Error).message; }
      }
      return { text: checkResult(selfCheck, error), tray: trayState() };
    },
    // Install the version the workspace recommends now, instead of at the next six-hourly check.
    "POST /update": async () => {
      working = "Updating Scopebond…";
      try { const result = await maintain(true); return { updated_to: result.updatedTo, error: result.error }; }
      finally { working = null; }
    },
    // The newest blocks on this computer, summarised the way `log` prints them (never raw arguments).
    // Open this computer's page in the workspace, only on the workspace this computer is connected to.
    "POST /open-workspace": () => {
      const connection = loadConnection(options.dir);
      const url = summary?.computer_url;
      if (!connection || !url || !sameOrigin(url, connection.url)) return { opened: false };
      openInBrowser(url);
      return { opened: true };
    },
    // Sign in again for the connected workspace; the tray shows the code, the approval page opens in the browser.
    // A computer never connected (the signed install): the first sign-in, with the hook entries and autostart.
    "POST /reconnect": () => signIn("from the tray"),
    "GET /recent-blocks": () => ({ recent_blocks: actionable(localActivity(options.dir, { limit: RECENT_BLOCKS_MAX })?.recent_blocks ?? [], Date.now()) }),
    // Allow an earlier block, or ask an admin, from the tray. The caller names the block; only the Scopebond window
    // answers (the same window the hook uses), so whoever calls this channel cannot allow anything by itself. Scopebond never
    // runs the action: the person or the coding agent runs it again.
    "POST /blocked": async (body) => {
      const id = typeof (body as { action_id?: unknown } | null)?.action_id === "string" ? String((body as { action_id: string }).action_id) : "";
      const q = id ? blockedQuestion(options.dir, id) : null;
      if (!q) return { outcome: "gone", text: "This block can no longer be allowed or sent to an admin from here." };
      log(`asking about an earlier block under "${q.title}"`);
      const answer = await windowPrompt({ action_id: id, rule: q.item.rule, title: q.title, summary: q.item.summary, reason_min: q.reason_min,
        lasts: "the next time it runs", timeout_ms: 55_000, mode: q.mode, offers: q.offers });
      if (answer.decision === "unavailable") return { outcome: "unavailable", text: "The Scopebond window could not be shown." };
      const done = actOnBlocked(options.dir, id, answer);
      if (done.outcome === "allowed" || done.outcome === "proposed" || done.outcome === "asked") setTimeout(() => { void sendReasons(); }, 1_000);
      if (done.outcome === "asked") pollAnswers();
      log(`earlier block under "${q.title}": ${done.outcome}`);
      return { outcome: done.outcome, text: blockedText(done.outcome) };
    },
    // The same answer from the tray's own form instead of the Scopebond window: the person chose in the tray's panel, which
    // only the person at the computer sees, and the tray sends the choice and the reason here. Checked again as the window
    // would be (the block is still offered, the choice is one the workspace allows, the reason is long enough), then applied
    // exactly as the window's answer is: the allowance or the request on this computer, sent to the workspace signed by this
    // computer's key. Scopebond never runs the action: the person or the coding agent runs it again.
    "POST /blocked/answer": (body) => {
      const parsed = parseBlockedAnswer(body);
      if (!parsed) return { outcome: "invalid", text: "That answer could not be read." };
      const q = blockedQuestion(options.dir, parsed.action_id);
      if (!q) return { outcome: "gone", text: blockedText("gone") };
      const offered = parsed.choice === "once" ? q.offers.allow : parsed.choice === "fifteen" ? q.offers.fifteen : parsed.choice === "always" ? q.offers.always : q.offers.ask;
      if (!offered) return { outcome: "not_offered", text: "Your workspace does not offer that choice for this block now." };
      if (parsed.reason.length < q.reason_min) return { outcome: "reason_short", text: `Say why in at least ${q.reason_min} characters.` };
      let os_user: string | undefined;
      try { os_user = userInfo().username; } catch { /* not known: the hook uses its own */ }
      const lasts = parsed.choice === "fifteen" ? "15m" as const : parsed.choice === "always" ? "always" as const : "once" as const;
      const answer = parsed.choice === "ask" ? { decision: "ask" as const, reason: parsed.reason, ...(os_user ? { os_user } : {}) }
        : { decision: "allow" as const, reason: parsed.reason, lasts, ...(os_user ? { os_user } : {}) };
      const done = actOnBlocked(options.dir, parsed.action_id, answer);
      if (done.outcome === "allowed" || done.outcome === "proposed" || done.outcome === "asked") setTimeout(() => { void sendReasons(); }, 1_000);
      if (done.outcome === "asked") pollAnswers();
      log(`earlier block under "${q.title}", answered in the tray: ${done.outcome} (${parsed.choice})`);
      return { outcome: done.outcome, choice: parsed.choice, text: answerText(done.outcome, parsed.choice, q.always_days, summary?.workspace_name ?? null, !!loadConnection(options.dir), q.reviewed) };
    },
    // What the person let through (in force, or waiting for an admin) and what they asked an admin, with the answers.
    "GET /allowances": () => ({ allowances: allowedList(options.dir) }),
    "GET /requests": () => ({ requests: askedList(options.dir) }),
    // "Stop allowing": the person ends an allowance they made here. It stops applying at once, and the ended record goes to
    // the workspace, signed by this computer's key.
    "POST /allowances/stop": (body) => {
      const id = typeof (body as { id?: unknown } | null)?.id === "string" ? String((body as { id: string }).id) : "";
      const item = allowedList(options.dir).find((a) => a.id === id && a.by === "person");
      if (!item) return { outcome: "gone", text: "This allowance has already ended." };
      if (endAllowance(options.dir, id).outcome !== "ended") return { outcome: "gone", text: "This allowance has already ended." };
      setTimeout(() => { void sendReasons(); }, 1_000);
      const what = item.what ?? item.rule_title ?? "it";
      const connected = !!loadConnection(options.dir);
      log(`stopped allowing an action under "${item.rule_title ?? item.rule}", from the tray`);
      return { outcome: "stopped", text: connected ? `Stopped allowing ${what} · Recorded and sent to ${summary?.workspace_name ?? "your workspace"}` : `Stopped allowing ${what} on this computer` };
    },
    // install_kind: a signed agent starting beside an older npm one tells them apart by it (migrate.ts).
    "GET /status": () => ({ ...computerStatus(options.dir), health: health(), agent: {
      pid: process.pid, version: AGENT_VERSION, install_kind: kind, last_cycle: last, cycle_started_at: cycleStartedAt, last_maintenance: lastMaintenance,
      failed_update: failedUpdate(options.dir), signing_in: reconnecting,
    } }),
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
      try { writeFileSync(join(options.dir, STOPPED_FILE), `${JSON.stringify({ stopped_at: new Date().toISOString(), pid: process.pid })}\n`); } catch { /* the tray may start it again */ }
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
      if (answer.decision === "allow" && answer.reason) { queueReason(options.dir, question.action_id, answer.reason); setTimeout(() => { void sendReasons(); }, 1_000); }
      // The hook writes the request or allowance after this answer; send it shortly after.
      if (answer.decision === "ask" || answer.lasts === "always" || answer.lasts === "15m") setTimeout(() => { void sendReasons(); }, 2_000);
      return answer;
    },
  }, nativeTray ? { loopback: false } : {}); // beside the native tray nothing uses loopback: its tray and its hook use the pipe
  // Beside the native tray (the signed install), the tray is that program: it started this agent, or starts at sign-in.
  const tray = (options.tray ?? true) && process.env.SCOPEBOND_AGENT_TRAY !== "off" && !nativeTray ? startTray(options.dir) : null;
  if (nativeTray && retireLauncherRunValue()) log("removed the ScopebondAgent sign-in entry: the Scopebond tray starts the agent");
  const stop = async () => {
    stopped = true;
    // A question waiting in the tray ends with the agent (the hook hears "unavailable", as when no agent runs).
    live.close();
    try { tray?.kill(); } catch { /* already gone */ }
    // A sign-in waiting for approval ends with the agent (an update or an uninstall replaces this program).
    try { endSignIn?.(); } catch { /* already over */ }
    if (timer) clearTimeout(timer);
    if (maintenanceTimer) clearInterval(maintenanceTimer);
    // A cycle under way gets a moment to finish; stop never waits on one that does not.
    if (running) await Promise.race([running.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 2_000).unref?.())]);
    await control.close();
    releaseAgentLock(lock);
  };
  /** Hand over to the agent just installed: start it, stop serving, and wait for it to answer with the new version. If it
   *  never does, put `previous` back, start that, and exit. A service manager (systemd) restarts the agent itself instead. */
  const handOver = (version: string, previous: string) => {
    setTimeout(() => {
      void (async () => {
        // Whatever happens below, this process ends.
        setTimeout(() => process.exit(0), HANDOVER_CONFIRM_MS + 10 * 60_000).unref();
        const spawned = spawnReplacement(options.dir);
        // A stop that never finishes (a tray or window child that will not close) must not keep this agent serving.
        await Promise.race([stop().catch(() => undefined), new Promise((r) => setTimeout(r, 5_000))]);
        if (!spawned) process.exit(RESTART_EXIT_CODE);
        if (await waitForAgentVersion(options.dir, version, HANDOVER_CONFIRM_MS)) process.exit(0);
        log(`the Scopebond Agent ${version} did not answer within ${Math.round(HANDOVER_CONFIRM_MS / 1000)} s; going back to ${previous}`);
        recordFailedUpdate(options.dir, version);
        const back = await installAgent(previous, { provenance: false });
        log(back.ok ? `went back to the Scopebond Agent ${previous}` : `going back to ${previous} failed: ${back.output.slice(-300)}`);
        // The replacement's launcher may restart it on the files just put back; otherwise start the previous version now.
        if (!await waitForAgentVersion(options.dir, previous, 45_000)) spawnReplacement(options.dir);
        process.exit(0);
      })();
    }, 500);
  };
  // The very first start of a signed install that was never connected: sign in once, by itself (the approval page opens in
  // the browser, the tray shows the code). The note is written first, so this never happens twice, even after a crash.
  if ((options.autoSignIn ?? kind !== "npm") && !loadConnection(options.dir) && !existsSync(join(options.dir, FIRST_SIGNIN_FILE))) {
    let noted = false;
    try { writeFileSync(join(options.dir, FIRST_SIGNIN_FILE), `${JSON.stringify({ started_at: new Date().toISOString(), pid: process.pid })}\n`, { mode: 0o600, flag: "wx" }); noted = true; }
    catch { /* written already, or the folder cannot be written: not started by itself */ }
    if (noted) void signIn("on the first start of this install");
  }
  log(`Scopebond Agent ${agentVersion()} running for ${options.dir} (control on ${[control.endpoint.socket, control.endpoint.port ? `127.0.0.1:${control.endpoint.port}` : null].filter(Boolean).join(" and ")})`);
  // Maintenance is armed before the first cycle, so a first cycle that hangs cannot keep it from ever starting.
  if (options.maintenance !== false) {
    // Shortly after start (so a fresh sign-in is not slowed), then every six hours.
    setTimeout(() => { if (!stopped) void maintain(); }, 2 * 60_000).unref?.();
    maintenanceTimer = setInterval(() => { if (!stopped) void maintain(); }, UPDATE_EVERY_MS);
    maintenanceTimer.unref?.();
  }
  await cycle();
  schedule();
  return { port: control.endpoint.port, cycleNow: cycle, maintainNow: () => maintain(true), stop };
}

/** Whether the workspace's rules let a person ask an admin under any rule ("Block, person may ask", or a rule a person may
 *  allow with requests on), as `blockedQuestion` would offer it. False without workspace rules. */
export function workspaceLetsAsk(dir: string): boolean {
  try {
    const doc = JSON.parse(readFileSync(join(dir, MANAGED_DOC_FILE), "utf8")) as { rules?: Record<string, { mode?: unknown; override?: { requests?: unknown } } | undefined> };
    return Object.values(doc.rules ?? {}).some((r) => !!r?.override && (r.mode === "ask" || (r.mode === "override" && r.override.requests === true)));
  } catch { return false; }
}

/** What the tray says after a person acted on an earlier block. */
function blockedText(outcome: "allowed" | "proposed" | "asked" | "declined" | "gone"): string {
  switch (outcome) {
    case "allowed": return "Allowed. Run it again, or let the coding agent retry.";
    case "proposed": return "Allowed for 15 minutes. Your workspace's admins decide whether it stands; run it again meanwhile.";
    case "asked": return "Request sent to your workspace's admins. Scopebond shows the answer; then run it again.";
    case "declined": return "Nothing was allowed.";
    case "gone": return "This block can no longer be allowed or sent to an admin from here.";
  }
}

export type BlockedChoice = "once" | "fifteen" | "always" | "ask";

/** Check an answer from the tray's form: an action id, one of the four choices, and a reason of at most 500 characters
 *  (control characters other than line breaks are refused). The rest (offered, long enough) is checked against the block. */
export function parseBlockedAnswer(raw: unknown): { action_id: string; choice: BlockedChoice; reason: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.action_id !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/.test(r.action_id)) return null;
  if (r.choice !== "once" && r.choice !== "fifteen" && r.choice !== "always" && r.choice !== "ask") return null;
  if (typeof r.reason !== "string") return null;
  const reason = r.reason.trim();
  if (reason.length > 500 || [...reason].some((c) => { const n = c.charCodeAt(0); return (n < 32 && n !== 10 && n !== 13) || n === 127; })) return null;
  return { action_id: r.action_id, choice: r.choice, reason };
}

/** What the tray says after a person answered a block in its form: what happened, and where it was recorded. */
export function answerText(outcome: "allowed" | "proposed" | "asked" | "declined" | "gone", choice: BlockedChoice, alwaysDays: number, workspace: string | null, connected: boolean, reviewed = false, now = Date.now()): string {
  if (outcome === "gone") return blockedText("gone");
  if (outcome === "declined") return blockedText("declined");
  // A request: where the answer will show (it is recorded and sent like everything else).
  if (outcome === "asked") return connected ? "Request sent · you'll see the answer under Requests" : "Request saved, sent once this computer is connected · you'll see the answer under Requests";
  // Applied at once, reviewed by an admin later: when it ends, and that it will be reviewed.
  if (reviewed && outcome === "allowed") {
    const until = choice === "once" ? "for the next try"
      : choice === "fifteen" ? `until ${new Date(now + 15 * 60_000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`
      : `until ${new Date(now + alwaysDays * 86_400_000).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
    return `Unblocked ${until} · an admin will review it`;
  }
  const what = outcome === "proposed" ? "Allowed for 15 minutes; always once an admin approves"
    : choice === "fifteen" ? "Allowed for 15 minutes"
    : choice === "always" ? `Always allowed on this computer for ${alwaysDays} day${alwaysDays === 1 ? "" : "s"}`
    : "Allowed once";
  const where = connected ? `Recorded and sent to ${workspace ?? "your workspace"}` : "Recorded on this computer";
  return `${what} · ${where}`;
}
