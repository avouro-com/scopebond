// A long-running MCP proxy keeps only the history its policy can read: nothing for a policy without windowed clauses,
// and the longest window for one with them. A decision does not get slower with every earlier call, and windowed
// limits still count exactly the calls inside their window.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createMcpProxy } from "../dist/index.js";

const pem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const principal = { subject: "client:bounded", issuer: "scopebond:mcp-proxy" };
const upstream = { call: async (m) => ({ jsonrpc: "2.0", id: m.id ?? null, result: { ok: true } }) };
const stateless = { vocabulary_version: "1.0", policy_id: "mcp", version: 1, clauses: [
  { id: "fs", type: "action_allowlist", mode: "enforce", action_types: ["mcp.tool.call"], param_bounds: { server: { enum: ["filesystem"] } } },
] };
const call = (id, path = `/f/${id}`) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "read_file", arguments: { path } } });

async function msPerCall(proxy, tag, n = 40) {
  const t0 = performance.now();
  for (let i = 0; i < n; i++) await proxy.handle(call(`${tag}-${i}`));
  return (performance.now() - t0) / n;
}

test("decision time does not grow with the number of earlier calls (stateless policy)", async () => {
  const proxy = createMcpProxy({ policy: stateless, principal, server: "filesystem", attesterKeyPem: pem, upstream });
  await msPerCall(proxy, "warm", 20);
  const early = await msPerCall(proxy, "early");
  for (let i = 0; i < 2500; i++) await proxy.handle(call(i));
  const late = await msPerCall(proxy, "late");
  assert.ok(late < Math.max(early * 3, early + 2), `ms per call: ${early.toFixed(2)} early, ${late.toFixed(2)} after 2,500 calls`);
});

test("a seeded history older than every window costs nothing per decision", async () => {
  const old = Array.from({ length: 20_000 }, (_, i) => ({
    intent: { action_type: "mcp.tool.call", params: { server: "filesystem", tool: "read_file", args_digest: `d${i}` } },
    executed: true, timestamp: "2020-01-01T00:00:00.000Z", intent_hash: `h${i}`, action_id: `old-${i}`,
  }));
  const rate = { vocabulary_version: "1.0", policy_id: "mcp-rate", version: 1, clauses: [
    { id: "rate", type: "rate_limit", mode: "enforce", action_types: ["mcp.tool.call"], max_count: 1000, window: "PT1H" },
  ] };
  const seeded = createMcpProxy({ policy: rate, principal, server: "filesystem", attesterKeyPem: pem, upstream, history: old });
  const fresh = createMcpProxy({ policy: rate, principal, server: "filesystem", attesterKeyPem: pem, upstream });
  await msPerCall(fresh, "warm", 10);
  const base = await msPerCall(fresh, "fresh", 20);
  const withOld = await msPerCall(seeded, "seeded", 20);
  assert.ok(withOld < Math.max(base * 3, base + 2), `ms per call: ${base.toFixed(2)} fresh, ${withOld.toFixed(2)} with 20,000 expired calls`);
});

test("a rate limit still counts exactly the calls inside its window while older ones are dropped", async () => {
  let now = Date.parse("2026-10-09T00:00:00.000Z");
  const clock = () => new Date(now).toISOString();
  const policy = { vocabulary_version: "1.0", policy_id: "mcp-rate", version: 1, clauses: [
    { id: "rate", type: "rate_limit", mode: "enforce", action_types: ["mcp.tool.call"], max_count: 3, window: "PT1M" },
  ] };
  const seededAt = new Date(now - 30_000).toISOString();
  const proxy = createMcpProxy({ policy, principal, server: "filesystem", attesterKeyPem: pem, upstream, now: clock, history: [
    { intent: { action_type: "mcp.tool.call", params: { server: "filesystem", tool: "read_file", args_digest: "x" } }, executed: true, timestamp: seededAt, intent_hash: "seed", action_id: "seed" },
  ] });
  const allowed = async (id) => !(await proxy.handle(call(id))).error;
  assert.equal(await allowed("a"), true);
  assert.equal(await allowed("b"), true);
  assert.equal(await allowed("c"), false, "the seeded call inside the window counts");
  now += 31_000; // the seeded call leaves the window
  assert.equal(await allowed("d"), true);
  assert.equal(await allowed("e"), false);
  now += 61_000; // every earlier call leaves the window
  for (const id of ["f", "g", "h"]) assert.equal(await allowed(id), true, id);
  assert.equal(await allowed("i"), false);
});
