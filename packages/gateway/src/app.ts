// The gateway: a Hono app wiring policy enforcement (scopebond-verify), receipt
// countersigning + storage, the kill switch, and HTTP + MCP ingress. The Hono app
// is runtime-agnostic (ADR-004) and testable in-process via app.request().

import { Hono } from "hono";
import { evaluate } from "./engine.js";
import { buildReceipt, createAttester, MemoryReceiptStore, canonical, sha256, intentHash } from "./receipts.js";
import type { Attester, ReceiptStore, SignedReceipt, Anchor } from "./receipts.js";
import { handleMcp } from "./mcp.js";
import { merkleRoot, merkleProof, verifyProof } from "./anchor.js";
import type { Policy, Intent, Approval, Verdict } from "@scopebond/verify";

/** How an allowed action is actually carried out. Default: a no-op (record only).
 *  Real forwarding (HTTP proxy, MCP passthrough) is a swappable implementation. */
export interface Executor {
  execute(intent: Intent): { ref: string } | Promise<{ ref: string }>;
}
export const noopExecutor: Executor = { execute: () => ({ ref: "noop:executed" }) };

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

export interface Gateway {
  app: Hono;
  store: ReceiptStore;
  attester: Attester;
  state: { killed: boolean };
  policyHash: string;
  handleAction(req: ActionRequest): Promise<ActionResult>;
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
  let policy = config.policy;
  let policyHash = sha256(canonical(policy));
  let policyVersion = (policy.version as number) ?? 1;
  const now = config.now ?? (() => new Date().toISOString());
  const state = { killed: false };

  async function handleAction(req: ActionRequest): Promise<ActionResult> {
    const ts = now();
    const ih = intentHash(req.intent);
    const attesterRef = { kind: "gateway" as const, kid: attester.kid };

    // Fail closed: while killed, deny everything and record the denial.
    if (state.killed) {
      const receipt = await buildReceipt({
        intent: req.intent, intent_hash: ih, policy_hash: policyHash, policy_version: policyVersion,
        verifier_version: VERIFIER_VERSION, realtime_result: "deny", executed: false, execution_ref: null,
        attester: attesterRef, timestamp: ts,
      }, attester);
      await store.put(receipt);
      return { allowed: false, reason: "kill switch active (fail closed)", receipt };
    }

    const prior = await store.executed();
    const d = evaluate(policy, prior, { intent: req.intent, approval: req.approval, intent_hash: ih }, ts);

    let ref: string | null = null;
    if (d.allow) ref = (await executor.execute(req.intent)).ref;

    const receipt = await buildReceipt({
      intent: req.intent, intent_hash: ih, policy_hash: policyHash, policy_version: policyVersion,
      verifier_version: VERIFIER_VERSION, realtime_result: d.realtime_result, executed: d.allow,
      execution_ref: ref, attester: attesterRef, timestamp: ts,
    }, attester);
    await store.put(receipt);

    const reason = d.allow
      ? (d.clause_mode === "monitor" ? "allowed (monitored, out of policy — covered at claim time)" : "allowed")
      : (d.verdict.explanation || "denied");
    return { allowed: d.allow, reason, verdict: d.verdict, receipt };
  }

  function setPolicy(next: Policy): void {
    policy = next;
    policyHash = sha256(canonical(next));
    policyVersion = (next.version as number) ?? 1;
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
    if (!body?.intent?.action_type) return c.json({ error: "intent.action_type is required" }, 400);
    const result = await handleAction(body);
    return c.json(result, result.allowed ? 200 : 403);
  });

  app.post("/mcp", async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch {
      return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }
    const res = await handleMcp(body, handleAction as unknown as (r: { intent: unknown; approval?: unknown }) => Promise<ActionResult>);
    return c.json(res as object);
  });

  return { app, store, attester, state, get policyHash() { return policyHash; }, handleAction, setPolicy, anchor };
}
