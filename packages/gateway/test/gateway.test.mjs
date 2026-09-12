import { test } from "node:test";
import assert from "node:assert/strict";
import { createGateway, createHttpExecutor } from "../dist/index.js";

const AT = "2026-09-12T12:00:00Z";
const post = (app, path, body) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function gw(policy, times) {
  let i = 0;
  const now = times ? () => times[Math.min(i++, times.length - 1)] : () => AT;
  return createGateway({ policy, now });
}

const enforcePolicy = {
  policy_id: "t", version: 1, clauses: [
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
  assert.equal(j.receipt.payload.executed, true);
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
  const policy = { version: 1, clauses: [{ id: "daily", type: "spend_limit", mode: "monitor", asset: "USDC", max_per_window: 5000000, window: "P1D", scope: "principal" }] };
  const { app } = gw(policy, ["2026-09-12T10:00:00Z", "2026-09-12T12:00:00Z"]);
  const first = await (await post(app, "/v1/evaluate", { intent: { action_type: "payout.create", asset: "USDC", amount: 3000000 } })).json();
  assert.equal(first.allowed, true);
  assert.equal(first.receipt.payload.realtime_result, "allow");
  const res = await post(app, "/v1/evaluate", { intent: { action_type: "payout.create", asset: "USDC", amount: 3000000 } });
  const j = await res.json();
  assert.equal(j.allowed, true); // monitor lets it through
  assert.equal(j.receipt.payload.executed, true);
  assert.equal(j.receipt.payload.realtime_result, "deny"); // but flagged out-of-policy
});

test("kill switch fails closed", async () => {
  const { app } = gw(enforcePolicy);
  await post(app, "/v1/kill", {});
  const res = await post(app, "/v1/evaluate", { intent: { action_type: "payout.create", asset: "USDC", amount: 500000 } });
  assert.equal(res.status, 403);
  const j = await res.json();
  assert.equal(j.allowed, false);
  assert.equal(j.receipt.payload.executed, false);
  assert.match(j.reason, /kill switch/);
});

test("stores and lists receipts; status reflects state", async () => {
  const { app } = gw(enforcePolicy);
  await post(app, "/v1/evaluate", { intent: { action_type: "payout.create", asset: "USDC", amount: 500000 } });
  const list = await (await app.request("/v1/receipts")).json();
  assert.equal(list.receipts.length, 1);
  const status = await (await app.request("/v1/status")).json();
  assert.equal(status.killed, false);
  assert.equal(status.receipts, 1);
});

test("HTTP executor forwards an allowed call and records a response digest", async () => {
  const policy = { version: 1, clauses: [{ id: "ep", type: "endpoint_allowlist", mode: "enforce", hosts: ["api.ok.example"], methods: ["POST"] }] };
  let seen;
  const fakeFetch = async (url, init) => {
    seen = { url, method: init.method };
    return { status: 200, text: async () => "ok-body" };
  };
  const { app } = createGateway({ policy, now: () => AT, executor: createHttpExecutor({ fetch: fakeFetch }) });
  const res = await post(app, "/v1/evaluate", { intent: { action_type: "http.call", params: { host: "api.ok.example", path: "/v1/x", method: "POST" } } });
  const j = await res.json();
  assert.equal(j.allowed, true);
  assert.equal(seen.url, "https://api.ok.example/v1/x");
  assert.equal(seen.method, "POST");
  assert.match(j.receipt.payload.execution_ref, /^http:200:sha256:/);
});

test("HTTP executor is not called for a denied action", async () => {
  const policy = { version: 1, clauses: [{ id: "ep", type: "endpoint_allowlist", mode: "enforce", hosts: ["api.ok.example"], methods: ["POST"] }] };
  let called = false;
  const fakeFetch = async () => { called = true; return { status: 200, text: async () => "" }; };
  const { app } = createGateway({ policy, now: () => AT, executor: createHttpExecutor({ fetch: fakeFetch }) });
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
