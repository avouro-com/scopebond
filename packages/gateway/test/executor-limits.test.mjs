// The dispatch executors against real local HTTP servers on 127.0.0.1 (random ports); nothing leaves the machine.
// A call the executor cannot send is refused before anything is reserved, a response is read only up to a size limit,
// and a dispatch that does not finish in time is stopped. Tests that talk to a slow upstream carry their own time limit,
// so an executor that stops enforcing one fails them instead of hanging the run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createGateway, createHttpExecutor, createSupportRefundExecutor, MemoryReceiptStore, StaticPrincipalKeyRegistry } from "../dist/index.js";
import { createSigner } from "@scopebond/sdk";

function listen(handler) {
  const server = createServer(handler);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port })));
}
function gatewayFor(policy, executor) {
  const agent = createSigner();
  const keys = new StaticPrincipalKeyRegistry([{ kid: agent.kid, publicKeyPem: agent.publicKeyPem, purposes: ["agent"], status: "active" }]);
  const gw = createGateway({ policy, authentication: { keys }, executor, store: new MemoryReceiptStore() });
  return { agent, gw };
}
const post = (gw, signed) => gw.app.request("/v1/evaluate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(signed) });

test("an http.call the executor cannot send is refused with 400 before it is reserved, and charges nothing", async () => {
  const calls = [];
  const fakeFetch = async (url) => { calls.push(String(url)); return new Response("ok", { status: 200 }); };
  const policy = { vocabulary_version: "1.0", policy_id: "egress", version: 1, clauses: [
    { id: "egress", type: "endpoint_allowlist", mode: "enforce", hosts: ["api.ok.example"] },
    { id: "one-per-day", type: "rate_limit", mode: "enforce", action_types: ["http.call"], max_count: 1, window: "P1D" },
  ] };
  const { agent, gw } = gatewayFor(policy, createHttpExecutor({ fetch: fakeFetch }));
  const refused = [
    ["path that names another host", { path: "//evil.example/x", method: "GET" }],
    ["backslash path", { path: "/\\evil.example/x", method: "GET" }],
    ["CR/LF in a header value", { path: "/p", method: "GET", headers: { "x-a": "v\r\nInjected: 1" } }],
    ["transfer-encoding header", { path: "/p", method: "POST", headers: { "Transfer-Encoding": "chunked" }, body: "x" }],
    ["content-length header", { path: "/p", method: "POST", headers: { "Content-Length": "100" }, body: "x" }],
    ["connection header", { path: "/p", method: "GET", headers: { Connection: "upgrade" } }],
    ["method CONNECT", { path: "/p", method: "CONNECT" }],
    ["method that is not a token", { path: "/p", method: "GET /x HTTP/1.1" }],
    ["body on a GET", { path: "/p", method: "GET", body: "x" }],
    ["header list that is not an object", { path: "/p", method: "GET", headers: "x-a: 1" }],
  ];
  for (const [label, params] of refused) {
    const res = await post(gw, agent.sign({ action_type: "http.call", params: { host: "api.ok.example", ...params } }));
    assert.equal(res.status, 400, `${label}: refused as bad input`);
  }
  assert.deepEqual(calls, [], "nothing was sent");
  assert.deepEqual(await gw.unresolvedActions(), [], "nothing is left unresolved");
  assert.equal((await gw.store.list()).length, 0, "nothing was recorded as dispatched");
  const good = await post(gw, agent.sign({ action_type: "http.call", params: { host: "api.ok.example", path: "/v1/items", method: "GET" } }));
  const goodBody = await good.json();
  assert.equal(good.status, 200, goodBody.reason);
  assert.equal(goodBody.receipt.payload.execution.state, "executed");
  assert.deepEqual(calls, ["https://api.ok.example/v1/items"], "the refused calls did not use the day's only slot");
});

test("createHttpExecutor stops reading a response at maxResponseBytes and records the call as executed", { timeout: 30_000 }, async () => {
  const SIZE = 64 * 1024 * 1024;
  let sent = 0;
  let finished = false;
  const { server, port } = await listen((req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream" }); // chunked, no content-length
    const chunk = Buffer.alloc(1024 * 1024, 0x61);
    const pump = () => { while (sent < SIZE) { sent += chunk.length; if (!res.write(chunk)) { res.once("drain", pump); return; } } res.end(); };
    res.on("finish", () => { finished = true; });
    res.on("error", () => {});
    pump();
  });
  try {
    const executor = createHttpExecutor({ scheme: "http", maxResponseBytes: 256 * 1024 });
    const r = await executor.execute({ action_type: "http.call", params: { host: `127.0.0.1:${port}`, path: "/big", method: "GET" } }, { actionId: "a1" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.match(r.ref, /^http:200:/, "the upstream answered, so the call happened");
    assert.match(r.ref, /over-limit/, "the reference says the response was not read in full");
    assert.equal(finished, false, "the 64 MiB body was not read to the end");
    assert.ok(sent < SIZE, `the upstream could not finish sending (${sent} bytes)`);
  } finally { server.closeAllConnections?.(); server.close(); }
});

test("createHttpExecutor refuses a nonsensical size or time limit", () => {
  for (const options of [{ maxResponseBytes: 0 }, { maxResponseBytes: -1 }, { maxResponseBytes: 1.5 }, { maxResponseBytes: Number.NaN }, { timeoutMs: 0 }, { timeoutMs: Infinity }]) {
    assert.throws(() => createHttpExecutor(options), TypeError, JSON.stringify(options));
  }
});

test("createHttpExecutor gives up on an upstream that trickles its answer, as an unknown outcome", { timeout: 30_000 }, async () => {
  const { server, port } = await listen((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    const t = setInterval(() => res.write("."), 50);
    res.on("close", () => clearInterval(t));
  });
  try {
    const executor = createHttpExecutor({ scheme: "http", timeoutMs: 400 });
    const started = Date.now();
    await assert.rejects(
      executor.execute({ action_type: "http.call", params: { host: `127.0.0.1:${port}`, path: "/trickle", method: "GET" } }, { actionId: "a2" }),
      (error) => error.name !== "ExecutorInputError",
    );
    assert.ok(Date.now() - started < 3000, "stopped near its time limit");
  } finally { server.closeAllConnections?.(); server.close(); }
});

test("a gateway records a timed-out http.call as outcome_unknown, never as failed", { timeout: 30_000 }, async () => {
  const { server, port } = await listen((req, res) => { /* never answers */ void req; void res; });
  try {
    const host = `127.0.0.1:${port}`;
    const policy = { vocabulary_version: "1.0", policy_id: "egress", version: 1, clauses: [
      { id: "egress", type: "endpoint_allowlist", mode: "enforce", hosts: [host] },
    ] };
    const { agent, gw } = gatewayFor(policy, createHttpExecutor({ scheme: "http", timeoutMs: 300 }));
    const res = await post(gw, agent.sign({ action_type: "http.call", params: { host, path: "/slow", method: "POST", body: "x" } }));
    const body = await res.json();
    assert.equal(res.status, 202);
    assert.equal(body.receipt.payload.execution.state, "outcome_unknown", "the request was sent: its effect is unknown");
  } finally { server.closeAllConnections?.(); server.close(); }
});

test("createSupportRefundExecutor stops reading a chunked response at maxResponseBytes", { timeout: 30_000 }, async () => {
  const SIZE = 32 * 1024 * 1024;
  let sent = 0;
  const { server, port } = await listen((req, res) => {
    res.writeHead(200, { "content-type": "application/json" }); // no content-length: chunked
    const chunk = Buffer.alloc(1024 * 1024, 0x20);
    res.on("error", () => {});
    const pump = () => { while (sent < SIZE) { sent += chunk.length; if (!res.write(chunk)) { res.once("drain", pump); return; } } res.end(); };
    pump();
  });
  try {
    let consumed = 0;
    const countingFetch = async (url, init) => {
      const res = await fetch(url, init);
      const counter = new TransformStream({ transform(chunk, ctl) { consumed += chunk.byteLength; ctl.enqueue(chunk); } });
      return new Response(res.body.pipeThrough(counter), { status: res.status, headers: res.headers });
    };
    const executor = createSupportRefundExecutor({ origin: `http://127.0.0.1:${port}`, apiToken: "test-refund-token-0001", allowHttpLoopbackForTesting: true, maxResponseBytes: 64 * 1024, fetch: countingFetch });
    await assert.rejects(
      executor.execute({ action_type: "support.refund", asset: "USD", amount: 5, params: { ticket_id: "t1", payment_id: "p1", reason_code: "dup" } }, { actionId: "act-1" }),
      /exceeds configured limit/,
    );
    assert.ok(consumed < 4 * 1024 * 1024, `read ${consumed} bytes of a 64 KiB limit`);
  } finally { server.closeAllConnections?.(); server.close(); }
});

test("createSupportRefundExecutor gives up on an upstream that never answers", { timeout: 30_000 }, async () => {
  const { server, port } = await listen(() => { /* never answers */ });
  try {
    const executor = createSupportRefundExecutor({ origin: `http://127.0.0.1:${port}`, apiToken: "test-refund-token-0001", allowHttpLoopbackForTesting: true, timeoutMs: 300 });
    const started = Date.now();
    await assert.rejects(executor.execute({ action_type: "support.refund", asset: "USD", amount: 5, params: { ticket_id: "t1", payment_id: "p1", reason_code: "dup" } }, { actionId: "act-2" }));
    assert.ok(Date.now() - started < 3000);
  } finally { server.closeAllConnections?.(); server.close(); }
});
