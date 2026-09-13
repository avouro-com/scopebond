import { test } from "node:test";
import assert from "node:assert/strict";
import { createGateway, createHttpExecutor, MemoryReceiptStore, verifyReceipt } from "../dist/index.js";

const AT = "2026-09-12T12:00:00Z";
const CONTROL_TOKEN = "test-control-token-000000000001";
const post = (app, path, body) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function gw(policy, times) {
  let i = 0;
  const now = times ? () => times[Math.min(i++, times.length - 1)] : () => AT;
  return createGateway({ authentication: { mode: "insecure-development" }, policy, now, control: { bearerToken: CONTROL_TOKEN } });
}

const controlRequest = (app, path, init = {}) => app.request(path, {
  ...init,
  headers: { ...(init.headers ?? {}), authorization: `Bearer ${CONTROL_TOKEN}` },
});

const enforcePolicy = {
  vocabulary_version: "1.0", policy_id: "t", version: 1, clauses: [
    { id: "tx", type: "spend_limit", mode: "enforce", asset: "USDC", max_per_action: 1000000 },
    { id: "vendors", type: "endpoint_allowlist", mode: "enforce", hosts: ["api.ok.example"], methods: ["POST"] },
  ],
};

test("allows an in-policy action and Ed25519-countersigns a receipt", async () => {
  const { app } = gw(enforcePolicy);
  const res = await post(app, "/v1/evaluate", { intent: { action_type: "payout.create", asset: "USDC", amount: 500000 } });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.allowed, true);
  assert.equal(j.receipt.payload.type, "scopebond:receipt");
  assert.equal(j.receipt.payload.evidence_version, "1.0");
  assert.equal(j.receipt.payload.executed, false);
  assert.equal(j.receipt.payload.execution.state, "simulated");
  assert.equal(j.receipt.payload.execution.external_effect, "not_independently_verified");
  assert.equal(j.receipt.payload.realtime_result, "allow");
  assert.equal(j.receipt.signature.alg, "Ed25519");
  assert.ok(j.receipt.signature.sig.length > 0);
});

test("denies an enforce-mode over-limit action (fail closed), not executed", async () => {
  const { app } = gw(enforcePolicy);
  const res = await post(app, "/v1/evaluate", { intent: { action_type: "payout.create", asset: "USDC", amount: 2000000 } });
  assert.equal(res.status, 403);
  const j = await res.json();
  assert.equal(j.allowed, false);
  assert.equal(j.receipt.payload.executed, false);
  assert.equal(j.receipt.payload.realtime_result, "deny");
});

test("denies a non-allowlisted endpoint (enforce)", async () => {
  const { app } = gw(enforcePolicy);
  const res = await post(app, "/v1/evaluate", { intent: { action_type: "http.call", params: { host: "evil.example", path: "/x", method: "POST" } } });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).allowed, false);
});

test("monitor clause: windowed over-limit is allowed but flagged (covered)", async () => {
  const policy = { vocabulary_version: "1.0", policy_id: "monitor-test", version: 1, clauses: [{ id: "daily", type: "spend_limit", mode: "monitor", asset: "USDC", max_per_window: 5000000, window: "P1D", scope: "principal" }] };
  let i = 0;
  const times = ["2026-09-12T10:00:00Z", "2026-09-12T12:00:00Z"];
  const { app } = createGateway({ authentication: { mode: "insecure-development" },
    policy,
    now: () => times[Math.min(i++, times.length - 1)],
    executor: { mode: "dispatch", execute: () => ({ ref: "test:reported" }) },
  });
  const first = await (await post(app, "/v1/evaluate", { intent: { action_type: "payout.create", asset: "USDC", amount: 3000000 } })).json();
  assert.equal(first.allowed, true);
  assert.equal(first.receipt.payload.realtime_result, "allow");
  const res = await post(app, "/v1/evaluate", { intent: { action_type: "payout.create", asset: "USDC", amount: 3000000 } });
  const j = await res.json();
  assert.equal(j.allowed, true); // monitor lets it through
  assert.equal(j.receipt.payload.executed, true);
  assert.equal(j.receipt.payload.execution.state, "executed");
  assert.equal(j.receipt.payload.realtime_result, "deny"); // but flagged out-of-policy
});

test("atomically reserves a shared window so concurrent actions cannot overspend", async () => {
  const policy = {
    vocabulary_version: "1.0", policy_id: "concurrent-budget", version: 1,
    clauses: [{ id: "window", type: "spend_limit", mode: "enforce", asset: "USDC", max_per_window: 100, window: "P1D", scope: "principal" }],
  };
  let release;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const released = new Promise((resolve) => { release = resolve; });
  let executions = 0;
  const gateway = createGateway({
    authentication: { mode: "insecure-development" }, policy, now: () => AT,
    executor: { mode: "dispatch", execute: async () => { executions++; markStarted(); await released; return { ref: "sandbox:ok" }; } },
  });

  const firstPromise = gateway.handleAction({ intent: { action_type: "payout.create", asset: "USDC", amount: 60 } });
  await started;
  const second = await gateway.handleAction({ intent: { action_type: "payout.create", asset: "USDC", amount: 60 } });
  release();
  const first = await firstPromise;

  assert.equal(first.allowed, true);
  assert.equal(second.allowed, false);
  assert.equal(executions, 1);
  assert.notEqual(first.receipt.payload.action_ref.action_id, second.receipt.payload.action_ref.action_id);
});

test("pins the evaluated policy while an allowed action is in flight", async () => {
  const firstPolicy = {
    vocabulary_version: "1.0", policy_id: "pinned", version: 1,
    clauses: [{ id: "actions", type: "action_allowlist", mode: "enforce", action_types: ["tool.call"] }],
  };
  let release;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const released = new Promise((resolve) => { release = resolve; });
  const gateway = createGateway({
    authentication: { mode: "insecure-development" }, policy: firstPolicy,
    executor: { mode: "dispatch", execute: async () => { markStarted(); await released; return { ref: "sandbox:ok" }; } },
  });
  const acceptedHash = gateway.policyHash;
  const pending = gateway.handleAction({ intent: { action_type: "tool.call" } });
  await started;
  gateway.setPolicy({ ...firstPolicy, version: 2 });
  release();
  const result = await pending;
  assert.equal(result.receipt.payload.policy_ref.version, 1);
  assert.equal(result.receipt.payload.policy_ref.digest, acceptedHash);
  assert.notEqual(gateway.policyHash, acceptedHash);
});

test("global authority fails closed unless this coordinator has the complete gateway set", async () => {
  const policy = {
    vocabulary_version: "1.0", policy_id: "global", version: 1,
    clauses: [{ id: "all-gateways", type: "spend_limit", mode: "enforce", asset: "USDC", max_per_window: 100, window: "P1D", scope: "global" }],
  };
  let executions = 0;
  const incomplete = createGateway({
    authentication: { mode: "insecure-development" }, policy,
    executor: { mode: "dispatch", execute: () => { executions++; return { ref: "unexpected" }; } },
  });
  const denied = await incomplete.handleAction({ intent: { action_type: "payout.create", asset: "USDC", amount: 1 } });
  assert.equal(denied.allowed, false);
  assert.equal(denied.verdict.undetermined, true);
  assert.equal(executions, 0);

  const complete = createGateway({
    authentication: { mode: "insecure-development" }, policy, gatewaysComplete: true,
    executor: { mode: "dispatch", execute: () => { executions++; return { ref: "sandbox:ok" }; } },
  });
  assert.equal((await complete.handleAction({ intent: { action_type: "payout.create", asset: "USDC", amount: 1 } })).allowed, true);
  assert.equal(executions, 1);
});

test("checks durable stop state again after reservation and before dispatch", async () => {
  class StopAfterReserveStore extends MemoryReceiptStore {
    reserveAction(reservation, decide) {
      const result = super.reserveAction(reservation, decide);
      this.setStopped("global", true);
      return result;
    }
  }
  let called = false;
  const gateway = createGateway({
    authentication: { mode: "insecure-development" }, policy: enforcePolicy,
    store: new StopAfterReserveStore(),
    executor: { mode: "dispatch", execute: () => { called = true; return { ref: "unexpected" }; } },
  });
  const result = await gateway.handleAction({ intent: { action_type: "payout.create", asset: "USDC", amount: 1 } });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /before dispatch/);
  assert.equal(result.receipt.payload.execution.state, "denied");
  assert.equal(called, false);
});

test("a receipt-finalization failure leaves the reservation charged conservatively", async () => {
  class FailOnceStore extends MemoryReceiptStore {
    failed = false;
    finalizeAction(actionId, receipt, state) {
      if (!this.failed) { this.failed = true; throw new Error("synthetic storage failure"); }
      return super.finalizeAction(actionId, receipt, state);
    }
  }
  const policy = {
    vocabulary_version: "1.0", policy_id: "storage-failure", version: 1,
    clauses: [{ id: "window", type: "spend_limit", mode: "enforce", asset: "USDC", max_per_window: 100, window: "P1D", scope: "principal" }],
  };
  let executions = 0;
  const gateway = createGateway({
    authentication: { mode: "insecure-development" }, policy, store: new FailOnceStore(), now: () => AT,
    executor: { mode: "dispatch", execute: () => { executions++; return { ref: "sandbox:ok" }; } },
  });
  await assert.rejects(
    gateway.handleAction({ intent: { action_type: "payout.create", asset: "USDC", amount: 60 } }),
    /synthetic storage failure/,
  );
  const retry = await gateway.handleAction({ intent: { action_type: "payout.create", asset: "USDC", amount: 60 } });
  assert.equal(retry.allowed, false);
  assert.equal(executions, 1);
});

test("minimizes sensitive request data before signing while retaining exact references", async () => {
  const policy = { vocabulary_version: "1.0", policy_id: "http-policy", version: 7, clauses: [{ id: "actions", type: "action_allowlist", mode: "enforce", action_types: ["http.call"] }] };
  const original = {
    action_type: "http.call",
    params: {
      host: "api.example.test",
      headers: { authorization: "Bearer synthetic-secret", "content-type": "application/json" },
      body: { email: "private@example.test", note: "private body" },
      metadata: { access_token: "example-access-token", case_id: "case-1" },
    },
  };
  const { app } = createGateway({ authentication: { mode: "insecure-development" }, policy });
  const response = await post(app, "/v1/evaluate", { intent: original });
  const { receipt } = await response.json();
  const serialized = JSON.stringify(receipt);

  assert.equal(serialized.includes("synthetic-secret"), false);
  assert.equal(serialized.includes("private@example.test"), false);
  assert.equal(serialized.includes("private body"), false);
  assert.equal(serialized.includes("example-access-token"), false);
  assert.equal(receipt.payload.intent.params.headers.authorization, "[REDACTED]");
  assert.match(receipt.payload.intent.params.body.content_digest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(receipt.payload.redaction.paths, [
    "intent.params.body",
    "intent.params.headers.authorization",
    "intent.params.metadata.access_token",
  ]);
  assert.equal(receipt.payload.action_ref.authorized_intent_hash, receipt.payload.intent_hash);
  assert.equal(receipt.payload.policy_ref.id, "http-policy");
  assert.equal(receipt.payload.policy_ref.version, 7);
  assert.equal(receipt.payload.policy_ref.digest, receipt.payload.policy_hash);
});

test("records an adapter exception as outcome unknown without raw error text", async () => {
  const { app } = createGateway({ authentication: { mode: "insecure-development" },
    policy: { vocabulary_version: "1.0", policy_id: "adapter-test", version: 1, clauses: [{ id: "actions", type: "action_allowlist", mode: "enforce", action_types: ["test.call"] }] },
    executor: {
      mode: "dispatch",
      execute: () => { throw new Error("synthetic upstream secret"); },
    },
  });
  const response = await post(app, "/v1/evaluate", { intent: { action_type: "test.call" } });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.allowed, true);
  assert.equal(result.receipt.payload.executed, false);
  assert.equal(result.receipt.payload.execution.state, "outcome_unknown");
  assert.equal(result.receipt.payload.execution.assertion, "adapter_outcome_unknown");
  assert.match(result.receipt.payload.execution.reference, /^error:sha256:[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(result).includes("synthetic upstream secret"), false);
});

test("kill switch fails closed", async () => {
  const { app } = gw(enforcePolicy);
  assert.equal((await post(app, "/v1/kill", {})).status, 401);
  await controlRequest(app, "/v1/kill", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const res = await post(app, "/v1/evaluate", { intent: { action_type: "payout.create", asset: "USDC", amount: 500000 } });
  assert.equal(res.status, 403);
  const j = await res.json();
  assert.equal(j.allowed, false);
  assert.equal(j.receipt.payload.executed, false);
  assert.match(j.reason, /kill switch/);
});

test("stores and lists receipts; status reflects state", async () => {
  const { app } = gw(enforcePolicy);
  const action = await post(app, "/v1/evaluate", { intent: { action_type: "payout.create", asset: "USDC", amount: 500000 } });
  const returned = await action.json();
  returned.receipt.payload.intent.amount = 9999999;
  assert.equal((await app.request("/v1/receipts")).status, 401);
  const list = await (await controlRequest(app, "/v1/receipts")).json();
  assert.equal(list.receipts.length, 1);
  assert.equal(list.receipts[0].payload.intent.amount, 500000, "accepted signed evidence is snapshotted");
  list.receipts[0].payload.intent.amount = 8888888;
  const listedAgain = await (await controlRequest(app, "/v1/receipts")).json();
  assert.equal(listedAgain.receipts[0].payload.intent.amount, 500000, "reads cannot mutate retained evidence");
  const status = await (await controlRequest(app, "/v1/status")).json();
  assert.equal(status.killed, false);
  assert.equal(status.receipts, 1);
});

test("HTTP executor forwards an allowed call and records a response digest", async () => {
  const policy = { vocabulary_version: "1.0", policy_id: "http-test", version: 1, clauses: [{ id: "ep", type: "endpoint_allowlist", mode: "enforce", hosts: ["api.ok.example"], methods: ["POST"] }] };
  let seen;
  const fakeFetch = async (url, init) => {
    seen = { url, method: init.method };
    return { status: 200, text: async () => "ok-body" };
  };
  const { app } = createGateway({ authentication: { mode: "insecure-development" }, policy, now: () => AT, executor: createHttpExecutor({ fetch: fakeFetch }) });
  const res = await post(app, "/v1/evaluate", { intent: { action_type: "http.call", params: { host: "api.ok.example", path: "/v1/x", method: "POST" } } });
  const j = await res.json();
  assert.equal(j.allowed, true);
  assert.equal(seen.url, "https://api.ok.example/v1/x");
  assert.equal(seen.method, "POST");
  assert.match(j.receipt.payload.execution_ref, /^http:200:sha256:/);
});

test("HTTP executor is not called for a denied action", async () => {
  const policy = { vocabulary_version: "1.0", policy_id: "http-test", version: 1, clauses: [{ id: "ep", type: "endpoint_allowlist", mode: "enforce", hosts: ["api.ok.example"], methods: ["POST"] }] };
  let called = false;
  const fakeFetch = async () => { called = true; return { status: 200, text: async () => "" }; };
  const { app } = createGateway({ authentication: { mode: "insecure-development" }, policy, now: () => AT, executor: createHttpExecutor({ fetch: fakeFetch }) });
  const res = await post(app, "/v1/evaluate", { intent: { action_type: "http.call", params: { host: "evil.example", path: "/x", method: "POST" } } });
  assert.equal((await res.json()).allowed, false);
  assert.equal(called, false); // denied → never forwarded
});

test("MCP: initialize + tools/call routes through policy enforcement", async () => {
  const { app } = gw(enforcePolicy);
  const init = await (await post(app, "/mcp", { jsonrpc: "2.0", id: 1, method: "initialize" })).json();
  assert.equal(init.result.serverInfo.name, "scopebond-gateway");
  const list = await (await post(app, "/mcp", { jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
  assert.equal(list.result.tools[0].name, "scopebond.evaluate");
  const call = await (await post(app, "/mcp", {
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "scopebond.evaluate", arguments: { intent: { action_type: "payout.create", asset: "USDC", amount: 2000000 } } },
  })).json();
  assert.equal(call.result.isError, true); // over the enforce limit → denied
});

test("an earlier monitor violation cannot override a later enforce violation", async () => {
  let called = false;
  const policy = {
    vocabulary_version: "1.0", policy_id: "precedence", version: 1,
    clauses: [
      { id: "monitor-cap", type: "spend_limit", mode: "monitor", asset: "USDC", max_per_action: 10 },
      { id: "enforce-cap", type: "spend_limit", mode: "enforce", asset: "USDC", max_per_action: 20 },
    ],
  };
  const gateway = createGateway({ authentication: { mode: "insecure-development" },
    policy,
    executor: { mode: "dispatch", execute: () => { called = true; return { ref: "unexpected" }; } },
  });
  const response = await post(gateway.app, "/v1/evaluate", {
    intent: { action_type: "payout.create", asset: "USDC", amount: 30 },
  });
  const result = await response.json();
  assert.equal(response.status, 403);
  assert.equal(result.verdict.clause_id, "enforce-cap");
  assert.equal(called, false);
});

test("action allowlists deny unknown actions and reject numeric type bypasses", async () => {
  const policy = {
    vocabulary_version: "1.0", policy_id: "actions", version: 1,
    clauses: [{
      id: "allowed-actions", type: "action_allowlist", mode: "enforce",
      action_types: ["transfer"], param_bounds: { amount: { min: 0, max: 100 } },
    }],
  };
  const gateway = createGateway({ authentication: { mode: "insecure-development" }, policy });

  let response = await post(gateway.app, "/v1/evaluate", { intent: { action_type: "unknown", params: { amount: 1 } } });
  assert.equal(response.status, 403);
  assert.match((await response.json()).reason, /not allowlisted/);

  response = await post(gateway.app, "/v1/evaluate", { intent: { action_type: "transfer", params: { amount: "101" } } });
  assert.equal(response.status, 403);
  assert.match((await response.json()).reason, /finite number/);

  response = await post(gateway.app, "/v1/evaluate", { intent: { action_type: "transfer", params: { amount: 100 } } });
  assert.equal(response.status, 200, "the exact numeric boundary remains allowed");

  await assert.rejects(
    gateway.handleAction({ intent: { action_type: "transfer", params: { amount: Number.NaN } } }),
    /invalid action/,
  );
});

test("a spend-limited action cannot omit its amount", async () => {
  const gateway = createGateway({ authentication: { mode: "insecure-development" }, policy: enforcePolicy });
  const response = await post(gateway.app, "/v1/evaluate", {
    intent: { action_type: "payout.create", asset: "USDC" },
  });
  const result = await response.json();
  assert.equal(response.status, 403);
  assert.match(result.reason, /amount.*safe integer/);
});

test("an action outside every supported clause is denied", async () => {
  const gateway = createGateway({ authentication: { mode: "insecure-development" }, policy: enforcePolicy });
  const response = await post(gateway.app, "/v1/evaluate", { intent: { action_type: "data.read" } });
  const result = await response.json();
  assert.equal(response.status, 403);
  assert.match(result.reason, /not covered/);
});

test("passive observation has an explicit non-authorizing path", async () => {
  let called = false;
  const policy = {
    vocabulary_version: "1.0", policy_id: "observe", version: 1,
    clauses: [{ id: "known", type: "action_allowlist", mode: "enforce", action_types: ["known.action"] }],
  };
  const gateway = createGateway({ authentication: { mode: "insecure-development" },
    policy,
    executor: { mode: "dispatch", execute: () => { called = true; return { ref: "unexpected" }; } },
  });
  const response = await post(gateway.app, "/v1/observe", { intent: { action_type: "unknown.observed", params: { value: 1 } } });
  const result = await response.json();
  assert.equal(response.status, 202);
  assert.equal(result.observed, true);
  assert.equal(result.receipt.payload.realtime_result, "not_evaluated");
  assert.equal(result.receipt.payload.execution.state, "observed_not_evaluated");
  assert.equal(result.receipt.payload.executed, false);
  assert.equal(verifyReceipt(result.receipt, gateway.attester.publicKeyPem).valid, true);
  assert.equal(called, false);
});
