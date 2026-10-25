// The resident loop: one cycle now, then one every interval, sooner after a change is asked for,
// backing off while the workspace is unreachable. Exactly one agent serves a Scopebond home: a
// second one finds the first answering and exits. Every six hours it asks the workspace which
// versions to run, and once a day it runs the end-to-end self-check.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname, release, uptime, userInfo } from "node:os";
import { join } from "node:path";
import {
  actOnBlocked, blockedQuestion, QUIET_BLOCK_DAYS, findClause, recordFatigue, hookVersion, loadPacks, readPackIndex, scrubSecrets, isSingleExecutable, isManaged, loadConnection, localActivity, MANAGED_DOC_FILE, endAllowance, noteUnresolvableHooks, readBlocked, readMeta, ruleSummary, ruleName, ruleTitle,
  automaticHarnesses, checkConfigPath, dedupeHooks, duplicateHooks, refreshIfDue, readDeliveryState, writeDeliveryState, userHarnessFile, writeHarnessConfig, type ExplainPolicy, type Harness, type RecentBlockRecord,
} from "@scopebond/hook";
import { ensurePrivateDir } from "@scopebond/gateway/node";
import { computerStatus, expectedHarnesses, missingHookEntries, runCycle, type CycleResult } from "./agent.js";
import { agentCliPath } from "./self.js";
import {
  clearUpdatePending, fetchVerifiedInstaller, installAfterExit, installerUnchanged, installKind, nativeTrayPath, readUpdatePending, removeOldHelpers, takeInstallResult, UPDATE_PENDING_MS,
  writeUpdatePending, type InstallKind,
} from "./native-update.js";
import { maintainEngine } from "./engine-update.js";
import { maintainIntel } from "./intel-install.js";
import { AGENT_LOG_ENV, autostartHealth, launcherIsCurrent, launcherPath, refreshLauncher, retireLauncherRunValue, startCommands } from "./autostart.js";
import { callAgent, startControl } from "./ipc.js";
import { runSelfCheck } from "./selfcheck.js";
import { integrationHealth } from "./integration-health.js";
import { startDiscoveryLoop } from "./discovery-loop.js";
import { createInventoryReporter } from "./inventory.js";
import { createHookActivityTracker } from "./hook-activity.js";
import { HOOK_ACTIVITY_ROUTE } from "@scopebond/hook";
import { flushReasons, queueReason } from "./override-reasons.js";
import { parseQuestion, serialized, systemPrompter, type Prompter } from "./prompt.js";
import { livePrompt, windowAllowed } from "./live-prompt.js";
import { healthOf, type HealthLevel } from "./health.js";
import { notifyChange, startTray } from "./tray.js";
import { sendAllowancesAndRequests } from "./allowance-sender.js";
import { allowedList, askedList, blockStates } from "./allowed-asked.js";
import { BLOCK_FEEDBACK_CAPABILITY, blockFeedbackFor, queueBlockFeedback, sendBlockFeedback } from "./block-feedback.js";
import { blockOutcome } from "./block-outcome.js";
import { checkResult, projectName, RECENT_BLOCKS_MAX, RULES_STALE_MS, supportBundle, toolName, trayModel, whyOf, type RecentBlock, type TrayModel } from "./tray-model.js";
import { fetchComputerSummary, openInBrowser, sameOrigin, type ComputerSummary } from "./summary.js";
import { startReconnect, type ReconnectStart } from "./reconnect.js";
import { connectWithInstallKey, FIRST_SIGNIN_FILE, installedKey, installedWorkspace, startFirstSignIn, type FirstSignIn, type RegistryReader } from "./signin.js";
import { migrateFromNpm, readMigration, npmRemovalCommand } from "./migrate.js";
import { hasMacUpdater, macAutoUpdate, MAC_UPDATER_PATHS, requestMacUpdate, takeMacUpdateResult, type MacUpdaterPaths } from "./mac-update.js";
import { enableAutostart } from "./autostart.js";
import {
  agentVersion, clearFailedUpdate, failedUpdate, fetchClientVersion, installAgent, maintainHookEntries, maintainedHookCommand, recentlyFailedUpdate, recordFailedUpdate, startCheck,
  updateTarget, type ClientVersion,
} from "./update.js";
import { runUpkeepApart, type UpkeepReport } from "./upkeep.js";
import { awakeSinceAtStart, readAwake, writeAwake } from "./awake.js";
import { noteRunningVersion, recentUpdate } from "./version-seen.js";
import { withoutNodeInjection } from "./child-env.js";

export const AGENT_VERSION = `agent/${agentVersion()}`;
const INTERVAL_MS = 60_000;
const MAX_BACKOFF_MS = 15 * 60_000;
const MIN_MS = 60_000;
/** A credential that ends within a week (the self-check's line) and that the rules check has not renewed: the agent asks the
 *  workspace itself, at most once an hour, to learn whether it renews or refuses. */
const CREDENTIAL_LAPSING_MS = 7 * 24 * 60 * 60 * 1000;
const CREDENTIAL_RETRY_MS = 60 * 60 * 1000;
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
/** The person's tray settings: one switch, "Tell me when something is blocked". "blocks": on (the default); "off". The
 *  older "problems" (problems only, the default before, which nobody chose) and "all" are read as on. Alerts the person must
 *  act on (protection off, sign in again) are not a setting: the tray shows them either way. */
const TRAY_SETTINGS_FILE = "agent-settings.json";
type NotificationSetting = "blocks" | "off";
export interface TraySettings { notifications: NotificationSetting }

const notificationSetting = (value: unknown): NotificationSetting | null =>
  value === "blocks" || value === "all" || value === "problems" ? "blocks" : value === "off" ? "off" : null;

export function readTraySettings(dir: string): TraySettings {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, TRAY_SETTINGS_FILE), "utf8")) as Partial<Record<keyof TraySettings, unknown>>;
    return { notifications: notificationSetting(parsed.notifications) ?? "blocks" };
  } catch { return { notifications: "blocks" }; }
}

export function writeTraySettings(dir: string, patch: unknown): TraySettings {
  const next = readTraySettings(dir);
  const value = notificationSetting((patch as { notifications?: unknown } | null)?.notifications);
  if (value) next.notifications = value;
  writeFileSync(join(dir, TRAY_SETTINGS_FILE), JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  return next;
}

/** On an agent's first start in a Scopebond folder, notifications are written on (a new install, or an older one whose
 *  person never chose). Written once; the person's choice is never changed. */
export function settleTraySettings(dir: string): void {
  if (existsSync(join(dir, TRAY_SETTINGS_FILE))) return;
  try { writeTraySettings(dir, { notifications: "blocks" }); } catch { /* read as on */ }
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
  /** Whether the Scopebond window may open for the hook's question when no tray listens (default: `windowAllowed()`, off on
   *  Windows unless SCOPEBOND_PROMPT_WINDOW=1). */
  promptWindow?: boolean;
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
  /** Whether an install for this user updates itself with the signed installer (default: on Windows only; on macOS a new
   *  package updates it, so it never takes the Windows installer's path). */
  nativeUpdates?: boolean;
  /** The macOS package's updater (mac-update.ts), for an install for every user that has it (default: found out; null:
   *  none; tests name their own folders). */
  macUpdater?: MacUpdaterPaths | null;
  /** A signed install that was never connected starts its first sign-in by itself, once (default: on for a signed
   *  install, off from npm). */
  autoSignIn?: boolean;
  /** The first sign-in's workspace setting and side effects (tests replace them). */
  signIn?: { registry?: RegistryReader; open?: (url: string) => void; autostart?: () => string };
  /** A signed install takes over from an npm install of the agent before it starts (default on; tests turn it off). */
  migrate?: boolean;
  /** The agent puts a lost hook entry back, takes a second copy out and starts broken autostart again as soon as it sees them
   *  (default: on with maintenance; a test turns it on with a temp home). The person's Repair works either way. */
  selfRepair?: boolean;
  /** Continuous inventory; off in fixtures that have not supplied an isolated profile. */
  discovery?: boolean;
  /** This computer's autostart, for that repair (tests replace it). */
  autostart?: AutostartRepair;
}

/** Whether autostart is on and works, and how to turn it on again. */
export interface AutostartRepair { health: () => { on: boolean; ok: boolean; detail: string }; enable: () => string }

/** What one repair of this computer's setup did, checked again afterwards. `failed`: the coding agents still without a
 *  Scopebond hook (shown to the person); `duplicates`: those still running it more than once (an enabled plugin, which only
 *  the person can turn off; reported by the self-check). `autostart`: repaired, failed, or null when it needed nothing (or
 *  the person turned it off). */
export interface SetupRepair { at: number; repaired: Harness[]; deduped: Harness[]; failed: Harness[]; duplicates: Harness[]; autostart: "repaired" | "failed" | null }

/** Repair this computer's setup at once: the hook entry put back where a coding agent's settings lost it, a second copy of it
 *  taken out (the user settings keep theirs), and autostart that is on but broken started again (autostart the person turned
 *  off stays off). Each step is checked again afterwards. */
export function repairSetup(harnesses: Harness[] = expectedHarnesses(), autostart: AutostartRepair | null = null, now = Date.now(), dir?: string): SetupRepair {
  harnesses = automaticHarnesses(harnesses, dir);
  const home = homedir();
  const repaired = repairHookEntries(missingHookEntries(harnesses, dir), dir).map((r) => r.harness);
  const deduped: Harness[] = [];
  for (const harness of harnesses) {
    try {
      checkConfigPath(userHarnessFile(harness));
      if (!duplicateHooks(harness, home, home)) continue;
      if (dedupeHooks(harness, "user", home, home).removed.length) deduped.push(harness);
    } catch (error) {
      process.stderr.write(`Scopebond Agent: could not take the second Scopebond hook out for ${harness}: ${(error as Error).message}\n`);
    }
  }
  let fixedAutostart: SetupRepair["autostart"] = null;
  if (autostart) {
    try {
      const before = autostart.health();
      if (before.on && !before.ok) { autostart.enable(); fixedAutostart = autostart.health().ok ? "repaired" : "failed"; }
    } catch { fixedAutostart = "failed"; }
  }
  const failed = missingHookEntries(harnesses, dir);
  const duplicates = harnesses.filter((h) => { try { return duplicateHooks(h, home, home) !== null; } catch { return false; } });
  return { at: now, repaired: repaired.filter((h) => !failed.includes(h)), deduped, failed, duplicates, autostart: fixedAutostart };
}

/** The self-check items a setup repair can fix. */
const SETUP_CHECKS = new Set(["hook_entry", "hook_duplicates", "autostart"]);

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
export function repairHookEntries(harnesses: Harness[] = expectedHarnesses(), dir?: string): Array<{ harness: Harness; file: string }> {
  const repaired: Array<{ harness: Harness; file: string }> = [];
  for (const harness of missingHookEntries(harnesses, dir)) {
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
    } else { clearFailedUpdate(dir); log(`the Scopebond Agent ${installed.version} was installed`); }
    return;
  }
  if (!pending) return;
  // Installed, and its result already read by an earlier start of this version.
  if (pending.version === running) { clearUpdatePending(dir); clearFailedUpdate(dir); return; }
  // Still under way (the helper waits for the old agent and runs msiexec), unless it has been far too long.
  if (now >= pending.at && now - pending.at < UPDATE_PENDING_MS) return;
  clearUpdatePending(dir);
  recordFailedUpdate(dir, pending.version, now, "the update helper did not finish");
  log(`the update to ${pending.version} did not finish: its helper never reported back`);
}

export async function startService(options: ServiceOptions): Promise<Service> {
  const log = options.log ?? ((line: string) => console.log(`${new Date().toISOString()} ${line}`));
  const kind = options.installKind ?? installKind();
  const nativeUpdates = options.nativeUpdates ?? process.platform === "win32";
  const macUpdater = options.macUpdater !== undefined ? options.macUpdater : kind === "per-machine" && hasMacUpdater() ? MAC_UPDATER_PATHS : null;
  const nativeTray = process.platform === "win32" ? nativeTrayPath() : null;
  // The signed install takes over from an npm install of the agent first: the npm agent is stopped and its sign-in entry
  // retired before this one looks for a running agent or takes the lock, so the npm one never keeps it from starting.
  if (kind !== "npm" && options.migrate !== false && (process.platform === "win32" || process.platform === "darwin")) await migrateFromNpm(options.dir, kind, nativeTray, log);
  if (await callAgent(options.dir, "GET", "/status", undefined, 2_000)) throw new Error("a Scopebond Agent is already running for this computer");
  // Two agents started within moments of each other (a slow first start, then a second start) both see
  // nobody answering yet: the lock file decides, so the second exits instead of orphaning the first.
  const lock = acquireAgentLock(options.dir);
  if (!lock) throw new Error("a Scopebond Agent is already running for this computer");
  // Everything the agent and the hook keep in the folder: readable by this user alone (made so once, on the first start).
  const unprotected = ensurePrivateDir(options.dir);
  if (unprotected) log(`the folder ${options.dir} could not be made readable by this user alone: ${unprotected}`);
  rmSync(join(options.dir, STOPPED_FILE), { force: true });
  // What the install helper of a signed update recorded before this start (installAfterExit), or the macOS package's
  // updater for the version this agent asked for.
  if (macUpdater) takeMacUpdateResult(options.dir, macUpdater);
  noteUpdateOutcome(options.dir, log);
  // The update this start finishes, if any: the tray says "Updated to …" once.
  const updatedHere = noteRunningVersion(options.dir, agentVersion());
  // No agent has run in this folder before (it writes its wake time from its first cycle): a new install.
  settleTraySettings(options.dir);
  const interval = options.intervalMs ?? INTERVAL_MS;
  let last: CycleResult | null = null;
  let lastMaintenance: MaintenanceResult | null = null;
  // The last self-check's result: kept until another self-check runs, so a failure stays until a check passes (upkeep that
  // runs no self-check does not clear it).
  let lastSelfCheck: MaintenanceResult["selfCheck"] = null;
  let failures = 0;
  // When the last cycle that could not deliver ended; and rules checks that failed in a row.
  let failedAt = 0;
  let rulesFailures = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  let running: Promise<CycleResult> | null = null;
  let cycleStartedAt: number | null = null;
  const cycleLimit = options.cycleLimitMs ?? CYCLE_LIMIT_MS;
  let stopped = false;
  let discovery: ReturnType<typeof startDiscoveryLoop> | null = null;
  const inventory = createInventoryReporter({ dir: options.dir, connection: () => loadConnection(options.dir), fetchImpl: options.fetchImpl });
  const callbacks = createHookActivityTracker((harness) => integrationHealth([harness], Date.now(), options.dir)[0]);
  let lastSelfCheckAt = 0;
  // Repairs of this computer's setup: done as soon as they are seen (each cycle, when the tray asks, before each self-check),
  // recorded, and shown only while one fails.
  const selfRepair = options.selfRepair ?? options.maintenance !== false;
  const autostart: AutostartRepair = options.autostart ?? { health: () => autostartHealth(options.dir), enable: () => enableAutostart(options.dir, agentCliPath()) };
  let lastRepair: SetupRepair | null = null;
  // The agent's own renewal of a credential about to end: what the workspace answered, for which credential, and when.
  let renewal: { at: number; outcome: Awaited<ReturnType<typeof refreshIfDue>>; credential_id: string; expires_at: string | null } | null = null;
  /** Renew the credential silently when it ends within a week (the rules check renews it in its last 30 days; this learns why
   *  it did not). Only a refusal is the person's to act on: "Sign in again". */
  const renewCredential = async (): Promise<void> => {
    const connection = loadConnection(options.dir);
    const expires = Date.parse(connection?.expires_at ?? "");
    if (!connection || !Number.isFinite(expires) || expires - Date.now() > CREDENTIAL_LAPSING_MS) { renewal = null; return; }
    if (renewal && renewal.credential_id === connection.credential_id && Date.now() - renewal.at < CREDENTIAL_RETRY_MS) return;
    const outcome = await refreshIfDue(options.dir, connection, { fetchImpl: options.fetchImpl });
    renewal = { at: Date.now(), outcome, credential_id: connection.credential_id, expires_at: connection.expires_at ?? null };
    if (outcome === "renewed") { renewal = null; log("renewed this computer's connection to the workspace"); }
    else log(outcome === "refused" ? "the workspace refused to renew this computer's connection: the person must sign in again"
      : `this computer's connection ends ${connection.expires_at}; renewing it did not work now (${outcome}), tried again in an hour`);
  };
  /** `thorough`: autostart too (a registry read on Windows), as before a self-check; `asked`: the person's Repair. A look
   *  reads a few small settings files and writes only what is broken. */
  const heal = (thorough = false, asked = false): SetupRepair | null => {
    const at = Date.now();
    if (!asked && !selfRepair) return lastRepair;
    let done: SetupRepair;
    try { done = repairSetup(expectedHarnesses(), thorough || asked ? autostart : null, at, options.dir); } catch (error) { log(`setup repair failed: ${(error as Error).message}`); return lastRepair; }
    const acted = done.repaired.length || done.deduped.length || done.failed.length || done.autostart;
    for (const h of done.repaired) log(`repaired: the Scopebond hook entry was missing for ${h}; put back and checked again`);
    for (const h of done.deduped) log(`repaired: the Scopebond hook ran more than once for ${h}; the second copy was taken out`);
    if (done.autostart) log(`autostart was on but broken: ${done.autostart === "repaired" ? "started again and checked" : "could not be repaired"}`);
    if (done.failed.length && !(lastRepair?.failed.length)) log(`could not put the Scopebond hook back for ${done.failed.join(", ")}`);
    // Kept while it says something: the last repair made, or one that failed until it no longer does.
    if (acted || asked || lastRepair?.failed.length) lastRepair = done;
    return done;
  };
  /** The end-to-end self-check, after a repair of anything it would find broken; when it still finds a setup problem, that
   *  is repaired and the check runs once more. */
  const selfCheck = async (connection: NonNullable<ReturnType<typeof loadConnection>>): Promise<MaintenanceResult["selfCheck"]> => {
    heal(true);
    try { await renewCredential(); } catch { /* the check says so */ }
    connection = loadConnection(options.dir) ?? connection;
    const run = () => runSelfCheck(options.dir, connection, expectedHarnesses(), agentVersion(), { fetchImpl: options.fetchImpl });
    const first = await run();
    if (!selfRepair || !first || first.ok || !first.checks.some((c) => !c.ok && SETUP_CHECKS.has(c.id))) return first;
    const fixed = heal(true);
    if (!fixed || !(fixed.repaired.length || fixed.deduped.length || fixed.autostart === "repaired")) return first;
    log("self-check: repaired what it found and checked again");
    return run();
  };
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

  // The Scopebond window, one at a time; and the hook's questions, asked only in the tray when one is listening, else in the
  // window where it may open, else no one now (the hook's denial points at this computer's page, when connected).
  const windowPrompt = serialized(options.prompter ?? systemPrompter);
  const live = livePrompt({
    fallback: windowPrompt, window: () => options.promptWindow ?? windowAllowed(),
    link: () => { const connection = loadConnection(options.dir); const url = summary?.computer_url; return connection && url && sameOrigin(url, connection.url) ? url : null; },
  });
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
    // "This shouldn't be blocked" marks, to a workspace that takes them.
    if (summary?.capabilities.includes(BLOCK_FEEDBACK_CAPABILITY)) {
      try { const n = await sendBlockFeedback(options.dir, connection, options.fetchImpl); if (n) log(`sent ${n} "shouldn't be blocked" mark(s) to the workspace`); }
      catch { /* they wait for the next cycle */ }
    }
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
      // A hook entry a coding agent's settings lost (an update or a reset can remove it), or a second copy: put right now.
      heal();
      if (result.connected) { try { await renewCredential(); } catch { /* tried again next cycle */ } }
      try { noticeHealth(); } catch { /* status is best effort */ }
      last = result;
      failures = result.deliveryError ? failures + 1 : 0;
      rulesFailures = result.rules === "unavailable" || result.rules === "refused" ? rulesFailures + 1 : result.rules === "skipped" ? rulesFailures : 0;
      if (result.deliveryError) failedAt = Date.now();
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
      result.hookEntries = maintainHookEntries(harnesses, target?.policy !== "hold", process.platform, options.dir);
      for (const change of result.hookEntries) log(`${change.reason}: ${change.file}`);
      // The npm install follows the workspace's `agent`; the signed install its `native_agent` only (updateTarget).
      const newer = updateTarget(target, kind, current);
      // The macOS updater's result for an update asked for earlier (a package that did not install counts as failed).
      if (macUpdater && takeMacUpdateResult(options.dir, macUpdater)) noteUpdateOutcome(options.dir, log);
      const pending = readUpdatePending(options.dir);
      if (newer && kind === "per-machine" && macUpdater) {
        // The macOS package, for every user: its root updater installs the next signed package when asked.
        if (!macAutoUpdate()) log(`the workspace recommends the Scopebond Agent ${newer}; updates are turned off for this Mac (AutoUpdate), so it is updated by your organization`);
        else if (recentlyFailedUpdate(options.dir, newer)) log(`the Scopebond Agent ${newer} did not install or start here earlier; staying on ${current} for now`);
        else if (pending && pending.version === newer && Date.now() - pending.at < UPDATE_PENDING_MS) log(`the update to ${newer} is under way`);
        // Asked before and never reported back: recorded as a failed update, and asked again on the retry schedule.
        else if (pending && pending.version === newer) noteUpdateOutcome(options.dir, log);
        else {
          const refused = requestMacUpdate(newer, process.getuid?.() ?? -1, macUpdater);
          if (refused) log(`the update to ${newer} could not start: ${refused}`);
          else { writeUpdatePending(options.dir, newer); log(`asked the Scopebond updater to install ${current} -> ${newer} (signed package)`); }
        }
      } else if (newer && kind === "per-machine") {
        // Installed for every user: the organisation that deployed it updates it.
        log(`the workspace recommends the Scopebond Agent ${newer}; this install is updated by your organization`);
      } else if (newer && kind === "per-user" && !nativeUpdates) {
        // The signed executable on macOS: a new package updates it; the Windows installer is never fetched here.
        log(`the workspace recommends the Scopebond Agent ${newer}; install its package to update this computer`);
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
          // Tried again after 1 hour, 6 hours, then daily: a download or a release not yet complete can pass then.
          recordFailedUpdate(options.dir, newer, Date.now(), verified.ok ? "the installer changed after it was checked" : verified.reason);
          result.error = `update to ${newer} could not be verified: ${verified.ok ? "the installer changed after it was checked" : verified.reason}; nothing was installed`;
        }
        log(result.error);
      } else if (newer && kind === "npm") {
        log(`updating the Scopebond Agent ${current} -> ${newer}`);
        const installed = await installAgent(newer, { fetchImpl: options.fetchImpl });
        const started = installed.ok ? await (options.startCheck ?? startCheck)(newer) : null;
        if (installed.ok && started?.ok) {
          clearFailedUpdate(options.dir);
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
        } else {
          result.error = `update to ${newer} failed: ${installed.output.slice(-300)}`;
          recordFailedUpdate(options.dir, newer, Date.now(), installed.output.slice(-300));
        }
        log(result.error);
      }
      // Components that need no installer: a newer engine for the signed install (engine-update.ts: verified, its pack
      // vectors run, rolled back when it does not start) and the plugin component (intel-install.ts). Neither throws.
      await maintainEngine({ dir: options.dir, kind, target, fetchImpl: options.fetchImpl, log });
      await maintainIntel({ dir: options.dir, connection, target, fetchImpl: options.fetchImpl, log });
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
        result.selfCheck = await selfCheck(connection);
        lastSelfCheck = result.selfCheck;
        lastSelfCheckAt = Date.now();
        log(`self-check ${result.selfCheck?.ok ? "passed" : `failed: ${result.selfCheck?.failed.join(", ") ?? "no result"}`}`);
      }
    } catch (error) { result.error = (error as Error).message; }
    lastMaintenance = result;
    retryUpdateWhenDue();
    return result;
  };
  // A failed update is tried again when its wait is over (1 hour, 6 hours, then daily), not only at the six-hourly check.
  let updateRetryTimer: ReturnType<typeof setTimeout> | null = null;
  const retryUpdateWhenDue = () => {
    if (updateRetryTimer) { clearTimeout(updateRetryTimer); updateRetryTimer = null; }
    const failed = failedUpdate(options.dir);
    if (stopped || options.maintenance === false || !failed || (kind === "per-machine" && !macUpdater) || (kind === "per-user" && !nativeUpdates)) return;
    const wait = failed.retry_at - Date.now() + 1_000;
    updateRetryTimer = setTimeout(() => { updateRetryTimer = null; if (!stopped) void maintain(); }, Math.max(wait, 1_000));
    updateRetryTimer.unref?.();
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
    // Rules not checked for over an hour (the last-known ones stay in force): checked again at once, then after 1, 2, 4, 8
    // and at most 15 minutes, never later than the usual interval.
    const rulesRetry = rulesFailures > 0 && rulesStale() ? Math.min(interval, rulesFailures <= 1 ? 0 : Math.min(MAX_BACKOFF_MS, MIN_MS * 2 ** (rulesFailures - 2))) : null;
    const usual = failures ? Math.min(MAX_BACKOFF_MS, interval * 2 ** Math.min(failures, 6))
      : requestWaiting(options.dir, Date.now()) ? Math.min(interval, ANSWER_POLL_MS) : interval;
    const delay = rulesRetry === null ? usual : Math.min(usual, rulesRetry);
    timerWaiting = true;
    const due = Date.now() + delay;
    let lastTick = Date.now();
    // While backing off, the agent looks again every interval and starts the next cycle at once (the backoff starts over)
    // when a delivery worked elsewhere since its last failed one (a hook call reached the workspace) or the computer has just
    // woken. Sending is the agent's job: nobody has to press "Send now".
    const tick = () => {
      const at = Date.now();
      const woke = at - lastTick > allowedGapMs + interval;
      lastTick = at;
      if (failures && at < due && !woke && !deliveredSince(failedAt)) { timer = setTimeout(tick, Math.min(interval, due - at)); return; }
      timerWaiting = false;
      void cycle().finally(schedule);
    };
    timer = setTimeout(tick, failures ? Math.min(delay, interval) : delay);
  };
  /** Connected, and the last rules check that worked was over an hour ago (or none is known). Only a check that failed
   *  makes the agent try again sooner, so a computer whose check is skipped is never asked in a loop. */
  const rulesStale = (): boolean => {
    if (!loadConnection(options.dir)) return false;
    const good = lastGoodCheck(readMeta(options.dir));
    return good === null || Date.now() - good > RULES_STALE_MS;
  };
  /** A delivery that worked after `at` (any process: the hook delivers on its own too). */
  const deliveredSince = (at: number): boolean => {
    try { const success = readDeliveryState(options.dir).last_success_at; return success !== null && success > at; } catch { return false; }
  };

  // A block under a rule a person may allow or ask about can be acted on afterwards, from the tray: what the workspace offers
  // for it now (the same checks the Scopebond window makes), in plain words with the rule's name, the project and the tool.
  // Each block has one outcome (block-outcome.ts): Unblock…, Ask an admin…, or a sentence saying why it stays blocked or
  // where the person's request stands. A block a request or an allowance in force already covers offers nothing more.
  const actionable = (blocks: RecentBlockRecord[], now: number): RecentBlock[] => {
    const known = new Map(readBlocked(options.dir).map((b) => [b.id, b]));
    const states = blockStates(options.dir, now);
    const marked = blockFeedbackFor(options.dir);
    const workspace = summary?.workspace_name ?? null;
    // Why each rule exists, for a block's details: the clause's own description in this computer's policy, read once.
    let policy: ExplainPolicy | undefined;
    try { policy = JSON.parse(readFileSync(join(options.dir, "policy.json"), "utf8")) as ExplainPolicy; } catch { /* no why lines */ }
    let asked = 0;
    return blocks.map((b) => {
      const item = b.action_id ? known.get(b.action_id) : undefined;
      const rule = b.rule ?? item?.rule ?? null;
      const request = states.requestFor(b.action_id, rule, item?.action_key ?? null);
      const allowed = !request && states.allowedFor(rule, item?.action_key ?? null);
      const quiet = !request && !allowed && ((item?.acted as string | null | undefined) === "quiet" || states.quietFor(rule, item?.action_key ?? null));
      // The workspace keeps blocks like this one quiet (the hook noted it): no question, no notification, still blocked.
      const workspaceQuiet = !request && !allowed && !quiet && b.quiet === true;
      // What the workspace offers, for the newest QUESTIONS_MAX blocks not acted on (each question reads the hook's files).
      const q = item && !item.acted && b.action_id && !request && !allowed && !quiet && !workspaceQuiet && asked++ < QUESTIONS_MAX ? blockedQuestion(options.dir, b.action_id, now) : null;
      const offers = q ? {
        once: q.offers.allow, fifteen: q.offers.fifteen, hour: q.offers.hour, tomorrow: q.offers.tomorrow, quiet: true, always: q.offers.always, always_days: q.offers.always ? q.always_days : null,
        always_needs_admin: q.offers.always && q.always_needs_admin, ask: q.offers.ask, reviewed: q.reviewed,
        // "Similar commands in this project", where the hook offers it: the words and the examples the form shows.
        similar: q.similar ?? null,
      } : null;
      const what = b.what ?? b.summary;
      const ruleTitleText = ruleTitle(rule) ?? b.rule_title ?? ruleName(rule);
      const tool = toolName(b.harness ?? item?.harness ?? null);
      const outcome = blockOutcome({
        offers, clause: b.clause ?? null, rule, kind: b.kind ?? null, verdict: b.verdict ?? null, held: b.held === true, request, allowed, quiet, workspace_quiet: workspaceQuiet,
        workspace, tool, what, rule_title: ruleTitleText, action_id: b.action_id,
      });
      return {
        action_id: b.action_id, summary: b.summary, at: b.at, rule, can_act: Boolean(q), acted: (quiet || workspaceQuiet ? "quiet" : null) ?? item?.acted ?? (request ? "asked" : allowed ? "allowed" : null),
        what, action_text: item?.summary ?? b.action_text ?? b.summary, rule_title: ruleTitleText,
        project: projectName(b.repository) ?? b.project ?? null, tool,
        offers,
        reason_min: q ? q.reason_min : null,
        tries: b.tries ?? 1, first_at: b.first_at ?? b.at, group_id: b.group_id ?? b.action_id,
        feedback_sent: b.action_id ? marked.has(b.action_id) : false,
        ...outcome,
        request,
        rule_why: whyOf(findClause(policy, b.clause ?? null)?.description ?? findClause(policy, rule)?.description),
      };
    });
  };

  // The rule packs in force, for Settings: read again only when the pack index changes (each pack's signature is checked).
  let packCache: { key: string; packs: Array<{ id: string; title: string; version: string }> } | null = null;
  const packsInForce = (): Array<{ id: string; title: string; version: string }> => {
    const index = readPackIndex(options.dir);
    const key = index ? `${index.checked_at}|${index.packs.map((p) => `${p.id}@${p.version}`).join(",")}` : "";
    if (packCache?.key !== key) {
      let packs: Array<{ id: string; title: string; version: string }> = [];
      try {
        packs = index ? loadPacks(options.dir).packs.map((p) => ({ id: p.id, version: p.version, title: (typeof p.title === "string" && p.title.trim() ? p.title.trim() : p.id).slice(0, 60) })) : [];
      } catch { /* none listed */ }
      packCache = { key, packs };
    }
    return packCache.packs;
  };

  const trayState = (): TrayModel => {
    const now = Date.now();
    // Seen now, repaired now: the tray shows a setup problem only while its repair fails.
    heal();
    const status = computerStatus(options.dir);
    const meta = readMeta(options.dir);
    // Every rule in force, counted (the hook's rule summary): the older `block`/`monitor` carry the same counts.
    const counted = ruleSummary(options.dir);
    const at = (iso: string | null | undefined): number | null => (iso && Number.isFinite(Date.parse(iso)) ? Date.parse(iso) : null);
    const activity = localActivity(options.dir, { limit: RECENT_BLOCKS_MAX });
    const model = trayModel({
      status, health: health(), now, awakeSince, working,
      rules: counted ? {
        checked_at: at(meta.checked_ok_at ?? meta.checked_at), managed: isManaged(options.dir), block: counted.blocking, monitor: counted.monitoring,
        blocking: counted.blocking, monitoring: counted.monitoring, packs: counted.packs, last_attempt_at: at(meta.last_attempt_at), last_error: meta.last_error ?? null,
      } : null,
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
      packs: packsInForce(),
      rulesUpdatedAt: lastGoodCheck(meta),
      updated: recentUpdate(updatedHere, now),
      repairFailed: (lastRepair?.failed ?? []).map((h) => toolName(h) ?? h),
      selfCheck: lastSelfCheck ? { ok: lastSelfCheck.ok, failed: lastSelfCheck.failed } : null,
      signInAgain: renewal?.outcome === "refused" && renewal.credential_id === loadConnection(options.dir)?.credential_id
        ? { expires_at: renewal.expires_at && Number.isFinite(Date.parse(renewal.expires_at)) ? Date.parse(renewal.expires_at) : null } : null,
    });
    // What the person let through and asked an admin, for the tray's Allowed and Requests lists.
    return { ...model, allowed: allowedList(options.dir, now), asked: askedList(options.dir), feedback_offered: summary?.capabilities.includes(BLOCK_FEEDBACK_CAPABILITY) ?? false };
  };
  /** What this install can update to, for the tray: from npm, the workspace's agent and hook (as its rules check said);
   *  the signed install, only the signed build the workspace names (the hook is inside it); for every user, nothing. */
  const offeredVersions = (): { recommendedAgent: string | null; recommendedHook: string | null } => {
    if (kind === "per-machine" || (kind === "per-user" && !nativeUpdates)) return { recommendedAgent: null, recommendedHook: null };
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
    // tray last saw), says when the person opened it, and sends the person's answer, which
    // the hook's waiting call receives. Checked as the window's answer would be; only the person at the computer sees the
    // tray's panel.
    "POST /override/wait": async (body) => {
      const seen = typeof (body as { seen?: unknown } | null)?.seen === "string" ? String((body as { seen: string }).seen) : null;
      return { question: await live.wait(seen, 20_000) };
    },
    // The tray says it showed a notification: counted for the workspace's view of how often people are interrupted (fatigue.ts).
    "POST /fatigue": (body) => {
      const kind = (body as { kind?: unknown } | null)?.kind;
      if (kind !== "toast") return { counted: false };
      return { counted: recordFatigue(options.dir, "toast") !== null };
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
      const outcome = done.choice === "ask" ? "asked" as const : done.choice === "quiet" ? "quiet" as const
        : done.choice === "always" && waiting?.offers.always_needs_admin ? "proposed" as const : "allowed" as const;
      log(`question under "${waiting?.rule_title ?? "a rule"}", answered in the tray: ${outcome} (${done.choice})`);
      if (outcome === "asked") pollAnswers();
      return { outcome, choice: done.choice, text: answerText(outcome, done.choice, done.always_days, summary?.workspace_name ?? null, !!loadConnection(options.dir), done.reviewed, Date.now(), waiting?.action_text || waiting?.what || null) };
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
      let checked: MaintenanceResult["selfCheck"] = null;
      if (connection) {
        try {
          checked = await selfCheck(connection);
          lastSelfCheck = checked;
          lastSelfCheckAt = Date.now();
        } catch (e) { error = error ?? (e as Error).message; }
      }
      return { text: checkResult(checked, error), tray: trayState() };
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
      // The window offers "keep blocking" (quiet) and the newer lengths only where the hook's question does, so the hook
      // takes every answer it can return.
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
      // Keeping it blocked is always offered for a block a person may act on, and needs no reason.
      const offered = parsed.choice === "once" ? q.offers.allow : parsed.choice === "fifteen" ? q.offers.fifteen : parsed.choice === "always" ? q.offers.always
        : parsed.choice === "hour" ? q.offers.hour : parsed.choice === "tomorrow" ? q.offers.tomorrow : parsed.choice === "quiet" ? true : q.offers.ask;
      if (!offered) return { outcome: "not_offered", text: "Your workspace does not offer that choice for this block now." };
      // "Similar commands in this project": only where the hook offers it for this block now.
      if (parsed.scope === "similar" && !q.similar) return { outcome: "not_offered", text: "Your workspace does not offer similar commands for this block now." };
      if (parsed.choice !== "quiet" && parsed.reason.length < q.reason_min) return { outcome: "reason_short", text: `Say why in at least ${q.reason_min} characters.` };
      let os_user: string | undefined;
      try { os_user = userInfo().username; } catch { /* not known: the hook uses its own */ }
      const lasts = LASTS_OF_CHOICE[parsed.choice] ?? "once";
      const answer = parsed.choice === "ask" ? { decision: "ask" as const, reason: parsed.reason, ...(os_user ? { os_user } : {}) }
        : parsed.choice === "quiet" ? { decision: "quiet" as const, ...(os_user ? { os_user } : {}) }
        : { decision: "allow" as const, reason: parsed.reason, lasts, ...(os_user ? { os_user } : {}), ...(parsed.scope === "similar" ? { scope: "similar" as const } : {}) };
      const done = actOnBlocked(options.dir, parsed.action_id, answer);
      if (done.outcome === "allowed" || done.outcome === "proposed" || done.outcome === "asked" || done.outcome === "quiet") setTimeout(() => { void sendReasons(); }, 1_000);
      if (done.outcome === "asked") pollAnswers();
      log(`earlier block under "${q.title}", answered in the tray: ${done.outcome} (${parsed.choice}${parsed.scope === "similar" ? ", similar" : ""})`);
      // The result line says what was allowed: the command, or the similar commands in words.
      const what = parsed.scope === "similar" && q.similar ? q.similar.words.charAt(0).toLowerCase() + q.similar.words.slice(1) : q.item.summary || null;
      return { outcome: done.outcome, choice: parsed.choice, ...(parsed.scope === "similar" ? { scope: "similar" } : {}),
        text: answerText(done.outcome, parsed.choice, q.always_days, summary?.workspace_name ?? null, !!loadConnection(options.dir), q.reviewed, Date.now(), what) };
    },
    // "Get help…": a support report the tray copies for the person (tray-model.ts supportBundle: no keys, records, commands
    // or reasons; failures in the log with the folders and anything token-shaped masked).
    "GET /support": () => {
      let os = process.platform as string;
      try { os = `${process.platform} ${release()}`; } catch { /* the platform alone */ }
      return { bundle: supportBundle({
        now: Date.now(), model: trayState(), status: computerStatus(options.dir),
        versions: { scopebond: agentVersion(), agent: agentVersion(), hook: hookVersion(), install_kind: kind, platform: process.platform, os, node: process.version },
        settings: readTraySettings(options.dir), selfCheck: lastSelfCheck ? { ok: lastSelfCheck.ok, failed: lastSelfCheck.failed } : null,
        maintenanceError: lastMaintenance?.error ?? null, failedUpdate: failedUpdate(options.dir),
        logLines: logTail(join(options.dir, "agent.log")), home: options.dir, userHome: homedir(),
      }, scrubSecrets) };
    },
    // What the person let through (in force, or waiting for an admin) and what they asked an admin, with the answers.
    "GET /allowances": () => ({ allowances: allowedList(options.dir) }),
    "GET /requests": () => ({ requests: askedList(options.dir) }),
    // "Stop allowing": the person ends an allowance they made here. It stops applying at once, and the ended record goes to
    // the workspace, signed by this computer's key.
    // "This shouldn't be blocked": the person's mark on a block, kept here and sent to a workspace that takes it. Only a block
    // this computer recorded can be marked, once.
    "POST /blocked/feedback": (body) => {
      const id = typeof (body as { action_id?: unknown } | null)?.action_id === "string" ? String((body as { action_id: string }).action_id) : "";
      // A block a person could act on has its action's key; any other block of the week is named by its record, and its key is
      // a digest of the record's id (the workspace finds the block by the record).
      const item = id ? readBlocked(options.dir).find((b) => b.id === id) : undefined;
      const listed = item ? undefined : localActivity(options.dir, { limit: RECENT_BLOCKS_MAX })?.recent_blocks.find((b) => b.action_id === id);
      const rule = item?.rule ?? listed?.rule ?? listed?.clause ?? null;
      if (!id || !rule) return { outcome: "gone", text: "This block is no longer on this computer." };
      const actionKey = item?.action_key ?? createHash("sha256").update(`record:${id}`).digest("hex");
      const added = queueBlockFeedback(options.dir, { action_id: id, rule, action_key: actionKey, harness: item?.harness ?? listed?.harness ?? null });
      if (added) setTimeout(() => { void sendReasons(); }, 1_000);
      return { outcome: added ? "noted" : "already", text: "Noted: your workspace's admins see that this shouldn't have been blocked" };
    },
    "POST /allowances/stop": (body) => {
      const id = typeof (body as { id?: unknown } | null)?.id === "string" ? String((body as { id: string }).id) : "";
      const item = allowedList(options.dir).find((a) => a.id === id && a.by === "person");
      if (!item) return { outcome: "gone", text: "This allowance has already ended." };
      if (endAllowance(options.dir, id).outcome !== "ended") return { outcome: "gone", text: "This allowance has already ended." };
      setTimeout(() => { void sendReasons(); }, 1_000);
      const what = item.what ?? item.rule_title ?? "it";
      const connected = !!loadConnection(options.dir);
      const where = connected ? ` · Recorded and sent to ${summary?.workspace_name ?? "your workspace"}` : " on this computer";
      if (item.kind === "quiet") {
        log(`no longer keeping an action under "${item.rule_title ?? item.rule}" blocked without asking, from the tray`);
        return { outcome: "stopped", text: `You'll be asked about ${what} again${where}` };
      }
      log(`stopped allowing an action under "${item.rule_title ?? item.rule}", from the tray`);
      return { outcome: "stopped", text: `Stopped allowing ${what}${where}` };
    },
    // install_kind: a signed agent starting beside an older npm one tells them apart by it (migrate.ts).
    [`POST ${HOOK_ACTIVITY_ROUTE}`]: (body) => callbacks.accept(body),
    "GET /status": () => ({ ...computerStatus(options.dir), integrations: integrationHealth(expectedHarnesses(), Date.now(), options.dir).map((health) => callbacks.apply(health)), inventory: inventory.state(), health: health(), agent: {
      pid: process.pid, version: AGENT_VERSION, install_kind: kind, last_cycle: last, cycle_started_at: cycleStartedAt, last_maintenance: lastMaintenance,
      failed_update: failedUpdate(options.dir), signing_in: reconnecting, last_repair: lastRepair, credential_renewal: renewal,
    } }),
    "POST /flush": async () => ({ cycle: await cycle() }),
    // The person's Repair: the same repair the agent makes by itself, whatever its setting, with what it did and what failed.
    "POST /repair": () => heal(true, true) ?? { repaired: [], deduped: [], failed: [], duplicates: [], autostart: null },
    "POST /maintain": async () => ({ maintenance: await maintain(true) }),
    "POST /rescan": () => { discovery?.rescan(); return { scheduled: discovery !== null }; },
    // `scopebond-agent stop` and `autostart off`: answer first, then stop, so the caller hears back.
    "POST /stop": () => {
      log("stopping: asked to by this computer's user");
      try { writeFileSync(join(options.dir, STOPPED_FILE), `${JSON.stringify({ stopped_at: new Date().toISOString(), pid: process.pid })}\n`); } catch { /* the tray may start it again */ }
      setTimeout(() => { void stop().finally(() => options.onStopped?.()); }, 50);
      return { stopping: true };
    },
    // Warn mode: the hook asks; only the person answers (the tray's form or the window). The caller learns the answer, never
    // decides it.
    "POST /override": async (body) => {
      const question = parseQuestion(body);
      if (!question) return { decision: "unavailable" };
      log(`asking whether to allow "${question.title}"`);
      const answer = await prompt(question);
      // A person was asked (not "later", not unavailable): one prompt today.
      if (answer.decision !== "unavailable" && !answer.later) recordFatigue(options.dir, "prompt");
      log(`override ${answer.decision === "allow" ? "given" : answer.decision === "deny" ? "not given" : answer.later ? "not asked (no tray listening, no window): the person acts on it later" : "not available"} for "${question.title}"`);
      if (answer.decision === "allow" && answer.reason) { queueReason(options.dir, question.action_id, answer.reason); setTimeout(() => { void sendReasons(); }, 1_000); }
      // The hook writes the request or allowance after this answer; send it shortly after.
      if (answer.decision === "ask" || answer.decision === "quiet" || answer.lasts === "always" || answer.lasts === "15m") setTimeout(() => { void sendReasons(); }, 2_000);
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
    discovery?.stop();
    inventory.stop();
    if (updateRetryTimer) clearTimeout(updateRetryTimer);
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
  if (options.discovery ?? options.maintenance !== false) discovery = startDiscoveryLoop({ reconcile: async () => { if (!stopped) { heal(); await inventory.reconcile(); } } });
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

/** The last lines of a log file (its last 128 KB), oldest first; none when it cannot be read. */
export function logTail(file: string, bytes = 128 * 1024): string[] {
  let fd: number | null = null;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split(/\r?\n/).filter((l) => l.trim());
    // The first line may start mid-way when the file was cut.
    return size > length ? lines.slice(1) : lines;
  } catch { return []; } finally { if (fd !== null) try { closeSync(fd); } catch { /* closed */ } }
}

/** When the workspace's rules were last checked successfully, for the tray: the time the rules check records for its last
 *  success when it records one, else its last check when that one did not fail, else unknown (never a failed check's time). */
export function lastGoodCheck(meta: object): number | null {
  const m = meta as Record<string, unknown>;
  const at = (v: unknown): number | null => { const t = typeof v === "string" ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; };
  for (const field of ["checked_ok_at", "last_success_at", "succeeded_at", "rules_ok_at"]) {
    const t = at(m[field]);
    if (t !== null) return t;
  }
  return m.last_error ? null : at(m.checked_at);
}

/** What a newer hook offers besides once, 15 minutes, always and ask: 1 hour and until tomorrow, and keeping the block
 *  without being asked again. A hook that knows the new lengths keeps a block quietly as well (one release), so "Keep
 *  blocking without asking me" is offered only by such a hook; an older one hears nothing it cannot answer. */
export function newerOffers(offers: object): { hour: boolean; tomorrow: boolean; quiet: boolean } {
  const o = offers as Record<string, unknown>;
  const lengths = typeof o.hour === "boolean" || typeof o.tomorrow === "boolean";
  return { hour: o.hour === true, tomorrow: o.tomorrow === true, quiet: o.quiet === true || (lengths && o.quiet !== false) };
}

/** What the tray says after a person acted on an earlier block. */
function blockedText(outcome: "allowed" | "proposed" | "asked" | "quiet" | "declined" | "gone"): string {
  switch (outcome) {
    case "allowed": return "Allowed. Run it again, or let the coding agent retry.";
    case "proposed": return "Allowed for 15 minutes. Your workspace's admins decide whether it stands; run it again meanwhile.";
    case "asked": return "Request sent to your workspace's admins. Scopebond shows the answer; then run it again.";
    case "quiet": return `Kept blocked for ${QUIET_BLOCK_DAYS} days. You won't be asked about it again.`;
    case "declined": return "Nothing was allowed.";
    case "gone": return "This block can no longer be allowed or sent to an admin from here.";
  }
}

/** hour: for an hour; tomorrow: until tomorrow (24 hours); quiet: keep it blocked without asking again (a quiet block). */
export type BlockedChoice = "once" | "fifteen" | "hour" | "tomorrow" | "always" | "ask" | "quiet";
/** The length the hook is told for each choice that allows. */
export const LASTS_OF_CHOICE: Readonly<Partial<Record<BlockedChoice, "once" | "15m" | "1h" | "tomorrow" | "always">>> = {
  once: "once", fifteen: "15m", hour: "1h", tomorrow: "tomorrow", always: "always",
};
const CHOICES: readonly string[] = ["once", "fifteen", "hour", "tomorrow", "always", "ask", "quiet"];

/** Check an answer from the tray's form: an action id, one of the choices, and a reason of at most 500 characters
 *  (control characters other than line breaks are refused; none is an empty one, enough where the workspace asks for none),
 *  and what it covers (`scope`: "exact", the default, or "similar" for "Similar commands in this project", only with a length
 *  longer than once). The rest (offered, long enough) is checked against the block. */
export function parseBlockedAnswer(raw: unknown): { action_id: string; choice: BlockedChoice; reason: string; scope?: "similar" } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.action_id !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/.test(r.action_id)) return null;
  if (typeof r.choice !== "string" || !CHOICES.includes(r.choice)) return null;
  if (r.reason !== undefined && typeof r.reason !== "string") return null;
  const reason = (r.reason ?? "").trim();
  if (reason.length > 500 || [...reason].some((c) => { const n = c.charCodeAt(0); return (n < 32 && n !== 10 && n !== 13) || n === 127; })) return null;
  if (r.scope !== undefined && r.scope !== "exact" && r.scope !== "similar") return null;
  // Similar commands are allowed for a length; the next try alone, asking an admin and keeping it blocked are about this action.
  if (r.scope === "similar" && (r.choice === "ask" || r.choice === "quiet" || r.choice === "once")) return null;
  return { action_id: r.action_id, choice: r.choice as BlockedChoice, reason, ...(r.scope === "similar" ? { scope: "similar" as const } : {}) };
}

/** A choice in the tray's form: the lengths (once, 15 minutes for older terms, 1 hour, until tomorrow, 30 days or the
 *  workspace's "always" length), asking an admin, or keeping it blocked without being asked. */
export type AnswerChoice = BlockedChoice | "hour" | "tomorrow" | "quiet";

/** What the tray says after a person answered a block in its form, in one line: the result, the command as the form showed
 *  it (when known), and where it was recorded ("Allowed for 1 hour: rm -rf ./dist · recorded in Acme"). Never "always". */
export function answerText(outcome: "allowed" | "proposed" | "asked" | "declined" | "gone" | "quiet", choice: AnswerChoice, alwaysDays: number, workspace: string | null,
  connected: boolean, reviewed = false, now = Date.now(), command: string | null = null): string {
  if (outcome === "gone") return blockedText("gone");
  if (outcome === "declined") return blockedText("declined");
  const on = command ? `: ${command.length > 120 ? `${command.slice(0, 119)}…` : command}` : "";
  const days = `${alwaysDays} day${alwaysDays === 1 ? "" : "s"}`;
  if (outcome === "quiet" || choice === "quiet") return `Kept blocked without asking you${on} · undo it under Allowed`;
  // A request: where the answer will show (it is recorded and sent like everything else).
  if (outcome === "asked") return connected ? `Request sent${on} · the answer shows on the block` : `Request saved${on}, sent once this computer is connected · the answer shows on the block`;
  const time = (ms: number) => new Date(now + ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  // Applied at once, reviewed by an admin later: when it ends, and that it will be reviewed.
  if (reviewed && outcome === "allowed") {
    const until = choice === "once" ? "for the next try"
      : choice === "fifteen" ? `until ${time(15 * 60_000)}`
      : choice === "hour" ? `until ${time(60 * 60_000)}`
      : choice === "tomorrow" ? `until tomorrow ${time(24 * 60 * 60_000)}`
      : `until ${new Date(now + alwaysDays * 86_400_000).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
    return `Unblocked ${until}${on} · an admin will review it`;
  }
  const what = outcome === "proposed" ? `Allowed for 15 minutes while an admin decides on ${days}`
    : choice === "fifteen" ? "Allowed for 15 minutes"
    : choice === "hour" ? "Allowed for 1 hour"
    : choice === "tomorrow" ? "Allowed until tomorrow"
    : choice === "always" ? `Allowed for ${days}`
    : "Allowed once";
  const where = connected ? `recorded in ${workspace ?? "your workspace"}` : "recorded on this computer";
  return `${what}${on} · ${where}`;
}
