import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createHmac } from "node:crypto";
import { createMcpProxy, requestBinderFromHex, manifestHash, describeToolCall, sourceReceiptHash } from "../dist/index.js";
import { canonical } from "@scopebond/policy-schema/canonical";

const keyPem = () => generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const KEY_HEX = "33".repeat(32);
const binder = requestBinderFromHex(KEY_HEX);

const TOOLS = [
  { name: "get_issue", description: "read an issue", inputSchema: { type: "object", properties: { repository: { type: "string" } } } },
  { name: "delete_branch", description: "delete a branch", inputSchema: { type: "object", properties: { repository: { type: "string" }, branch: { type: "string" } } } },
  { name: "create_release", description: "publish", inputSchema: { type: "object" } },
  { name: "search", description: "search", inputSchema: { type: "object" } },
];
const MANIFEST = {
  hash: manifestHash(TOOLS),
  tools: {
    get_issue: { operation_class: "read_only", resources: [{ arg: "repository", kind: "repository" }] },
    search: { operation_class: "read_only" },
    delete_branch: { operation_class: "mutation", resources: [{ arg: "repository", kind: "repository" }] },
    create_release: { operation_class: "mutation" },
  },
};
const open = { vocabulary_version: "1.0", policy_id: "mcp", version: 1, clauses: [{ id: "any", type: "action_allowlist", mode: "enforce", action_types: ["mcp.tool.call"] }] };

/** An upstream that serves a tool list and records every message it is sent. */
function upstreamWith(tools = TOOLS) {
  const messages = [];
  return {
    messages,
    calls: () => messages.filter((m) => m.method === "tools/call"),
    call: async (m) => {
      messages.push(m);
      if (m.method === "tools/list") return { jsonrpc: "2.0", id: m.id, result: { tools } };
      return { jsonrpc: "2.0", id: m.id ?? null, result: { content: [{ type: "text", text: "done" }] } };
    },
  };
}

function build(upstream, typed, extra = {}) {
  const drafts = [];
  const receipts = [];
  const proxy = createMcpProxy({
    policy: open, principal: { subject: "client:c1", issuer: "scopebond:mcp-proxy" }, server: "github", attesterKeyPem: keyPem(), upstream,
    onReceipt: (r) => receipts.push(r), adapterVersion: "test-1",
    typed: { mode: "enforce", manifest: MANIFEST, binder, sink: { emit: (d) => { drafts.push(d); } }, ...typed }, ...extra,
  });
  return { proxy, drafts, receipts };
}
const call = (name, args, id = 1) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const list = (proxy) => proxy.handle({ jsonrpc: "2.0", id: "list", method: "tools/list" });

test("a read-only tool: intent before dispatch, outcome after, closed operation with keyed ids", async () => {
  const upstream = upstreamWith();
  const { proxy, drafts, receipts } = build(upstream, {});
  await list(proxy);
  const order = [];
  const sink = { emit: (d) => { order.push(`${d.kind}@${upstream.calls().length}`); } };
  const again = build(upstream, { sink });
  await list(again.proxy);
  const res = await again.proxy.handle(call("get_issue", { repository: "acme/widgets", number: 7 }));
  assert.ok(res.result);
  assert.deepEqual(order, ["tool_intent@0", "tool_outcome@1"], "the intent is recorded before the upstream sees the call");
  await list(proxy);
  await proxy.handle(call("get_issue", { repository: "acme/widgets" }));
  const [intent, outcome] = drafts;
  assert.equal(intent.kind, "tool_intent");
  assert.equal(outcome.kind, "tool_outcome");
  const op = intent.data.operation;
  assert.equal(op.type, "mcp");
  assert.equal(op.server_id, "github");
  assert.equal(op.tool_name, "get_issue");
  assert.equal(op.manifest_version, MANIFEST.hash);
  assert.equal(op.operation_class, "read_only");
  assert.deepEqual(op.resource_ids, [binder.resourceId("mcp:repository", "acme/widgets")]);
  assert.equal(op.digest_key_generation, binder.generation);
  assert.equal(outcome.data.exit_category, "ok");
  assert.equal(outcome.data.event, "completed");
  assert.equal(outcome.data.operation.request_digest, op.request_digest);
  assert.equal(intent.parentActionId, receipts[0].payload.action_ref.action_id);
  assert.equal(intent.sourceReceiptHash, sourceReceiptHash(receipts[0]));
  assert.ok(!JSON.stringify(drafts).includes("acme") && !JSON.stringify(drafts).includes("widgets"), "no raw resource value");
});

test("the request digest is an HMAC over exactly the request the upstream received", async () => {
  const upstream = upstreamWith();
  const { proxy, drafts } = build(upstream, { mode: "monitor" });
  await list(proxy);
  const message = call("get_issue", { repository: "acme/widgets", number: 7 }, 42);
  await proxy.handle(message);
  const sent = upstream.calls()[0];
  const expected = createHmac("sha256", Buffer.from(KEY_HEX, "hex"))
    .update("scopebond:request-binding/v1\n" + canonical({ action_type: "mcp.tool.call", server: "github", request: { method: "tools/call", params: sent.params } }), "utf8").digest("hex");
  assert.equal(drafts[0].data.operation.request_digest, expected);
  assert.equal(drafts[0].data.request_digest, expected);
  // A different argument is a different digest; the key generation never reveals the key.
  await proxy.handle(call("get_issue", { repository: "acme/widgets", number: 8 }, 43));
  assert.notEqual(drafts[2].data.operation.request_digest, expected);
  assert.ok(!binder.generation.includes(KEY_HEX.slice(0, 16)));
});

test("unknown tool or drifted revision is denied before dispatch under enforce; the upstream sees no tools/call", async () => {
  const upstream = upstreamWith();
  const { proxy, drafts } = build(upstream, {});
  await list(proxy);
  const before = upstream.messages.length;
  const res = await proxy.handle(call("exfiltrate", { target: "x" }));
  assert.match(res.error.message, /not in the pinned manifest/);
  assert.equal(upstream.messages.length, before, "the upstream was not invoked at all");
  assert.equal(upstream.calls().length, 0);
  assert.equal(drafts.length, 1, "the intent is still recorded");
  assert.equal(drafts[0].data.operation.operation_class, "unknown");

  // The server's tool list changed after the manifest was pinned.
  const drifted = upstreamWith([...TOOLS, { name: "new_tool", description: "x", inputSchema: {} }]);
  const second = build(drifted, {});
  await list(second.proxy);
  const denied = await second.proxy.handle(call("search", {}));
  assert.match(denied.error.message, /no longer matches the pinned manifest/);
  assert.equal(drifted.calls().length, 0);
  assert.equal(second.drafts[0].data.operation.manifest_version, "unverified");
  assert.equal(second.drafts[0].data.operation.operation_class, "unknown", "a tool of a drifted revision is not read_only on the old manifest's word");
  assert.equal(second.drafts.filter((d) => d.kind === "tool_outcome").length, 0, "no outcome for a call that was never dispatched");
});

test("monitor mode records unknowns and forwards them", async () => {
  const upstream = upstreamWith();
  const { proxy, drafts } = build(upstream, { mode: "monitor" });
  await list(proxy);
  const res = await proxy.handle(call("exfiltrate", {}));
  assert.ok(res.result, "forwarded");
  assert.equal(upstream.calls().length, 1);
  assert.equal(drafts[0].data.operation.operation_class, "unknown");
  assert.equal(drafts[1].data.exit_category, "ok");
});

test("a manifest is verified against the live tool list even when the client never listed", async () => {
  const upstream = upstreamWith();
  const { proxy, drafts } = build(upstream, {});
  const res = await proxy.handle(call("search", {}));
  assert.ok(res.result);
  assert.equal(upstream.messages[0].method, "tools/list", "the proxy read the live list itself first");
  assert.equal(drafts[0].data.operation.operation_class, "read_only");
  // An upstream that will not list its tools leaves the revision unverified: denied under enforce.
  const silent = { messages: [], calls: () => [], call: async (m) => { silent.messages.push(m); return m.method === "tools/list" ? { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no" } } : { jsonrpc: "2.0", id: m.id, result: {} }; } };
  const closed = build(silent, {});
  const denied = await closed.proxy.handle(call("search", {}));
  assert.ok(denied.error);
  assert.equal(silent.messages.filter((m) => m.method === "tools/call").length, 0);
});

test("a manifest alone never authorizes a resource-specific call: binding is required and checked against the approved set", async () => {
  const typed = { requireResourceBinding: true, approvedResources: { repository: ["acme/widgets"] } };
  const upstream = upstreamWith();
  const { proxy } = build(upstream, typed);
  await list(proxy);
  const ok = await proxy.handle(call("delete_branch", { repository: "acme/widgets", branch: "old" }));
  assert.ok(ok.result, "the approved repository is allowed");
  assert.equal(upstream.calls().length, 1);
  const wrongRepo = await proxy.handle(call("delete_branch", { repository: "other/repo", branch: "old" }, 2));
  assert.match(wrongRepo.error.message, /not in the approved set/);
  const missing = await proxy.handle(call("delete_branch", { branch: "old" }, 3));
  assert.match(missing.error.message, /could not be read from the dispatched arguments/);
  const nonScalar = await proxy.handle(call("delete_branch", { repository: { name: "acme/widgets" } }, 4));
  assert.ok(nonScalar.error, "an object where a resource id is expected is not bound");
  const unbindable = await proxy.handle(call("create_release", { tag: "v1" }, 5));
  assert.match(unbindable.error.message, /names no resource to bind/);
  assert.equal(upstream.calls().length, 1, "only the approved call was dispatched");
  // A read-only tool with no resource of its own is not resource-specific.
  assert.ok((await proxy.handle(call("search", { q: "x" }, 6))).result);
  // A kind with no approved entry approves nothing.
  const none = build(upstreamWith(), { requireResourceBinding: true, approvedResources: {} });
  await list(none.proxy);
  assert.ok((await none.proxy.handle(call("get_issue", { repository: "acme/widgets" }))).error);
  // Without the option a manifest-listed mutation is allowed by the manifest alone (that is the gap the option closes).
  const loose = build(upstreamWith(), {});
  await list(loose.proxy);
  assert.ok((await loose.proxy.handle(call("delete_branch", { repository: "anything/at-all" }))).result);
});

test("the policy still decides first, and an adapter failure never blocks or breaks a call", async () => {
  const deny = { ...open, clauses: [{ id: "no", type: "action_allowlist", mode: "enforce", action_types: ["mcp.tool.call"], param_bounds: { tool: { pattern: "^(?!search$).+" } } }] };
  const upstream = upstreamWith();
  const { proxy, drafts } = build(upstream, {}, { policy: deny });
  await list(proxy);
  const res = await proxy.handle(call("search", {}));
  assert.match(res.error.message, /Scopebond policy denied search/);
  assert.equal(upstream.calls().length, 0);
  assert.equal(drafts.length, 1);
  const throwing = build(upstreamWith(), { sink: { emit: () => { throw new Error("outbox full"); } } });
  await list(throwing.proxy);
  assert.ok((await throwing.proxy.handle(call("search", {}))).result, "a failing sink does not change the call");
});

test("an upstream error is reported as an error outcome; a name that is not a plain identifier has no operation", async () => {
  const upstream = { messages: [], calls: () => [], call: async (m) => (m.method === "tools/list" ? { jsonrpc: "2.0", id: m.id, result: { tools: TOOLS } } : { jsonrpc: "2.0", id: m.id, result: { isError: true, content: [] } }) };
  const { proxy, drafts } = build(upstream, {});
  await list(proxy);
  await proxy.handle(call("search", {}));
  assert.equal(drafts[1].data.exit_category, "error");
  assert.equal(drafts[1].data.event, "failed");
  const odd = describeToolCall({ mode: "enforce", manifest: MANIFEST, binder }, "github", { params: { name: "bad name!", arguments: {} } }, true);
  assert.equal(odd.operation, null);
  assert.equal(odd.allow, false);
});

test("requestBinderFromHex matches the hook's binding key byte for byte", async () => {
  const hook = await import("@scopebond/hook");
  const theirs = hook.bindingKeyFromHex(KEY_HEX);
  const request = { action_type: "mcp.tool.call", server: "github", request: { method: "tools/call", params: { name: "x", arguments: { a: [1, "é"] } } } };
  assert.equal(binder.requestDigest(request), theirs.requestDigest(request));
  assert.equal(binder.resourceId("mcp", "github\0x"), theirs.resourceId("mcp", "github\0x"));
  assert.equal(binder.generation, theirs.generation);
  assert.throws(() => requestBinderFromHex("short"));
});

test("manifestHash ignores presentation order and detects a changed tool", () => {
  assert.equal(manifestHash([...TOOLS].reverse()), manifestHash(TOOLS));
  assert.notEqual(manifestHash(TOOLS.map((t) => (t.name === "search" ? { ...t, description: "search everything" } : t))), manifestHash(TOOLS));
});
