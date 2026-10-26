// A tool call is decided by its exact tool name, but some upstreams resolve tool names loosely (another case, a
// full-width form). A rule that denies a tool by its exact name could then be passed by a call spelled another way.
// In enforce mode the proxy forwards a call only under a name that is exactly one tool of the upstream's own tool list,
// with no other listed tool spelled the same way up to case and width; without a list it forwards none. In monitor mode
// the finding is recorded on the receipt and the call is forwarded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createMcpProxy } from "../dist/index.js";

const keyPem = () => generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
// Every tool is allowed except `remove_item`, denied by its exact name.
const POLICY = {
  vocabulary_version: "1.0", policy_id: "mcp-names", version: 1,
  clauses: [{ id: "all-but-remove", type: "action_allowlist", mode: "enforce", action_types: ["mcp.tool.call"],
    param_bounds: { tool: { pattern: "^(?!remove_item$).+" } } }],
};

/** An upstream that lists `tools` (or fails to list when null) and resolves a call's tool name loosely. */
function looseUpstream(tools) {
  const ran = [];
  return {
    ran,
    async call(m) {
      if (m.method === "tools/list") {
        return tools === null ? { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no" } } : { jsonrpc: "2.0", id: m.id, result: { tools: tools.map((name) => ({ name })) } };
      }
      const loose = (s) => s.normalize("NFKC").toLowerCase();
      const name = (tools ?? []).find((t) => loose(t) === loose(String(m.params?.name))) ?? m.params?.name;
      ran.push(name);
      return { jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: `ran ${name}` }] } };
    },
  };
}
const proxyFor = (upstream) => createMcpProxy({
  policy: POLICY, principal: { subject: "client:names", issuer: "scopebond:mcp-proxy" }, server: "files", attesterKeyPem: keyPem(), upstream,
});
const call = (id, name) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: {} } });

test("a case or width variant of a tool denied by name is refused, never run by a loosely matching upstream", async () => {
  const up = looseUpstream(["read_file", "remove_item"]);
  const proxy = proxyFor(up);
  assert.match((await proxy.handle(call(1, "remove_item"))).error.message, /denied remove_item/, "control: the exact name is denied by the rule");
  for (const [i, name] of ["Remove_Item", "REMOVE_ITEM", "ｒｅｍｏｖｅ＿ｉｔｅｍ", "remove_ITEM"].entries()) {
    const reply = await proxy.handle(call(10 + i, name));
    assert.equal(reply.error?.code, -32000, `${name}: ${JSON.stringify(reply)}`);
    assert.match(reply.error.message, /another spelling of a listed tool/, name);
  }
  assert.deepEqual(up.ran, [], "the upstream ran nothing");
  assert.ok((await proxy.handle(call(2, "read_file"))).result, "an exact listed name is forwarded");
  assert.deepEqual(up.ran, ["read_file"]);
});

test("a tool the upstream does not list is refused", async () => {
  const up = looseUpstream(["read_file"]);
  const reply = await proxyFor(up).handle(call(1, "unlisted_tool"));
  assert.match(reply.error.message, /not in the upstream's tool list/);
  assert.deepEqual(up.ran, []);
});

test("with no tool list from the upstream, every call is refused", async () => {
  const up = looseUpstream(null);
  const reply = await proxyFor(up).handle(call(1, "read_file"));
  assert.match(reply.error.message, /tool list could not be read/);
  assert.deepEqual(up.ran, []);
});

test("a name listed twice up to case is refused under either spelling", async () => {
  const up = looseUpstream(["read_file", "Read_File"]);
  const proxy = proxyFor(up);
  for (const name of ["read_file", "Read_File"]) assert.match((await proxy.handle(call(1, name))).error.message, /differ only in case or width/, name);
  assert.deepEqual(up.ran, []);
});

test("the client's own tool list is the one calls are checked against", async () => {
  const seen = [];
  const up = looseUpstream(["read_file", "remove_item"]);
  const counting = { call: (m) => { seen.push(m.method); return up.call(m); } };
  const proxy = proxyFor(counting);
  await proxy.handle({ jsonrpc: "2.0", id: "l", method: "tools/list" });
  assert.ok((await proxy.handle(call(1, "read_file"))).result);
  assert.deepEqual(seen, ["tools/list", "tools/call"], "no second listing was needed");
});

// Monitor mode: nothing is blocked for a tool-list finding. The finding is recorded on the receipt's action
// (`tool_listing`) and the call is forwarded. In enforce mode the same finding denies the call and is recorded too.
const MONITOR_POLICY = { ...POLICY, clauses: POLICY.clauses.map((c) => ({ ...c, mode: "monitor" })) };
const binder = { generation: "bk_test", requestDigest: () => "00".repeat(32), resourceId: (k, v) => `sbr_${k}_${v}` };
function proxyWith(upstream, extra) {
  const receipts = [];
  const proxy = createMcpProxy({
    policy: POLICY, principal: { subject: "client:names", issuer: "scopebond:mcp-proxy" }, server: "files", attesterKeyPem: keyPem(), upstream,
    onReceipt: (r) => receipts.push(r), ...extra,
  });
  return { proxy, receipts };
}
const listingOf = (receipt) => receipt.payload.intent.params.tool_listing;

test("enforce mode: the finding denies the call and is recorded on its receipt", async () => {
  const up = looseUpstream(["read_file", "remove_item"]);
  const { proxy, receipts } = proxyWith(up, {});
  assert.match((await proxy.handle(call(1, "Remove_Item"))).error.message, /another spelling/);
  assert.equal(receipts.at(-1).payload.realtime_result, "deny");
  assert.equal(listingOf(receipts.at(-1)), "spelling_variant");
  assert.ok((await proxy.handle(call(2, "read_file"))).result);
  assert.equal(listingOf(receipts.at(-1)), undefined, "an exact listed name has no finding");
  assert.deepEqual(up.ran, ["read_file"]);
});

test("monitor mode (a policy whose clauses all monitor): every finding is recorded and the call is forwarded", async () => {
  const cases = [
    [["read_file", "remove_item"], "Remove_Item", "spelling_variant"],
    [["read_file"], "unlisted_tool", "unlisted"],
    [["read_file", "Read_File"], "read_file", "ambiguous"],
    [null, "read_file", "no_list"],
  ];
  for (const [tools, name, finding] of cases) {
    const up = looseUpstream(tools);
    const { proxy, receipts } = proxyWith(up, { policy: MONITOR_POLICY });
    const reply = await proxy.handle(call(1, name));
    assert.ok(reply.result, `${name}: ${JSON.stringify(reply)}`);
    assert.equal(up.ran.length, 1, `${name} was forwarded`);
    assert.equal(receipts.at(-1).payload.realtime_result, "allow", name);
    assert.equal(listingOf(receipts.at(-1)), finding, name);
  }
});

test("monitor mode (a typed adapter in monitor): an unlisted name is recorded and forwarded; in enforce it is denied", async () => {
  const monitor = proxyWith(looseUpstream(["read_file"]), { typed: { mode: "monitor", binder } });
  assert.ok((await monitor.proxy.handle(call(1, "unlisted_tool"))).result);
  assert.equal(listingOf(monitor.receipts.at(-1)), "unlisted");
  const enforce = proxyWith(looseUpstream(["read_file"]), { typed: { mode: "enforce", binder } });
  assert.ok((await enforce.proxy.handle(call(1, "unlisted_tool"))).error);
  assert.equal(listingOf(enforce.receipts.at(-1)), "unlisted");
});
