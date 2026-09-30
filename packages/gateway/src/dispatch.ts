// Dispatch-boundary contracts: single-use approvals, delegated scope and per-agent
// action budgets. This file is pure (no storage): it defines the wire shapes, the
// canonical request hash, and the checks that do not need shared state. The durable
// half, which makes the decisions atomic across processes, is `dispatch-store.ts`.
//
// Everything here is decided at the point an action is about to be dispatched. An
// approval, a delegation or a budget that cannot be checked is treated as absent, and
// absence is a denial wherever the boundary is enforcing.

import { createPublicKey, sign as edSign, verify as edVerify } from "node:crypto";
import { canonical, sha256 } from "./crypto.js";
import type { PrincipalKeyRegistry } from "./auth.js";

// ── Request hash ──────────────────────────────────────────────────────────────

export const REQUEST_HASH_DOMAIN = "scopebond:dispatch-request/v1\n";

/** Parameters that identify a call, not the request. They differ between two dispatches of
 *  the same request, so an approval cannot bind them. */
const NON_REQUEST_PARAMS = new Set(["action_group", "action_group_size", "action_group_seq"]);

/** Drop the group linkage from an intent's params so the hash covers only the request. */
export function requestParams(params: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params ?? {})) if (!NON_REQUEST_PARAMS.has(k)) out[k] = v;
  return out;
}

/** SHA-256 over a domain string plus the canonical actual request that will be dispatched.
 *  Whatever the caller passes must be the exact object it then forwards. */
export function requestHash(request: unknown): string {
  return sha256(REQUEST_HASH_DOMAIN + canonical(request as never));
}

// ── Approvals (R19) ───────────────────────────────────────────────────────────

export const DISPATCH_APPROVAL_VERSION = "1.0" as const;
/** Default and maximum lifetime of one approval. A narrower configured lifetime wins. */
export const APPROVAL_MAX_LIFETIME_MS = 5 * 60_000;
export const APPROVAL_MAX_SKEW_MS = 30_000;

/** One approval of one action. It names who may use it, what it permits, the policy it was
 *  granted under and the exact request; it is valid once, until it expires. */
export interface DispatchApproval {
  version: typeof DISPATCH_APPROVAL_VERSION;
  approval_id: string;
  approver: { kid: string; alg: "Ed25519" };
  /** The acting agent this approval is for. */
  actor: string;
  action_type: string;
  /** The resource the action reaches (a path, a ref, a `server/tool`). */
  target: string;
  /** Digest of the policy in force when it was granted. */
  policy_digest: string;
  /** `requestHash()` of the actual request. */
  request_hash: string;
  issued_at: string;
  expires_at: string;
  signature: string;
}

export function approvalClaims(a: DispatchApproval): Omit<DispatchApproval, "signature"> {
  return {
    version: a.version, approval_id: a.approval_id, approver: a.approver, actor: a.actor, action_type: a.action_type,
    target: a.target, policy_digest: a.policy_digest, request_hash: a.request_hash, issued_at: a.issued_at, expires_at: a.expires_at,
  };
}

const ID = /^[\x21-\x7e]{8,200}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const validTime = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));

export function validateDispatchApproval(v: unknown): v is DispatchApproval {
  if (!isRecord(v)) return false;
  const keys = ["version", "approval_id", "approver", "actor", "action_type", "target", "policy_digest", "request_hash", "issued_at", "expires_at", "signature"];
  if (Object.keys(v).length !== keys.length || !keys.every((k) => k in v)) return false;
  const ap = v.approver;
  return v.version === DISPATCH_APPROVAL_VERSION && typeof v.approval_id === "string" && ID.test(v.approval_id) &&
    isRecord(ap) && typeof ap.kid === "string" && ap.kid !== "" && ap.alg === "Ed25519" &&
    typeof v.actor === "string" && v.actor !== "" && typeof v.action_type === "string" && v.action_type !== "" &&
    typeof v.target === "string" && typeof v.policy_digest === "string" && v.policy_digest !== "" &&
    typeof v.request_hash === "string" && HEX64.test(v.request_hash) &&
    validTime(v.issued_at) && validTime(v.expires_at) && typeof v.signature === "string" && v.signature.length >= 40;
}

export type ApprovalRejection =
  | "malformed" | "unknown_approver" | "bad_signature" | "self_approval" | "wrong_actor" | "wrong_action"
  | "wrong_target" | "wrong_policy" | "changed_request" | "expired" | "not_yet_valid" | "bad_lifetime";

/** What an action presents to the boundary for the approval to be judged against. */
export interface ApprovalSubject {
  actor: string;
  action_type: string;
  target: string;
  policy_digest: string;
  request_hash: string;
}

/** Check an approval against the action about to be dispatched. Signature and every binding
 *  are verified; single use is enforced separately, atomically, by the store. */
export async function checkApproval(
  approval: unknown, subject: ApprovalSubject, keys: PrincipalKeyRegistry, nowMs: number,
  options: { maxLifetimeMs?: number; maxSkewMs?: number } = {},
): Promise<{ ok: true; approval: DispatchApproval } | { ok: false; reason: ApprovalRejection }> {
  if (!validateDispatchApproval(approval)) return { ok: false, reason: "malformed" };
  const maxLife = Math.min(options.maxLifetimeMs ?? APPROVAL_MAX_LIFETIME_MS, APPROVAL_MAX_LIFETIME_MS);
  const skew = options.maxSkewMs ?? APPROVAL_MAX_SKEW_MS;
  const issued = Date.parse(approval.issued_at);
  const expires = Date.parse(approval.expires_at);
  if (expires <= issued || expires - issued > maxLife) return { ok: false, reason: "bad_lifetime" };
  // Clock uncertainty beyond the allowed skew rejects the approval rather than stretching it.
  if (issued > nowMs + skew) return { ok: false, reason: "not_yet_valid" };
  if (expires <= nowMs) return { ok: false, reason: "expired" };
  if (approval.actor !== subject.actor) return { ok: false, reason: "wrong_actor" };
  if (approval.action_type !== subject.action_type) return { ok: false, reason: "wrong_action" };
  if (approval.target !== subject.target) return { ok: false, reason: "wrong_target" };
  if (approval.policy_digest !== subject.policy_digest) return { ok: false, reason: "wrong_policy" };
  if (approval.request_hash !== subject.request_hash) return { ok: false, reason: "changed_request" };
  if (approval.approver.kid === subject.actor) return { ok: false, reason: "self_approval" };
  let record;
  try { record = await keys.resolve(approval.approver.kid, "approver"); } catch { record = null; }
  if (!record || record.status === "revoked" || !record.purposes.includes("approver")) return { ok: false, reason: "unknown_approver" };
  try {
    const ok = edVerify(null, Buffer.from(canonical(approvalClaims(approval) as never)), createPublicKey(record.publicKeyPem), Buffer.from(approval.signature, "base64"));
    if (!ok) return { ok: false, reason: "bad_signature" };
  } catch { return { ok: false, reason: "bad_signature" }; }
  return { ok: true, approval };
}

// ── Delegation (R20) ──────────────────────────────────────────────────────────

/** What a session may do. A target entry ending in `*` is a prefix; anything else is exact.
 *  Absent `targets` means any target for the listed action types. */
export interface DelegatedScope {
  action_types: string[];
  targets?: string[];
}

export interface Delegation {
  delegation_id: string;
  /** Null for a root grant issued by the person who owns the agent. */
  parent_id: string | null;
  /** The agent or session identity this grant is for. */
  actor: string;
  scope: DelegatedScope;
  scope_digest: string;
  issued_at: string;
  expires_at: string;
}

export const scopeDigest = (scope: DelegatedScope): string =>
  sha256("scopebond:delegated-scope/v1\n" + canonical({ action_types: [...scope.action_types].sort(), targets: scope.targets ? [...scope.targets].sort() : null } as never));

const covers = (parent: string, child: string): boolean =>
  parent === child || (parent.endsWith("*") && child.startsWith(parent.slice(0, -1)));

/** Whether one target is inside a scope's target set. */
export function targetInScope(scope: DelegatedScope, target: string): boolean {
  return scope.targets === undefined || scope.targets.some((t) => covers(t, target));
}

/** Whether an action type and target are inside a scope. */
export function actionInScope(scope: DelegatedScope, actionType: string, target: string): boolean {
  return scope.action_types.includes(actionType) && targetInScope(scope, target);
}

/** A child scope is allowed only if it is a subset of the parent: every action type is the
 *  parent's, and every child target is covered by a parent target. A child that names no
 *  targets under a parent that does would widen the scope, so it is refused. */
export function isSubScope(child: DelegatedScope, parent: DelegatedScope): boolean {
  if (!child.action_types.length || !child.action_types.every((t) => parent.action_types.includes(t))) return false;
  if (parent.targets === undefined) return true;
  if (child.targets === undefined || !child.targets.length) return false;
  return child.targets.every((t) => parent.targets!.some((p) => covers(p, t)));
}

export type DelegationProblem =
  | "malformed" | "digest_mismatch" | "unknown_parent" | "parent_revoked" | "parent_expired" | "not_subset"
  | "outlives_parent" | "already_exists" | "expired" | "depth";

export const MAX_DELEGATION_DEPTH = 16;

export function validateDelegation(d: unknown): d is Delegation {
  if (!isRecord(d) || !isRecord(d.scope)) return false;
  const s = d.scope;
  const strings = (x: unknown): x is string[] => Array.isArray(x) && x.every((e) => typeof e === "string" && e !== "");
  return typeof d.delegation_id === "string" && ID.test(d.delegation_id) &&
    (d.parent_id === null || (typeof d.parent_id === "string" && ID.test(d.parent_id))) &&
    typeof d.actor === "string" && d.actor !== "" && strings(s.action_types) && s.action_types.length > 0 &&
    (s.targets === undefined || strings(s.targets)) && typeof d.scope_digest === "string" &&
    validTime(d.issued_at) && validTime(d.expires_at) && Date.parse(d.expires_at) > Date.parse(d.issued_at);
}

// ── Workspace delegation scope (declared by a session, resolved by the workspace) ──
//
// A session may declare its scope as a list of opaque entries, each the digest of a kind and a value,
// plus one digest binding the sorted list. The workspace resolves the effective scope down the whole
// ancestor chain. These formulas are shared with the workspace byte for byte; the vectors in the
// tests pin them.

export const DELEGATION_SCOPE_DOMAIN = "scopebond:delegation-scope/v1\n";
export const SCOPE_ENTRY_DOMAIN = "scopebond:scope-entry/v1\u0000";

/** SHA-256 of the domain plus the canonical (RFC 8785) sorted, de-duplicated entry list. */
export const delegationScopeDigest = (entries: readonly string[]): string =>
  sha256(DELEGATION_SCOPE_DOMAIN + canonical([...new Set(entries)].sort() as never));

/** One scope entry: SHA-256 of the domain, the kind and the value, separated by NUL. */
export const scopeEntryDigest = (kind: string, value: string): string => sha256(`${SCOPE_ENTRY_DOMAIN}${kind}\u0000${value}`);

/** The entry that authorizes granting `permission` on `resourceScope`. */
export const privilegeScopeEntry = (resourceScope: string, permission: string): string => scopeEntryDigest("privilege", `${resourceScope}\u0000${permission}`);

/** The entries that would cover one dispatch intent: the exact action on the exact target, or every target of the action type (`*`). */
export const actionScopeEntries = (actionType: string, target: string): { exact: string; anyTarget: string } => ({
  exact: scopeEntryDigest("action", `${actionType}\u0000${target}`),
  anyTarget: scopeEntryDigest("action", `${actionType}\u0000*`),
});

// ── Action budgets (§4.1) ─────────────────────────────────────────────────────

export type BudgetMode = "monitor" | "enforce";
export type BudgetAuthority = "installation" | "shared_gateway";

/** A reviewed per-agent limit on how many actions may be dispatched in a window. It counts
 *  dispatched parent actions, never money or tokens. */
export interface ActionBudgetPolicy {
  budget_id: string;
  actor: string;
  /** The action types counted. A parent action counts once if any of its intents is one of these. */
  operations: string[];
  authority_scope: BudgetAuthority;
  max: number;
  window_seconds: number;
  mode: BudgetMode;
  version: number;
  /** When this reviewed policy stops being valid; an expired enforce policy denies. */
  expires_at: string;
  /** Set only when a person has accepted this exact policy. */
  acknowledgement: null | { digest: string; acknowledged_at: string };
  /** A withdrawn policy. An enforce policy withdrawn without a replacement denies. */
  revoked?: boolean;
}

/** The digest an acknowledgement must echo: everything but the acknowledgement itself. */
export function budgetDigest(p: ActionBudgetPolicy): string {
  const { acknowledgement: _ack, ...rest } = p;
  return sha256("scopebond:action-budget/v1\n" + canonical(rest as never));
}

export function validateBudgetPolicy(p: unknown): p is ActionBudgetPolicy {
  if (!isRecord(p)) return false;
  const ack = p.acknowledgement;
  return typeof p.budget_id === "string" && ID.test(p.budget_id) && typeof p.actor === "string" && p.actor !== "" &&
    Array.isArray(p.operations) && p.operations.length > 0 && p.operations.every((o) => typeof o === "string" && o !== "") &&
    (p.authority_scope === "installation" || p.authority_scope === "shared_gateway") &&
    Number.isInteger(p.max) && (p.max as number) >= 1 && (p.max as number) <= 1_000_000_000 &&
    Number.isInteger(p.window_seconds) && (p.window_seconds as number) >= 1 && (p.window_seconds as number) <= 366 * 86_400 &&
    (p.mode === "monitor" || p.mode === "enforce") && Number.isInteger(p.version) && (p.version as number) >= 1 &&
    validTime(p.expires_at) &&
    (ack === null || (isRecord(ack) && typeof ack.digest === "string" && validTime(ack.acknowledged_at)));
}

/** The suggested starting point: 100 dispatches in 60 seconds, monitoring only, not acknowledged.
 *  Nothing enforces it until a person changes the mode and acknowledges the result. */
export function defaultBudgetTemplate(actor: string, operations: string[], now: Date = new Date()): ActionBudgetPolicy {
  return {
    budget_id: `budget:${sha256(`${actor}\0${operations.join(",")}`).slice(0, 24)}`, actor, operations, authority_scope: "installation",
    max: 100, window_seconds: 60, mode: "monitor", version: 1,
    expires_at: new Date(now.getTime() + 90 * 86_400_000).toISOString(), acknowledgement: null,
  };
}

/** A policy is acknowledged when the acknowledgement echoes exactly this policy's digest. */
export const budgetAcknowledged = (p: ActionBudgetPolicy): boolean => p.acknowledgement !== null && p.acknowledgement.digest === budgetDigest(p);

// ── The guard's contract, shared by every boundary ────────────────────────────

/** One action about to be dispatched. `request` is the exact object that will be forwarded. */
export interface DispatchIntent {
  action_type: string;
  target: string;
  request: unknown;
}

export interface DispatchRequest {
  actor: string;
  /** The parent action: one tool call, however many intents it maps to. A retry of the same call keeps it. */
  action_group: string;
  policy_digest: string;
  intents: DispatchIntent[];
  /** The delegation the acting session runs under, when it is a delegated child. */
  delegation_id?: string;
}

export type DispatchReason =
  | "ok" | "approval_required" | "approval_rejected" | "approval_replayed" | "approval_unavailable" | "delegation_unknown" | "delegation_revoked"
  | "delegation_expired" | "delegation_out_of_scope" | "delegation_wrong_actor" | "budget_exceeded" | "budget_unacknowledged"
  | "budget_expired" | "budget_revoked" | "budget_capability_unsupported" | "clock_rollback" | "counter_unavailable";

export interface BudgetObservation {
  budget_id: string;
  version: number;
  mode: BudgetMode;
  authority_scope: BudgetAuthority;
  count: number;
  max: number;
  window_seconds: number;
  /** `within` and `at_limit` are counts up to and including max; `over` is beyond it (monitor only records it). */
  state: "within" | "at_limit" | "over" | "unavailable" | "unenforceable";
  /** True when this parent action was already counted (a retry of the same call). */
  repeated: boolean;
}

export interface DispatchDecision {
  allow: boolean;
  reason: DispatchReason;
  detail?: string;
  /** Approval ids consumed by this dispatch. */
  consumed_approvals: string[];
  budgets: BudgetObservation[];
}

/** What the gateway, the hook and the MCP proxy call immediately before permitted dispatch. */
export interface DispatchGuard {
  authorize(request: DispatchRequest): Promise<DispatchDecision>;
}

// ── Building a request from an intent ─────────────────────────────────────────

/** The resource an intent reaches, read from its parameters: a path, a ref, a URL, an MCP
 *  `server/tool`, a program, or the asset. Empty when the intent names none. */
export function intentTarget(intent: { action_type: string; params?: Record<string, unknown>; asset?: string }): string {
  const p = intent.params ?? {};
  const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
  if (intent.action_type === "mcp.tool.call") return `${str(p.server) ?? ""}/${str(p.tool) ?? ""}`;
  return str(p.path) ?? str(p.ref) ?? str(p.url) ?? str(p.program) ?? str(p.resource) ?? str(intent.asset) ?? "";
}

/** The dispatch intent for one policy intent: what is approved and hashed is the intent as it
 *  will be acted on, without the parent-group linkage. */
export function dispatchIntentOf(intent: { action_type: string; params?: Record<string, unknown>; asset?: string; amount?: number }): DispatchIntent {
  return {
    action_type: intent.action_type, target: intentTarget(intent),
    request: { action_type: intent.action_type, params: requestParams(intent.params), ...(intent.asset !== undefined ? { asset: intent.asset } : {}), ...(intent.amount !== undefined ? { amount: intent.amount } : {}) },
  };
}

/** Sign an approval. This is what the approver's tooling runs; it is here so the wire format has one reference. */
export function signDispatchApproval(privateKey: import("node:crypto").KeyObject, claims: Omit<DispatchApproval, "signature">): DispatchApproval {
  return { ...claims, signature: edSign(null, Buffer.from(canonical(claims as never)), privateKey).toString("base64") };
}
