import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createPublicKey } from "node:crypto";
import { createMcpProxy, mapMcpToolCall } from "../dist/index.js";
import { verifyReceipt } from "@scopebond/gateway";

const keyPem = () => generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const policy = {
  vocabulary_version: "1.0", policy_id: "mcp", version: 1,
  clauses: [{
    id: "fs", type: "action_allowlist", mode: "enforce", action_types: ["mcp.tool.call"],
    param_bounds: { server: { enum: ["filesystem"] }, tool: { pattern: "^(?!delete_|write_).+" } },
  }],
};

function stubUpstream() {
  const calls = [];
  return { calls, call: async (m) => { calls.push(m); return { jsonrpc: "2.0", id: m.id ?? null, result: { ok: true } }; } };
}

function proxyWith(upstream, onReceipt) {
  const pem = keyPem();
  return {
    pem,
    proxy: createMcpProxy({ policy, principal: { subject: "client:c7", issuer: "scopebond:mcp-proxy" }, server: "filesystem", attesterKeyPem: pem, upstream, onReceipt }),
  };
}

test("mapMcpToolCall digests arguments and never stores them", () => {
  const a = mapMcpToolCall("filesystem", { name: "read_file", arguments: { path: "/etc/passwd" } });
  assert.equal(a.action_type, "mcp.tool.call");
  assert.equal(a.params.server, "filesystem");
  assert.equal(a.params.tool, "read_file");
  assert.match(String(a.params.args_digest), /^sha256:[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(a).includes("/etc/passwd"), false, "raw arguments are not retained");
});

test("an allowed tool call is forwarded upstream with a pep_authorized allow receipt", async () => {
  const upstream = stubUpstream();
  const receipts = [];
  const { pem, proxy } = proxyWith(upstream, (r) => receipts.push(r));
  const res = await proxy.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_file", arguments: { path: "a" } } });
  assert.deepEqual(res.result, { ok: true }, "the upstream result is returned");
  assert.equal(upstream.calls.length, 1, "the call was forwarded");
  assert.equal(receipts.length, 1);
  const pub = createPublicKey(pem).export({ type: "spki", format: "pem" }).toString();
  const v = verifyReceipt(receipts[0], pub);
  assert.equal(v.valid, true);
  assert.equal(v.evidence_class, "pep_authorized");
  assert.equal(receipts[0].payload.execution.state, "cooperative_allow");
});

test("a denied tool call is blocked, never forwarded, with a deny receipt", async () => {
  const upstream = stubUpstream();
  const receipts = [];
  const { proxy } = proxyWith(upstream, (r) => receipts.push(r));
  const res = await proxy.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "delete_file", arguments: { path: "a" } } });
  assert.ok(res.error, "a JSON-RPC error is returned");
  assert.match(res.error.message, /Scopebond policy denied delete_file/);
  assert.equal(upstream.calls.length, 0, "the denied call was never forwarded");
  assert.equal(receipts[0].payload.realtime_result, "deny");
  assert.equal(receipts[0].payload.execution.state, "denied");
});

test("a tool failing the tool bound is denied regardless of a matching server", async () => {
  const upstream = stubUpstream();
  const { proxy } = proxyWith(upstream);
  const res = await proxy.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "write_secret" } });
  assert.ok(res.error);
  assert.equal(upstream.calls.length, 0);
});

test("non-tool-call methods pass through unchanged", async () => {
  const upstream = stubUpstream();
  const { proxy } = proxyWith(upstream);
  const res = await proxy.handle({ jsonrpc: "2.0", id: 9, method: "tools/list", params: {} });
  assert.deepEqual(res.result, { ok: true });
  assert.equal(upstream.calls.length, 1, "the passthrough reached the upstream");
});

test("rate_limit binds across calls: the proxy counts prior authorized calls (SB66)", async () => {
  const ratePolicy = {
    vocabulary_version: "1.0", policy_id: "mcp-rate", version: 1,
    clauses: [
      { id: "fs", type: "action_allowlist", mode: "enforce", action_types: ["mcp.tool.call"], param_bounds: { server: { enum: ["filesystem"] } } },
      { id: "rl", type: "rate_limit", mode: "enforce", action_types: ["mcp.tool.call"], max_count: 2, window: "PT1H" },
    ],
  };
  const upstream = stubUpstream();
  const proxy = createMcpProxy({
    policy: ratePolicy, principal: { subject: "client:c7", issuer: "scopebond:mcp-proxy" },
    server: "filesystem", attesterKeyPem: keyPem(), upstream,
  });
  const call = (i) => proxy.handle({ jsonrpc: "2.0", id: i, method: "tools/call", params: { name: "read_file", arguments: { path: `f${i}` } } });
  assert.ok((await call(1)).result, "first call allowed");
  assert.ok((await call(2)).result, "second call allowed");
  const third = await call(3);
  assert.ok(third.error, "the third call in the window is denied");
  assert.match(third.error.message, /max_count/);
  assert.equal(upstream.calls.length, 2, "only the two authorized calls were forwarded");
});

test("seeded history counts toward the window at startup (SB66)", async () => {
  const ratePolicy = {
    vocabulary_version: "1.0", policy_id: "mcp-rate2", version: 1,
    clauses: [
      { id: "fs", type: "action_allowlist", mode: "enforce", action_types: ["mcp.tool.call"], param_bounds: { server: { enum: ["filesystem"] } } },
      { id: "rl", type: "rate_limit", mode: "enforce", action_types: ["mcp.tool.call"], max_count: 1, window: "PT1H" },
    ],
  };
  const upstream = stubUpstream();
  const proxy = createMcpProxy({
    policy: ratePolicy, principal: { subject: "client:c7", issuer: "scopebond:mcp-proxy" },
    server: "filesystem", attesterKeyPem: keyPem(), upstream,
    history: [{ intent: { action_type: "mcp.tool.call", params: { server: "filesystem", tool: "read_file", args_digest: "sha256:seed" } }, executed: true, timestamp: new Date().toISOString(), intent_hash: "seed-1" }],
  });
  const res = await proxy.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_file", arguments: { path: "x" } } });
  assert.ok(res.error, "one seeded call already fills the max_count:1 window, so this is denied");
  assert.equal(upstream.calls.length, 0, "the denied call was not forwarded");
});
