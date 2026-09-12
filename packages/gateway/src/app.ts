// The gateway: a Hono app wiring policy enforcement (scopebond-verify), receipt
// countersigning + storage, the kill switch, and HTTP + MCP ingress. The Hono app
// is runtime-agnostic (ADR-004) and testable in-process via app.request().

import { Hono } from "hono";
import { evaluate } from "./engine.js";
import { buildReceipt, createAttester, MemoryReceiptStore, canonical, sha256, intentHash } from "./receipts.js";
import type { Attester, ReceiptStore, SignedReceipt } from "./receipts.js";
import { handleMcp } from "./mcp.js";
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
}

const VERIFIER_VERSION = "scopebond-verify@0.1.0";

export function createGateway(config: GatewayConfig): Gateway {
  const store = config.store ?? new MemoryReceiptStore();
  const executor = config.executor ?? noopExecutor;
  const attester = config.attester ?? createAttester();
  const policy = config.policy;
  const policyHash = sha256(canonical(policy));
  const policyVersion = (policy.version as number) ?? 1;
  const now = config.now ?? (() => new Date().toISOString());
  const state = { killed: false };

  async function handleAction(req: ActionRequest): Promise<ActionResult> {
    const ts = now();
    const ih = intentHash(req.intent);
    const attesterRef = { kind: "gateway" as const, kid: attester.kid };

    // Fail closed: while killed, deny everything and record the denial.
    if (state.killed) {
      const receipt = buildReceipt({
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

    const receipt = buildReceipt({
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

  return { app, store, attester, state, policyHash, handleAction };
}
