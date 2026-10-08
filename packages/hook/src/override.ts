// Warn mode: a person at the computer may allow one action a workspace rule blocks, when the workspace set that rule to
// "Block, user may override" and lets someone override. Only a channel the coding agent cannot answer counts:
//
//   1. The Scopebond Agent's own window. The hook asks the resident agent on its local channel and waits; the answer comes
//      from the window, never from whoever called the channel. The person gives a reason; its digest is signed into the receipt
//      and the agent sends the text to the workspace.
//   2. Claude Code's own permission prompt, only when the workspace allows it, only in a permission mode where Claude Code
//      really asks the person (default, acceptEdits, plan), and only when the window is not available. It takes no reason and
//      does not prove who answered, so the receipt says "offered", not "allowed".
//
// Never overridable: a denial that a rule on Block, or Scopebond's own protection, would also make (checked by evaluating the
// action against the same rules with every overridable rule recorded instead of blocked), and the kill switch (the gateway
// never asks while it is on). Beyond the daily limit the rule blocks.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { userInfo } from "node:os";
import { evaluate, type OverrideHandler, type OverrideRecord } from "@scopebond/gateway";
import { compileManaged, floorDocument, MANAGED_DOC_FILE, personMayAct, RULE_OF_CLAUSE, writeAtomic, type ManagedDocument, type ManagedRuleId } from "./managed.js";
import { makeAllowance, markBlocked, matchAllowance, mergeWorkspaceAllowances, readAllowances, readBlocked, recordBlocked, writeAllowances, type BlockedItem } from "./allowances.js";
import { queueRequest } from "./requests.js";
import { defaultRules, loadRules } from "./rules.js";
import { agentCommand } from "./windows-hints.js";
import { requestOverSocket } from "./local-socket.js";

export const OVERRIDE_STATE_FILE = "overrides.json";
const AGENT_FILE = "agent.json";
const TOKEN_HEADER = "x-scopebond-agent-token";
/** Claude Code permission modes in which it shows the person a prompt for "ask". Any other or missing mode blocks. */
export const PROMPTING_MODES = new Set(["default", "acceptEdits", "plan"]);
const DAY_MS = 24 * 60 * 60 * 1000;

const RULE_TITLE: Record<ManagedRuleId, string> = {
  "force-push-protected": "Force-push to a protected branch",
  "push-protected": "Push to a protected branch",
  "destructive-shell": "Destructive command",
  "secret-read": "Reading a secret file",
  "ci-config-write": "Changing CI configuration",
  "network-egress": "Request to a site not on the allowed list",
};

export const digestOf = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

interface StateEntry { rule: string; action_key: string; action_id: string; at: number; reason_digest: string; reason_length: number }
interface OverrideState { entries: StateEntry[] }

function readState(dir: string): OverrideState {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, OVERRIDE_STATE_FILE), "utf8")) as OverrideState;
    return Array.isArray(parsed.entries) ? parsed : { entries: [] };
  } catch { return { entries: [] }; }
}
function writeState(dir: string, state: OverrideState, now: number): void {
  // Keep two days: enough for today's count and any time window.
  const kept = state.entries.filter((e) => now - e.at < 2 * DAY_MS).slice(-500);
  mkdirSync(dir, { recursive: true });
  writeAtomic(join(dir, OVERRIDE_STATE_FILE), `${JSON.stringify({ entries: kept })}\n`);
}

/** Control, bidi and zero-width characters: shown to a person, they can make a command read as a different one. */
const HIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/g;

/** The text with each such character written out as ⟨U+XXXX⟩, so the summary a person (and an admin) reads is what runs. */
export function revealHidden(text: string): string {
  return text.replace(HIDDEN, (ch) => `⟨U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}⟩`);
}

/** One line a person can judge at a glance, from the minimized intent: never file contents or command output. */
export function actionSummary(intent: { action_type?: string; params?: Record<string, unknown> }): string {
  const p = intent.params ?? {};
  const pick = (k: string) => (typeof p[k] === "string" ? String(p[k]) : "");
  const text = intent.action_type === "shell.exec" ? pick("command") || pick("program")
    : intent.action_type === "git.push" ? `git push ${pick("remote")} ${pick("ref")}`.trim()
    : intent.action_type === "net.fetch" ? pick("url") || pick("host")
    : pick("path") || intent.action_type || "an action";
  // Arguments the hook keeps only as a keyed digest stay out of the window.
  const shown = revealHidden(text.slice(0, 2000).replace(/ ?\(hmac-sha256:[0-9a-f]{64}\)/g, "").trim());
  return shown.length > 200 ? `${shown.slice(0, 197)}...` : shown;
}

/** The same action, whatever tool call it came from: its type and parameters without the per-call group id. */
export function actionKey(intent: { action_type?: string; params?: Record<string, unknown> }): string {
  // The group fields name the tool call an action came from (its id, size and place in it), so they are left out.
  const { action_group: _group, action_group_size: _size, action_group_seq: _seq, ...params } = intent.params ?? {};
  const sorted = (v: unknown): unknown => Array.isArray(v) ? v.map(sorted)
    : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])])) : v;
  return digestOf(JSON.stringify({ action_type: intent.action_type ?? "", params: sorted(params) }));
}

/** The window's answer. allow: allow this action (`lasts`: once, or also for 15 minutes, or always via an allowance). ask: send
 *  "Ask an admin" with the reason; the action stays blocked. */
export interface AgentAnswer { decision: "allow" | "deny" | "unavailable" | "ask"; reason?: string; os_user?: string; lasts?: "once" | "15m" | "always" }

/** Ask the resident Scopebond Agent to show its window. Returns "unavailable" when no agent answers. */
export async function askAgent(home: string, request: Record<string, unknown>, timeoutMs: number, fetchImpl: typeof fetch = fetch): Promise<AgentAnswer> {
  let endpoint: { port?: unknown; socket?: unknown; token?: unknown };
  try { endpoint = JSON.parse(readFileSync(join(home, AGENT_FILE), "utf8")) as { port?: unknown; socket?: unknown; token?: unknown }; }
  catch { return { decision: "unavailable" }; }
  if (typeof endpoint.token !== "string") return { decision: "unavailable" };
  const hasPort = Number.isInteger(endpoint.port) && (endpoint.port as number) > 0;
  if (!hasPort && !(typeof endpoint.socket === "string" && endpoint.socket)) return { decision: "unavailable" };
  try {
    let body: AgentAnswer;
    // The agent's pipe or socket when it has one (and no test stands in for the network); else its loopback port.
    if (typeof endpoint.socket === "string" && endpoint.socket && fetchImpl === fetch) {
      const answer = await requestOverSocket(endpoint.socket, "POST", "/override", { [TOKEN_HEADER]: endpoint.token }, request, timeoutMs);
      if (!answer || answer.status !== 200 || !answer.body || typeof answer.body !== "object") return { decision: "unavailable" };
      body = answer.body as AgentAnswer;
    } else {
      if (!hasPort) return { decision: "unavailable" };
      const res = await fetchImpl(`http://127.0.0.1:${endpoint.port as number}/override`, {
        method: "POST", headers: { "content-type": "application/json", [TOKEN_HEADER]: endpoint.token }, body: JSON.stringify(request),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return { decision: "unavailable" };
      body = await res.json() as AgentAnswer;
    }
    const user = typeof body.os_user === "string" ? { os_user: body.os_user } : {};
    const lasts = body.lasts === "15m" || body.lasts === "always" ? body.lasts : "once";
    if (body.decision === "allow" && typeof body.reason === "string") return { decision: "allow", reason: body.reason, lasts, ...user };
    if (body.decision === "ask" && typeof body.reason === "string") return { decision: "ask", reason: body.reason, ...user };
    return { decision: body.decision === "deny" ? "deny" : "unavailable" };
  } catch { return { decision: "unavailable" }; }
}

export interface OverrideContext {
  /** The folder holding the policy and the workspace rules document. */
  dir: string;
  /** The Scopebond home, where the resident agent publishes its local channel. */
  home: string;
  agentKid: string;
  harness: "claude" | "codex" | "cursor";
  /** Claude Code's permission_mode from the hook payload, when it sent one. */
  permissionMode?: string | null;
  now?: () => number;
  /** How long to wait for the person; the agent's own hook timeout must be longer. */
  waitMs?: number;
  ask?: typeof askAgent;
}

/** What happened when the last override was considered, so a denial can say how an override would be possible. */
export interface OverrideNote { rule: ManagedRuleId; title: string; outcome: "declined" | "limit" | "unavailable" | "not_overridable" | "asked" | "ask_unavailable" }

export function createOverrideHandler(ctx: OverrideContext): { handler: OverrideHandler; note(): OverrideNote | null } | null {
  let doc: ManagedDocument;
  try { doc = JSON.parse(readFileSync(join(ctx.dir, MANAGED_DOC_FILE), "utf8")) as ManagedDocument; } catch { return null; }
  if (!Object.values(doc.rules ?? {}).some((r) => personMayAct(r))) return null;
  const now = ctx.now ?? Date.now;
  let last: OverrideNote | null = null;
  const handler: OverrideHandler = async ({ verdict, action_id, intent, intent_hash }) => {
    const key = actionKey(intent as never);
    const rule = RULE_OF_CLAUSE[verdict.clause_id ?? ""];
    const setting = rule ? doc.rules[rule] : undefined;
    if (!rule || !personMayAct(setting) || !setting?.override) return null;
    const terms = setting.override;
    const title = RULE_TITLE[rule];
    // Would the action still be denied with every overridable rule only recorded? Then a Block rule or Scopebond's own
    // protection denies it too, and no one may override that.
    const floor = compileManaged(loadRules(ctx.dir) ?? defaultRules(), floorDocument(doc, rule), ctx.agentKid);
    const atFloor = evaluate(floor as never, [], { intent, intent_hash }, new Date(now()).toISOString(), { cooperative: true });
    if (!atFloor.allow) { last = { rule, title, outcome: "not_overridable" }; return null; }

    const t = now();
    const osDigest = osUserDigest();
    // D144: a standing allowance for this rule and this exact action lets it through, and the receipt names it.
    let allowances = readAllowances(ctx.dir);
    if (doc.allowances || doc.revoked_allowances) allowances = mergeWorkspaceAllowances(allowances, doc.allowances, doc.revoked_allowances);
    const standing = matchAllowance(allowances, { rule, actionKey: key, osUserDigest: osDigest, now: t });
    if (standing) {
      standing.uses += 1;
      try { writeAllowances(ctx.dir, allowances, t); } catch { /* the receipt records the use; a one-time allowance may be used again */ }
      return { version: 1, rule, method: "allowance", state: "allowed", repeat_of: standing.id, reason_digest: standing.reason_digest,
        reason_length: standing.reason_length, os_user_digest: osDigest, decided_at: new Date(t).toISOString() };
    }
    const summary = actionSummary(intent as never);
    const blocked = () => recordBlocked(ctx.dir, { id: action_id, at: new Date(t).toISOString(), rule, mode: setting!.mode as "override" | "ask", action_key: key, summary, harness: ctx.harness }, t);
    // A workspace that sends the D144 terms knows allowances; an older one gets "Allow once" only (its receipts could not
    // carry an allowance's use).
    const knowsAllowances = terms.always !== undefined || terms.requests !== undefined;
    const offers = {
      allow: setting!.mode === "override",
      always: setting!.mode === "override" && terms.always !== undefined && terms.always !== "off",
      ask: setting!.mode === "ask" || terms.requests === true,
      fifteen: setting!.mode === "override" && knowsAllowances,
    };
    const state = readState(ctx.dir);
    const dayStart = t - (t % DAY_MS);
    // Inside the time an earlier override allowed, the same action is allowed again without asking, and says so.
    if (terms.minutes > 0) {
      const earlier = [...state.entries].reverse().find((e) => e.rule === rule && e.action_key === key && t - e.at <= terms.minutes * 60_000);
      if (earlier) {
        return { version: 1, rule, method: "agent_dialog", state: "allowed", repeat_of: earlier.action_id, reason_digest: earlier.reason_digest,
          reason_length: earlier.reason_length, os_user_digest: osUserDigest(), decided_at: new Date(t).toISOString() };
      }
    }
    if (offers.allow && state.entries.filter((e) => e.rule === rule && e.at >= dayStart).length >= terms.daily_limit) { last = { rule, title, outcome: "limit" }; blocked(); return null; }

    let answer = await (ctx.ask ?? askAgent)(ctx.home, {
      action_id, rule, title, summary, reason_min: terms.reason_min, mode: setting!.mode, offers,
      lasts: terms.minutes > 0 ? `the same action for ${terms.minutes} minutes` : "this action only", timeout_ms: ctx.waitMs ?? 45_000,
    }, (ctx.waitMs ?? 45_000) + 2_000);
    // Ask an admin: the action stays blocked; the request waits for the agent to send it.
    // An older Scopebond Agent shows only "Allow once"; where only asking is offered, its answer is a request to an admin.
    if (answer.decision === "allow" && !offers.allow && offers.ask) answer = { ...answer, decision: "ask" };
    if (answer.decision === "ask" && offers.ask) {
      const reason = (answer.reason ?? "").trim();
      if (reason.length < terms.reason_min || reason.length > 500) { last = { rule, title, outcome: "declined" }; blocked(); return null; }
      try { queueRequest(ctx.dir, { rule, action_key: key, action_id, summary, reason, os_user_digest: answer.os_user ? digestOf(answer.os_user) : osDigest, harness: ctx.harness, now: t }); }
      catch { /* the block stands either way */ }
      last = { rule, title, outcome: "asked" }; blocked(); return null;
    }
    if (answer.decision === "allow" && offers.allow) {
      const reason = (answer.reason ?? "").trim();
      if (reason.length < terms.reason_min || reason.length > 500) { last = { rule, title, outcome: "declined" }; return null; }
      const record: OverrideRecord = { version: 1, rule, method: "agent_dialog", state: "allowed", repeat_of: null, reason_digest: digestOf(reason),
        reason_length: reason.length, os_user_digest: answer.os_user ? digestOf(answer.os_user) : osUserDigest(), decided_at: new Date(t).toISOString() };
      state.entries.push({ rule, action_key: key, action_id, at: t, reason_digest: record.reason_digest!, reason_length: reason.length });
      try { writeState(ctx.dir, state, t); } catch { /* the receipt still records it; the count is checked again in the workspace */ }
      // "Allow for 15 min" and "Always allow this here…" also stand for the same action afterwards (D144).
      if ((answer.lasts === "15m" && offers.fifteen) || (answer.lasts === "always" && offers.always)) {
        try {
          const made = makeAllowance({ rule, actionKey: key, reason, osUserDigest: record.os_user_digest, lasts: answer.lasts,
            alwaysDays: terms.always_days, needsAdmin: terms.always === "needs_admin", now: t });
          writeAllowances(ctx.dir, [...allowances, made], t);
          // Waiting for an admin, the person is still covered for 15 minutes.
          if (made.state === "proposed") writeAllowances(ctx.dir, [...allowances, made, makeAllowance({ rule, actionKey: key, reason, osUserDigest: record.os_user_digest, lasts: "15m", now: t })], t);
        } catch { /* this action is allowed by the receipt; the next one asks again */ }
      }
      return record;
    }
    if (answer.decision === "deny") { last = { rule, title, outcome: "declined" }; blocked(); return null; }
    // No window: Claude Code's own prompt, only where the workspace allows it and Claude Code really asks the person.
    if (offers.allow && terms.harness_prompt && ctx.harness === "claude" && PROMPTING_MODES.has(ctx.permissionMode ?? "")) {
      return { version: 1, rule, method: "harness_prompt", state: "offered", repeat_of: null, reason_digest: null, reason_length: null,
        os_user_digest: osUserDigest(), decided_at: new Date(t).toISOString() };
    }
    last = { rule, title, outcome: offers.allow ? "unavailable" : "ask_unavailable" };
    blocked();
    return null;
  };
  return { handler, note: () => last };
}

/** A block a person may act on afterwards, from the tray (D144): what the Scopebond window may offer for it now. */
export interface BlockedQuestion {
  item: BlockedItem;
  title: string;
  reason_min: number;
  mode: "override" | "ask";
  offers: { allow: boolean; always: boolean; ask: boolean };
}

/** What the window may offer for an earlier block, under the rules as they are now; null when it is gone, was already acted
 *  on, is older than a week, or the rule no longer lets a person allow or ask. Allowing stops at the daily limit. */
export function blockedQuestion(dir: string, id: string, now = Date.now()): BlockedQuestion | null {
  const item = readBlocked(dir).find((b) => b.id === id);
  if (!item || item.acted || !(now - Date.parse(item.at) < 7 * DAY_MS)) return null;
  let doc: ManagedDocument;
  try { doc = JSON.parse(readFileSync(join(dir, MANAGED_DOC_FILE), "utf8")) as ManagedDocument; } catch { return null; }
  const setting = doc.rules?.[item.rule as ManagedRuleId];
  if (!personMayAct(setting) || !setting?.override) return null;
  const terms = setting.override;
  const dayStart = now - (now % DAY_MS);
  const underLimit = readState(dir).entries.filter((e) => e.rule === item.rule && e.at >= dayStart).length < terms.daily_limit;
  const offers = {
    allow: setting.mode === "override" && underLimit,
    always: setting.mode === "override" && underLimit && terms.always !== undefined && terms.always !== "off",
    ask: setting.mode === "ask" || terms.requests === true,
  };
  if (!offers.allow && !offers.ask) return null;
  return { item, title: RULE_TITLE[item.rule as ManagedRuleId] ?? item.rule, reason_min: terms.reason_min, mode: setting.mode as "override" | "ask", offers };
}

/** Act on an earlier block with the window's answer. Allowing makes an allowance (once: the next try; 15 minutes; or always,
 *  waiting for an admin when the workspace says so) and counts as one of today's overrides; asking queues "Ask an admin".
 *  Scopebond never runs the action itself: the person or the coding agent runs it again. */
export function actOnBlocked(dir: string, id: string, answer: AgentAnswer, now = Date.now()): { outcome: "allowed" | "proposed" | "asked" | "declined" | "gone" } {
  const q = blockedQuestion(dir, id, now);
  if (!q) return { outcome: "gone" };
  const reason = (answer.reason ?? "").trim();
  if (answer.decision !== "allow" && answer.decision !== "ask") return { outcome: "declined" };
  if (reason.length < q.reason_min || reason.length > 500) return { outcome: "declined" };
  const osDigest = answer.os_user ? digestOf(answer.os_user) : osUserDigest();
  if (answer.decision === "ask") {
    if (!q.offers.ask) return { outcome: "declined" };
    queueRequest(dir, { rule: q.item.rule, action_key: q.item.action_key, action_id: q.item.id, summary: q.item.summary, reason, os_user_digest: osDigest, harness: q.item.harness, now });
    markBlocked(dir, id, "asked", now);
    return { outcome: "asked" };
  }
  if (!q.offers.allow) return { outcome: "declined" };
  const lasts = answer.lasts === "always" && q.offers.always ? "always" : answer.lasts === "15m" ? "15m" : "once";
  let doc: ManagedDocument | null = null;
  try { doc = JSON.parse(readFileSync(join(dir, MANAGED_DOC_FILE), "utf8")) as ManagedDocument; } catch { /* checked above */ }
  const terms = doc?.rules?.[q.item.rule as ManagedRuleId]?.override;
  const made = makeAllowance({ rule: q.item.rule, actionKey: q.item.action_key, reason, osUserDigest: osDigest, lasts,
    alwaysDays: terms?.always_days, needsAdmin: terms?.always === "needs_admin", now });
  const allowances = [...readAllowances(dir), made];
  // Waiting for an admin, the person is still covered for 15 minutes.
  if (made.state === "proposed") allowances.push(makeAllowance({ rule: q.item.rule, actionKey: q.item.action_key, reason, osUserDigest: osDigest, lasts: "15m", now }));
  writeAllowances(dir, allowances, now);
  const state = readState(dir);
  state.entries.push({ rule: q.item.rule, action_key: q.item.action_key, action_id: q.item.id, at: now, reason_digest: made.reason_digest, reason_length: made.reason_length });
  try { writeState(dir, state, now); } catch { /* the allowance stands; the workspace counts it again */ }
  markBlocked(dir, id, "allowed", now);
  return { outcome: made.state === "proposed" ? "proposed" : "allowed" };
}

function osUserDigest(): string | null {
  try { return digestOf(userInfo().username); } catch { return null; }
}

/** The sentence added to a denial when the rule allows an override, so the person knows what to do. */
export function overrideHint(note: OverrideNote | null): string | null {
  if (!note) return null;
  switch (note.outcome) {
    case "unavailable": return `Your workspace lets you allow this once with a reason in the Scopebond window, but the Scopebond Agent is not running. Start it (${agentCommand("autostart on")}) and try again.`;
    case "limit": return `You have used today's overrides for "${note.title}". It blocks until tomorrow.`;
    case "declined": return `The override was not given.`;
    case "not_overridable": return null;
    case "asked": return `A request to allow "${note.title}" was sent to your workspace's admins. The Scopebond icon shows their answer; then run it again.`;
    case "ask_unavailable": return `Your workspace lets you ask an admin to allow this, from the Scopebond window, but the Scopebond Agent is not running. Start it (${agentCommand("autostart on")}) and try again.`;
  }
}

export const hasOverrideState = (dir: string): boolean => existsSync(join(dir, OVERRIDE_STATE_FILE));
