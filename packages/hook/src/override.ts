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
import { compileManaged, floorDocument, MANAGED_DOC_FILE, RULE_OF_CLAUSE, writeAtomic, type ManagedDocument, type ManagedRuleId } from "./managed.js";
import { defaultRules, loadRules } from "./rules.js";

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

/** One line a person can judge at a glance, from the minimized intent: never file contents or command output. */
export function actionSummary(intent: { action_type?: string; params?: Record<string, unknown> }): string {
  const p = intent.params ?? {};
  const pick = (k: string) => (typeof p[k] === "string" ? String(p[k]) : "");
  const text = intent.action_type === "shell.exec" ? pick("command") || pick("program")
    : intent.action_type === "git.push" ? `git push ${pick("remote")} ${pick("ref")}`.trim()
    : intent.action_type === "net.fetch" ? pick("url") || pick("host")
    : pick("path") || intent.action_type || "an action";
  // Arguments the hook keeps only as a keyed digest stay out of the window.
  const shown = text.replace(/\s*\(hmac-sha256:[0-9a-f]{64}\)/g, "");
  return shown.length > 200 ? `${shown.slice(0, 197)}...` : shown;
}

/** The same action, whatever tool call it came from: its type and parameters without the per-call group id. */
export function actionKey(intent: { action_type?: string; params?: Record<string, unknown> }): string {
  const { action_group: _group, ...params } = intent.params ?? {};
  const sorted = (v: unknown): unknown => Array.isArray(v) ? v.map(sorted)
    : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])])) : v;
  return digestOf(JSON.stringify({ action_type: intent.action_type ?? "", params: sorted(params) }));
}

export interface AgentAnswer { decision: "allow" | "deny" | "unavailable"; reason?: string; os_user?: string }

/** Ask the resident Scopebond Agent to show its window. Returns "unavailable" when no agent answers. */
export async function askAgent(home: string, request: Record<string, unknown>, timeoutMs: number, fetchImpl: typeof fetch = fetch): Promise<AgentAnswer> {
  let endpoint: { port?: unknown; token?: unknown };
  try { endpoint = JSON.parse(readFileSync(join(home, AGENT_FILE), "utf8")) as { port?: unknown; token?: unknown }; }
  catch { return { decision: "unavailable" }; }
  if (!Number.isInteger(endpoint.port) || typeof endpoint.token !== "string") return { decision: "unavailable" };
  try {
    const res = await fetchImpl(`http://127.0.0.1:${endpoint.port as number}/override`, {
      method: "POST", headers: { "content-type": "application/json", [TOKEN_HEADER]: endpoint.token }, body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { decision: "unavailable" };
    const body = await res.json() as AgentAnswer;
    if (body.decision === "allow" && typeof body.reason === "string") return { decision: "allow", reason: body.reason, ...(typeof body.os_user === "string" ? { os_user: body.os_user } : {}) };
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
export interface OverrideNote { rule: ManagedRuleId; title: string; outcome: "declined" | "limit" | "unavailable" | "not_overridable" }

export function createOverrideHandler(ctx: OverrideContext): { handler: OverrideHandler; note(): OverrideNote | null } | null {
  let doc: ManagedDocument;
  try { doc = JSON.parse(readFileSync(join(ctx.dir, MANAGED_DOC_FILE), "utf8")) as ManagedDocument; } catch { return null; }
  if (!Object.values(doc.rules ?? {}).some((r) => r?.mode === "override")) return null;
  const now = ctx.now ?? Date.now;
  let last: OverrideNote | null = null;
  const handler: OverrideHandler = async ({ verdict, action_id, intent, intent_hash }) => {
    const key = actionKey(intent as never);
    const rule = RULE_OF_CLAUSE[verdict.clause_id ?? ""];
    const setting = rule ? doc.rules[rule] : undefined;
    if (!rule || setting?.mode !== "override" || !setting.override) return null;
    const terms = setting.override;
    const title = RULE_TITLE[rule];
    // Would the action still be denied with every overridable rule only recorded? Then a Block rule or Scopebond's own
    // protection denies it too, and no one may override that.
    const floor = compileManaged(loadRules(ctx.dir) ?? defaultRules(), floorDocument(doc), ctx.agentKid);
    const atFloor = evaluate(floor as never, [], { intent, intent_hash }, new Date(now()).toISOString(), { cooperative: true });
    if (!atFloor.allow) { last = { rule, title, outcome: "not_overridable" }; return null; }

    const t = now();
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
    if (state.entries.filter((e) => e.rule === rule && e.at >= dayStart).length >= terms.daily_limit) { last = { rule, title, outcome: "limit" }; return null; }

    const answer = await (ctx.ask ?? askAgent)(ctx.home, {
      action_id, rule, title, summary: actionSummary(intent as never), reason_min: terms.reason_min,
      lasts: terms.minutes > 0 ? `the same action for ${terms.minutes} minutes` : "this action only", timeout_ms: ctx.waitMs ?? 45_000,
    }, (ctx.waitMs ?? 45_000) + 2_000);
    if (answer.decision === "allow") {
      const reason = (answer.reason ?? "").trim();
      if (reason.length < terms.reason_min || reason.length > 500) { last = { rule, title, outcome: "declined" }; return null; }
      const record: OverrideRecord = { version: 1, rule, method: "agent_dialog", state: "allowed", repeat_of: null, reason_digest: digestOf(reason),
        reason_length: reason.length, os_user_digest: answer.os_user ? digestOf(answer.os_user) : osUserDigest(), decided_at: new Date(t).toISOString() };
      state.entries.push({ rule, action_key: key, action_id, at: t, reason_digest: record.reason_digest!, reason_length: reason.length });
      try { writeState(ctx.dir, state, t); } catch { /* the receipt still records it; the count is checked again in the workspace */ }
      return record;
    }
    if (answer.decision === "deny") { last = { rule, title, outcome: "declined" }; return null; }
    // No window: Claude Code's own prompt, only where the workspace allows it and Claude Code really asks the person.
    if (terms.harness_prompt && ctx.harness === "claude" && PROMPTING_MODES.has(ctx.permissionMode ?? "")) {
      return { version: 1, rule, method: "harness_prompt", state: "offered", repeat_of: null, reason_digest: null, reason_length: null,
        os_user_digest: osUserDigest(), decided_at: new Date(t).toISOString() };
    }
    last = { rule, title, outcome: "unavailable" };
    return null;
  };
  return { handler, note: () => last };
}

function osUserDigest(): string | null {
  try { return digestOf(userInfo().username); } catch { return null; }
}

/** The sentence added to a denial when the rule allows an override, so the person knows what to do. */
export function overrideHint(note: OverrideNote | null): string | null {
  if (!note) return null;
  switch (note.outcome) {
    case "unavailable": return `Your workspace lets you allow this once with a reason in the Scopebond window, but the Scopebond Agent is not running. Start it (scopebond-agent run) and try again.`;
    case "limit": return `You have used today's overrides for "${note.title}". It blocks until tomorrow.`;
    case "declined": return `The override was not given.`;
    case "not_overridable": return null;
  }
}

export const hasOverrideState = (dir: string): boolean => existsSync(join(dir, OVERRIDE_STATE_FILE));
