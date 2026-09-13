import { test } from "node:test";
import assert from "node:assert/strict";
import { createGateway, createSupportRefundExecutor } from "../dist/index.js";

const TOKEN = "sandbox-refund-secret-00000001";
const policy = {
  vocabulary_version: "1.0", policy_id: "support-refunds", version: 1,
  clauses: [
    { id: "actions", type: "action_allowlist", mode: "enforce", action_types: ["support.refund"] },
    { id: "refund-cap", type: "spend_limit", mode: "enforce", asset: "USD", max_per_action: 500 },
  ],
};

function sandbox() {
  const effects = new Map();
  const calls = [];
  const fetch = async (url, init) => {
    const headers = init.headers;
    const key = headers["idempotency-key"];
    calls.push({ url: String(url), init, key });
    if (!effects.has(key)) effects.set(key, JSON.parse(init.body));
    return new Response(JSON.stringify({ refund_id: "refund_123", duplicate: calls.filter((call) => call.key === key).length > 1 }), {
      status: 201, headers: { "content-type": "application/json" },
    });
  };
  return { effects, calls, fetch };
}

const refund = (amount = 420, params = {}) => ({
  action_type: "support.refund", asset: "USD", amount,
  params: { ticket_id: "ticket_123", payment_id: "payment_456", reason_code: "customer_request", ...params },
});

test("a permitted support refund changes the fixed sandbox exactly as recorded", async () => {
  const upstream = sandbox();
  const executor = createSupportRefundExecutor({ origin: "https://support.example.test", apiToken: TOKEN, fetch: upstream.fetch });
  const gateway = createGateway({ authentication: { mode: "insecure-development" }, policy, executor });
  const result = await gateway.handleAction({ intent: refund() });

  assert.equal(result.allowed, true);
  assert.equal(result.receipt.payload.execution.state, "executed");
  assert.match(result.receipt.payload.execution.reference, /^support-refund:201:sha256:/);
  assert.deepEqual(result.output, { status: 201, refund_id: "refund_123", duplicate: false });
  assert.equal(upstream.effects.size, 1);
  assert.equal(upstream.calls.length, 1);
  assert.equal(upstream.calls[0].url, "https://support.example.test/v1/refunds");
  assert.equal(upstream.calls[0].init.method, "POST");
  assert.equal(upstream.calls[0].init.redirect, "error");
  assert.equal(upstream.calls[0].init.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(upstream.calls[0].key, result.receipt.payload.action_ref.action_id);
  assert.equal(JSON.stringify(result.receipt).includes(TOKEN), false);
  assert.deepEqual(upstream.effects.get(upstream.calls[0].key), {
    ticket_id: "ticket_123", payment_id: "payment_456", reason_code: "customer_request", amount: 420, asset: "USD",
  });
});

test("policy denial and injected transport fields never reach the refund service", async () => {
  const upstream = sandbox();
  const executor = createSupportRefundExecutor({ origin: "https://support.example.test", apiToken: TOKEN, fetch: upstream.fetch });
  const gateway = createGateway({ authentication: { mode: "insecure-development" }, policy, executor });

  assert.equal((await gateway.handleAction({ intent: refund(501) })).allowed, false);
  assert.equal(upstream.calls.length, 0);
  await assert.rejects(
    gateway.handleAction({ intent: refund(10, { host: "127.0.0.1", path: "/admin", headers: { authorization: "attacker" } }) }),
    /unsupported parameter/,
  );
  assert.equal(upstream.calls.length, 0);
});

test("refund origin rejects insecure, private, ambiguous, and credential-bearing destinations", () => {
  for (const origin of [
    "http://support.example.test", "https://127.0.0.1", "https://[::1]",
    "https://support.internal", "https://user:pass@support.example.test", "https://support.example.test:8443",
    "https://support.example.test/base", "https://support.example.test?next=https://evil.test",
  ]) {
    assert.throws(() => createSupportRefundExecutor({ origin, apiToken: TOKEN }), /refund origin/);
  }
});

test("the upstream idempotency key is the durable action id", async () => {
  const upstream = sandbox();
  const executor = createSupportRefundExecutor({ origin: "https://support.example.test", apiToken: TOKEN, fetch: upstream.fetch });
  const intent = refund(100);
  const context = { actionId: "request:stable-refund-00001" };
  await executor.execute(intent, context);
  await executor.execute(intent, context);
  assert.equal(upstream.calls.length, 2);
  assert.equal(upstream.effects.size, 1);
});
