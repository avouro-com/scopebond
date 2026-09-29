import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  leafHash, nodeHash, merkleTreeHash, inclusionProof, verifyInclusionProof,
  consistencyProof, verifyConsistencyProof, merkleRootV1, receiptLeafHash, receiptLeafHashV1,
  anchorHash, anchorBody, anchorRoot, verifyAnchorRoot, verifyAnchorSignature, verifyAnchorChain, deriveKid,
  sha256Hex, ANCHOR_ALGO_V1, ANCHOR_ALGO_V2,
} from "../dist/anchor.js";
import { canonical } from "../dist/violates.js";

const vectors = JSON.parse(readFileSync(new URL("../vectors/merkle-rfc9162.json", import.meta.url), "utf8"));

// --- An independent, synchronous RFC 9162 implementation (node:crypto, Buffers),
// written directly from the definitions, used to cross-check the WebCrypto one.
const H = (...parts) => createHash("sha256").update(Buffer.concat(parts)).digest();
const refLeaf = (bytes) => H(Buffer.from([0]), bytes);
const refK = (n) => 2 ** Math.ceil(Math.log2(n) - 1);
function refMth(d) {
  if (d.length === 0) return H(Buffer.alloc(0));
  if (d.length === 1) return d[0];
  const k = refK(d.length);
  return H(Buffer.from([1]), refMth(d.slice(0, k)), refMth(d.slice(k)));
}
function refPath(m, d) {
  if (d.length <= 1) return [];
  const k = refK(d.length);
  return m < k ? [...refPath(m, d.slice(0, k)), refMth(d.slice(k))] : [...refPath(m - k, d.slice(k)), refMth(d.slice(0, k))];
}
function refSub(m, d, b) {
  if (m === d.length) return b ? [] : [refMth(d)];
  const k = refK(d.length);
  return m <= k ? [...refSub(m, d.slice(0, k), b), refMth(d.slice(k))] : [...refSub(m - k, d.slice(k), false), refMth(d.slice(0, k))];
}
const hex = (b) => b.toString("hex");
// Recompute a root from (index, size, leaf, path) by recursing on the definition.
function refRootFrom(i, size, leaf, path) {
  if (size === 1) return path.length === 0 ? leaf : null;
  if (path.length === 0) return null;
  const k = refK(size);
  const last = path[path.length - 1];
  const rest = path.slice(0, -1);
  const sub = i < k ? refRootFrom(i, k, leaf, rest) : refRootFrom(i - k, size - k, leaf, rest);
  if (!sub) return null;
  return i < k ? H(Buffer.from([1]), sub, last) : H(Buffer.from([1]), last, sub);
}
const refVerify = (i, size, leaf, path, root) =>
  size > 0 && i < size && hex(refRootFrom(i, size, leaf, path) ?? Buffer.alloc(0)) === root;

const leafData = (i) => Buffer.from(`leaf-${i}`, "utf8");
async function tree(n) {
  const raw = Array.from({ length: n }, (_, i) => leafData(i));
  const hashes = await Promise.all(raw.map((b) => leafHash(new Uint8Array(b))));
  return { raw, hashes, ref: raw.map(refLeaf) };
}

test("RFC 9162 / Certificate Transparency reference vectors", async () => {
  const leaves = await Promise.all(vectors.leaves.map((h) => leafHash(new Uint8Array(Buffer.from(h, "hex")))));
  assert.equal(await merkleTreeHash([]), vectors.empty_root);
  for (let n = 1; n <= leaves.length; n++) {
    assert.equal(await merkleTreeHash(leaves.slice(0, n)), vectors.roots[n - 1], `root of ${n}`);
  }
  for (const v of vectors.inclusion) {
    const p = await inclusionProof(leaves.slice(0, v.tree_size), v.leaf_index);
    assert.deepEqual(p.audit_path, v.audit_path);
    assert.equal(await verifyInclusionProof({ leaf_hash: leaves[v.leaf_index], ...v, root: vectors.roots[v.tree_size - 1] }), true);
  }
  for (const v of vectors.consistency) {
    const p = await consistencyProof(leaves.slice(0, v.second_size), v.first_size);
    assert.deepEqual(p.proof, v.proof);
    assert.equal(await verifyConsistencyProof({
      ...v, first_root: vectors.roots[v.first_size - 1], second_root: vectors.roots[v.second_size - 1],
    }), true);
  }
});

test("leaf and node hashes are domain separated", async () => {
  const a = await leafHash("a");
  assert.equal(a, hex(refLeaf(Buffer.from("a"))));
  assert.notEqual(a, await sha256Hex("a"));
  const b = await leafHash("b");
  assert.equal(await nodeHash(a, b), hex(H(Buffer.from([1]), Buffer.from(a, "hex"), Buffer.from(b, "hex"))));
});

test("inclusion proofs verify for every leaf of trees of size 1..17 and match an independent implementation", async () => {
  for (let n = 1; n <= 17; n++) {
    const { hashes, ref } = await tree(n);
    const root = await merkleTreeHash(hashes);
    assert.equal(root, hex(refMth(ref)), `root n=${n}`);
    for (let i = 0; i < n; i++) {
      const p = await inclusionProof(hashes, i);
      assert.deepEqual(p.audit_path, refPath(i, ref).map(hex), `path n=${n} i=${i}`);
      assert.equal(await verifyInclusionProof({ leaf_hash: hashes[i], ...p, root }), true, `n=${n} i=${i}`);
    }
  }
});

test("inclusion proofs are rejected for the wrong index, size, root, leaf or path", async () => {
  for (const n of [1, 2, 3, 5, 7, 8, 9, 16, 17]) {
    const { hashes } = await tree(n);
    const root = await merkleTreeHash(hashes);
    const other = await leafHash("not-in-tree");
    for (let i = 0; i < n; i++) {
      const p = await inclusionProof(hashes, i);
      const ok = { leaf_hash: hashes[i], ...p, root };
      for (let j = 0; j < n; j++) if (j !== i) {
        assert.equal(await verifyInclusionProof({ ...ok, leaf_index: j }), false, `n=${n} i=${i} as ${j}`);
      }
      // A wrong size fails unless the audit path has the identical shape for that
      // size (e.g. leaf 0 of 3 vs of 4); the size a verifier uses comes from the
      // signed anchor, never from the proof. Agree with the independent verifier.
      for (const size of [0, i, n - 1, n + 1, 2 * n, 4 * n + 1]) if (size !== n) {
        const expected = refVerify(i, size, Buffer.from(hashes[i], "hex"), p.audit_path.map((h) => Buffer.from(h, "hex")), root);
        assert.equal(await verifyInclusionProof({ ...ok, tree_size: size }), expected, `n=${n} i=${i} size=${size}`);
        if (size <= i || size >= 2 * n) assert.equal(expected, false);
      }
      assert.equal(await verifyInclusionProof({ ...ok, root: other }), false);
      assert.equal(await verifyInclusionProof({ ...ok, leaf_hash: other }), false);
      assert.equal(await verifyInclusionProof({ ...ok, audit_path: [...p.audit_path, other] }), false);
      if (p.audit_path.length > 0) {
        assert.equal(await verifyInclusionProof({ ...ok, audit_path: p.audit_path.slice(1) }), false);
        assert.equal(await verifyInclusionProof({ ...ok, audit_path: [other, ...p.audit_path.slice(1)] }), false);
      }
    }
  }
  // Malformed input is false, never an exception.
  const { hashes } = await tree(4);
  const root = await merkleTreeHash(hashes);
  assert.equal(await verifyInclusionProof({ leaf_hash: hashes[0], leaf_index: -1, tree_size: 4, audit_path: [], root }), false);
  assert.equal(await verifyInclusionProof({ leaf_hash: "XYZ", leaf_index: 0, tree_size: 4, audit_path: [], root }), false);
  assert.equal(await verifyInclusionProof(null), false);
  await assert.rejects(() => inclusionProof(hashes, 4), RangeError);
});

test("consistency proofs verify for every 0 <= m <= n <= 17 and reject wrong roots", async () => {
  const { hashes, ref } = await tree(17);
  const roots = [];
  for (let n = 0; n <= 17; n++) roots.push(await merkleTreeHash(hashes.slice(0, n)));
  const bogus = await leafHash("bogus");
  for (let n = 1; n <= 17; n++) {
    for (let m = 0; m <= n; m++) {
      const p = await consistencyProof(hashes.slice(0, n), m);
      if (m > 0 && m < n) assert.deepEqual(p.proof, refSub(m, ref.slice(0, n), true).map(hex), `proof ${m}->${n}`);
      const ok = { first_size: m, second_size: n, first_root: roots[m], second_root: roots[n], proof: p.proof };
      assert.equal(await verifyConsistencyProof(ok), true, `${m}->${n}`);
      if (m > 0) {
        assert.equal(await verifyConsistencyProof({ ...ok, first_root: bogus }), false, `bad first ${m}->${n}`);
        assert.equal(await verifyConsistencyProof({ ...ok, second_root: bogus }), false, `bad second ${m}->${n}`);
      }
      if (m > 0 && m < n) {
        assert.equal(await verifyConsistencyProof({ ...ok, proof: [bogus, ...p.proof.slice(1)] }), false, `tampered ${m}->${n}`);
        assert.equal(await verifyConsistencyProof({ ...ok, proof: p.proof.slice(0, -1) }), false, `short ${m}->${n}`);
        assert.equal(await verifyConsistencyProof({ ...ok, first_size: n + 1 }), false, `first > second`);
      }
    }
  }
});

test("[a,b,c] and [a,b,c,c] have different v2 roots (v1 collides)", async () => {
  const [a, b, c] = await Promise.all(["a", "b", "c"].map((x) => leafHash(x)));
  assert.notEqual(await merkleTreeHash([a, b, c]), await merkleTreeHash([a, b, c, c]));
  const [va, vb, vc] = await Promise.all(["a", "b", "c"].map((x) => sha256Hex(x)));
  assert.equal(await merkleRootV1([va, vb, vc]), await merkleRootV1([va, vb, vc, vc]), "the documented v1 weakness");
});

test("v1 root reproduces the legacy algorithm exactly", async () => {
  const s = (x) => createHash("sha256").update(x).digest("hex");
  const leaves = ["a", "b", "c", "d", "e"].map(s);
  const l1 = [s(leaves[0] + leaves[1]), s(leaves[2] + leaves[3]), s(leaves[4] + leaves[4])];
  const l2 = [s(l1[0] + l1[1]), s(l1[2] + l1[2])];
  assert.equal(await merkleRootV1(leaves), s(l2[0] + l2[1]));
  assert.equal(await merkleRootV1([]), s(""));
  const payload = { b: 1, a: "x" };
  assert.equal(await receiptLeafHashV1(payload), s(canonical(payload)));
  assert.equal(await receiptLeafHash(payload), hex(refLeaf(Buffer.from(canonical(payload), "utf8"))));
});

// --- Signed anchors
function attester() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" });
  return { jwk, sign: (s) => edSign(null, Buffer.from(s, "utf8"), privateKey).toString("base64") };
}
async function makeV1(prev, payloads, ts) {
  const leaves = await Promise.all(payloads.map(receiptLeafHashV1));
  const base = {
    seq: (prev?.seq ?? 0) + 1, algo: ANCHOR_ALGO_V1, merkle_root: await merkleRootV1(leaves), count: leaves.length,
    from: null, to: ts, prev_anchor_hash: prev?.anchor_hash ?? null, timestamp: ts,
  };
  return { ...base, anchor_hash: await sha256Hex(canonical(base)) };
}
async function makeV2(att, prev, payloads, ts) {
  const body = {
    type: "scopebond:anchor", seq: (prev?.seq ?? 0) + 1, algo: ANCHOR_ALGO_V2, tree_size: payloads.length,
    root: await anchorRoot(ANCHOR_ALGO_V2, payloads), prev_anchor_hash: prev?.anchor_hash ?? null, timestamp: ts,
    attester: { kind: "gateway", kid: await deriveKid(att.jwk) },
  };
  const c = canonical(body);
  return { ...body, anchor_hash: await sha256Hex(c), signature: { alg: "Ed25519", sig: att.sign(c) } };
}

test("a signed v2 anchor verifies; tampering or a wrong key fails", async () => {
  const att = attester();
  const payloads = [{ n: 1 }, { n: 2 }, { n: 3 }];
  const a = await makeV2(att, null, payloads, "2026-09-23T00:00:00Z");
  assert.equal(await verifyAnchorSignature(a, att.jwk), true);
  assert.equal(await verifyAnchorRoot(a, payloads), true);
  assert.equal(await verifyAnchorRoot(a, [...payloads, { n: 4 }]), false);
  assert.equal(await verifyAnchorRoot(a, [payloads[1], payloads[0], payloads[2]]), false);

  const other = await leafHash("x");
  for (const tampered of [
    { ...a, root: other },
    { ...a, tree_size: 4 },
    { ...a, prev_anchor_hash: other },
    { ...a, seq: 2 },
    { ...a, anchor_hash: other },
    { ...a, signature: { alg: "Ed25519", sig: attester().sign(canonical(anchorBody(a))) } },
  ]) assert.equal(await verifyAnchorSignature(tampered, att.jwk), false);
  // A rewriter with store access re-hashes but cannot re-sign.
  const rewritten = { ...a, root: other };
  rewritten.anchor_hash = await anchorHash(rewritten);
  assert.equal(await verifyAnchorSignature(rewritten, att.jwk), false);
  assert.equal(await verifyAnchorSignature(a, attester().jwk), false, "wrong key");
});

test("an anchor chain continues from v1 to v2 and verifies; breaks are detected", async () => {
  const att = attester();
  const p = [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }];
  const v1a = await makeV1(null, p.slice(0, 2), "t1");
  const v1b = await makeV1(v1a, p.slice(0, 3), "t2");
  const v2a = await makeV2(att, v1b, p.slice(0, 3), "t3");
  const v2b = await makeV2(att, v2a, p, "t4");
  assert.equal(v2a.prev_anchor_hash, v1b.anchor_hash);
  assert.equal(await anchorHash(v1b), v1b.anchor_hash);
  assert.deepEqual(await verifyAnchorChain([v1a, v1b, v2a, v2b], att.jwk), { valid: true });
  assert.equal(await verifyAnchorRoot(v1b, p.slice(0, 3)), true);

  // v2a and v1b cover the same 3 receipts under different algorithms.
  assert.equal(await verifyAnchorRoot(v2a, p.slice(0, 3)), true);
  // Consistency between the two v2 anchors.
  const leaves = await Promise.all(p.map(receiptLeafHash));
  const cp = await consistencyProof(leaves, v2a.tree_size);
  assert.equal(await verifyConsistencyProof({ ...cp, first_root: v2a.root, second_root: v2b.root }), true);

  assert.equal((await verifyAnchorChain([v1a, v1b, v2a, v2b])).valid, false, "v2 requires a key");
  assert.equal((await verifyAnchorChain([v1a, v1b, v2a, v2b], attester().jwk)).valid, false);
  assert.equal((await verifyAnchorChain([v1a, v2a, v2b], att.jwk)).valid, false, "missing link");
  assert.equal((await verifyAnchorChain([v1a, v1b, v2a, { ...v1b, seq: 4, prev_anchor_hash: v2a.anchor_hash }], att.jwk)).valid, false, "downgrade");
  const forged = { ...v1b, merkle_root: await leafHash("x") };
  assert.equal((await verifyAnchorChain([v1a, forged, v2a], att.jwk)).valid, false, "v1 anchor_hash mismatch");
});
