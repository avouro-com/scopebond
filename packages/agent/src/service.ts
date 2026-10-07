// The resident loop: one cycle now, then one every interval, sooner after a change is asked for,
// backing off while the workspace is unreachable. Exactly one agent serves a Scopebond home: a
// second one finds the first answering and exits. Every six hours it asks the workspace which
// versions to run, and once a day it runs the end-to-end self-check.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hookVersion, isManaged, loadConnection, localActivity, readMeta, ruleReport, userHarnessFile, writeHarnessConfig, type Harness } from "@scopebond/hook";
import { computerStatus, expectedHarnesses, missingHookEntries, runCycle, type CycleResult } from "./agent.js";
import { launcherPath } from "./autostart.js";
import { callAgent, startControl } from "./ipc.js";
import { runSelfCheck } from "./selfcheck.js";
import { flushReasons, queueReason } from "./override-reasons.js";
import { parseQuestion, serialized, systemPrompter, type Prompter } from "./prompt.js";
import { healthOf, type HealthLevel } from "./health.js";
import { notifyChange, startTray } from "./tray.js";
import { sendAllowancesAndRequests } from "./allowance-sender.js";
import { checkResult, trayModel, type TrayModel } from "./tray-model.js";
import { fetchComputerSummary, openInBrowser, sameOrigin, type ComputerSummary } from "./summary.js";
import { startReconnect, type ReconnectStart } from "./reconnect.js";
import { agentVersion, compareVersions, fetchClientVersion, installAgent, maintainHookEntries, maintainedHookCommand } from "./update.js";

export const AGENT_VERSION = `agent/${agentVersion()}`;
const INTERVAL_MS = 60_000;
const MAX_BACKOFF_MS = 15 * 60_000;
const UPDATE_EVERY_MS = 6 * 60 * 60 * 1000;
const SELF_CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
const SUMMARY_EVERY_MS = 5 * 60 * 1000;
export const AFTER_PID_ENV = "SCOPEBOND_AGENT_AFTER_PID";
/** The person's tray settings (D143: notifications about problems by default, none about blocks). */
export const TRAY_SETTINGS_FILE = "agent-settings.json";
export type NotificationSetting = "all" | "problems" | "off";
export interface TraySettings { notifications: NotificationSetting }

export function readTraySettings(dir: string): TraySettings {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, TRAY_SETTINGS_FILE), "utf8")) as Partial<TraySettings>;
    return { notifications: parsed.notifications === "all" || parsed.notifications === "off" ? parsed.notifications : "problems" };
  } catch { return { notifications: "problems" }; }
}

export function writeTraySettings(dir: string, patch: unknown): TraySettings {
  const next = readTraySettings(dir);
  const value = (patch as { notifications?: unknown } | null)?.notifications;
  if (value === "all" || value === "problems" || value === "off") next.notifications = value;
  writeFileSync(join(dir, TRAY_SETTINGS_FILE), JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  return next;
}

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
  // SB388: time asleep never counts as records waiting. A gap between cycles longer than the schedule allows means the
  // computer slept (or the agent was stopped); waiting is counted again from the next cycle.
  let awakeSince = Date.now();
  let lastCycleAt = 0;
  // A long step the person should see as "working" (an update), or null.
  let working: string | null = null;
  // SB391: the workspace's own summary for the tray (names, links, open reviews), refreshed every five minutes; null when the
  // workspace does not answer it (a self-hosted gateway), and the tray simply leaves those rows out.
  // SB392: a sign-in started from the tray, while it waits for approval.
  let reconnecting: ReconnectStart | null = null;
  let summary: ComputerSummary | null = null;
  let summaryAt = 0;
  const refreshSummary = async () => {
    summaryAt = Date.now();
    const connection = loadConnection(options.dir);
    summary = connection ? await fetchComputerSummary(connection, options.fetchImpl) : null;
  };

  const prompt = serialized(options.prompter ?? systemPrompter);
  let shownLevel: HealthLevel | null = null;
  const health = () => healthOf(computerStatus(options.dir), lastMaintenance?.selfCheck ?? null);
  const noticeHealth = () => { const h = health(); notifyChange(shownLevel, h); shownLevel = h.level; };
  const sendReasons = async () => {
    const connection = loadConnection(options.dir);
    if (!connection) return;
    try { const sent = await flushReasons(options.dir, connection, options.fetchImpl); if (sent) log(`sent ${sent} override reason(s) to the workspace`); }
    catch { /* they wait for the next cycle */ }
    // D144: allowances a person made here, and their requests to an admin.
    try {
      const sent = await sendAllowancesAndRequests(options.dir, connection, options.fetchImpl);
      if (sent.allowances || sent.requests) log(`sent ${sent.allowances} allowance(s) and ${sent.requests} request(s) to the workspace`);
    } catch { /* they wait for the next cycle */ }
  };
  const cycle = async (): Promise<CycleResult> => {
    if (running) return running;
    const started = Date.now();
    const allowedGap = failures ? MAX_BACKOFF_MS + 5 * 60_000 : Math.max(3 * interval, 5 * 60_000);
    if (lastCycleAt && started - lastCycleAt > allowedGap) awakeSince = started;
    lastCycleAt = started;
    running = runCycle({ dir: options.dir, fetchImpl: options.fetchImpl }).then(async (result) => {
      await sendReasons();
      try { noticeHealth(); } catch { /* status is best effort */ }
      last = result;
      failures = result.deliveryError ? failures + 1 : 0;
      if (result.delivered) log(`delivered ${result.delivered} record(s); ${result.pending} waiting`);
      if (result.deliveryError) log(`delivery problem: ${result.deliveryError}`);
      // SB390: asked from the workspace's computer page. Send again now (the cycle sent before its rules check), or run the
      // self-check; each once.
      if (result.requested === "flush") { log("the workspace asked this computer to send now"); setTimeout(() => { void cycle(); }, 0); }
      if (result.requested === "self_check") { log("the workspace asked this computer to check now"); setTimeout(() => { void maintain(true); }, 0); }
      if (result.connected && Date.now() - summaryAt > SUMMARY_EVERY_MS) void refreshSummary();
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
            spawnReplacement(options.dir);
            // Hand over: stop, then exit. A stop that never finishes (a tray or window child that will not close) must not
            // keep the old agent alive with the replacement waiting on it, so the exit has a hard deadline.
            setTimeout(() => { setTimeout(() => process.exit(0), 5_000).unref(); void stop().finally(() => process.exit(0)); }, 500);
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

  const trayState = (): TrayModel => {
    const now = Date.now();
    const status = computerStatus(options.dir);
    const meta = readMeta(options.dir);
    const report = ruleReport(options.dir);
    const modes = report ? Object.values(report).map(([mode]) => mode) : [];
    const activity = localActivity(options.dir);
    return trayModel({
      status, health: health(), now, awakeSince, working,
      rules: report ? { checked_at: meta.checked_at ? Date.parse(meta.checked_at) : null, managed: isManaged(options.dir), block: modes.filter((m) => m === "enforce").length, monitor: modes.filter((m) => m === "monitor").length } : null,
      today: activity?.today ?? null,
      recentBlocks: activity?.recent_blocks ?? [],
      version: { agent: agentVersion(), hook: hookVersion(), policy: lastMaintenance?.policy ?? "unknown", recommendedAgent: meta.recommended?.agent ?? null, recommendedHook: meta.recommended?.hook ?? null },
      workspace: summary ? { name: summary.workspace_name, environment: summary.environment_name, computer_url: summary.computer_url } : null,
      openReviews: summary?.open_reviews ?? 0,
      computerName: hostname(),
      canReconnect: true,
    });
  };

  const control = await startControl(options.dir, `${AGENT_VERSION} hook/${hookVersion()}`, {
    // SB387: what the tray draws, and the person's tray settings.
    "GET /tray": () => ({ tray: trayState(), settings: readTraySettings(options.dir) }),
    "POST /settings": (body) => ({ settings: writeTraySettings(options.dir, body) }),
    // SB387: "Check now" always says what it found.
    "POST /check": async () => {
      const result = await maintain(true);
      return { text: checkResult(result.selfCheck, result.error), tray: trayState() };
    },
    // SB389: install the version the workspace recommends now, instead of at the next six-hourly check.
    "POST /update": async () => {
      working = "Updating Scopebond…";
      try { const result = await maintain(true); return { updated_to: result.updatedTo, error: result.error }; }
      finally { working = null; }
    },
    // SB389: the newest blocks on this computer, summarised the way `log` prints them (never raw arguments).
    // SB391: open this computer's page in the workspace, only on the workspace this computer is connected to.
    "POST /open-workspace": () => {
      const connection = loadConnection(options.dir);
      const url = summary?.computer_url;
      if (!connection || !url || !sameOrigin(url, connection.url)) return { opened: false };
      openInBrowser(url);
      return { opened: true };
    },
    // SB392: sign in again for the connected workspace; the tray shows the code, the approval page opens in the browser.
    "POST /reconnect": async () => {
      if (reconnecting) return reconnecting;
      working = "Signing in again…";
      const result = await startReconnect(options.dir, (ok) => {
        reconnecting = null; working = null;
        log(ok ? "signed in again" : "the sign-in did not finish");
        if (ok) void cycle();
      });
      if ("error" in result) { working = null; return { error: result.error }; }
      reconnecting = result.started;
      log(`signing in again: waiting for approval of code ${result.started.user_code}`);
      return result.started;
    },
    "GET /recent-blocks": () => ({ recent_blocks: localActivity(options.dir, { limit: 10 })?.recent_blocks ?? [] }),
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
      if (answer.decision === "allow" && answer.reason) { queueReason(options.dir, question.action_id, answer.reason); setTimeout(() => { void sendReasons(); }, 1_000); }
      // The hook writes the request or allowance after this answer; send it shortly after.
      if (answer.decision === "ask" || answer.lasts === "always" || answer.lasts === "15m") setTimeout(() => { void sendReasons(); }, 2_000);
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
