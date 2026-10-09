import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import { checkChainHeads, verifyAnchorList, verifyChainHeadSignature, verifySegmentChain, CHAIN_HEAD_CONTEXT, ANCHOR_LIST_CONTEXT } from "../dist/chain.js";
import { canonical } from "../dist/violates.js";

// The chain checks are run on documents a workspace serves, and the workspace is the party they check. Whatever shape a
// segment or a published list takes, they report a problem; they never throw.

const sha = (t) => createHash("sha256").update(t).digest("hex");
const ANCHOR = "a".repeat(64);

function segmentKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  return { spki, kid: "seg_" + sha(spki).slice(0, 16), sign: (text) => edSign(null, Buffer.from(text), privateKey).toString("base64") };
}

test("a segment whose records are not objects is reported, not thrown on", async () => {
  for (const bad of [null, 5, "x", true, []]) {
    const text = canonical({ type: "scopebond:evidence-segment", version: 1, bounds: { first_ingest_seq: 1, last_ingest_seq: 1 }, previous_segment_digest: null, records: [bad], proof: { merkle_root: "x" } });
    const check = await verifySegmentChain([text]);
    assert.equal(check.ok, false, JSON.stringify(bad));
    assert.match(check.problems.join("\n"), /the record at position 0 is not an object/, JSON.stringify(bad));
  }
  // One bad record among good ones does not hide the rest of the segment's problems.
  const text = canonical({ type: "scopebond:evidence-segment", version: 1, bounds: { first_ingest_seq: 1, last_ingest_seq: 2 }, previous_segment_digest: null, records: [null, { ingest_seq: 2, event_id: "e2", leaf: "0".repeat(64), receipt: { payload: { n: 2 } } }], proof: { merkle_root: "x" } });
  const check = await verifySegmentChain([text], [], { publicKey: computerKeyPem() });
  assert.match(check.problems.join("\n"), /the record at position 0 is not an object/);
  assert.match(check.problems.join("\n"), /record e2 does not hash to its leaf/);
});

function computerKeyPem() {
  const { publicKey } = generateKeyPairSync("ed25519");
  return publicKey.export({ format: "pem", type: "spki" }).toString();
}

test("a published list carrying text that cannot be canonical JSON is reported, not thrown on", async () => {
  const lone = { type: "scopebond:chain-anchors", version: 1, date: "2026-10-09", key: { alg: "Ed25519", kid: "seg_x", public_key_spki: "\ud800" }, heads: [], signed: true, signature: { kid: "seg_x", sig: "AA==" } };
  const check = await verifyAnchorList(lone);
  assert.equal(check.valid, false);
  assert.match(check.problems.join("\n"), /the list signature does not verify/);

  // A head whose issue time parses as a date yet carries a lone surrogate, in an otherwise well-signed list.
  const key = segmentKey();
  const body = { type: "scopebond:chain-head", version: 1, anchor_id: ANCHOR, ingest_seq: 3, segment: null, issued_at: "2026-10-09 (\ud800)" };
  const h = { head: body, signed: true, signature: { alg: "Ed25519", kid: key.kid, sig: "AA==" } };
  const list = { type: "scopebond:chain-anchors", version: 1, date: "2026-10-09", key: { alg: "Ed25519", kid: key.kid, public_key_spki: key.spki }, heads: [h], signed: true, signature: { alg: "Ed25519", kid: key.kid, sig: "AA==" } };
  const withHead = await verifyAnchorList(list);
  assert.equal(withHead.valid, false);
  assert.match(withHead.problems.join("\n"), /its head signature does not verify/);
  assert.equal(await verifyChainHeadSignature(h, list.key), false);
});

test("a head checked against a key that is not a key is false, never a throw", async () => {
  const key = segmentKey();
  const body = { type: "scopebond:chain-head", version: 1, anchor_id: ANCHOR, ingest_seq: 3, segment: null, issued_at: "2026-10-09T10:00:00.000Z" };
  const h = { head: body, signed: true, signature: { alg: "Ed25519", kid: key.kid, sig: key.sign(CHAIN_HEAD_CONTEXT + canonical(body)) } };
  assert.equal(await verifyChainHeadSignature(h, { alg: "Ed25519", kid: key.kid, public_key_spki: key.spki }), true);
  for (const bad of [{ alg: "Ed25519", kid: key.kid, public_key_spki: 123 }, { kid: key.kid, public_key_spki: { x: 1 } }, null, "key"]) {
    assert.equal(await verifyChainHeadSignature(h, bad), false, JSON.stringify(bad));
  }
  // A signed list whose key member is the wrong shape says so.
  const listBody = { type: "scopebond:chain-anchors", version: 1, date: "2026-10-09", key: { alg: "Ed25519", kid: key.kid, public_key_spki: 123 }, heads: [h] };
  const check = await verifyAnchorList({ ...listBody, signed: true, signature: { alg: "Ed25519", kid: key.kid, sig: key.sign(ANCHOR_LIST_CONTEXT + "x") } });
  assert.equal(check.valid, false);
  assert.match(check.problems.join("\n"), /a signed list must publish its key/);
});

test("heads of any shape are reported, not thrown on", () => {
  assert.doesNotThrow(() => checkChainHeads([null, 5, { head: null }], [null, { head: { anchor_id: ANCHOR } }]));
  assert.equal(checkChainHeads([null]).ok, false);
});
