// The gateway: a Hono app wiring policy enforcement (scopebond-verify), receipt
// countersigning + storage, the kill switch, and HTTP + MCP ingress. The Hono app
// is runtime-agnostic (ADR-004) and testable in-process via app.request().

import { Hono } from "hono";
import { evaluate } from "./engine.js";
import {
  buildReceipt, createAttester, MemoryReceiptStore, canonical, sha256, intentHash,
  minimizeIntentForEvidence, REDACTION_PROFILE,
  CANONICALIZATION,
} from "./receipts.js";
import type { Attester, ReceiptStore, SignedReceipt, Anchor, ExecutionState, RealtimeResult } from "./receipts.js";
import { handleMcp } from "./mcp.js";
import { merkleRoot, merkleProof, verifyProof } from "./anchor.js";
import { validateIntent, validatePolicy } from "@scopebond/verify";
import type { Policy, Intent, Approval, Verdict } from "@scopebond/verify";

/** How an allowed action is actually carried out. Default: a no-op (record only).
 *  Real forwarding (HTTP proxy, MCP passthrough) is a swappable implementation. */
export interface Executor {
  /** Simulation never claims that an external action occurred. */
  mode?: "simulation" | "dispatch";
  execute(intent: Intent): { ref: string } | Promise<{ ref: string }>;
}
export const noopExecutor: Executor = { mode: "simulation", execute: () => ({ ref: "simulation:no-dispatch" }) };

export interface GatewayConfig {
  policy: Policy;
  store?: ReceiptStore;
  executor?: Executor;
  attester?: Attester;
  /** Injectable clock for determinism/testing. */
  now?: () => string;
}

export interface ActionRequest { intent: Intent; approval?: Approval; }
export interface ActionResult { allowed: boolean; reason: string; verdict?: Verdict; receipt: SignedReceipt; }
export interface ObservationResult { observed: true; receipt: SignedReceipt; }

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

  async function handleAction(req: ActionRequest): Promise<ActionResult> {
    assertValidIntent(req.intent);
    const ts = now();
    const ih = intentHash(req.intent);
    const minimized = minimizeIntentForEvidence(req.intent);
    const evidenceHash = intentHash(minimized.intent);
    const attesterRef = { kind: "gateway" as const, kid: attester.kid };
    const policyRef = {
      id: typeof policy.policy_id === "string" ? policy.policy_id : null,
      version: policyVersion,
      digest: policyHash,
    };

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
      action_ref: { authorized_intent_hash: ih, evidence_intent_hash: evidenceHash },
      policy_hash: policyHash,
      policy_version: policyVersion,
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
      attester: attesterRef,
      timestamp: ts,
    });

    // Fail closed: while killed, deny everything and record the denial.
    if (state.killed) {
      const receipt = await buildReceipt({
        ...receiptFields("deny", "denied", "none", null),
      }, attester);
      await store.put(receipt);
      return { allowed: false, reason: "kill switch active (fail closed)", receipt };
    }

    const prior = await store.executed();
    const d = evaluate(policy, prior, { intent: req.intent, approval: req.approval, intent_hash: ih }, ts);

    let ref: string | null = null;
    let executionState: ExecutionState = "denied";
    let assertion: "none" | "gateway_simulation" | "adapter_reported_success" | "adapter_reported_failure" | "adapter_outcome_unknown" = "none";
    if (d.allow) {
      if (executor.mode === "simulation") {
        ref = (await executor.execute(req.intent)).ref;
        executionState = "simulated";
        assertion = "gateway_simulation";
      } else {
        try {
          ref = (await executor.execute(req.intent)).ref;
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
      ...receiptFields(d.realtime_result, executionState, assertion, ref),
    }, attester);
    await store.put(receipt);

    const reason = d.allow
      ? (d.clause_mode === "monitor" ? "allowed (monitored, out of policy — covered at claim time)" : "allowed")
      : (d.verdict.explanation || "denied");
    return {
      allowed: d.allow,
      reason: executionState === "outcome_unknown" ? "execution outcome unknown" : reason,
      verdict: d.verdict,
      receipt,
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
    const receipt = await buildReceipt({
      evidence_version: "1.0",
      canonicalization: CANONICALIZATION,
      intent: minimized.intent,
      intent_hash: ih,
      action_ref: { authorized_intent_hash: ih, evidence_intent_hash: evidenceHash },
      policy_hash: policyHash,
      policy_version: policyVersion,
      policy_ref: {
        id: policy.policy_id as string,
        version: policyVersion,
        digest: policyHash,
      },
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
  app.get("/v1/status", async (c) => c.json({
    killed: state.killed, policy_hash: policyHash, policy_version: policyVersion,
    attester: attester.kid, receipts: (await store.list()).length,
  }));
  app.post("/v1/kill", (c) => { state.killed = true; return c.json({ killed: true }); });
  app.post("/v1/resume", (c) => { state.killed = false; return c.json({ killed: false }); });
  app.get("/v1/receipts", async (c) => c.json({ receipts: await store.list() }));

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
    const result = await handleAction(body);
    return c.json(result, result.allowed ? 200 : 403);
  });

  app.post("/v1/observe", async (c) => {
    let body: ActionRequest;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
    const validation = validateIntent(body?.intent);
    if (!validation.valid) return c.json({ error: "invalid action", details: validation.errors }, 400);
    return c.json(await observeAction(body), 202);
  });

  app.post("/mcp", async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch {
      return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }
    const res = await handleMcp(body, handleAction as unknown as (r: { intent: unknown; approval?: unknown }) => Promise<ActionResult>);
    return c.json(res as object);
  });

  return { app, store, attester, state, get policyHash() { return policyHash; }, handleAction, observeAction, setPolicy, anchor };
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
