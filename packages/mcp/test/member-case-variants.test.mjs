// JSON-RPC member names are case-sensitive and the proxy reads them that way, but some upstream decoders
// (Go's encoding/json among them) match member names case-insensitively, folding Unicode as well ("ſ" is "s",
// the Kelvin sign is "k"), and let the later of two matches win. A message whose members differ from the
// protocol's only in case could then run something other than what was decided. The proxy refuses such
// messages and forwards a message rebuilt from exactly the members it read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createMcpProxy, requestBinderFromHex, manifestHash } from "../dist/index.js";

const keyPem = () => generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const NOW = () => "2026-10-08T12:00:00.000Z";
// Read-only tool names only, as the starter policy.
const POLICY = {
  vocabulary_version: "1.0", policy_id: "mcp", version: 1,
  clauses: [{ id: "ro", type: "action_allowlist", mode: "enforce", action_types: ["mcp.tool.call"],
    param_bounds: { tool: { pattern: "^(list_|get_|update_file$)" } } }],
};
const TOOLS = [{ name: "update_file", description: "write a file", inputSchema: { type: "object", properties: { repository: { type: "string" } } } }];
const MANIFEST = { hash: manifestHash(TOOLS), tools: { update_file: { operation_class: "mutation", resources: [{ arg: "repository", kind: "repository" }] } } };

function upstream() {
  const seen = [];
  return {
    seen,
    calls: () => seen.filter((m) => m.method === "tools/call"),
    async call(m) {
      seen.push(m);
      if (m.method === "tools/list") return { jsonrpc: "2.0", id: m.id, result: { tools: TOOLS } };
      return { jsonrpc: "2.0", id: m.id ?? null, result: { content: [{ type: "text", text: "ran" }] } };
    },
  };
}
const proxyWith = (up, extra = {}) => createMcpProxy({
  policy: POLICY, principal: { subject: "client:c1", issuer: "scopebond:mcp-proxy" }, server: "github", attesterKeyPem: keyPem(), now: NOW, upstream: up, ...extra,
});
const typedWith = (up, typed = {}) => proxyWith(up, {
  typed: { mode: "enforce", manifest: MANIFEST, binder: requestBinderFromHex("44".repeat(32)), requireResourceBinding: true, approvedResources: { repository: ["acme/sandbox"] }, ...typed },
});

test("a top-level member spelled like a protocol member in another case is refused with -32600 and never forwarded", async () => {
  const up = upstream();
  const proxy = proxyWith(up);
  const variants = [
    { jsonrpc: "2.0", id: 1, Method: "tools/call", params: { name: "delete_repository", arguments: {} } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", METHOD: "tools/call", params: { name: "list_issues", arguments: {} } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_issues", arguments: {} }, Params: { name: "delete_repository", arguments: {} } },
    { jsonrpc: "2.0", id: 4, ID: 5, method: "ping" },
    { jsonrpc: "2.0", id: 6, method: "ping", "jſonrpc": "2.0" },
    { jsonrpc: "2.0", id: 7, Result: {} },
  ];
  for (const message of variants) {
    const reply = await proxy.handle(message);
    assert.equal(reply.error?.code, -32600, JSON.stringify(message));
    assert.equal(reply.id, message.id);
  }
  assert.equal(up.seen.length, 0, "nothing was forwarded");
});

test("tools/call params holding a case or fold variant of name, arguments or _meta are refused", async () => {
  const up = upstream();
  const proxy = proxyWith(up);
  const params = [
    { name: "list_issues", Name: "delete_repository", arguments: {} },
    { NAME: "delete_repository", name: "list_issues" },
    { name: "list_issues", arguments: {}, Arguments: { repo: "acme/prod" } },
    { name: "list_issues", "argumentſ": { repo: "acme/prod" } },
    { name: "list_issues", _meta: {}, _META: { progressToken: 1 } },
  ];
  for (const [i, p] of params.entries()) {
    const reply = await proxy.handle({ jsonrpc: "2.0", id: i + 1, method: "tools/call", params: p });
    assert.equal(reply.error?.code, -32600, JSON.stringify(p));
  }
  assert.equal(up.seen.length, 0, "nothing was forwarded");
});

test("the typed adapter denies arguments holding two keys equal under case folding, at any depth", async () => {
  const up = upstream();
  const proxy = typedWith(up);
  await proxy.handle({ jsonrpc: "2.0", id: "l", method: "tools/list" });
  const call = (id, args) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "update_file", arguments: args } });
  const ok = await proxy.handle(call(1, { repository: "acme/sandbox", path: "a" }));
  assert.ok(ok.result, "the approved repository is allowed");
  for (const [id, args] of [
    [2, { repository: "acme/sandbox", Repository: "acme/prod", path: "a" }],
    [3, { repository: "acme/sandbox", "REPOſITORY": "acme/prod" }],
    [4, { repository: "acme/sandbox", options: { kind: "a", "Kind": "b" } }],
    [5, { repository: "acme/sandbox", list: [{ x: 1, X: 2 }] }],
  ]) {
    const reply = await proxy.handle(call(id, args));
    assert.equal(reply.error?.code, -32000, JSON.stringify(args));
    assert.match(reply.error.message, /differ only in case/);
  }
  // A resource argument spelled only in another case is not the one the manifest names: not bound, not forwarded.
  const variantOnly = await proxy.handle(call(6, { Repository: "acme/prod" }));
  assert.ok(variantOnly.error, "a resource spelled in another case is denied");
  const loose = typedWith(upstream(), { requireResourceBinding: false });
  await loose.handle({ jsonrpc: "2.0", id: "l", method: "tools/list" });
  const looseReply = await loose.handle(call(7, { Repository: "acme/prod" }));
  assert.match(looseReply.error?.message ?? "", /spelled differently/);
  assert.equal(up.calls().length, 1, "only the unambiguous call was dispatched");
});

test("the forwarded message is rebuilt from the members the proxy read", async () => {
  const up = upstream();
  const proxy = proxyWith(up);
  await proxy.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", extra: "x", params: { name: "list_issues", arguments: { q: "a" }, _meta: { progressToken: "p" }, other: 1 } });
  assert.deepEqual(up.seen.at(-1), { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_issues", arguments: { q: "a" }, _meta: { progressToken: "p" } } });
  await proxy.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_issues" } });
  assert.deepEqual(up.seen.at(-1), { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_issues" } });
});

test("ordinary MCP traffic still flows: other methods, notifications, responses, errors and _meta", async () => {
  const up = upstream();
  const proxy = typedWith(up, { mode: "monitor" });
  const messages = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri: "file:///a", _meta: { progressToken: 3 } } },
    { jsonrpc: "2.0", id: "u1", result: { roots: [] } },
    { jsonrpc: "2.0", id: "u2", error: { code: -1, message: "no" } },
    { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2, reason: "r" } },
    { jsonrpc: "2.0", id: 3, method: "tools/list" },
  ];
  for (const m of messages) await proxy.handle(m);
  assert.deepEqual(up.seen, messages, "each message reached the upstream unchanged");
  // Argument keys that differ in more than case are not ambiguous; in monitor mode an ambiguous call is still forwarded.
  const fine = await proxy.handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "update_file", arguments: { repository: "acme/sandbox", repository_id: 1, _meta: 1 }, _meta: { progressToken: 1 } } });
  assert.ok(fine.result);
  const monitored = await proxy.handle({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "update_file", arguments: { repository: "acme/sandbox", Repository: "acme/prod" } } });
  assert.ok(monitored.result, "monitor mode records and forwards");
});
