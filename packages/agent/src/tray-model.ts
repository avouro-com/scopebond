// What the tray shows, as data. The tray (today a PowerShell script, later a native one) only draws this: one
// state, one headline, the rows that have data, the one fix when something is wrong, and the actions that apply now. It never
// works out health itself, so the tray, `status` and the workspace's computer page say the same thing.

import type { StatusJson } from "@scopebond/hook";
import type { Health } from "./health.js";
import type { AllowedItem, AskedItem } from "./allowed-asked.js";
import type { LiveQuestion } from "./live-prompt.js";
import type { BlockOutcome, BlockRequest } from "./block-outcome.js";

/** The six icon states of the "S" tile: no badge when protected; a badge with its own glyph otherwise. */
type TrayState = "protected" | "working" | "offline" | "attention" | "problem" | "disconnected";

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
  /** Up to 200 blocks of the last seven days, newest first (today's, then earlier ones); an agent's retries of one block
   *  are one entry with its number of tries. */
  recent_blocks: RecentBlock[];
  /** `recent_blocks` as the tray lists them: today's repeats of one action under one rule as one row (groupBlocks). Absent
   *  from an older agent: each block is its own row. */
  blocked_groups?: BlockGroup[];
  /** The line under the state when it is protected ("Rules checked 3 min ago · 2 blocked today"); null otherwise (the
   *  headline says it). */
  detail?: string | null;
  /** The workspace's name, when the workspace said it (for "Open … in Scopebond Cloud" and "Recorded and sent to …"). */
  workspace?: string | null;
  /** Since local midnight. `blocked` is the number of distinct blocks (retries folded): the header, the tab, the menu and
   *  the Today row all show this one number. */
  today?: { actions: number; blocked: number } | null;
  /** Whether the workspace lets a person ask an admin under any rule (so the tray shows its Requests list even before the
   *  person has asked anything); absent from an older agent. */
  can_ask?: boolean;
  /** What the person let through (in force or waiting for an admin), and what they asked an admin (allowed-asked.ts). */
  allowed?: AllowedItem[];
  asked?: AskedItem[];
  /** The hook's question waiting for the person now, when the tray is listening (live-prompt.ts). */
  pending?: LiveQuestion | null;
}

/** What the person may do about a block, as the workspace allows it now: allow it once (the next try), for 15 minutes, or
 *  always (for `always_days`, after an admin approves when `always_needs_admin`), or ask an admin. */
export interface BlockOffers {
  once: boolean; fifteen: boolean; always: boolean; always_days: number | null; always_needs_admin: boolean; ask: boolean;
  /** The workspace reviews every unblock later and may undo it; absent from an older agent. */
  reviewed?: boolean;
}

/** A recent block. `can_act`: the person may still allow it or ask an admin from the tray; `acted`: what they did. The
 *  fields after `acted` are newer (an older tray reads `summary` and `rule`): `what` is the action in plain words and
 *  `action_text` the text the Scopebond window shows (both with secrets masked), `rule_title` the rule's name, `project`
 *  the repository's name and `tool` the coding tool's, each when the record has it; `offers` and `reason_min` what the
 *  person may do now and the shortest reason the workspace accepts (null when nothing can be done). */
export interface RecentBlock {
  action_id: string | null; summary: string; at: string; rule: string | null; can_act?: boolean; acted?: "allowed" | "asked" | "quiet" | null;
  what?: string; action_text?: string; rule_title?: string | null; project?: string | null; tool?: string | null;
  offers?: BlockOffers | null; reason_min?: number | null;
  /** Newer still (an older tray leaves them out): how many times the coding agent tried it (retries folded, 1 for a single
   *  block) and when it first did; the one outcome the row shows (block-outcome.ts), the sentence that stands in for a
   *  button, the text "Copy details" copies, and the person's request for it, when they asked. */
  tries?: number; first_at?: string; group_id?: string | null;
  outcome?: BlockOutcome; outcome_text?: string | null; copy_details?: string | null; request?: BlockRequest | null;
  /** Newer again: why the rule exists, in one line (the first sentence of the rule's description on this computer), for the
   *  block's details; absent when the rule says nothing about itself. */
  rule_why?: string | null;
}

/** Blocks shown as one row in the tray: today, the same action under the same rule, however many sessions tried it; else one
 *  block (with its retries) alone. `members` are indexes into `recent_blocks`, newest first; the first is the one the row
 *  shows and acts on. `times` counts every try (retries included). */
export interface BlockGroup {
  key: string;
  members: number[];
  times: number;
  first_at: string;
  last_at: string;
  today: boolean;
}

/** The most blocks the tray lists (the last seven days; the panel shows them 50 at a time). */
export const RECENT_BLOCKS_MAX = 200;
/** The longest "why" line a block's details show. */
const WHY_MAX = 200;

/** A rule's description as one line for a person: its first sentence, at most 200 characters (cut at a word). Null when
 *  there is nothing to say. */
export function whyOf(description: unknown): string | null {
  if (typeof description !== "string") return null;
  const clean = description.replace(/\s+/g, " ").trim();
  if (!clean) return null;
  const end = clean.search(/[.!?](?:\s|$)/);
  const first = end >= 0 ? clean.slice(0, end + 1) : clean;
  if (first.length <= WHY_MAX) return first;
  const cut = first.slice(0, WHY_MAX - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > WHY_MAX * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/, "")}…`;
}

/** Group the list the way the tray shows it: today's blocks of the same action under the same rule (across sessions and
 *  coding tools) are one row, newest first; earlier blocks are each their own row. Order follows the newest member. */
export function groupBlocks(blocks: readonly RecentBlock[], now: number): BlockGroup[] {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const groups: BlockGroup[] = [];
  const byKey = new Map<string, BlockGroup>();
  blocks.forEach((b, i) => {
    const at = Date.parse(b.at);
    const today = Number.isFinite(at) && at >= midnight.getTime();
    const tries = typeof b.tries === "number" && b.tries > 0 ? b.tries : 1;
    const first = b.first_at ?? b.at;
    const key = today ? `${b.rule_title ?? b.rule ?? ""}\n${b.what ?? b.summary}` : `one\n${b.group_id ?? b.action_id ?? ""}\n${i}`;
    const known = today ? byKey.get(key) : undefined;
    if (known) {
      known.members.push(i);
      known.times += tries;
      if (Date.parse(first) < Date.parse(known.first_at)) known.first_at = first;
      return;
    }
    const group: BlockGroup = { key, members: [i], times: tries, first_at: first, last_at: b.at, today };
    groups.push(group);
    if (today) byKey.set(key, group);
  });
  return groups;
}

const TOOL_NAMES: Readonly<Record<string, string>> = {
  claude: "Claude Code", cursor: "Cursor", codex: "Codex", copilot: "GitHub Copilot", windsurf: "Windsurf", gemini: "Gemini CLI",
  cline: "Cline", opencode: "OpenCode", aider: "Aider", gateway: "Scopebond Gateway", mcp: "MCP",
};

/** The coding tool's name as a person knows it, from the record's harness id (`claude` → "Claude Code"); null when unknown. */
export function toolName(harness: string | null | undefined): string | null {
  return harness && Object.prototype.hasOwnProperty.call(TOOL_NAMES, harness) ? TOOL_NAMES[harness] : null;
}

/** The project's name from the record's repository (`github.com/acme/checkout` → "checkout"); null when there is none. */
export function projectName(repository: string | null | undefined): string | null {
  const name = repository?.split("/").filter(Boolean).at(-1)?.replace(/\.git$/i, "");
  return name ? name.slice(0, 80) : null;
}

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
  /** `recommendedAgent`/`recommendedHook`: what this install can update to (the signed install: the workspace's signed
   *  build, and never a separate hook; an install for every user: nothing). `failedUpdate`: a version that did not install
   *  or start here within the last day (not offered again until then). */
  version: { agent: string; hook: string; policy: "recommended" | "hold" | "unknown"; recommendedAgent: string | null; recommendedHook: string | null; failedUpdate?: { version: string; reason: string | null } | null };
  workspace: { name: string | null; environment: string | null; computer_url: string | null } | null;
  computerName: string;
  /** Items about this computer waiting in the workspace's Review (from the workspace's summary). */
  openReviews?: number;
  /** Whether the agent can run the sign-in itself (`POST /reconnect`); until then the tray shows the command. */
  canReconnect?: boolean;
  /** A computer never connected can be signed in from the tray (the signed install: `POST /reconnect` runs the first-time
   *  sign-in and setup). */
  canSignIn?: boolean;
  /** A sign-in waiting for approval in the workspace: its code, shown until it is approved. */
  signingIn?: { user_code: string; verification_url: string } | null;
  /** Something to tell the person once things are fine (shown as the hint when there is no other). */
  notice?: string | null;
  /** The workspace lets a person ask an admin under at least one rule. */
  canAsk?: boolean;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
/** Records waiting this long while the computer is awake and online need attention. */
export const WAITING_ATTENTION_MS = 15 * MIN;
/** Offline (the workspace unreachable) this long needs attention. */
const OFFLINE_ATTENTION_MS = 4 * HOUR;
/** Rules not checked for this long while online need attention. */
const RULES_STALE_MS = HOUR;

/** A delivery error that means the workspace could not be reached (no answer at all), not a refusal. */
export function unreachable(error: string | null | undefined): boolean {
  return !!error && !/HTTP \d{3}/.test(error) && /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|getaddrinfo|network|socket|could not reach/i.test(error);
}

/** The workspace refused records because it reached its monthly limit (they stay on the computer). */
function overQuota(error: string | null | undefined): boolean {
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
function planPaused(error: string | null | undefined): boolean {
  return !!error && /HTTP 402 \(agent_paused\)/.test(error);
}

/** The workspace licenses fewer agents than it has, and this one holds no license (HTTP 402 not_licensed). */
function notLicensed(error: string | null | undefined): boolean {
  return !!error && /HTTP 402 \(not_licensed\)/.test(error);
}

/** The HTTP status of a refusal the workspace answered (not "unreachable"), or null. */
function refusedStatus(error: string | null | undefined): number | null {
  const m = error ? /HTTP (\d{3})/.exec(error) : null;
  return m ? Number(m[1]) : null;
}

/** A count as people read it ("16,867"), formatted here once so every surface shows the same text. */
export const count = (n: number): string => n.toLocaleString("en-US");

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

const ACTIONS: Record<TrayAction["id"] | "sign_in", TrayAction> = {
  send_now: { id: "send_now", label: "Send records now", route: "/flush" },
  update_now: { id: "update_now", label: "Update now", route: "/update" },
  check_now: { id: "check_now", label: "Check now", route: "/check" },
  repair: { id: "repair", label: "Repair", route: "/repair" },
  reconnect: { id: "reconnect", label: "Reconnect…", route: "/reconnect" },
  // The same route and id (the tray shows the code the answer carries for "reconnect"), for a computer never connected.
  sign_in: { id: "reconnect", label: "Sign in…", route: "/reconnect" },
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
  const failed = input.version.failedUpdate ?? null;
  const offered = (want: string | null) => want !== null && want !== failed?.version ? want : null;
  const updateAvailable = input.version.policy === "recommended" && (newer(offered(input.version.recommendedAgent), input.version.agent) || newer(offered(input.version.recommendedHook), input.version.hook));

  let state: TrayState;
  let headline: string;
  let fix: TrayAction | null = null;
  let hint: string | null = null;
  if (input.signingIn) {
    // The code to check on the approval page; "Sign in…" shows it again and opens the page again.
    state = "working"; headline = `Approve this computer in your workspace: code ${input.signingIn.user_code}`;
    hint = `The approval page opened in your browser. Check that it shows the code ${input.signingIn.user_code}, then approve this computer.`;
    fix = ACTIONS.sign_in;
  } else if (input.working) {
    state = "working"; headline = input.working;
  } else if (!d.connected && input.canSignIn) {
    // First things first: signing in also puts the hook in the coding agents' settings, so it fixes "not checking" too.
    state = "disconnected"; headline = "Not signed in to a workspace yet: records stay on this computer";
    hint = "Sign in to connect this computer to your workspace: the approval page opens in your browser, and Scopebond sets up your coding agents."; fix = ACTIONS.sign_in;
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
  } else if (pending > 0 && notLicensed(d.last_error) && health.fix?.route !== "/repair") {
    // Not a delivery problem to retry: this agent holds no license. Sending again changes nothing; an owner decides.
    state = "attention"; headline = `Not licensed: ${pending} record${pending === 1 ? "" : "s"} waiting`;
    hint = "This agent is not covered by your workspace's licenses. The starter protections stay on, and this computer keeps its records; they send once an owner adds licenses in Settings, Billing.";
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
    const parts = [`${count(input.today.actions)} action${input.today.actions === 1 ? "" : "s"}`, `${count(input.today.blocked)} blocked`];
    if (input.today.recorded_after) parts.push(`${input.today.recorded_after} recorded, not prevented`);
    if (input.today.allowed_by_person) parts.push(`${input.today.allowed_by_person} allowed by a person`);
    if (input.openReviews) parts.push(`${input.openReviews} in Review`);
    rows.push({ label: "Today", value: parts.join(" · ") });
  }
  rows.push({
    label: "Version",
    value: failed && !updateAvailable ? `agent ${input.version.agent} · the update to ${failed.version} did not install; tried again later`
      : updateAvailable ? `Update available (agent ${input.version.recommendedAgent ?? input.version.agent})`
      : input.version.policy === "hold" ? `agent ${input.version.agent} · updates managed by your workspace`
      : `Up to date (agent ${input.version.agent})`,
  });

  const actions: TrayAction[] = [];
  if (pending > 0 && fix?.id !== "send_now" && state !== "disconnected") actions.push(ACTIONS.send_now);
  if (updateAvailable && !input.working) actions.push(ACTIONS.update_now);
  if (fix?.id !== "check_now") actions.push(ACTIONS.check_now);
  if (input.workspace?.computer_url) actions.push(ACTIONS.open_workspace);

  if (hint === null && input.notice) hint = input.notice;

  const where = [input.workspace?.name, input.workspace?.environment].filter(Boolean).join(" · ");
  const label = state === "protected" ? `Protected${where ? ` · ${where}` : ""}` : headline;
  const tooltip = `Scopebond — ${label}`;
  // One line under "Protected": when the rules were last checked and what was blocked today (the rows say the rest).
  let detail: string | null = null;
  if (state === "protected") {
    const checked = input.rules?.checked_at ? `Rules checked ${ago(input.rules.checked_at, now)}` : input.rules && !input.rules.managed ? "Using this computer's own rules" : null;
    const blocked = input.today ? (input.today.blocked ? `${count(input.today.blocked)} blocked today` : "nothing blocked today") : null;
    detail = [checked, blocked].filter(Boolean).join(" · ") || null;
    if (detail) detail = detail[0].toUpperCase() + detail.slice(1);
  }
  const recent = (input.recentBlocks ?? []).slice(0, RECENT_BLOCKS_MAX);
  return {
    state, headline, fix, actions, hint, rows,
    tooltip: tooltip.length > 63 ? `${tooltip.slice(0, 62)}…` : tooltip,
    recent_blocks: recent,
    blocked_groups: groupBlocks(recent, now),
    detail,
    workspace: input.workspace?.name ?? null,
    today: input.today ? { actions: input.today.actions, blocked: input.today.blocked } : null,
    can_ask: input.canAsk ?? false,
  };
}

/** What "Check now" says afterwards, for five seconds: never silence. */
export function checkResult(selfCheck: { ok: boolean; failed: string[] } | null, error: string | null): string {
  if (error) return `Check could not finish: ${error}`.slice(0, 200);
  if (!selfCheck) return "Checked just now: this computer is not connected to a workspace, so only local checks ran";
  return selfCheck.ok ? "Checked just now: all good" : `Check found a problem: ${selfCheck.failed[0] ?? "see status"}`;
}
