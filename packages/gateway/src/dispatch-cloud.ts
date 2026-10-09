// The optional workspace source for the dispatch boundary: approvals a person granted in the
// workspace are consumed there, at the moment of dispatch, and the effective scope of a
// delegated session is read from there.
//
// Two calls, both made with the installation's machine credential (the `observations:write`
// grant), both fail-closed:
//
//   POST /v1/monitoring/approvals/consume   200 { ok: true }  = approved; anything else = not approved
//   GET  /v1/monitoring/delegations?session_id=[&action_type=&target_id=]   the CURRENT resolved delegation
//        (with an action and a target, also `covers`: the workspace's own answer for that one action)
//   GET  /v1/monitoring/approvals/active?request_hash=&action_type=&target_id=   the id of the active
//        approval bound to exactly that request, when there is one, so nobody has to copy it by hand
//
// Nothing here decides anything; it reports what the workspace said, or that it could not be
// reached. The guard treats "could not be reached" as "not approved" and "not granted".

import { delegationScopeDigest } from "./dispatch.js";

export const CLOUD_CONSUME_PATH = "/v1/monitoring/approvals/consume";
export const CLOUD_DELEGATIONS_PATH = "/v1/monitoring/delegations";
export const CLOUD_ACTIVE_APPROVAL_PATH = "/v1/monitoring/approvals/active";
export const CLOUD_DISPATCH_SCOPE = "observations:write";

/** The closed reasons the workspace gives for refusing a consume. */
export const CONSUME_REFUSALS = [
  "not_found", "wrong_environment", "revoked", "consumed", "expired", "actor_mismatch", "action_mismatch", "policy_mismatch",
  "request_mismatch", "target_mismatch", "clock_uncertain",
] as const;
export type ConsumeRefusal = (typeof CONSUME_REFUSALS)[number];

/** Exactly the body the workspace accepts (strict keys). */
export interface ConsumeRequest {
  approval_id: string;
  request_hash: string;
  action_type: string;
  policy_digest: string;
  target_id: string;
  client_time?: string;
}

export type ConsumeAnswer =
  | { ok: true }
  | { ok: false; reason: ConsumeRefusal }
  /** The workspace answered, but not with a consume or a closed refusal (bad request, credential refused, malformed answer). */
  | { ok: false; reason: "server_refused"; status: number }
  | { ok: false; reason: "unreachable"; detail: string };

export const DELEGATION_STATES = ["active", "ended", "revoked", "expired", "invalid_scope", "unknown_ancestry", "not_found"] as const;
export type CloudDelegationState = (typeof DELEGATION_STATES)[number];

/** The parts of the workspace's resolved delegation the boundary uses. */
export interface CloudDelegation {
  state: CloudDelegationState;
  grants: boolean;
  effective_entries: string[];
  effective_scope_digest: string;
  /** Epoch milliseconds, or null when the scope declared no expiry. */
  effective_expires_at: number | null;
}

export type DelegationAnswer =
  /** `covers` is present only when the question named an action and a target: the workspace's own answer for that action. */
  | { ok: true; delegation: CloudDelegation; covers?: boolean }
  | { ok: false; reason: "server_refused"; status: number }
  | { ok: false; reason: "bad_response"; detail: string }
  | { ok: false; reason: "unreachable"; detail: string };

export interface ActiveApprovalQuery { request_hash: string; action_type: string; target_id: string }

export type ActiveApprovalAnswer =
  | { ok: true; approval_id: string | null }
  | { ok: false; reason: "server_refused"; status: number }
  | { ok: false; reason: "bad_response"; detail: string }
  | { ok: false; reason: "unreachable"; detail: string };

export interface CloudDispatchSource {
  consume(request: ConsumeRequest): Promise<ConsumeAnswer>;
  /** The resolved delegation of a session; with `ask`, also whether it covers that one ordinary action (`target_id` is the opaque id, never the raw target). */
  delegation(sessionId: string, ask?: { action_type: string; target_id: string }): Promise<DelegationAnswer>;
  /** The active approval for exactly this request, action type and target id, if any. Only an id is returned; consuming it is still the only thing that approves. */
  activeApproval(query: ActiveApprovalQuery): Promise<ActiveApprovalAnswer>;
  /** The opaque id this installation gives a target, so no path or ref leaves the machine. */
  targetId(target: string): string;
}

const HEX64 = /^[0-9a-f]{64}$/;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export interface CloudSourceOptions {
  url: string;
  credential: string;
  targetId: (target: string) => string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Read and check the workspace's resolved delegation. The digest it reports must bind the entries it lists. */
export function parseDelegationAnswer(body: unknown): DelegationAnswer {
  const d = isRecord(body) && body.version === 1 && isRecord(body.delegation) ? body.delegation : null;
  if (!d) return { ok: false, reason: "bad_response", detail: "no delegation in the answer" };
  const state = d.state;
  if (typeof state !== "string" || !(DELEGATION_STATES as readonly string[]).includes(state)) return { ok: false, reason: "bad_response", detail: "unknown delegation state" };
  const entries = d.effective_entries;
  if (!Array.isArray(entries) || entries.length > 100 || !entries.every((e) => typeof e === "string" && HEX64.test(e))) return { ok: false, reason: "bad_response", detail: "malformed scope entries" };
  if (typeof d.effective_scope_digest !== "string" || d.effective_scope_digest !== delegationScopeDigest(entries as string[])) return { ok: false, reason: "bad_response", detail: "the scope digest does not bind the listed entries" };
  const expires = d.effective_expires_at;
  if (expires !== null && (typeof expires !== "number" || !Number.isFinite(expires))) return { ok: false, reason: "bad_response", detail: "malformed expiry" };
  if ((body as Record<string, unknown>).covers !== undefined && typeof (body as Record<string, unknown>).covers !== "boolean") return { ok: false, reason: "bad_response", detail: "malformed covers" };
  const covers = (body as Record<string, unknown>).covers as boolean | undefined;
  return {
    ok: true,
    delegation: { state: state as CloudDelegationState, grants: d.grants === true, effective_entries: entries as string[], effective_scope_digest: d.effective_scope_digest, effective_expires_at: expires },
    ...(covers !== undefined ? { covers } : {}),
  };
}

export function createCloudDispatchSource(options: CloudSourceOptions): CloudDispatchSource {
  let end = options.url.length;
  while (end > 0 && options.url.charCodeAt(end - 1) === 47) end--;
  const base = options.url.slice(0, end);
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 3000;
  const headers = { authorization: `Bearer ${options.credential}`, "content-type": "application/json" };
  const call = async (path: string, init: RequestInit): Promise<{ status: number; body: unknown }> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(base + path, { ...init, headers, signal: controller.signal, redirect: "error" });
      let body: unknown = null;
      try { body = await res.json(); } catch { /* not JSON */ }
      return { status: res.status, body };
    } finally { clearTimeout(timer); }
  };
  return {
    targetId: options.targetId,
    async consume(request: ConsumeRequest): Promise<ConsumeAnswer> {
      let answer: { status: number; body: unknown };
      try { answer = await call(CLOUD_CONSUME_PATH, { method: "POST", body: JSON.stringify(request) }); }
      catch (error) { return { ok: false, reason: "unreachable", detail: (error as Error).name }; }
      if (answer.status === 200 && isRecord(answer.body) && answer.body.ok === true) return { ok: true };
      if (answer.status === 409 && isRecord(answer.body) && answer.body.ok === false && typeof answer.body.reason === "string" && (CONSUME_REFUSALS as readonly string[]).includes(answer.body.reason)) {
        return { ok: false, reason: answer.body.reason as ConsumeRefusal };
      }
      // Anything but a 200 success or a closed refusal is "not approved". A 5xx is an outage, not an answer.
      if (answer.status >= 500) return { ok: false, reason: "unreachable", detail: `status ${answer.status}` };
      return { ok: false, reason: "server_refused", status: answer.status };
    },
    async activeApproval(query: ActiveApprovalQuery): Promise<ActiveApprovalAnswer> {
      let answer: { status: number; body: unknown };
      const qs = `request_hash=${encodeURIComponent(query.request_hash)}&action_type=${encodeURIComponent(query.action_type)}&target_id=${encodeURIComponent(query.target_id)}`;
      try { answer = await call(`${CLOUD_ACTIVE_APPROVAL_PATH}?${qs}`, { method: "GET" }); }
      catch (error) { return { ok: false, reason: "unreachable", detail: (error as Error).name }; }
      if (answer.status >= 500) return { ok: false, reason: "unreachable", detail: `status ${answer.status}` };
      if (answer.status !== 200) return { ok: false, reason: "server_refused", status: answer.status };
      const b = answer.body;
      if (!isRecord(b) || b.version !== 1 || typeof b.active !== "boolean") return { ok: false, reason: "bad_response", detail: "malformed active-approval answer" };
      if (!b.active) return { ok: true, approval_id: null };
      return typeof b.approval_id === "string" && /^[!-~]{1,100}$/.test(b.approval_id) ? { ok: true, approval_id: b.approval_id } : { ok: false, reason: "bad_response", detail: "active approval without a usable id" };
    },
    async delegation(sessionId: string, ask?: { action_type: string; target_id: string }): Promise<DelegationAnswer> {
      let answer: { status: number; body: unknown };
      const extra = ask ? `&action_type=${encodeURIComponent(ask.action_type)}&target_id=${encodeURIComponent(ask.target_id)}` : "";
      try { answer = await call(`${CLOUD_DELEGATIONS_PATH}?session_id=${encodeURIComponent(sessionId)}${extra}`, { method: "GET" }); }
      catch (error) { return { ok: false, reason: "unreachable", detail: (error as Error).name }; }
      if (answer.status >= 500) return { ok: false, reason: "unreachable", detail: `status ${answer.status}` };
      if (answer.status !== 200) return { ok: false, reason: "server_refused", status: answer.status };
      return parseDelegationAnswer(answer.body);
    },
  };
}
