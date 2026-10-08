// The MCP proxy's argument digest is keyed (an HMAC under the proxy's local key), so a low-entropy argument cannot be
// confirmed offline from a receipt; and the proxy's Cloud queue keeps every record (no cap, no expiry) and reports any
// gap it does record.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical } from "@scopebond/policy-schema/canonical";
import { SqliteCloudOutbox } from "@scopebond/gateway/node";
import { createMcpProxy, mapMcpToolCall, openExporter, keyedArgsDigest } from "../dist/index.js";

const keyPem = () => generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const policy = { vocabulary_version: "1.0", policy_id: "mcp", version: 1, clauses: [{ id: "fs", type: "action_allowlist", mode: "enforce", action_types: ["mcp.tool.call"] }] };
const upstream = { call: async (m) => ({ jsonrpc: "2.0", id: m.id ?? null, result: { ok: true } }) };
const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "verify_code", arguments: { code: "123456" } } };

test("args_digest is keyed: not a plain hash, stable under one key, different under another", () => {
  const plain = "sha256:" + createHash("sha256").update(canonical({ code: "123456" })).digest("hex");
  const unkeyed = mapMcpToolCall("auth", call.params).params.args_digest;
  assert.match(unkeyed, /^hmac-sha256:[0-9a-f]{64}$/, "without a key, a per-process key is used");
  assert.notEqual(unkeyed.slice(-64), plain.slice(-64));
  const k1 = keyedArgsDigest("11".repeat(32));
  const a = mapMcpToolCall("auth", call.params, k1).params.args_digest;
  assert.equal(a, mapMcpToolCall("auth", call.params, k1).params.args_digest);
  assert.notEqual(a, mapMcpToolCall("auth", call.params, keyedArgsDigest("22".repeat(32))).params.args_digest);
  assert.notEqual(a.slice(-64), plain.slice(-64));
});

test("the proxy's receipts carry the digest under its configured key", async () => {
  const receipts = [];
  const key = "33".repeat(32);
  for (let i = 0; i < 2; i++) {
    const proxy = createMcpProxy({ policy, principal: { subject: "client:c", issuer: "scopebond:mcp-proxy" }, server: "auth", attesterKeyPem: keyPem(), upstream, argsDigestKey: key, onReceipt: (r) => receipts.push(r) });
    await proxy.handle(call);
  }
  const digests = receipts.map((r) => r.payload.intent.params.args_digest);
  assert.equal(digests[0], digests[1], "two proxies with one key agree");
  assert.equal(digests[0], mapMcpToolCall("auth", call.params, keyedArgsDigest(key)).params.args_digest);
});

test("the proxy's Cloud queue is lossless and reports gaps", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-mcp-outbox-"));
  const keyPath = join(dir, "proxy.key");
  const gaps = [];
  const down = async () => new Response("{}", { status: 503 });
  const exporter = openExporter(keyPath, { url: "https://cloud.invalid", credential: "sbm_fake" }, down, { onGap: (g) => gaps.push(g) });
  const base = { payload: { action_ref: { action_id: "x" }, timestamp: new Date().toISOString() }, signature: { alg: "Ed25519", sig: "AA" } };
  for (let i = 0; i < 10_050; i++) exporter.enqueue({ ...base, payload: { ...base.payload, action_ref: { action_id: `a${i}` } } });
  exporter.enqueue({ ...base, payload: { ...base.payload, action_ref: {} } }); // a record with no id cannot be queued
  const st = exporter.status();
  exporter.stop();
  assert.equal(st.pending, 10_050, "more than the bounded default (10,000) stays queued");
  assert.deepEqual(gaps.map((g) => g.reason), ["missing_action_id"], "the one gap is reported");
  const reopened = new SqliteCloudOutbox(keyPath + ".cloud-outbox.db");
  assert.equal(reopened.status().gaps, 1, "and kept on disk");
  reopened.close();
});
