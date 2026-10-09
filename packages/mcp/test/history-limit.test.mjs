// The MCP proxy's session history is bounded in calls and bytes, dropping the oldest, so a long-running proxy does not grow
// or slow down with every call it has made. The bound never lets through more than the policy allows: while a dropped call
// may still be inside a windowed clause's window, calls are refused, and once it has left the window they are decided again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createMcpProxy } from "../dist/index.js";

const pem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const principal = { subject: "client:history-limit", issuer: "scopebond:mcp-proxy" };
const upstream = { call: async (m) => ({ jsonrpc: "2.0", id: m.id ?? null, result: { ok: true } }) };
const stateless = { vocabulary_version: "1.0", policy_id: "mcp", version: 1, clauses: [
  { id: "fs", type: "action_allowlist", mode: "enforce", action_types: ["mcp.tool.call"], param_bounds: { server: { enum: ["filesystem"] } } },
] };
const rate = (max, window) => ({ vocabulary_version: "1.0", policy_id: "mcp-rate", version: 1, clauses: [
  { id: "rate", type: "rate_limit", mode: "enforce", action_types: ["mcp.tool.call"], max_count: max, window },
] });
const call = (id, name = "read_file") => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: { path: `/f/${id}` } } });

function clocked(policy, historyLimit) {
  let now = Date.parse("2026-10-09T00:00:00.000Z");
  const proxy = createMcpProxy({ policy, principal, server: "filesystem", attesterKeyPem: pem, upstream, now: () => new Date(now).toISOString(), historyLimit });
  return { proxy, advance: (ms) => { now += ms; } };
}
const answer = async (proxy, id, name) => (await proxy.handle(call(id, name))).error?.message ?? "allowed";

async function msPerCall(proxy, tag, n = 40) {
  const t0 = performance.now();
  for (let i = 0; i < n; i++) await proxy.handle(call(`${tag}-${i}`));
  return (performance.now() - t0) / n;
}

test("decision time stays flat once the history is at its bound", async () => {
  const proxy = createMcpProxy({ policy: stateless, principal, server: "filesystem", attesterKeyPem: pem, upstream, historyLimit: { maxCalls: 200 } });
  await msPerCall(proxy, "warm", 20);
  const early = await msPerCall(proxy, "early");
  for (let i = 0; i < 3000; i++) await proxy.handle(call(i));
  const late = await msPerCall(proxy, "late");
  assert.ok(late < Math.max(early * 4, early + 3), `ms per call: ${early.toFixed(2)} early, ${late.toFixed(2)} after 3,000 calls`);
});

test("a rate limit is never exceeded because calls were dropped: calls are refused until the dropped ones leave the window", async () => {
  const { proxy, advance } = clocked(rate(5, "PT1H"), { maxCalls: 3 });
  const answers = [];
  for (let i = 0; i < 10; i++) { answers.push(await answer(proxy, `a${i}`)); advance(1_000); }
  const allowed = answers.filter((a) => a === "allowed").length;
  assert.ok(allowed <= 5, `${allowed} calls allowed under a limit of 5: ${answers.join(" | ")}`);
  assert.match(answers.at(-1), /call history is full .* refused until those leave the policy's longest window/);
  advance(61 * 60_000); // every dropped call has left the hour
  assert.equal(await answer(proxy, "later"), "allowed");
});

test("the history is bounded in bytes too", async () => {
  const { proxy, advance } = clocked(rate(1000, "PT1H"), { maxBytes: 4096 });
  const long = "t".repeat(1500);
  const answers = [];
  for (let i = 0; i < 6; i++) { answers.push(await answer(proxy, `b${i}`, `${long}${i}`)); advance(1_000); }
  assert.match(answers.at(-1), /call history is full/, answers.join(" | "));
});

test("dropping calls a policy cannot read refuses nothing", async () => {
  const flat = clocked(stateless, { maxCalls: 3 });
  for (let i = 0; i < 20; i++) assert.equal(await answer(flat.proxy, `s${i}`), "allowed", `stateless call ${i}`);
  // Calls two minutes apart under a one-minute window: what is dropped is already outside it.
  const spaced = clocked(rate(100, "PT1M"), { maxCalls: 3 });
  for (let i = 0; i < 10; i++) { assert.equal(await answer(spaced.proxy, `w${i}`), "allowed", `windowed call ${i}`); spaced.advance(2 * 60_000); }
});

test("a history limit that is not a positive whole number is refused", () => {
  for (const historyLimit of [{ maxCalls: 0 }, { maxBytes: -1 }, { maxCalls: 1.5 }]) {
    assert.throws(() => createMcpProxy({ policy: stateless, principal, server: "filesystem", attesterKeyPem: pem, upstream, historyLimit }), /historyLimit/);
  }
});
