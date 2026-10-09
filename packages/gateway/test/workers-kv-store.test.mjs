// The Workers gateway (createWorkerGateway, KvReceiptStore) under concurrent requests. A fake KV with async latency
// stands in for a KV namespace (or a Durable Object's storage); no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorkerGateway, KvReceiptStore, StaticPrincipalKeyRegistry, verifyReceipt } from "../dist/index.js";
import { createSigner } from "@scopebond/sdk";

function fakeKv(latencyMs = 2) {
  const data = new Map();
  // Every call yields, so concurrent requests interleave; 0 yields without a timer (Windows timers tick every ~15 ms).
  const later = (v) => new Promise((r) => (latencyMs > 0 ? setTimeout(() => r(v), latencyMs) : setImmediate(() => r(v))));
  return {
    data,
    async get(key) { return later(data.has(key) ? data.get(key) : null); },
    async put(key, value) { await later(); data.set(key, value); },
  };
}
const policy = { vocabulary_version: "1.0", policy_id: "kv", version: 1,
  clauses: [{ id: "tx", type: "spend_limit", mode: "enforce", asset: "USDC", max_per_action: 1000000 }] };
const windowed = { vocabulary_version: "1.0", policy_id: "kv-rate", version: 1,
  clauses: [{ id: "rate", type: "rate_limit", mode: "enforce", action_types: ["payout.create"], max_count: 3, window: "PT1H" }] };

async function setup(p = policy, kv = fakeKv()) {
  const agent = createSigner();
  const keys = new StaticPrincipalKeyRegistry([{ kid: agent.kid, publicKeyPem: agent.publicKeyPem, purposes: ["agent"], status: "active" }]);
  const gw = await createWorkerGateway({ policy: p, kv, authentication: { keys } });
  return { gw, kv, agent, keys };
}
const post = (gw, signed) => gw.app.request("/v1/evaluate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(signed) });

test("every receipt a concurrent request was given is in the log", async () => {
  const { gw, agent } = await setup();
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => post(gw, agent.sign({ action_type: "payout.create", asset: "USDC", amount: i + 1 }))));
  const answered = (await Promise.all(results.map((r) => r.json()))).filter((b) => b.receipt?.signature);
  const stored = await gw.store.list();
  assert.equal(answered.length, 20);
  assert.equal(stored.length, 20, `${stored.length} of 20 acknowledged receipts are in the log`);
  const sigs = new Set(stored.map((r) => r.signature.sig));
  for (const b of answered) assert.ok(sigs.has(b.receipt.signature.sig), "the receipt returned is the receipt stored");
});

test("gateways on the same KV in one process (one per request) still lose nothing", async () => {
  const kv = fakeKv();
  const { agent, keys } = await setup(policy, kv);
  const results = await Promise.all(Array.from({ length: 12 }, async (_, i) => {
    const gw = await createWorkerGateway({ policy, kv, authentication: { keys } });
    return post(gw, agent.sign({ action_type: "payout.create", asset: "USDC", amount: i + 1 }));
  }));
  assert.deepEqual(results.map((r) => r.status), Array(12).fill(200));
  assert.equal((await new KvReceiptStore(kv).list()).length, 12);
});

test("one signed authorization sent twice at once is accepted once", async () => {
  const { gw, agent } = await setup();
  const signed = agent.sign({ action_type: "payout.create", asset: "USDC", amount: 7 });
  const [a, b] = await Promise.all([post(gw, signed), post(gw, signed)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409], "the second copy is a replay");
  assert.equal((await gw.store.list()).length, 1);
  const again = await post(gw, signed);
  assert.equal(again.status, 409, "and so is a later copy");
});

test("a windowed limit holds for requests that arrive together", async () => {
  const { gw, agent } = await setup(windowed);
  const results = await Promise.all(Array.from({ length: 6 }, () => post(gw, agent.sign({ action_type: "payout.create", asset: "USDC", amount: 1 }))));
  const statuses = results.map((r) => r.status);
  assert.equal(statuses.filter((s) => s === 200).length, 3, JSON.stringify(statuses));
  assert.equal(statuses.filter((s) => s === 403).length, 3, JSON.stringify(statuses));
});

test("past 500 receipts nothing is dropped and anchoring keeps working", async () => {
  const kv = fakeKv(0);
  const { gw, agent } = await setup(policy, kv);
  for (let i = 0; i < 10; i++) await gw.handleAction(agent.sign({ action_type: "payout.create", asset: "USDC", amount: 1 }));
  const first = await gw.anchor();
  for (let i = 0; i < 495; i++) await gw.handleAction(agent.sign({ action_type: "payout.create", asset: "USDC", amount: 1 }));
  const store = new KvReceiptStore(kv);
  assert.equal((await store.list()).length, 505);
  const second = await gw.anchor();
  assert.equal(first.tree_size, 10);
  assert.equal(second.tree_size, 505);
  assert.equal(second.prev_anchor_hash, first.anchor_hash);
  for (const r of (await store.list()).slice(-3)) assert.equal(verifyReceipt(r, gw.attester.publicKeyPem).valid, true);
});

test("a log written by the earlier single-array layout is read, kept in order and extended", async () => {
  const kv = fakeKv(0);
  const { gw: old, agent, keys } = await setup(policy, kv);
  const legacy = [];
  const signed = [];
  for (let i = 0; i < 3; i++) {
    signed.push(agent.sign({ action_type: "payout.create", asset: "USDC", amount: i + 1 }));
    legacy.push((await old.handleAction(signed[i])).receipt);
  }
  // Rewrite the KV as the earlier release left it: the whole log as one JSON array under the store key.
  kv.data.clear();
  kv.data.set("receipts", JSON.stringify(legacy));
  const store = new KvReceiptStore(kv);
  assert.deepEqual((await store.list()).map((r) => r.signature.sig), legacy.map((r) => r.signature.sig));
  const gw = await createWorkerGateway({ policy, kv, authentication: { keys } });
  assert.equal((await post(gw, signed[2])).status, 409, "an authorization the earlier log used is refused again");
  const anchored = await gw.anchor();
  assert.equal(anchored.tree_size, 3);
  await gw.handleAction(agent.sign({ action_type: "payout.create", asset: "USDC", amount: 9 }));
  const after = await store.list();
  assert.equal(after.length, 4);
  assert.deepEqual(after.slice(0, 3).map((r) => r.signature.sig), legacy.map((r) => r.signature.sig));
  assert.equal((await gw.anchor()).tree_size, 4, "the earlier anchor still matches the log");
});

test("an authorization recorded by an observation is not accepted again for an action", async () => {
  const { gw, agent } = await setup();
  const signed = agent.sign({ action_type: "payout.create", asset: "USDC", amount: 3 });
  const observed = await gw.app.request("/v1/observe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(signed) });
  assert.equal(observed.status, 202);
  assert.equal((await post(gw, signed)).status, 409);
});

test("kill and resume through a Worker gateway are durable on the KV", async () => {
  const kv = fakeKv(0);
  const { agent, keys } = await setup(policy, kv);
  const gw = await createWorkerGateway({ policy, kv, authentication: { keys } });
  await Promise.all([new KvReceiptStore(kv).setStopped("global", true), new KvReceiptStore(kv).setStopped(agent.kid, true)]);
  const state = await new KvReceiptStore(kv).getStopState();
  assert.deepEqual(state, { global: true, agents: [agent.kid] }, "two concurrent stops are both kept");
  assert.equal((await post(gw, agent.sign({ action_type: "payout.create", asset: "USDC", amount: 1 }))).status, 403);
});
