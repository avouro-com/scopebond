// The public anchor proof and consistency routes answer from leaves computed once per anchored prefix: an anonymous
// request does not read, parse or hash the whole receipt log again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGateway, MemoryReceiptStore, receiptLeafHash, verifyInclusionProof, verifyConsistencyProof } from "../dist/index.js";

const policy = { vocabulary_version: "1.0", policy_id: "cost", version: 1,
  clauses: [{ id: "tx", type: "spend_limit", mode: "enforce", asset: "USDC", max_per_action: 1000000 }] };

function countingStore() {
  const store = new MemoryReceiptStore();
  let lists = 0;
  const list = store.list.bind(store);
  store.list = () => { lists++; return list(); };
  return { store, lists: () => lists };
}

test("repeated public proof and consistency requests do not re-read the receipt log", async () => {
  const { store, lists } = countingStore();
  const gw = createGateway({ policy, store, authentication: { mode: "insecure-development" } });
  const receipts = [];
  for (let i = 0; i < 40; i++) receipts.push((await gw.handleAction({ intent: { action_type: "payout.create", asset: "USDC", amount: i + 1 } })).receipt);
  const first = await gw.anchor();
  for (let i = 0; i < 20; i++) receipts.push((await gw.handleAction({ intent: { action_type: "payout.create", asset: "USDC", amount: i + 1 } })).receipt);
  const second = await gw.anchor();

  const missing = `/v1/anchors/proof?leaf=${"0".repeat(64)}`;
  assert.equal((await gw.app.request(missing)).status, 404); // may read the log once to learn the anchored leaves
  const afterFirst = lists();
  for (let i = 0; i < 5; i++) assert.equal((await gw.app.request(missing)).status, 404);
  for (const r of [receipts[0], receipts[39], receipts[59]]) {
    const leaf = await receiptLeafHash(r.payload);
    const res = await gw.app.request(`/v1/anchors/proof?leaf=${leaf}`);
    assert.equal(res.status, 200);
    const p = await res.json();
    assert.equal(await verifyInclusionProof({ leaf_hash: leaf, leaf_index: p.leaf_index, tree_size: p.tree_size, audit_path: p.audit_path, root: p.anchor.root }), true);
  }
  // The earlier anchor answers from the same leaves, as does a consistency proof between the two.
  const leaf0 = await receiptLeafHash(receipts[5].payload);
  const old = await (await gw.app.request(`/v1/anchors/proof?leaf=${leaf0}&anchor_seq=${first.seq}`)).json();
  assert.equal(old.tree_size, 40);
  assert.equal(await verifyInclusionProof({ leaf_hash: leaf0, leaf_index: old.leaf_index, tree_size: old.tree_size, audit_path: old.audit_path, root: first.root }), true);
  const notInFirst = await receiptLeafHash(receipts[50].payload);
  assert.equal((await gw.app.request(`/v1/anchors/proof?leaf=${notInFirst}&anchor_seq=${first.seq}`)).status, 404, "a receipt after the anchor is not covered by it");
  const cons = await gw.app.request(`/v1/anchors/consistency?from=${first.seq}&to=${second.seq}`);
  assert.equal(cons.status, 200);
  const c = await cons.json();
  assert.equal(await verifyConsistencyProof({ first_size: c.first_size, second_size: c.second_size, first_root: first.root, second_root: second.root, proof: c.proof }), true);
  assert.equal(lists(), afterFirst, "no further request read the whole log");
});

test("a store whose anchored prefix changed is still caught when anchoring", async () => {
  const store = new MemoryReceiptStore();
  const gw = createGateway({ policy, store, authentication: { mode: "insecure-development" } });
  for (let i = 0; i < 4; i++) await gw.handleAction({ intent: { action_type: "payout.create", asset: "USDC", amount: i + 1 } });
  await gw.anchor();
  assert.equal((await gw.app.request(`/v1/anchors/proof?leaf=${"0".repeat(64)}`)).status, 404);
  store.all[1].payload.intent.amount = 999; // tamper with the anchored prefix
  await assert.rejects(gw.anchor(), /does not match the previous anchor/);
});
