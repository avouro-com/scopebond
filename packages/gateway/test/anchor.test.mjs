import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createGateway, MemoryReceiptStore, canonical, sha256,
  merkleRoot, merkleProof, verifyProof,
  receiptLeafHash, receiptLeafHashV1, merkleRootV1, merkleTreeHash, anchorHash,
  verifyInclusionProof, verifyConsistencyProof, verifyAnchorSignature, verifyAnchorRoot, verifyAnchorChain,
} from "../dist/index.js";
import { openReceiptStore } from "../dist/node.js";

const policy = {
  vocabulary_version: "1.0", policy_id: "t", version: 1,
  clauses: [{ id: "tx", type: "spend_limit", mode: "enforce", asset: "USDC", max_per_action: 100000000 }],
};
const CONTROL_TOKEN = "test-control-token-000000000001";
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

test("v2 anchor commits to receipts; the client verifies the audit path and signature; anchors chain", async () => {
  const gw = createGateway({ authentication: { mode: "insecure-development" }, policy, store: new MemoryReceiptStore(), control: { bearerToken: CONTROL_TOKEN } });
  await pay(gw.app, 100000); await pay(gw.app, 200000); await pay(gw.app, 300000);

  const a1 = await gw.anchor();
  assert.equal(a1.seq, 1);
  assert.equal(a1.tree_size, 3);
  assert.equal(a1.prev_anchor_hash, null);
  assert.equal(a1.algo, "rfc9162-sha256");
  assert.equal(a1.attester.kid, gw.attester.kid);
  assert.equal(await verifyAnchorSignature(a1, gw.attester.publicKeyJwk), true);
  const receipts = await gw.store.list();
  assert.equal(await verifyAnchorRoot(a1, receipts.map((r) => r.payload)), true);

  // Inclusion proof for the 2nd receipt (by leaf and by intent_hash): the
  // server returns the path; the client computes inclusion itself.
  const leaf = await receiptLeafHash(receipts[1].payload);
  const p1 = await (await gw.app.request("/v1/anchors/proof?leaf=" + leaf)).json();
  assert.equal(p1.included, undefined, "the server no longer asserts inclusion");
  assert.equal(p1.leaf_index, 1);
  assert.equal(p1.tree_size, 3);
  assert.equal(p1.root, a1.root);
  assert.equal(await verifyAnchorSignature(p1.anchor, gw.attester.publicKeyJwk), true);
  assert.equal(await verifyInclusionProof({ leaf_hash: leaf, leaf_index: p1.leaf_index, tree_size: p1.anchor.tree_size, audit_path: p1.audit_path, root: p1.anchor.root }), true);
  assert.equal(await verifyInclusionProof({ leaf_hash: leaf, leaf_index: 0, tree_size: 3, audit_path: p1.audit_path, root: a1.root }), false);

  const p2 = await (await gw.app.request("/v1/anchors/proof?intent_hash=" + receipts[2].payload.intent_hash)).json();
  assert.equal(p2.leaf_index, 2);
  assert.equal(await verifyInclusionProof({ leaf_hash: await receiptLeafHash(receipts[2].payload), ...p2, root: a1.root }), true);

  // A receipt not in the anchor → 404.
  const miss = await gw.app.request("/v1/anchors/proof?leaf=" + sha256("nope"));
  assert.equal(miss.status, 404);

  // A new receipt + second anchor chains to the first and covers more.
  await pay(gw.app, 400000);
  const a2 = await gw.anchor();
  assert.equal(a2.seq, 2);
  assert.equal(a2.tree_size, 4);
  assert.equal(a2.prev_anchor_hash, a1.anchor_hash);
  assert.notEqual(a2.root, a1.root);

  // Proof against a specific (older) anchor, and a consistency proof between the two.
  const old = await (await gw.app.request(`/v1/anchors/proof?anchor_seq=1&leaf=${leaf}`)).json();
  assert.equal(old.anchor.seq, 1);
  assert.equal(await verifyInclusionProof({ leaf_hash: leaf, ...old, root: a1.root }), true);
  const cons = await (await gw.app.request("/v1/anchors/consistency?from=1&to=2")).json();
  assert.equal(await verifyConsistencyProof({ ...cons, first_root: a1.root, second_root: a2.root }), true);
  assert.equal((await gw.app.request("/v1/anchors/consistency")).status, 400);
  assert.equal((await gw.app.request("/v1/anchors/proof?anchor_seq=99&leaf=" + leaf)).status, 404);

  // POST /v1/anchor endpoint works and continues the chain.
  assert.equal((await gw.app.request("/v1/anchor", { method: "POST" })).status, 401);
  const a3 = await (await gw.app.request("/v1/anchor", { method: "POST", headers: { authorization: `Bearer ${CONTROL_TOKEN}` } })).json();
  assert.equal(a3.seq, 3);
  assert.equal(a3.prev_anchor_hash, a2.anchor_hash);

  const list = await (await gw.app.request("/v1/anchors")).json();
  assert.equal(list.anchors.length, 3);
  assert.deepEqual(await verifyAnchorChain(list.anchors, gw.attester.publicKeyJwk), { valid: true });
  const latest = await (await gw.app.request("/v1/anchors/latest")).json();
  assert.equal(latest.seq, 3);
});

// Build a v1 anchor exactly as gateway versions before v2 did.
function legacyAnchor(prev, receipts, ts) {
  const leaves = receipts.map((r) => sha256(canonical(r.payload)));
  const base = {
    seq: (prev?.seq ?? 0) + 1, algo: "sha256-merkle", merkle_root: merkleRoot(leaves), count: leaves.length,
    from: receipts[0]?.payload.timestamp ?? null, to: ts, prev_anchor_hash: prev?.anchor_hash ?? null, timestamp: ts,
  };
  return { ...base, anchor_hash: sha256(canonical(base)) };
}

test("v1 anchors keep verifying and the first v2 anchor chains to the last v1 anchor", async () => {
  const store = new MemoryReceiptStore();
  const gw = createGateway({ authentication: { mode: "insecure-development" }, policy, store });
  await pay(gw.app, 100000); await pay(gw.app, 200000);
  const v1a = legacyAnchor(null, await store.list(), "2026-01-01T00:00:00Z");
  store.putAnchor(v1a);
  await pay(gw.app, 300000);
  const v1b = legacyAnchor(v1a, await store.list(), "2026-01-02T00:00:00Z");
  store.putAnchor(v1b);

  // The v1 root from the unchanged sync merkleRoot equals the verify package's v1 root.
  const payloads = (await store.list()).map((r) => r.payload);
  assert.equal(await merkleRootV1(await Promise.all(payloads.map(receiptLeafHashV1))), v1b.merkle_root);
  assert.equal(await verifyAnchorRoot(v1b, payloads), true);
  assert.equal(await anchorHash(v1b), v1b.anchor_hash);

  // The legacy proof endpoint shape for a v1 anchor still verifies with verifyProof.
  const leaf = sha256(canonical(payloads[0]));
  const lp = await (await gw.app.request(`/v1/anchors/proof?anchor_seq=2&leaf=${leaf}`)).json();
  assert.equal(lp.algo, "sha256-merkle");
  assert.equal(verifyProof(leaf, lp.proof, v1b.merkle_root), true);

  await pay(gw.app, 400000);
  const v2 = await gw.anchor();
  assert.equal(v2.seq, 3);
  assert.equal(v2.prev_anchor_hash, v1b.anchor_hash);
  assert.deepEqual(await verifyAnchorChain(await store.anchors(), gw.attester.publicKeyJwk), { valid: true });
});

test("anchoring refuses a log rewritten under a previous anchor; rewriting receipts + anchors is detected", async () => {
  const store = new MemoryReceiptStore();
  const gw = createGateway({ authentication: { mode: "insecure-development" }, policy, store });
  await pay(gw.app, 100000); await pay(gw.app, 200000);
  const a1 = await gw.anchor();
  // An attacker with store write access rewrites a receipt...
  store.all[0].payload.intent.amount = 1;
  await assert.rejects(() => gw.anchor(), /does not match the previous anchor/);
  // ...and the anchor to match, re-hashing it: the signature no longer verifies.
  const forged = { ...a1, root: await merkleTreeHash(await Promise.all(store.all.map((r) => receiptLeafHash(r.payload)))) };
  forged.anchor_hash = await anchorHash(forged);
  assert.equal(await verifyAnchorSignature(forged, gw.attester.publicKeyJwk), false);
  assert.equal((await verifyAnchorChain([forged], gw.attester.publicKeyJwk)).valid, false);
});

test("setPolicy hot-swaps the active policy (and /v1/status reflects it)", async () => {
  const strict = { vocabulary_version: "1.0", policy_id: "s", version: 1, clauses: [{ id: "c", type: "spend_limit", mode: "enforce", asset: "USDC", max_per_action: 100000 }] };
  const loose = { vocabulary_version: "1.0", policy_id: "l", version: 2, clauses: [{ id: "c", type: "spend_limit", mode: "enforce", asset: "USDC", max_per_action: 100000000 }] };
  const gw = createGateway({ authentication: { mode: "insecure-development" }, policy: strict, store: new MemoryReceiptStore(), control: { bearerToken: CONTROL_TOKEN } });
  const h1 = gw.policyHash;

  let r = await (await pay(gw.app, 500000)).json(); // $5,000 > $1,000 cap
  assert.equal(r.allowed, false);

  gw.setPolicy(loose);
  assert.notEqual(gw.policyHash, h1);

  r = await (await pay(gw.app, 500000)).json(); // now under the higher cap
  assert.equal(r.allowed, true);

  const st = await (await gw.app.request("/v1/status", { headers: { authorization: `Bearer ${CONTROL_TOKEN}` } })).json();
  assert.equal(st.policy_hash, gw.policyHash);
  assert.equal(st.policy_version, 2);
});

test("invalid policy initialization and reload fail without replacing the active snapshot", async () => {
  assert.throws(
    () => createGateway({ authentication: { mode: "insecure-development" }, policy: { vocabulary_version: "1.0", policy_id: "empty", version: 1, clauses: [] } }),
    /invalid policy/,
  );

  const strict = {
    vocabulary_version: "1.0", policy_id: "strict", version: 1,
    clauses: [{ id: "cap", type: "spend_limit", mode: "enforce", asset: "USDC", max_per_action: 100 }],
  };
  const gateway = createGateway({ authentication: { mode: "insecure-development" }, policy: strict });
  const originalHash = gateway.policyHash;
  assert.throws(() => gateway.setPolicy({ clauses: [] }), /invalid policy/);
  assert.equal(gateway.policyHash, originalHash);
  const denied = await (await pay(gateway.app, 101)).json();
  assert.equal(denied.allowed, false, "the last valid policy remains active");
});

test("anchors persist in a durable store across reopen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scopebond-anchor-"));
  try {
    const dbFile = join(dir, "r.db");
    {
      const { store } = openReceiptStore({ db: dbFile });
      const gw = createGateway({ authentication: { mode: "insecure-development" }, policy, store });
      await pay(gw.app, 100000); await pay(gw.app, 200000);
      const a = await gw.anchor();
      assert.equal(a.seq, 1);
      await store.close?.();
    }
    {
      const { store } = openReceiptStore({ db: dbFile });
      const anchors = await store.anchors();
      assert.equal(anchors.length, 1);
      assert.equal(anchors[0].tree_size, 2);
      await store.close?.();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
