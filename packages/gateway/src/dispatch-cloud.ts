// The optional workspace source for the dispatch boundary: approvals a person granted in the
// workspace are consumed there, at the moment of dispatch, and the effective scope of a
// delegated session is read from there.
//
// Two calls, both made with the installation's machine credential (the `observations:write`
// grant), both fail-closed:
//
//   POST /v1/monitoring/approvals/consume   200 { ok: true }  = approved; anything else = not approved
//   GET  /v1/monitoring/delegations?session_id=   the CURRENT resolved delegation
//
// Nothing here decides anything; it reports what the workspace said, or that it could not be
// reached. The guard treats "could not be reached" as "not approved" and "not granted".

import { delegationScopeDigest } from "./dispatch.js";

export const CLOUD_CONSUME_PATH = "/v1/monitoring/approvals/consume";
export const CLOUD_DELEGATIONS_PATH = "/v1/monitoring/delegations";
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
  | { ok: true; delegation: CloudDelegation }
  | { ok: false; reason: "server_refused"; status: number }
  | { ok: false; reason: "bad_response"; detail: string }
  | { ok: false; reason: "unreachable"; detail: string };

export interface CloudDispatchSource {
  consume(request: ConsumeRequest): Promise<ConsumeAnswer>;
  delegation(sessionId: string): Promise<DelegationAnswer>;
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
  return {
    ok: true,
    delegation: { state: state as CloudDelegationState, grants: d.grants === true, effective_entries: entries as string[], effective_scope_digest: d.effective_scope_digest, effective_expires_at: expires as number | null },
  };
}

export function createCloudDispatchSource(options: CloudSourceOptions): CloudDispatchSource {
  const base = options.url.replace(/\/+$/, "");
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
    async delegation(sessionId: string): Promise<DelegationAnswer> {
      let answer: { status: number; body: unknown };
      try { answer = await call(`${CLOUD_DELEGATIONS_PATH}?session_id=${encodeURIComponent(sessionId)}`, { method: "GET" }); }
      catch (error) { return { ok: false, reason: "unreachable", detail: (error as Error).name }; }
      if (answer.status >= 500) return { ok: false, reason: "unreachable", detail: `status ${answer.status}` };
      if (answer.status !== 200) return { ok: false, reason: "server_refused", status: answer.status };
      return parseDelegationAnswer(answer.body);
    },
  };
}
