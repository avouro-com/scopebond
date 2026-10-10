// What the tray shows, as data. The tray (today a PowerShell script, later a native one) only draws this: one
// state, one headline, the rows that have data, the one fix when something is wrong, and the actions that apply now. It never
// works out health itself, so the tray, `status` and the workspace's computer page say the same thing.

import type { StatusJson } from "@scopebond/hook";
import type { Health } from "./health.js";

/** The six icon states of the "S" tile: no badge when protected; a badge with its own glyph otherwise. */
export type TrayState = "protected" | "working" | "offline" | "attention" | "problem" | "disconnected";

export interface TrayAction {
  id: "send_now" | "update_now" | "check_now" | "repair" | "reconnect" | "open_workspace";
  label: string;
  /** The agent's local route that does it (POST). */
  route: string;
}

export interface TrayModel {
  state: TrayState;
  /** One line at the top, and the tooltip (Windows allows 63 characters in a classic tray tooltip). */
  headline: string;
  tooltip: string;
  /** Rules, Delivery, Today, Version: each only when there is data (never "unknown"). */
  rows: Array<{ label: string; value: string }>;
  /** The one fix when something is wrong (shown first, in place of the usual actions). */
  fix: TrayAction | null;
  /** Actions that apply now, in menu order. */
  actions: TrayAction[];
  /** A sign-in or similar step no button can do, in words. */
  hint: string | null;
  recent_blocks: RecentBlock[];
}

/** A recent block. `can_act`: the person may still allow it or ask an admin from the tray; `acted`: what they did. */
export interface RecentBlock { action_id: string | null; summary: string; at: string; rule: string | null; can_act?: boolean; acted?: "allowed" | "asked" | null }

export interface TrayInput {
  status: StatusJson;
  health: Health;
  now: number;
  /** When this computer last came back from sleep or started (the agent sees the gap between its cycles). */
  awakeSince: number;
  /** A long step the agent is running (an update, a sign-in, a repair), or null. */
  working: string | null;
  rules: { checked_at: number | null; managed: boolean; block: number; monitor: number } | null;
  /** `recorded_after`: out of policy but reported only after it ran (a Cursor edit); never counted as blocked. */
  today: { actions: number; blocked: number; recorded_after?: number; allowed_by_person: number } | null;
  recentBlocks?: RecentBlock[];
  version: { agent: string; hook: string; policy: "recommended" | "hold" | "unknown"; recommendedAgent: string | null; recommendedHook: string | null };
  workspace: { name: string | null; environment: string | null; computer_url: string | null } | null;
  computerName: string;
  /** Items about this computer waiting in the workspace's Review (from the workspace's summary). */
  openReviews?: number;
  /** Whether the agent can run the sign-in itself (`POST /reconnect`); until then the tray shows the command. */
  canReconnect?: boolean;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
/** Records waiting this long while the computer is awake and online need attention. */
export const WAITING_ATTENTION_MS = 15 * MIN;
/** Offline (the workspace unreachable) this long needs attention. */
export const OFFLINE_ATTENTION_MS = 4 * HOUR;
/** Rules not checked for this long while online need attention. */
export const RULES_STALE_MS = HOUR;

/** A delivery error that means the workspace could not be reached (no answer at all), not a refusal. */
export function unreachable(error: string | null | undefined): boolean {
  return !!error && !/HTTP \d{3}/.test(error) && /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|getaddrinfo|network|socket|could not reach/i.test(error);
}

/** The workspace refused records because it reached its monthly limit (they stay on the computer). */
export function overQuota(error: string | null | undefined): boolean {
  return !!error && /HTTP 429 \(quota\)/.test(error);
}

/** The monthly limit a plan change would give, when the workspace's limit refusal named one (the delivery error then ends
 *  with "[plan_lifts_to=<n>]"); null when it named none, so nothing promises that a plan change lifts the limit. */
function planLiftsTo(error: string | null | undefined): number | null {
  const m = error && overQuota(error) ? / \[plan_lifts_to=(\d{1,15})\]$/.exec(error) : null;
  const n = m ? Number(m[1]) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** The workspace's plan keeps fewer agents active than it has, and this one is paused (HTTP 402 agent_paused). */
export function planPaused(error: string | null | undefined): boolean {
  return !!error && /HTTP 402 \(agent_paused\)/.test(error);
}

/** The HTTP status of a refusal the workspace answered (not "unreachable"), or null. */
export function refusedStatus(error: string | null | undefined): number | null {
  const m = error ? /HTTP (\d{3})/.exec(error) : null;
  return m ? Number(m[1]) : null;
}

export function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

function clock(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const newer = (want: string | null, have: string): boolean => {
  if (!want) return false;
  const a = want.split(".").map(Number), b = have.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
};

const ACTIONS: Record<TrayAction["id"], TrayAction> = {
  send_now: { id: "send_now", label: "Send records now", route: "/flush" },
  update_now: { id: "update_now", label: "Update now", route: "/update" },
  check_now: { id: "check_now", label: "Check now", route: "/check" },
  repair: { id: "repair", label: "Repair", route: "/repair" },
  reconnect: { id: "reconnect", label: "Reconnect…", route: "/reconnect" },
  open_workspace: { id: "open_workspace", label: "Open workspace", route: "/open-workspace" },
};

export function trayModel(input: TrayInput): TrayModel {
  const { status, health, now } = input;
  const d = status.delivery;
  const pending = d.pending;
  const oldestAt = d.oldest_pending_age_s === null ? null : now - d.oldest_pending_age_s * 1000;
  // Sleep-aware: time the computer was asleep or off never counts as waiting.
  const waitingMs = oldestAt === null ? 0 : now - Math.max(oldestAt, input.awakeSince);
  const offline = d.connected && unreachable(d.last_error);
  const offlineFor = offline ? now - Math.max(d.last_success_at ?? input.awakeSince, input.awakeSince) : 0;
  const updateAvailable = input.version.policy === "recommended" && (newer(input.version.recommendedAgent, input.version.agent) || newer(input.version.recommendedHook, input.version.hook));

  let state: TrayState;
  let headline: string;
  let fix: TrayAction | null = null;
  let hint: string | null = null;
  if (input.working) {
    state = "working"; headline = input.working;
  } else if (health.level === "red" && d.connection_refused_since !== null) {
    state = "disconnected"; headline = "Not connected to your workspace: using this computer's own rules";
    if (input.canReconnect) fix = ACTIONS.reconnect; else hint = health.hint;
  } else if (pending > 0 && overQuota(d.last_error) && health.fix?.route !== "/repair") {
    // Not "sending": the workspace refuses them until its limit allows. Nothing is lost; say so. A plan change is named only
    // when the workspace said one lifts the limit, with the limit it gives: on some plans none does.
    state = "attention"; headline = `Workspace limit reached: ${pending} record${pending === 1 ? "" : "s"} waiting`;
    const liftsTo = planLiftsTo(d.last_error);
    hint = liftsTo !== null
      ? `Your workspace reached its monthly limit. Records stay on this computer and send once the limit allows, or sooner if a workspace owner moves to a plan that allows ${liftsTo.toLocaleString("en-US")} records a month.`
      : "Your workspace reached its monthly limit. Records stay on this computer and send once the limit allows.";
    fix = ACTIONS.open_workspace;
  } else if (pending > 0 && planPaused(d.last_error) && health.fix?.route !== "/repair") {
    // Not a delivery problem to retry: the plan paused this agent. Sending again changes nothing; an owner decides.
    state = "attention"; headline = `Paused by your workspace's plan: ${pending} record${pending === 1 ? "" : "s"} waiting`;
    hint = "Your workspace's plan keeps fewer agents active than it has, and this one is paused. This computer keeps checking actions and keeps its records; they send once an owner keeps this agent active or changes the plan.";
    fix = ACTIONS.open_workspace;
  } else if (health.level === "red") {
    state = "problem"; headline = health.headline; hint = health.hint;
    if (health.fix?.route === "/repair") fix = ACTIONS.repair;
  } else if (offline) {
    state = offlineFor > OFFLINE_ATTENTION_MS ? "attention" : "offline";
    headline = pending ? `Workspace unreachable: ${pending} record${pending === 1 ? "" : "s"} waiting` : "Workspace unreachable: still checking actions";
  } else if (pending > 0 && waitingMs > WAITING_ATTENTION_MS) {
    state = "attention"; headline = `${pending} record${pending === 1 ? "" : "s"} waiting to send`; fix = ACTIONS.send_now;
  } else if (health.level === "amber" && health.fix?.route === "/maintain") {
    state = "attention"; headline = health.headline; fix = ACTIONS.check_now;
  } else if (input.rules?.checked_at && d.connected && now - input.rules.checked_at > RULES_STALE_MS) {
    state = "attention"; headline = `Rules not checked for ${ago(input.rules.checked_at, now).replace(" ago", "")}`; fix = ACTIONS.check_now;
  } else {
    state = "protected"; headline = "Protected";
  }

  const rows: TrayModel["rows"] = [];
  if (input.rules) {
    const when = input.rules.checked_at ? ` · checked ${ago(input.rules.checked_at, now)}` : "";
    const source = input.rules.managed ? "Up to date" : "Using this computer's own rules";
    const counts = input.rules.block + input.rules.monitor > 0 ? ` · ${input.rules.block} block · ${input.rules.monitor} monitor` : "";
    rows.push({ label: "Rules", value: `${input.rules.managed && input.rules.checked_at && now - input.rules.checked_at > RULES_STALE_MS ? `Not checked for ${ago(input.rules.checked_at, now).replace(" ago", "")}` : source}${when}${counts}` });
  }
  if (d.connected) {
    const value = pending === 0
      ? (d.last_success_at ? `All sent · ${ago(d.last_success_at, now)}` : "Nothing to send yet")
      : offline ? `${pending} waiting since ${oldestAt ? clock(oldestAt) : "earlier"} · offline`
      : overQuota(d.last_error) ? `${pending} waiting · workspace limit reached`
      : refusedStatus(d.last_error) ? `${pending} waiting · last try refused (HTTP ${refusedStatus(d.last_error)})`
      : `${pending} waiting · sending`;
    rows.push({ label: "Delivery", value });
  }
  if (input.today) {
    const parts = [`${input.today.actions} action${input.today.actions === 1 ? "" : "s"}`, `${input.today.blocked} blocked`];
    if (input.today.recorded_after) parts.push(`${input.today.recorded_after} recorded, not prevented`);
    if (input.today.allowed_by_person) parts.push(`${input.today.allowed_by_person} allowed by a person`);
    if (input.openReviews) parts.push(`${input.openReviews} in Review`);
    rows.push({ label: "Today", value: parts.join(" · ") });
  }
  rows.push({
    label: "Version",
    value: updateAvailable ? `Update available (agent ${input.version.recommendedAgent ?? input.version.agent})`
      : input.version.policy === "hold" ? `agent ${input.version.agent} · updates managed by your workspace`
      : `Up to date (agent ${input.version.agent})`,
  });

  const actions: TrayAction[] = [];
  if (pending > 0 && fix?.id !== "send_now" && state !== "disconnected") actions.push(ACTIONS.send_now);
  if (updateAvailable && !input.working) actions.push(ACTIONS.update_now);
  if (fix?.id !== "check_now") actions.push(ACTIONS.check_now);
  if (input.workspace?.computer_url) actions.push(ACTIONS.open_workspace);

  const where = [input.workspace?.name, input.workspace?.environment].filter(Boolean).join(" · ");
  const label = state === "protected" ? `Protected${where ? ` · ${where}` : ""}` : headline;
  const tooltip = `Scopebond — ${label}`;
  return {
    state, headline, fix, actions, hint, rows,
    tooltip: tooltip.length > 63 ? `${tooltip.slice(0, 62)}…` : tooltip,
    recent_blocks: (input.recentBlocks ?? []).slice(0, 3),
  };
}

/** What "Check now" says afterwards, for five seconds: never silence. */
export function checkResult(selfCheck: { ok: boolean; failed: string[] } | null, error: string | null): string {
  if (error) return `Check could not finish: ${error}`.slice(0, 200);
  if (!selfCheck) return "Checked just now: this computer is not connected to a workspace, so only local checks ran";
  return selfCheck.ok ? "Checked just now: all good" : `Check found a problem: ${selfCheck.failed[0] ?? "see status"}`;
}
