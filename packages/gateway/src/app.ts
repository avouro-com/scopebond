// The gateway: a Hono app wiring policy enforcement (scopebond-verify), receipt
// countersigning + storage, the kill switch, and HTTP + MCP ingress. The Hono app
// is runtime-agnostic (ADR-004) and testable in-process via app.request().

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Context } from "hono";
import { evaluate } from "./engine.js";
import type { Decision } from "./engine.js";
import { dispatchIntentOf } from "./dispatch.js";
import type { DispatchGuard } from "./dispatch.js";
import {
  buildReceipt, createAttester, MemoryReceiptStore, canonical, sha256, intentHash,
  minimizeIntentForEvidence, REDACTION_PROFILE,
  CANONICALIZATION,
} from "./receipts.js";
import type {
  Attester, ReceiptStore, SignedReceipt, Anchor, ExecutionState, RealtimeResult,
  AuthorityFinalState, ActionLifecycleRecord, ReceiptContext, PriorScope, OverrideRecord,
} from "./receipts.js";
import { handleMcp } from "./mcp.js";
import { merkleProof } from "./anchor.js";
import {
  ANCHOR_ALGO_V1, ANCHOR_ALGO_V2, ANCHOR_TYPE, receiptLeafHash, merkleTreeHash, inclusionProof, consistencyProof,
  verifyAnchorRoot, isAnchorV2,
} from "@scopebond/verify/anchor";
import type { AnchorV2, AnchorV2Body } from "@scopebond/verify/anchor";
import { validateIntent, validatePolicy, historyNeed, boundPrior, VERIFIER_VERSION as VERIFY_VERSION } from "@scopebond/verify";
import type { Policy, Intent, Approval, Verdict, HistoryNeed } from "@scopebond/verify";
import { authenticateRequest, AuthorizationError } from "./auth.js";
import type {
  AuthenticationConfig, AuthorizationEvidence, GatewayAuthentication, SignedApproval, SignedIntentAuthorization,
} from "./auth.js";

/** How an allowed action is actually carried out. Default: a no-op (record only).
 *  Real forwarding (HTTP proxy, MCP passthrough) is a swappable implementation. */
export interface Executor {
  /** Stable adapter identity used to ensure the same integration reconciles a dispatch. */
  id?: string;
  /** Simulation never claims that an external action occurred. */
  mode?: "simulation" | "dispatch";
  /** Integration-specific structural validation before authorization/reservation. */
  validate?(intent: Intent): void;
  execute(intent: Intent, context: { actionId: string }): ExecutionResult | Promise<ExecutionResult>;
  /** Query a prior dispatch by its durable idempotency key. It must never create an effect. */
  query?(context: { actionId: string }): ExecutionQueryResult | Promise<ExecutionQueryResult>;
}
export interface ExecutionResult { ref: string; output?: unknown; }
export type ExecutionQueryResult =
  | { state: "executed"; ref: string; output?: unknown }
  | { state: "failed"; ref: string | null; output?: unknown }
  | { state: "outcome_unknown"; ref?: string | null };
export const noopExecutor: Executor = {
  id: "scopebond:simulation", mode: "simulation", execute: () => ({ ref: "simulation:no-dispatch" }),
};

export interface GatewayConfig {
  policy: Policy;
  /** The largest request body accepted, in bytes (default 1 MiB). A larger one is refused with 413 before it is read. */
  maxBodyBytes?: number;
  store?: ReceiptStore;
  executor?: Executor;
  attester?: Attester;
  /** Injectable clock for determinism/testing. */
  now?: () => string;
  /** Principal-key verification. Insecure mode must be selected explicitly. */
  authentication: GatewayAuthentication;
  /** True only when this coordinator owns the complete receipt set for global
   * policy clauses. Global limits fail closed by default. */
  gatewaysComplete?: boolean;
  /** Bearer token for receipt reads and emergency-control routes. Without it,
   * those routes remain unavailable. */
  control?: { bearerToken: string };
  /** Recovery/inspection mode: new outbound dispatch and result queries are disabled. */
  outboundExecution?: boolean;
  /** Enforcement mode. `"enforce"` (default) simulates or dispatches an allowed
   * action; `"check_only"` (M0 / cooperative) never touches an executor — an
   * allowed action is recorded as `cooperative_allow` (executed: false) and the
   * agent performs it itself. Must be selected explicitly; it is never implicit. */
  mode?: "enforce" | "check_only";
  /** The dispatch boundary: single-use approvals, delegated scope and action budgets, decided
   *  immediately before an allowed action is dispatched (or, in check-only mode, allowed). A denial
   *  here is a denial: nothing is dispatched and nothing it would have spent is spent. */
  dispatchGuard?: DispatchGuard;
}

export interface ActionRequest {
  intent: Intent;
  authorization?: SignedIntentAuthorization;
  approval?: SignedApproval | Approval;
}
export interface ActionResult { allowed: boolean; reason: string; verdict?: Verdict; receipt: SignedReceipt; output?: unknown; }
export interface ObservationResult { observed: true; receipt: SignedReceipt; }

export class DuplicateActionError extends Error {
  readonly status = 409 as const;
  constructor() { super("action id has already been consumed"); this.name = "DuplicateActionError"; }
}

export class AuthorityUnavailableError extends Error {
  readonly status = 503 as const;
  constructor() { super("receipt store does not provide atomic authority reservations for dispatch"); this.name = "AuthorityUnavailableError"; }
}

export class ReconciliationUnavailableError extends Error {
  readonly status = 503 as const;
  constructor(message: string) { super(message); this.name = "ReconciliationUnavailableError"; }
}

export class ExecutorInputError extends Error {
  readonly status = 400 as const;
  constructor(message: string) { super(message); this.name = "ExecutorInputError"; }
}

/** Asked once when policy denies an action (never for the kill switch or the dispatch boundary): return the override record when
 *  a person allows it, or null to keep the denial. The caller is responsible for who may answer; the gateway only records it. */
export type OverrideHandler = (ctx: { verdict: Verdict; action_id: string; intent: Intent; intent_hash: string }) => Promise<OverrideRecord | null>;
export interface ActionOptions { override?: OverrideHandler }

export interface Gateway {
  app: Hono;
  store: ReceiptStore;
  attester: Attester;
  state: { killed: boolean };
  policyHash: string;
  handleAction(req: ActionRequest, options?: ActionOptions): Promise<ActionResult>;
  /** M0 cooperative check: evaluate and countersign a decision without ever
   * dispatching. An allowed action is recorded as `cooperative_allow`
   * (executed: false); the caller performs the action itself. Equivalent to a
   * `check_only`-mode `handleAction`, but forced regardless of configured mode. */
  check(req: ActionRequest): Promise<ActionResult>;
  /** Record a passive observation without evaluating or dispatching it. */
  observeAction(req: ActionRequest): Promise<ObservationResult>;
  /** Hot-swap the active policy (recomputes the policy hash + version). */
  setPolicy(policy: Policy): void;
  /** Compute, sign and store a v2 (RFC 9162) anchor over the receipts to date. */
  anchor(): Promise<AnchorV2>;
  unresolvedActions(): Promise<ActionLifecycleRecord[]>;
  reconcileAction(actionId: string): Promise<ActionLifecycleRecord>;
}

// Imported rather than repeated: SPEC.md says this names the violates() version that
// produced the verdict, and the literal that used to live here drifted three releases
// behind the real one, so every receipt misnamed its own verifier.
const VERIFIER_VERSION = VERIFY_VERSION;

export function createGateway(config: GatewayConfig): Gateway {
  if (!config.authentication) throw new Error("gateway authentication configuration is required");
  const store = config.store ?? new MemoryReceiptStore();
  const executor = config.executor ?? noopExecutor;
  const attester = config.attester ?? createAttester();
  if (attester.kid !== deriveAttesterKid(attester.publicKeyJwk)) {
    throw new Error("attester kid must match the public-key fingerprint for evidence contract v1");
  }
  assertValidPolicy(config.policy);
  let policy = structuredClone(config.policy);
  let policyHash = sha256(canonical(policy));
  let policyVersion = (policy.version as number) ?? 1;
  let policyHistory = historyNeed(policy);
  const now = config.now ?? (() => new Date().toISOString());
  const state = { killed: false };

  async function isStopped(signer?: string): Promise<boolean> {
    const durable = await store.getStopState?.();
    if (durable) {
      state.killed = durable.global;
      return durable.global || (!!signer && durable.agents.includes(signer));
    }
    return state.killed;
  }

  async function setStopped(target: "global" | string, stopped: boolean): Promise<void> {
    if (store.setStopped) await store.setStopped(target, stopped);
    if (target === "global") state.killed = stopped;
  }

  function requireControl(c: Context): Response | null {
    const expected = config.control?.bearerToken;
    if (!expected) return c.json({ error: "control API is not configured" }, 503);
    if (expected.length < 24) return c.json({ error: "control API token is invalid" }, 503);
    const supplied = c.req.header("authorization") ?? "";
    if (!constantTimeTextEqual(supplied, `Bearer ${expected}`)) return c.json({ error: "unauthorized" }, 401);
    return null;
  }

  async function authorize(req: ActionRequest, ts: string, policyRef: { id: string | null; version: number; digest: string }): Promise<{
    evidence: AuthorizationEvidence;
    approvalForPolicy?: Approval;
  }> {
    const authentication = config.authentication;
    if (!("keys" in authentication)) {
      return {
        evidence: { mode: "insecure_development", agent: null, approval: null },
        approvalForPolicy: req.approval as Approval | undefined,
      };
    }
    const { requestIds: usedRequestIds, approvalIds: usedApprovalIds } = await usedAuthorizations(req, ts, authentication);
    return authenticateRequest(
      req.intent, req.authorization, req.approval, authentication, ts, policyRef,
      usedRequestIds, usedApprovalIds,
    );
  }

  /** Which of this request's ids were already used. A store that can look one id up answers for just this request, within
   *  the time any still-valid authorization could have been used: an authorization lives at most `maxLifetimeMs` and is
   *  accepted at most `maxClockSkewMs` early, so a use older than both cannot collide with one that is still fresh. Reading
   *  the whole log instead parsed every receipt on every action (hundreds of megabytes on a long-used computer). */
  async function usedAuthorizations(req: ActionRequest, ts: string, authentication: AuthenticationConfig): Promise<{ requestIds: Set<string>; approvalIds: Set<string> }> {
    const requestId = idField(req.authorization, "request_id");
    const approvalId = idField(req.approval, "approval_id");
    const windowMs = (authentication.maxLifetimeMs ?? 5 * 60_000) + (authentication.maxClockSkewMs ?? 30_000) + REPLAY_MARGIN_MS;
    const since = new Date(Date.parse(ts) - windowMs);
    const lookup = (store as ReceiptStore).authorizationUsed?.bind(store);
    if (lookup && Number.isFinite(since.getTime())) {
      const sinceIso = since.toISOString();
      const used = async (kind: "request_id" | "approval_id", id: string | null) => !!id && await lookup(kind, id, sinceIso);
      return {
        requestIds: new Set(requestId && await used("request_id", requestId) ? [requestId] : []),
        approvalIds: new Set(approvalId && await used("approval_id", approvalId) ? [approvalId] : []),
      };
    }
    const requestIds = new Set<string>();
    const approvalIds = new Set<string>();
    for (const receipt of await store.list()) {
      const evidence = receipt.payload.authorization;
      if (evidence?.agent?.request_id) requestIds.add(evidence.agent.request_id);
      if (evidence?.approval?.approval_id) approvalIds.add(evidence.approval.approval_id);
    }
    return { requestIds, approvalIds };
  }

  async function handleAction(req: ActionRequest, opts?: { checkOnly?: boolean } & ActionOptions): Promise<ActionResult> {
    // Check-only (M0): never dispatch; an allowed action is a cooperative allow.
    // The flag defaults to the gateway's configured mode and can be forced per
    // call by `check()`, but is never implicitly turned on.
    const checkOnly = opts?.checkOnly ?? (config.mode === "check_only");
    assertValidIntent(req.intent);
    const ts = now();
    const ih = intentHash(req.intent);
    const minimized = minimizeIntentForEvidence(req.intent);
    const evidenceHash = intentHash(minimized.intent);
    const attesterRef = { kind: "gateway" as const, kid: attester.kid };
    const activePolicy = structuredClone(policy);
    const activePolicyHash = policyHash;
    const activePolicyVersion = policyVersion;
    const activeHistory = policyHistory;
    const policyRef = {
      id: typeof activePolicy.policy_id === "string" ? activePolicy.policy_id : null,
      version: activePolicyVersion,
      digest: activePolicyHash,
    };
    const authenticated = await authorize(req, ts, policyRef);
    executor.validate?.(req.intent);
    const actionId = authenticated.evidence.agent?.request_id ?? globalThis.crypto.randomUUID();

    const receiptContext: ReceiptContext = {
      evidence_version: "1.0",
      canonicalization: CANONICALIZATION,
      intent: minimized.intent,
      intent_hash: ih,
      action_ref: { action_id: actionId, authorized_intent_hash: ih, evidence_intent_hash: evidenceHash },
      policy_hash: activePolicyHash,
      policy_version: activePolicyVersion,
      policy_ref: policyRef,
      verifier_version: VERIFIER_VERSION,
      redaction: { profile: REDACTION_PROFILE, paths: minimized.redactedPaths },
      authorization: authenticated.evidence,
      attester: attesterRef,
      timestamp: ts,
      // Tag the class explicitly when the agent signed (§15). Unsigned/dev
      // receipts stay legacy (absent) and are classified at read time.
      ...(authenticated.evidence.agent ? { evidence_class: "signed_intent" as const } : {}),
    };
    const receiptFields = (
      realtimeResult: RealtimeResult,
      executionState: ExecutionState,
      assertion: "none" | "gateway_simulation" | "adapter_reported_success" | "adapter_reported_failure" | "adapter_outcome_unknown",
      executionRef: string | null,
    ) => ({
      ...receiptContext,
      realtime_result: realtimeResult,
      executed: executionState === "executed",
      execution_ref: executionRef,
      execution: {
        state: executionState,
        assertion,
        reference: executionRef,
        external_effect: "not_independently_verified" as const,
      },
    });
    const reservation = {
      action_id: actionId,
      candidate: {
        intent: minimized.intent,
        action_id: actionId,
        intent_hash: ih,
        // A cooperative allow is never counted as executed — not even transiently
        // while reserved — so it cannot inflate a spend window it did not dispatch.
        executed: !checkOnly,
        realtime_result: "allow",
        timestamp: ts,
        approval: authenticated.approvalForPolicy,
      },
      policy_ref: policyRef,
      policy_snapshot: canonical(activePolicy),
      authorization_ids: {
        ...(authenticated.evidence.agent?.request_id ? { request_id: authenticated.evidence.agent.request_id } : {}),
        ...(authenticated.evidence.approval?.approval_id ? { approval_id: authenticated.evidence.approval.approval_id } : {}),
      },
      receipt_context: receiptContext,
    };

    // Fail closed: while killed, deny everything and record the denial.
    if (await isStopped(req.intent.signer)) {
      if (store.reserveAction) {
        const attempt = await store.reserveAction(reservation, () => ({ allow: false }), { kind: "none" });
        if (attempt.duplicate) return await duplicateActionResult(actionId);
      }
      const receipt = await buildReceipt({
        ...receiptFields("deny", "denied", "none", null),
      }, attester);
      if (store.finalizeAction && store.reserveAction) await store.finalizeAction(actionId, receipt, "denied");
      else await store.put(receipt);
      return { allowed: false, reason: "kill switch active (fail closed)", receipt };
    }

    // Read only the history this policy can see: a store loads the scope (or more), and
    // `boundPrior` trims it to the exact set, so the verdict and its `inputs_hash` do not
    // depend on which store answered.
    const scope = priorScope(activeHistory, ts);
    const decide = (prior: Awaited<ReturnType<ReceiptStore["executed"]>>) => evaluate(
      activePolicy, boundPrior(activeHistory, prior, ts),
      { intent: req.intent, approval: authenticated.approvalForPolicy, intent_hash: ih },
      ts, { gatewaysComplete: config.gatewaysComplete ?? false, cooperative: checkOnly },
    );
    let d: Decision;
    if (store.reserveAction) {
      const attempt = await store.reserveAction(reservation, decide, scope);
      if (attempt.duplicate) return await duplicateActionResult(actionId);
      d = attempt.decision;
    } else {
      if (executor.mode === "dispatch") throw new AuthorityUnavailableError();
      d = decide(await store.executed(scope));
    }

    // A person may override a policy denial (warn mode). Asked only for a policy verdict, never while the kill switch is on;
    // the overridden action still goes through the dispatch boundary below, and a later denial drops the override.
    let override: OverrideRecord | null = null;
    if (!d.allow && d.realtime_result === "deny" && opts?.override && !(await isStopped(req.intent.signer))) {
      override = await opts.override({ verdict: d.verdict, action_id: actionId, intent: req.intent, intent_hash: ih });
      if (override) d = { ...d, allow: true, realtime_result: "approved", clause_mode: "enforce" };
    }

    // The dispatch boundary. It runs only for an action policy has already allowed, after the kill
    // switch and before any executor, and it answers with everything it spent or nothing at all.
    let guardDenied: string | null = null;
    if (d.allow && config.dispatchGuard && !(await isStopped(req.intent.signer))) {
      const group = (req.intent.params as Record<string, unknown> | undefined)?.action_group;
      let verdict;
      try {
        verdict = await config.dispatchGuard.authorize({
          actor: req.intent.signer ?? "", action_group: typeof group === "string" && group !== "" ? group : actionId,
          policy_digest: activePolicyHash, intents: [dispatchIntentOf(req.intent as never)],
        });
      } catch (error) {
        verdict = { allow: false, reason: "counter_unavailable" as const, detail: (error as Error).message, consumed_approvals: [], budgets: [] };
      }
      if (!verdict.allow) {
        guardDenied = `dispatch boundary: ${verdict.reason}${verdict.detail ? ` (${verdict.detail})` : ""}`;
        d = { ...d, allow: false, realtime_result: "deny", clause_mode: "enforce" };
      }
    }

    let ref: string | null = null;
    let output: unknown;
    let executionState: ExecutionState = "denied";
    let assertion: "none" | "gateway_simulation" | "adapter_reported_success" | "adapter_reported_failure" | "adapter_outcome_unknown" = "none";
    const outboundDisabled = config.outboundExecution === false && executor.mode === "dispatch";
    const stoppedBeforeDispatch = d.allow && (outboundDisabled || await isStopped(req.intent.signer));
    if (d.allow && !stoppedBeforeDispatch) {
      if (checkOnly) {
        // Cooperative enforcement (M0): the gateway decides but does not act; the
        // agent performs the allowed action itself. No executor is invoked, and the
        // receipt asserts nothing about execution beyond the policy decision.
        executionState = "cooperative_allow";
        assertion = "none";
      } else if (executor.mode === "simulation") {
        const result = await executor.execute(req.intent, { actionId });
        ref = result.ref;
        output = result.output;
        executionState = "simulated";
        assertion = "gateway_simulation";
      } else {
        if (!store.prepareDispatch) throw new AuthorityUnavailableError();
        const pendingReceipt = await buildReceipt({
          ...receiptFields(d.realtime_result, "allowed_pending", "none", null),
        }, attester);
        await store.prepareDispatch(actionId, pendingReceipt, executor.id ?? "scopebond:unidentified-dispatch-adapter");
        try {
          const result = await executor.execute(req.intent, { actionId });
          ref = result.ref;
          output = result.output;
          executionState = "executed";
          assertion = "adapter_reported_success";
        } catch (error) {
          const resolution = await queryAfterDispatchError(actionId, error);
          ref = resolution.ref ?? null;
          output = "output" in resolution ? resolution.output : undefined;
          executionState = resolution.state;
          assertion = resolution.state === "executed" ? "adapter_reported_success" :
            resolution.state === "failed" ? "adapter_reported_failure" : "adapter_outcome_unknown";
        }
      }
    }

    const finalResult = stoppedBeforeDispatch ? "deny" : d.realtime_result;
    const receipt = await buildReceipt({
      ...receiptFields(finalResult, executionState, assertion, ref),
      ...(override && finalResult === "approved" ? { override } : {}),
    }, attester);
    const finalState = executionState as AuthorityFinalState;
    if (store.finalizeAction && store.reserveAction) await store.finalizeAction(actionId, receipt, finalState);
    else await store.put(receipt);

    const reason = guardDenied ? guardDenied : d.allow
      ? override ? `allowed by override (${override.method === "agent_dialog" ? "a person allowed it" : override.method === "allowance" ? "a standing allowance" : "offered at the agent's prompt"})` : (d.clause_mode === "monitor" ? "allowed (monitored, out of policy — covered at claim time)" : "allowed")
      : (d.verdict.explanation || "denied");
    return {
      allowed: d.allow && !stoppedBeforeDispatch,
      reason: outboundDisabled ? "outbound execution disabled (recovery mode)" :
        stoppedBeforeDispatch ? "kill switch active before dispatch (fail closed)" :
        (executionState === "outcome_unknown" ? "execution outcome unknown" :
          executionState === "failed" ? "execution failed without an external effect" : reason),
      verdict: d.verdict,
      receipt,
      ...(output === undefined ? {} : { output }),
    };
  }

  async function duplicateActionResult(actionId: string): Promise<ActionResult> {
    const existing = await store.getAction?.(actionId);
    if (!existing?.terminal_receipt) throw new DuplicateActionError();
    const executionState = existing.terminal_receipt.payload.execution.state;
    return {
      allowed: executionState !== "denied",
      reason: executionState === "outcome_unknown"
        ? "existing action outcome remains unknown"
        : "existing result returned for duplicate action id",
      receipt: existing.terminal_receipt,
    };
  }

  async function queryAfterDispatchError(actionId: string, error: unknown): Promise<ExecutionQueryResult> {
    if (config.outboundExecution !== false && executor.query) {
      try {
        const queried = await executor.query({ actionId });
        if (queried.state === "executed" || queried.state === "failed") return queried;
      } catch {
        // A failed result query cannot weaken an ambiguous outcome.
      }
    }
    const errorText = error instanceof Error ? `${error.name}:${error.message}` : String(error);
    return { state: "outcome_unknown", ref: `error:sha256:${sha256(errorText)}` };
  }

  async function unresolvedActions(): Promise<ActionLifecycleRecord[]> {
    if (!store.unresolvedActions) {
      throw new ReconciliationUnavailableError("receipt store does not expose unresolved lifecycle records");
    }
    return await store.unresolvedActions();
  }

  async function reconcileAction(actionId: string): Promise<ActionLifecycleRecord> {
    if (!store.getAction || !store.finalizeAction) {
      throw new ReconciliationUnavailableError("receipt store does not support lifecycle reconciliation");
    }
    const record = await store.getAction(actionId);
    if (!record) throw new ReconciliationUnavailableError("unknown action lifecycle record");
    if (record.state !== "reserved" && record.state !== "dispatching" && record.state !== "outcome_unknown") return record;
    let resolution: ExecutionQueryResult;
    if (record.state === "reserved") {
      resolution = { state: "failed", ref: "gateway:dispatch-not-started" };
    } else {
      if (config.outboundExecution === false) {
        throw new ReconciliationUnavailableError("outbound result queries are disabled in recovery mode");
      }
      const adapterId = executor.id ?? "scopebond:unidentified-dispatch-adapter";
      if (!executor.query || record.adapter_id !== adapterId) {
        throw new ReconciliationUnavailableError("the configured adapter cannot query this action");
      }
      try { resolution = await executor.query({ actionId }); }
      catch { resolution = { state: "outcome_unknown", ref: null }; }
      if (resolution.state === "outcome_unknown") return record;
    }

    const context = record.reservation.receipt_context;
    if (!context) throw new ReconciliationUnavailableError("legacy lifecycle record cannot reconstruct a receipt");
    const receipt = await buildReceipt({
      ...context,
      realtime_result: record.realtime_result ?? "allow",
      executed: resolution.state === "executed",
      execution_ref: resolution.ref,
      execution: {
        state: resolution.state,
        assertion: resolution.state === "executed" ? "adapter_reported_success" : "adapter_reported_failure",
        reference: resolution.ref,
        external_effect: "not_independently_verified",
      },
    }, attester);
    await store.finalizeAction(actionId, receipt, resolution.state);
    return (await store.getAction(actionId))!;
  }

  function setPolicy(next: Policy): void {
    assertValidPolicy(next);
    const snapshot = structuredClone(next);
    const nextHash = sha256(canonical(snapshot));
    const nextVersion = snapshot.version as number;
    policy = snapshot;
    policyHash = nextHash;
    policyVersion = nextVersion;
    policyHistory = historyNeed(snapshot);
  }

  async function observeAction(req: ActionRequest): Promise<ObservationResult> {
    assertValidIntent(req.intent);
    const ts = now();
    const ih = intentHash(req.intent);
    const minimized = minimizeIntentForEvidence(req.intent);
    const evidenceHash = intentHash(minimized.intent);
    const policyRef = {
      id: typeof policy.policy_id === "string" ? policy.policy_id : null,
      version: policyVersion,
      digest: policyHash,
    };
    const authenticated = await authorize(req, ts, policyRef);
    const actionId = authenticated.evidence.agent?.request_id ?? globalThis.crypto.randomUUID();
    const receipt = await buildReceipt({
      evidence_version: "1.0",
      canonicalization: CANONICALIZATION,
      intent: minimized.intent,
      intent_hash: ih,
      action_ref: { action_id: actionId, authorized_intent_hash: ih, evidence_intent_hash: evidenceHash },
      policy_hash: policyRef.digest,
      policy_version: policyRef.version,
      policy_ref: policyRef,
      verifier_version: VERIFIER_VERSION,
      realtime_result: "not_evaluated",
      executed: false,
      execution_ref: null,
      execution: {
        state: "observed_not_evaluated",
        assertion: "none",
        reference: null,
        external_effect: "not_independently_verified",
      },
      redaction: { profile: REDACTION_PROFILE, paths: minimized.redactedPaths },
      authorization: authenticated.evidence,
      attester: { kind: "gateway", kid: attester.kid },
      timestamp: ts,
    }, attester);
    await store.put(receipt);
    return { observed: true, receipt };
  }

  // Anchors v2 (SPEC.md "Anchors"): an RFC 9162 root over the first `tree_size`
  // receipts in append order, chained to the previous anchor (v1 or v2) and
  // Ed25519-signed by the attester. Before signing, the log is checked against
  // the previous anchor so a rewritten or reordered prefix is never re-anchored.
  async function anchor(): Promise<AnchorV2> {
    const receipts = (await store.list()) as SignedReceipt[];
    const payloads = receipts.map((r) => r.payload);
    const leaves = await Promise.all(payloads.map(receiptLeafHash));
    const prior = (await store.anchors?.()) ?? [];
    const prev = prior[prior.length - 1] ?? null;
    if (prev) {
      const prevSize = isAnchorV2(prev) ? prev.tree_size : prev.count;
      if (!(prevSize <= payloads.length && await verifyAnchorRoot(prev, payloads.slice(0, prevSize)))) {
        throw new Error("receipt log does not match the previous anchor; refusing to anchor");
      }
    }
    const body: AnchorV2Body = {
      type: ANCHOR_TYPE,
      seq: (prev?.seq ?? 0) + 1,
      algo: ANCHOR_ALGO_V2,
      tree_size: leaves.length,
      root: await merkleTreeHash(leaves),
      prev_anchor_hash: prev?.anchor_hash ?? null,
      timestamp: now(),
      attester: { kind: "gateway", kid: attester.kid },
    };
    const bytes = canonical(body);
    const a: AnchorV2 = {
      ...body,
      anchor_hash: sha256(bytes),
      signature: { alg: "Ed25519", sig: await attester.sign(bytes) },
    };
    await store.putAnchor?.(a);
    return a;
  }

  async function findAnchor(seqParam: string | undefined): Promise<Anchor | null> {
    const all = (await store.anchors?.()) ?? [];
    if (seqParam === undefined) return all[all.length - 1] ?? null;
    if (!/^[1-9][0-9]{0,15}$/.test(seqParam)) return null;
    return all.find((a) => a.seq === Number(seqParam)) ?? null;
  }

  const app = new Hono();
  // Every request body is bounded before it is read or parsed (a gateway that runs out of memory fails closed for everyone).
  app.use("*", bodyLimit({ maxSize: config.maxBodyBytes ?? 1024 * 1024, onError: (c) => c.json({ error: "request body too large" }, 413) }));
  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/v1/status", async (c) => {
    const denied = requireControl(c); if (denied) return denied;
    const stops = await store.getStopState?.() ?? { global: state.killed, agents: [] };
    state.killed = stops.global;
    return c.json({
      killed: stops.global, stopped_agents: stops.agents, policy_hash: policyHash, policy_version: policyVersion,
      attester: attester.kid, receipts: (await store.list()).length,
    });
  });
  app.post("/v1/kill", async (c) => {
    const denied = requireControl(c); if (denied) return denied;
    const body = await optionalJson(c);
    const target = typeof body?.agent === "string" ? body.agent : "global";
    if (target !== "global" && !/^key:[0-9a-f]{16}$/.test(target)) return c.json({ error: "invalid agent key id" }, 400);
    await setStopped(target, true);
    return c.json({ killed: true, target });
  });
  app.post("/v1/resume", async (c) => {
    const denied = requireControl(c); if (denied) return denied;
    const body = await optionalJson(c);
    const target = typeof body?.agent === "string" ? body.agent : "global";
    if (target !== "global" && !/^key:[0-9a-f]{16}$/.test(target)) return c.json({ error: "invalid agent key id" }, 400);
    await setStopped(target, false);
    return c.json({ killed: false, target });
  });
  app.get("/v1/receipts", async (c) => {
    const denied = requireControl(c); if (denied) return denied;
    return c.json({ receipts: await store.list() });
  });
  app.get("/v1/actions/unresolved", async (c) => {
    const denied = requireControl(c); if (denied) return denied;
    try { return c.json({ actions: await unresolvedActions() }); }
    catch (error) {
      if (error instanceof ReconciliationUnavailableError) return c.json({ error: error.message }, error.status);
      throw error;
    }
  });
  app.post("/v1/actions/:actionId/reconcile", async (c) => {
    const denied = requireControl(c); if (denied) return denied;
    try { return c.json(await reconcileAction(c.req.param("actionId"))); }
    catch (error) {
      if (error instanceof ReconciliationUnavailableError) return c.json({ error: error.message }, error.status);
      throw error;
    }
  });

  // The attester's public key, so a receipt holder can independently verify
  // signatures (see verifyReceipt). JWKS is the standard discovery form.
  app.get("/v1/attester", (c) => c.json({
    kid: attester.kid, alg: "Ed25519", public_key_pem: attester.publicKeyPem, jwk: attester.publicKeyJwk,
  }));
  app.get("/.well-known/jwks.json", (c) => c.json({ keys: [attester.publicKeyJwk] }));

  // Tamper-evidence: Merkle anchors over the receipt log, and inclusion proofs.
  app.get("/v1/anchors", async (c) => c.json({ anchors: (await store.anchors?.()) ?? [] }));
  app.get("/v1/anchors/latest", async (c) => {
    const all = (await store.anchors?.()) ?? [];
    return c.json(all[all.length - 1] ?? null);
  });
  app.post("/v1/anchor", async (c) => {
    const denied = requireControl(c); if (denied) return denied;
    if (!store.putAnchor || !store.anchors) return c.json({ error: "this store does not support anchoring" }, 400);
    return c.json(await anchor());
  });
  // Inclusion proof for one receipt against an anchor (the latest, or ?anchor_seq=).
  // The server returns the audit path and the signed anchor; it never asserts
  // inclusion itself — the client verifies (verifyInclusionProof +
  // verifyAnchorSignature from @scopebond/verify/anchor). Leaf positions are the
  // receipts' append-order sequence in the log.
  // A receipt's v2 leaf hash, computed once: the proof routes are public and would otherwise re-hash the whole log on
  // every request. Keyed by the receipt's signature, which is unique to it.
  const leafCache = new Map<string, string>();
  const leafOf = async (r: SignedReceipt): Promise<string> => {
    const key = typeof r.signature === "object" && r.signature ? JSON.stringify(r.signature) : null;
    const hit = key ? leafCache.get(key) : undefined;
    if (hit) return hit;
    const leaf = await receiptLeafHash(r.payload);
    if (key) leafCache.set(key, leaf);
    return leaf;
  };

  app.get("/v1/anchors/proof", async (c) => {
    // Whether an action happened is not public: a lookup by its intent hash needs the control token; anyone may look a
    // receipt up by its leaf hash (which only someone holding the receipt can compute).
    if (c.req.query("intent_hash") !== undefined) { const denied = requireControl(c); if (denied) return denied; }
    const target = await findAnchor(c.req.query("anchor_seq"));
    if (!target) return c.json({ error: "anchor not found — POST /v1/anchor first" }, 404);
    const size = isAnchorV2(target) ? target.tree_size : target.count;
    const receipts = ((await store.list()) as SignedReceipt[]).slice(0, size);
    const wantLeaf = c.req.query("leaf");
    const wantIntent = c.req.query("intent_hash");
    if (isAnchorV2(target)) {
      const leaves = await Promise.all(receipts.map(leafOf));
      let index = -1;
      if (wantLeaf) index = leaves.indexOf(wantLeaf);
      else if (wantIntent) index = receipts.findIndex((r) => r.payload.intent_hash === wantIntent);
      if (index < 0) return c.json({ error: "receipt not covered by this anchor" }, 404);
      const proof = await inclusionProof(leaves, index);
      return c.json({
        algo: target.algo, anchor_seq: target.seq, root: target.root, leaf_hash: leaves[index],
        leaf_index: proof.leaf_index, tree_size: proof.tree_size, audit_path: proof.audit_path, anchor: target,
      });
    }
    // Legacy v1 anchor: the v1 sibling list; verify with verifyProof (unsigned, see SPEC.md).
    const leaves = receipts.map((r) => sha256(canonical(r.payload)));
    let index = -1;
    if (wantLeaf) index = leaves.indexOf(wantLeaf);
    else if (wantIntent) index = receipts.findIndex((r) => r.payload.intent_hash === wantIntent);
    if (index < 0) return c.json({ error: "receipt not covered by this anchor" }, 404);
    return c.json({
      algo: target.algo ?? ANCHOR_ALGO_V1, anchor_seq: target.seq, merkle_root: target.merkle_root,
      leaf: leaves[index], leaf_index: index, proof: merkleProof(leaves, index), anchor: target,
    });
  });
  // Consistency proof between two v2 anchors: ?from=<seq>&to=<seq> (to defaults to latest).
  app.get("/v1/anchors/consistency", async (c) => {
    const fromParam = c.req.query("from");
    if (fromParam === undefined) return c.json({ error: "from (anchor seq) is required" }, 400);
    const first = await findAnchor(fromParam);
    const second = await findAnchor(c.req.query("to"));
    if (!first || !second) return c.json({ error: "anchor not found" }, 404);
    if (!isAnchorV2(first) || !isAnchorV2(second)) return c.json({ error: "consistency proofs require v2 anchors" }, 400);
    if (first.tree_size > second.tree_size) return c.json({ error: "from must not be larger than to" }, 400);
    const receipts = ((await store.list()) as SignedReceipt[]).slice(0, second.tree_size);
    if (receipts.length < second.tree_size) return c.json({ error: "receipt log is shorter than the anchor" }, 409);
    const leaves = await Promise.all(receipts.map(leafOf));
    const proof = await consistencyProof(leaves, first.tree_size);
    return c.json({ ...proof, first_root: first.root, second_root: second.root, first, second });
  });

  app.post("/v1/evaluate", async (c) => {
    let body: ActionRequest;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
    const validation = validateIntent(body?.intent);
    if (!validation.valid) return c.json({ error: "invalid action", details: validation.errors }, 400);
    try {
      const result = await handleAction(body);
      const executionState = result.receipt.payload.execution.state;
      const status = !result.allowed ? 403 : executionState === "outcome_unknown" ? 202 : executionState === "failed" ? 502 : 200;
      return c.json(result, status);
    } catch (error) {
      if (error instanceof AuthorizationError || error instanceof DuplicateActionError ||
          error instanceof AuthorityUnavailableError || error instanceof ExecutorInputError ||
          error instanceof ReconciliationUnavailableError) {
        return c.json({ error: error.message }, error.status);
      }
      throw error;
    }
  });

  app.post("/v1/observe", async (c) => {
    let body: ActionRequest;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
    const validation = validateIntent(body?.intent);
    if (!validation.valid) return c.json({ error: "invalid action", details: validation.errors }, 400);
    try {
      return c.json(await observeAction(body), 202);
    } catch (error) {
      if (error instanceof AuthorizationError) return c.json({ error: error.message }, error.status);
      throw error;
    }
  });

  app.post("/mcp", async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch {
      return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }
    const res = await handleMcp(body, handleAction as unknown as (r: { intent: unknown; authorization?: unknown; approval?: unknown }) => Promise<ActionResult>);
    return c.json(res as object);
  });

  return {
    app, store, attester, state, get policyHash() { return policyHash; },
    handleAction: (req: ActionRequest, options?: ActionOptions) => handleAction(req, options), check: (req: ActionRequest) => handleAction(req, { checkOnly: true }),
    observeAction, setPolicy, anchor, unresolvedActions, reconcileAction,
  };
}

async function optionalJson(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const value = await c.req.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

function constantTimeTextEqual(left: string, right: string): boolean {
  if (left.length > 4096) return false;
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

// Stores compare `since` against stored timestamps as text. Those are ISO strings from
// `now()`, which a caller may override with any parseable form (an offset rather than
// `Z`, a different precision), so the text cutoff is a day earlier than the exact one:
// a superset, trimmed exactly by `boundPrior`.
const SINCE_MARGIN_MS = 24 * 60 * 60 * 1000;

// Slack on the replay window for timestamps written in another format or by a clock that moved a little.
const REPLAY_MARGIN_MS = 60 * 60 * 1000;

function idField(value: unknown, key: string): string | null {
  const id = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : null;
  return typeof id === "string" && id !== "" ? id : null;
}

/** The store query for a policy's history need at evaluation time `at`. */
function priorScope(need: HistoryNeed, at: string): PriorScope {
  if (need.kind !== "window") return { kind: need.kind };
  const from = Date.parse(at) - need.ms - SINCE_MARGIN_MS;
  const since = new Date(from);
  // A window wider than the representable date range reads everything.
  if (!Number.isFinite(since.getTime()) || since.getUTCFullYear() < 1) return { kind: "all" };
  return { kind: "since", since: since.toISOString() };
}

function assertValidPolicy(policy: unknown): asserts policy is Policy {
  const result = validatePolicy(policy);
  if (!result.valid) throw new TypeError(`invalid policy: ${result.errors.join("; ")}`);
}

function assertValidIntent(intent: unknown): asserts intent is Intent {
  const result = validateIntent(intent);
  if (!result.valid) throw new TypeError(`invalid action: ${result.errors.join("; ")}`);
}

function deriveAttesterKid(jwk: Record<string, unknown>): string {
  return "key:" + sha256(canonical({ crv: jwk.crv, kty: jwk.kty, x: jwk.x })).slice(0, 16);
}
