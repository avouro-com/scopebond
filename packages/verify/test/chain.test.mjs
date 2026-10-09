import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import {
  verifyAnchorList, verifyChainHeadSignature, checkChainHeads, verifySegmentChain, segmentKeyId, isSignedChainHead,
  CHAIN_HEAD_CONTEXT, ANCHOR_LIST_CONTEXT,
} from "../dist/chain.js";
import { merkleRootV1 } from "../dist/anchor.js";
import { canonical } from "../dist/violates.js";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const ANCHOR = "a".repeat(64);
const OTHER = "b".repeat(64);

function segmentKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const kid = "seg_" + sha(spki).slice(0, 16);
  return { spki, kid, sign: (text) => edSign(null, Buffer.from(text), privateKey).toString("base64") };
}

function head(key, { anchor = ANCHOR, seq, segment = null, at }) {
  const body = { type: "scopebond:chain-head", version: 1, anchor_id: anchor, ingest_seq: seq, segment, issued_at: at };
  return key ? { head: body, signed: true, signature: { alg: "Ed25519", kid: key.kid, sig: key.sign(CHAIN_HEAD_CONTEXT + canonical(body)) } }
    : { head: body, signed: false, signature: null };
}

function list(key, date, heads) {
  const body = { type: "scopebond:chain-anchors", version: 1, date, key: key ? { alg: "Ed25519", kid: key.kid, public_key_spki: key.spki } : null, heads };
  return key ? { ...body, signed: true, signature: { alg: "Ed25519", kid: key.kid, sig: key.sign(ANCHOR_LIST_CONTEXT + canonical(body)) } }
    : { ...body, signed: false, signature: null };
}

// A computer key that signs receipts, with the kid the receipts name.
function computerKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" });
  const kid = "key:" + sha(canonical({ crv: jwk.crv, kty: jwk.kty, x: jwk.x })).slice(0, 16);
  const pem = publicKey.export({ format: "pem", type: "spki" }).toString();
  return { pem, receipt: (n) => {
    const payload = { type: "test", attester: { kind: "gateway", kid }, n };
    return { payload, signature: { alg: "Ed25519", sig: edSign(null, Buffer.from(canonical(payload)), privateKey).toString("base64") } };
  } };
}

async function segment(previous, first, receipts) {
  const records = receipts.map((receipt, i) => ({ ingest_seq: first + i, event_id: `e${first + i}`, leaf: sha(canonical(receipt.payload)), receipt }));
  const doc = {
    type: "scopebond:evidence-segment", version: 1, bounds: { first_ingest_seq: first, last_ingest_seq: first + receipts.length - 1 },
    previous_segment_digest: previous, records, proof: { algorithm: "sha256-merkle", merkle_root: await merkleRootV1(records.map((r) => r.leaf)), leaf_count: records.length },
  };
  const text = canonical(doc);
  return { text, digest: sha(text), last: doc.bounds.last_ingest_seq };
}

// Three deliveries of three records each, and the heads the computer kept from the answers.
async function history(signer = null) {
  const computer = computerKey();
  const a = await segment(null, 1, [1, 2, 3].map(computer.receipt));
  const b = await segment(a.digest, 4, [4, 5, 6].map(computer.receipt));
  const c = await segment(b.digest, 7, [7, 8, 9].map(computer.receipt));
  const kept = [
    head(signer, { seq: 3, segment: { digest: a.digest, last_ingest_seq: 3 }, at: "2026-10-07T10:00:00.000Z" }),
    head(signer, { seq: 6, segment: { digest: b.digest, last_ingest_seq: 6 }, at: "2026-10-07T11:00:00.000Z" }),
    head(signer, { seq: 9, segment: { digest: c.digest, last_ingest_seq: 9 }, at: "2026-10-07T12:00:00.000Z" }),
  ];
  return { computer, a, b, c, kept };
}

test("a published list verifies: its key id names its key, the list and each head are signed by it", async () => {
  const key = segmentKey();
  assert.equal(await segmentKeyId(key.spki), key.kid);
  const h = head(key, { seq: 5, segment: { digest: "c".repeat(64), last_ingest_seq: 4 }, at: "2026-10-07T23:50:00.000Z" });
  const day = list(key, "2026-10-07", [h]);
  assert.deepEqual(await verifyAnchorList(day), { valid: true, signed: true, kid: key.kid, heads: 1, problems: [] });
  assert.equal(await verifyChainHeadSignature(h, day.key), true);
  // Stable: the same list re-serialised in another member order still verifies (the signature is over canonical JSON).
  assert.equal((await verifyAnchorList(JSON.parse(JSON.stringify({ signature: day.signature, ...day })))).valid, true);
});

test("a changed list, a changed head, another key or a head from another day is refused", async () => {
  const key = segmentKey();
  const day = list(key, "2026-10-07", [head(key, { seq: 5, at: "2026-10-07T01:00:00.000Z" })]);
  const lowered = structuredClone(day);
  lowered.heads[0].head.ingest_seq = 4;
  const check = await verifyAnchorList(lowered);
  assert.equal(check.valid, false);
  assert.ok(check.problems.some((p) => /list signature does not verify/.test(p)));
  assert.ok(check.problems.some((p) => /head signature does not verify/.test(p)));
  const swapped = { ...day, key: { ...day.key, public_key_spki: segmentKey().spki } };
  assert.ok((await verifyAnchorList(swapped)).problems.some((p) => /key id does not name/.test(p)));
  const late = list(key, "2026-10-07", [head(key, { seq: 5, at: "2026-10-08T00:00:01.000Z" })]);
  assert.ok((await verifyAnchorList(late)).problems.some((p) => /issued on another day/.test(p)));
  assert.equal((await verifyAnchorList({ type: "something else" })).valid, false);
});

test("an unsigned list is well formed but says it is unsigned", async () => {
  const day = list(null, "2026-10-07", [head(null, { seq: 2, at: "2026-10-07T01:00:00.000Z" })]);
  assert.deepEqual(await verifyAnchorList(day), { valid: true, signed: false, kid: null, heads: 1, problems: [] });
  assert.equal(isSignedChainHead(day.heads[0]), true);
  assert.equal(isSignedChainHead({ ...day.heads[0], head: { ...day.heads[0].head, workspace: "x" } }), false, "a head carries nothing but the chain's facts");
});

test("kept and published heads that agree pass; a chain that went back, or two segments at one position, do not", async () => {
  const { kept } = await history();
  const published = [head(null, { seq: 9, segment: kept[2].head.segment, at: "2026-10-07T12:05:00.000Z" }), head(null, { anchor: OTHER, seq: 1, at: "2026-10-07T12:00:00.000Z" })];
  assert.deepEqual(checkChainHeads(kept, published), { ok: true, problems: [], chains: 1, matched: 1 });
  // Published later, lower: the chain was rewound after the computer was told 9.
  const rewound = checkChainHeads(kept, [head(null, { seq: 6, segment: kept[1].head.segment, at: "2026-10-07T23:59:00.000Z" })]);
  assert.equal(rewound.ok, false);
  assert.match(rewound.problems.join("\n"), /went back: sequence 9 \(kept/);
  // A later head ends a different segment at sequence 9.
  const forked = checkChainHeads([...kept, head(null, { seq: 11, segment: { digest: "d".repeat(64), last_ingest_seq: 9 }, at: "2026-10-07T13:00:00.000Z" })]);
  assert.match(forked.problems.join("\n"), /two different segments end at sequence 9/);
});

test("segments and kept heads agree end to end, with every record signed by the computer's key", async () => {
  const { computer, a, b, c, kept } = await history();
  const check = await verifySegmentChain([a.text, b.text, c.text], kept, { publicKey: computer.pem });
  assert.deepEqual(check, { ok: true, problems: [], segments: 3, records: 9, covered: { [ANCHOR]: 9 }, signatures: { checked: 9, other_keys: 0 } });
  // Another computer's key checks nothing here: its records are not in these segments.
  assert.deepEqual((await verifySegmentChain([a.text, b.text, c.text], kept, { publicKey: computerKey().pem })).signatures, { checked: 0, other_keys: 9 });
  // A record that names this computer's key but was changed does not pass.
  const doc = JSON.parse(c.text);
  doc.records[0].receipt.payload.n = 70;
  doc.records[0].leaf = sha(canonical(doc.records[0].receipt.payload));
  doc.proof.merkle_root = await merkleRootV1(doc.records.map((r) => r.leaf));
  const forged = await verifySegmentChain([a.text, b.text, canonical(doc)], [], { publicKey: computer.pem });
  assert.match(forged.problems.join("\n"), /names this key but its signature does not verify/);
});

test("deleting the newest segment, even with the chain rewound and later records chained on, contradicts the kept heads", async () => {
  const { computer, a, b, kept } = await history();
  // Without the newest segment the files alone look like a clean chain of two.
  assert.equal((await verifySegmentChain([a.text, b.text], [])).ok, true);
  const missing = await verifySegmentChain([a.text, b.text], kept);
  assert.equal(missing.ok, false);
  assert.match(missing.problems.join("\n"), /not among the segments given/);
  // Rewound: two more records become 7 and 8 on top of b; the computer is told 8.
  const d = await segment(b.digest, 7, [10, 11].map(computer.receipt));
  const later = [...kept, head(null, { seq: 8, segment: { digest: d.digest, last_ingest_seq: 8 }, at: "2026-10-07T13:00:00.000Z" })];
  const after = await verifySegmentChain([a.text, b.text, d.text], later);
  assert.equal(after.ok, false);
  assert.match(after.problems.join("\n"), /no longer in the chain/);
  assert.match(checkChainHeads(later).problems.join("\n"), /went back/);
});

test("deleting a middle segment and re-chaining the rest (re-signed or not) contradicts the kept heads", async () => {
  const { computer, a, c, kept } = await history();
  const rechained = await segment(a.digest, 4, [7, 8, 9].map(computer.receipt));
  assert.equal((await verifySegmentChain([a.text, rechained.text], [])).ok, true, "the files alone verify");
  const check = await verifySegmentChain([a.text, rechained.text], kept);
  assert.equal(check.ok, false);
  assert.ok(check.problems.join("\n").includes(`segment ${c.digest.slice(0, 12)} is not among the segments given`), check.problems.join("\n"));
});

test("a changed record, a broken link or a gap in the sequence is reported", async () => {
  const { a, b, c, kept } = await history();
  const doc = JSON.parse(b.text);
  doc.records[1].receipt.payload.n = 99;
  const altered = canonical(doc);
  const check = await verifySegmentChain([a.text, altered, c.text], kept);
  assert.match(check.problems.join("\n"), /does not hash to its leaf/);
  assert.match(check.problems.join("\n"), /not among the segments given/, "the changed segment has another digest, so c's link breaks");
  const gap = await segment(a.digest, 5, [JSON.parse(c.text).records[0].receipt]);
  const gapped = await verifySegmentChain([a.text, gap.text], [head(null, { seq: 5, segment: { digest: gap.digest, last_ingest_seq: 5 }, at: "2026-10-07T12:00:00.000Z" })]);
  assert.match(gapped.problems.join("\n"), /sequence numbers 4–4 are in no segment/);
});
