// The gateway: a Hono app wiring policy enforcement (scopebond-verify), receipt
// countersigning + storage, the kill switch, and HTTP + MCP ingress. The Hono app
// is runtime-agnostic (ADR-004) and testable in-process via app.request().

import { Hono } from "hono";
import type { Context } from "hono";
import { evaluate } from "./engine.js";
import {
  buildReceipt, createAttester, MemoryReceiptStore, canonical, sha256, intentHash,
  minimizeIntentForEvidence, REDACTION_PROFILE,
  CANONICALIZATION,
} from "./receipts.js";
import type { Attester, ReceiptStore, SignedReceipt, Anchor, ExecutionState, RealtimeResult, AuthorityFinalState } from "./receipts.js";
import { handleMcp } from "./mcp.js";
import { merkleRoot, merkleProof, verifyProof } from "./anchor.js";
import { validateIntent, validatePolicy } from "@scopebond/verify";
import type { Policy, Intent, Approval, Verdict } from "@scopebond/verify";
import { authenticateRequest, AuthorizationError } from "./auth.js";
import type {
  AuthorizationEvidence, GatewayAuthentication, SignedApproval, SignedIntentAuthorization,
} from "./auth.js";

/** How an allowed action is actually carried out. Default: a no-op (record only).
 *  Real forwarding (HTTP proxy, MCP passthrough) is a swappable implementation. */
export interface Executor {
  /** Simulation never claims that an external action occurred. */
  mode?: "simulation" | "dispatch";
  /** Integration-specific structural validation before authorization/reservation. */
  validate?(intent: Intent): void;
  execute(intent: Intent, context: { actionId: string }): ExecutionResult | Promise<ExecutionResult>;
}
export interface ExecutionResult { ref: string; output?: unknown; }
export const noopExecutor: Executor = { mode: "simulation", execute: () => ({ ref: "simulation:no-dispatch" }) };

export interface GatewayConfig {
  policy: Policy;
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

export class ExecutorInputError extends Error {
  readonly status = 400 as const;
  constructor(message: string) { super(message); this.name = "ExecutorInputError"; }
}

export interface Gateway {
  app: Hono;
  store: ReceiptStore;
  attester: Attester;
  state: { killed: boolean };
  policyHash: string;
  handleAction(req: ActionRequest): Promise<ActionResult>;
  /** Record a passive observation without evaluating or dispatching it. */
  observeAction(req: ActionRequest): Promise<ObservationResult>;
  /** Hot-swap the active policy (recomputes the policy hash + version). */
  setPolicy(policy: Policy): void;
  /** Compute + store a Merkle anchor over the receipts to date (tamper-evidence). */
  anchor(): Promise<Anchor>;
}

const VERIFIER_VERSION = "scopebond-verify@0.1.0";

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
    const receipts = await store.list();
    const usedRequestIds = new Set<string>();
    const usedApprovalIds = new Set<string>();
    for (const receipt of receipts) {
      const evidence = receipt.payload.authorization;
      if (evidence?.agent?.request_id) usedRequestIds.add(evidence.agent.request_id);
      if (evidence?.approval?.approval_id) usedApprovalIds.add(evidence.approval.approval_id);
    }
    return authenticateRequest(
      req.intent, req.authorization, req.approval, authentication, ts, policyRef,
      usedRequestIds, usedApprovalIds,
    );
  }

  async function handleAction(req: ActionRequest): Promise<ActionResult> {
    assertValidIntent(req.intent);
    const ts = now();
    const ih = intentHash(req.intent);
    const minimized = minimizeIntentForEvidence(req.intent);
    const evidenceHash = intentHash(minimized.intent);
    const attesterRef = { kind: "gateway" as const, kid: attester.kid };
    const activePolicy = structuredClone(policy);
    const activePolicyHash = policyHash;
    const activePolicyVersion = policyVersion;
    const policyRef = {
      id: typeof activePolicy.policy_id === "string" ? activePolicy.policy_id : null,
      version: activePolicyVersion,
      digest: activePolicyHash,
    };
    const authenticated = await authorize(req, ts, policyRef);
    executor.validate?.(req.intent);
    const actionId = authenticated.evidence.agent?.request_id ?? globalThis.crypto.randomUUID();

    const receiptFields = (
      realtimeResult: RealtimeResult,
      executionState: ExecutionState,
      assertion: "none" | "gateway_simulation" | "adapter_reported_success" | "adapter_reported_failure" | "adapter_outcome_unknown",
      executionRef: string | null,
    ) => ({
      evidence_version: "1.0" as const,
      canonicalization: CANONICALIZATION,
      intent: minimized.intent,
      intent_hash: ih,
      action_ref: { action_id: actionId, authorized_intent_hash: ih, evidence_intent_hash: evidenceHash },
      policy_hash: activePolicyHash,
      policy_version: activePolicyVersion,
      policy_ref: policyRef,
      verifier_version: VERIFIER_VERSION,
      realtime_result: realtimeResult,
      executed: executionState === "executed",
      execution_ref: executionRef,
      execution: {
        state: executionState,
        assertion,
        reference: executionRef,
        external_effect: "not_independently_verified" as const,
      },
      redaction: { profile: REDACTION_PROFILE, paths: minimized.redactedPaths },
      authorization: authenticated.evidence,
      attester: attesterRef,
      timestamp: ts,
    });
    const reservation = {
      action_id: actionId,
      candidate: {
        intent: minimized.intent,
        action_id: actionId,
        intent_hash: ih,
        executed: true,
        realtime_result: "allow",
        timestamp: ts,
        approval: authenticated.approvalForPolicy,
      },
      policy_ref: policyRef,
      policy_snapshot: canonical(activePolicy),
    };

    // Fail closed: while killed, deny everything and record the denial.
    if (await isStopped(req.intent.signer)) {
      if (store.reserveAction) {
        const attempt = await store.reserveAction(reservation, () => ({ allow: false }));
        if (attempt.duplicate) throw new DuplicateActionError();
      }
      const receipt = await buildReceipt({
        ...receiptFields("deny", "denied", "none", null),
      }, attester);
      if (store.finalizeAction && store.reserveAction) await store.finalizeAction(actionId, receipt, "denied");
      else await store.put(receipt);
      return { allowed: false, reason: "kill switch active (fail closed)", receipt };
    }

    const decide = (prior: Awaited<ReturnType<ReceiptStore["executed"]>>) => evaluate(
      activePolicy, prior,
      { intent: req.intent, approval: authenticated.approvalForPolicy, intent_hash: ih },
      ts, { gatewaysComplete: config.gatewaysComplete ?? false },
    );
    let d;
    if (store.reserveAction) {
      const attempt = await store.reserveAction(reservation, decide);
      if (attempt.duplicate) throw new DuplicateActionError();
      d = attempt.decision;
    } else {
      if (executor.mode === "dispatch") throw new AuthorityUnavailableError();
      d = decide(await store.executed());
    }

    let ref: string | null = null;
    let output: unknown;
    let executionState: ExecutionState = "denied";
    let assertion: "none" | "gateway_simulation" | "adapter_reported_success" | "adapter_reported_failure" | "adapter_outcome_unknown" = "none";
    const stoppedBeforeDispatch = d.allow && await isStopped(req.intent.signer);
    if (d.allow && !stoppedBeforeDispatch) {
      if (executor.mode === "simulation") {
        const result = await executor.execute(req.intent, { actionId });
        ref = result.ref;
        output = result.output;
        executionState = "simulated";
        assertion = "gateway_simulation";
      } else {
        try {
          const result = await executor.execute(req.intent, { actionId });
          ref = result.ref;
          output = result.output;
          executionState = "executed";
          assertion = "adapter_reported_success";
        } catch (error) {
          const errorText = error instanceof Error ? `${error.name}:${error.message}` : String(error);
          ref = `error:sha256:${sha256(errorText)}`;
          executionState = "outcome_unknown";
          assertion = "adapter_outcome_unknown";
        }
      }
    }

    const receipt = await buildReceipt({
      ...receiptFields(stoppedBeforeDispatch ? "deny" : d.realtime_result, executionState, assertion, ref),
    }, attester);
    const finalState = executionState as AuthorityFinalState;
    if (store.finalizeAction && store.reserveAction) await store.finalizeAction(actionId, receipt, finalState);
    else await store.put(receipt);

    const reason = d.allow
      ? (d.clause_mode === "monitor" ? "allowed (monitored, out of policy — covered at claim time)" : "allowed")
      : (d.verdict.explanation || "denied");
    return {
      allowed: d.allow && !stoppedBeforeDispatch,
      reason: stoppedBeforeDispatch ? "kill switch active before dispatch (fail closed)" :
        (executionState === "outcome_unknown" ? "execution outcome unknown" : reason),
      verdict: d.verdict,
      receipt,
      ...(output === undefined ? {} : { output }),
    };
  }

  function setPolicy(next: Policy): void {
    assertValidPolicy(next);
    const snapshot = structuredClone(next);
    const nextHash = sha256(canonical(snapshot));
    const nextVersion = snapshot.version as number;
    policy = snapshot;
    policyHash = nextHash;
    policyVersion = nextVersion;
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

  async function anchor(): Promise<Anchor> {
    const receipts = (await store.list()) as SignedReceipt[];
    const leaves = receipts.map((r) => sha256(canonical(r.payload)));
    const prior = (await store.anchors?.()) ?? [];
    const prev = prior[prior.length - 1] ?? null;
    const ts = now();
    const base = {
      seq: (prev?.seq ?? 0) + 1,
      algo: "sha256-merkle" as const,
      merkle_root: merkleRoot(leaves),
      count: leaves.length,
      from: receipts[0]?.payload.timestamp ?? null,
      to: ts,
      prev_anchor_hash: prev?.anchor_hash ?? null,
      timestamp: ts,
    };
    const a: Anchor = { ...base, anchor_hash: sha256(canonical(base)) };
    await store.putAnchor?.(a);
    return a;
  }

  const app = new Hono();
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
  app.get("/v1/anchors/proof", async (c) => {
    const all = (await store.anchors?.()) ?? [];
    const latest = all[all.length - 1];
    if (!latest) return c.json({ error: "no anchor yet — POST /v1/anchor first" }, 404);
    const receipts = ((await store.list()) as SignedReceipt[]).slice(0, latest.count);
    const leaves = receipts.map((r) => sha256(canonical(r.payload)));
    const wantLeaf = c.req.query("leaf");
    const wantIntent = c.req.query("intent_hash");
    let index = -1;
    if (wantLeaf) index = leaves.indexOf(wantLeaf);
    else if (wantIntent) index = receipts.findIndex((r) => r.payload.intent_hash === wantIntent);
    if (index < 0) return c.json({ error: "receipt not covered by the latest anchor" }, 404);
    const leaf = leaves[index];
    const proof = merkleProof(leaves, index);
    return c.json({ anchor_seq: latest.seq, merkle_root: latest.merkle_root, leaf, proof, included: verifyProof(leaf, proof, latest.merkle_root) });
  });

  app.post("/v1/evaluate", async (c) => {
    let body: ActionRequest;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
    const validation = validateIntent(body?.intent);
    if (!validation.valid) return c.json({ error: "invalid action", details: validation.errors }, 400);
    try {
      const result = await handleAction(body);
      return c.json(result, result.allowed ? 200 : 403);
    } catch (error) {
      if (error instanceof AuthorizationError || error instanceof DuplicateActionError ||
          error instanceof AuthorityUnavailableError || error instanceof ExecutorInputError) {
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

  return { app, store, attester, state, get policyHash() { return policyHash; }, handleAction, observeAction, setPolicy, anchor };
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
