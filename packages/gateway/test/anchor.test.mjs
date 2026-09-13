import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createGateway, MemoryReceiptStore, canonical, sha256,
  merkleRoot, merkleProof, verifyProof,
} from "../dist/index.js";
import { openReceiptStore } from "../dist/node.js";

const policy = {
  policy_id: "t", version: 1,
  clauses: [{ id: "tx", type: "spend_limit", mode: "enforce", asset: "USDC", max_per_action: 100000000 }],
};
const post = (app, path, body) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const pay = (app, amount) => post(app, "/v1/evaluate", { intent: { action_type: "payout.create", asset: "USDC", amount } });

test("merkle proofs verify for every leaf; a wrong leaf fails", () => {
  const leaves = ["a", "b", "c", "d", "e"].map(sha256);
  const root = merkleRoot(leaves);
  for (let i = 0; i < leaves.length; i++) {
    assert.equal(verifyProof(leaves[i], merkleProof(leaves, i), root), true, `leaf ${i}`);
  }
  assert.equal(verifyProof(sha256("x"), merkleProof(leaves, 0), root), false);
});

test("anchor commits to receipts; inclusion proof verifies; anchors chain", async () => {
  const gw = createGateway({ policy, store: new MemoryReceiptStore() });
  await pay(gw.app, 100000); await pay(gw.app, 200000); await pay(gw.app, 300000);

  const a1 = await gw.anchor();
  assert.equal(a1.seq, 1);
  assert.equal(a1.count, 3);
  assert.equal(a1.prev_anchor_hash, null);
  assert.equal(a1.algo, "sha256-merkle");

  // Inclusion proof for the 2nd receipt (by leaf and by intent_hash).
  const receipts = await gw.store.list();
  const leaf = sha256(canonical(receipts[1].payload));
  const p1 = await (await gw.app.request("/v1/anchors/proof?leaf=" + leaf)).json();
  assert.equal(p1.included, true);
  assert.equal(p1.merkle_root, a1.merkle_root);
  assert.equal(verifyProof(leaf, p1.proof, a1.merkle_root), true);

  const p2 = await (await gw.app.request("/v1/anchors/proof?intent_hash=" + receipts[2].payload.intent_hash)).json();
  assert.equal(p2.included, true);

  // A receipt not in the anchor → 404.
  const miss = await gw.app.request("/v1/anchors/proof?leaf=" + sha256("nope"));
  assert.equal(miss.status, 404);

  // A new receipt + second anchor chains to the first and covers more.
  await pay(gw.app, 400000);
  const a2 = await gw.anchor();
  assert.equal(a2.seq, 2);
  assert.equal(a2.count, 4);
  assert.equal(a2.prev_anchor_hash, a1.anchor_hash);
  assert.notEqual(a2.merkle_root, a1.merkle_root);

  // POST /v1/anchor endpoint works and continues the chain.
  const a3 = await (await gw.app.request("/v1/anchor", { method: "POST" })).json();
  assert.equal(a3.seq, 3);
  assert.equal(a3.prev_anchor_hash, a2.anchor_hash);

  const list = await (await gw.app.request("/v1/anchors")).json();
  assert.equal(list.anchors.length, 3);
  const latest = await (await gw.app.request("/v1/anchors/latest")).json();
  assert.equal(latest.seq, 3);
});

test("setPolicy hot-swaps the active policy (and /v1/status reflects it)", async () => {
  const strict = { policy_id: "s", version: 1, clauses: [{ id: "c", type: "spend_limit", mode: "enforce", asset: "USDC", max_per_action: 100000 }] };
  const loose = { policy_id: "l", version: 2, clauses: [{ id: "c", type: "spend_limit", mode: "enforce", asset: "USDC", max_per_action: 100000000 }] };
  const gw = createGateway({ policy: strict, store: new MemoryReceiptStore() });
  const h1 = gw.policyHash;

  let r = await (await pay(gw.app, 500000)).json(); // $5,000 > $1,000 cap
  assert.equal(r.allowed, false);

  gw.setPolicy(loose);
  assert.notEqual(gw.policyHash, h1);

  r = await (await pay(gw.app, 500000)).json(); // now under the higher cap
  assert.equal(r.allowed, true);

  const st = await (await gw.app.request("/v1/status")).json();
  assert.equal(st.policy_hash, gw.policyHash);
  assert.equal(st.policy_version, 2);
});

test("anchors persist in a durable store across reopen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scopebond-anchor-"));
  try {
    const dbFile = join(dir, "r.db");
    {
      const { store } = openReceiptStore({ db: dbFile });
      const gw = createGateway({ policy, store });
      await pay(gw.app, 100000); await pay(gw.app, 200000);
      const a = await gw.anchor();
      assert.equal(a.seq, 1);
      await store.close?.();
    }
    {
      const { store } = openReceiptStore({ db: dbFile });
      const anchors = await store.anchors();
      assert.equal(anchors.length, 1);
      assert.equal(anchors[0].count, 2);
      await store.close?.();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
