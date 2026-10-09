import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import { checkChainHeads, CHAIN_HEAD_CONTEXT } from "../dist/chain.js";
import { canonical } from "../dist/violates.js";

// A chain that went back must be reported whatever issue time the workspace puts on its heads: the workspace signs
// `issued_at`, so it can stamp a lower head at or before a higher one it already handed out. The order that cannot be
// chosen by the workspace is this computer's own: a head that answered a delivery sent after another head had arrived
// was issued after it. Deliveries in flight together may still be answered out of order, which is not a rollback.

const sha = (t) => createHash("sha256").update(t).digest("hex");
const ANCHOR = "a".repeat(64);
const DAY = "2026-10-09";

function segmentKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  return { spki, kid: "seg_" + sha(spki).slice(0, 16), sign: (text) => edSign(null, Buffer.from(text), privateKey).toString("base64") };
}
const key = segmentKey();

/** A signed head, with the times this computer kept beside it (its own clock: request sent, answer held). */
function head({ seq, digest, at, sent, received }) {
  const body = { type: "scopebond:chain-head", version: 1, anchor_id: ANCHOR, ingest_seq: seq, segment: { digest: digest.repeat(64), last_ingest_seq: seq }, issued_at: `${DAY}T${at}Z` };
  const signed = { head: body, signed: true, signature: { alg: "Ed25519", kid: key.kid, sig: key.sign(CHAIN_HEAD_CONTEXT + canonical(body)) } };
  if (received === undefined) return signed;
  return { ...signed, local: { ...(sent ? { sent_at: `${DAY}T${sent}Z` } : {}), received_at: `${DAY}T${received}Z` } };
}

test("a chain that went back is reported even when the workspace stamps the lower head at or before the higher one", () => {
  // Seq 100 answered a delivery sent at 10:00:00.200 and arrived at 10:00:00.400. The next delivery left at 10:05 and was
  // answered with seq 50: the records after 50 are gone.
  const A = head({ seq: 100, digest: "1", at: "10:00:00.300", sent: "10:00:00.200", received: "10:00:00.400" });
  const honest = head({ seq: 50, digest: "2", at: "10:05:00.100", sent: "10:05:00.000", received: "10:05:00.200" });
  const backdated = head({ seq: 50, digest: "2", at: "09:59:59.000", sent: "10:05:00.000", received: "10:05:00.200" });
  const sameInstant = head({ seq: 50, digest: "2", at: "10:00:00.300", sent: "10:05:00.000", received: "10:05:00.200" });
  for (const [name, B] of [["honest issue time", honest], ["backdated", backdated], ["same instant", sameInstant]]) {
    const check = checkChainHeads([A, B]);
    assert.equal(check.ok, false, `${name}: ${JSON.stringify(check)}`);
    assert.equal(check.problems.length, 1, `${name}: one problem per head that went back: ${check.problems.join("\n")}`);
    assert.match(check.problems[0], /chain aaaaaaaaaaaa went back: sequence 100 \(kept/, name);
    // Whichever order the heads are listed in.
    assert.equal(checkChainHeads([B, A]).ok, false, `${name}, listed the other way round`);
  }
});

test("a rolled-back chain stays visible beside a published day list that agrees with the lower head", () => {
  const A = head({ seq: 100, digest: "1", at: "10:00:00.000", sent: "09:59:59.900", received: "10:00:00.100" });
  const B = head({ seq: 50, digest: "2", at: "09:59:59.000", sent: "10:30:00.000", received: "10:30:00.100" });
  const published = [head({ seq: 50, digest: "2", at: "09:59:59.000" })];
  const check = checkChainHeads([A, B], published);
  assert.equal(check.ok, false, JSON.stringify(check));
  assert.equal(check.matched, 1);
  assert.match(check.problems.join("\n"), /went back: sequence 100/);
});

test("deliveries in flight together may be answered out of order: that is not a rollback", () => {
  // Two deliveries left at once; the one answered with the lower sequence arrived second.
  const A = head({ seq: 103, digest: "1", at: "10:00:00.500", sent: "10:00:00.000", received: "10:00:00.700" });
  const B = head({ seq: 100, digest: "2", at: "10:00:00.400", sent: "10:00:00.100", received: "10:00:00.900" });
  assert.deepEqual(checkChainHeads([A, B]), { ok: true, problems: [], chains: 1, matched: 0 });
  // A later delivery, sent after both arrived, is answered at or above both.
  const C = head({ seq: 103, digest: "1", at: "10:01:00.000", sent: "10:01:00.000", received: "10:01:00.100" });
  assert.equal(checkChainHeads([A, B, C]).ok, true);
  const D = head({ seq: 101, digest: "3", at: "10:02:00.000", sent: "10:02:00.000", received: "10:02:00.100" });
  assert.match(checkChainHeads([A, B, C, D]).problems.join("\n"), /went back: sequence 103 \(kept/);
});

test("a head kept before its delivery times were recorded still bounds every head sent after it was held", () => {
  // Kept by an earlier version: only the time by which it was held is known.
  const A = head({ seq: 100, digest: "1", at: "10:00:00.000", received: "10:10:00.000" });
  const concurrent = head({ seq: 50, digest: "2", at: "09:59:00.000", sent: "10:09:00.000", received: "10:09:30.000" });
  assert.equal(checkChainHeads([A, concurrent]).ok, true, "sent before the earlier head was known to be held: not ordered");
  const after = head({ seq: 51, digest: "3", at: "09:59:30.000", sent: "10:20:00.000", received: "10:20:00.100" });
  assert.match(checkChainHeads([A, concurrent, after]).problems.join("\n"), /went back: sequence 100 \(kept/);
});

test("heads without this computer's times are compared by issue time, as before", () => {
  const A = head({ seq: 100, digest: "1", at: "10:00:00.000" });
  const later = head({ seq: 50, digest: "2", at: "10:05:00.000" });
  assert.match(checkChainHeads([A, later]).problems.join("\n"), /went back: sequence 100 \(kept, 2026-10-09T10:00:00.000Z\) then 50/);
  assert.equal(checkChainHeads([A, head({ seq: 120, digest: "3", at: "10:05:00.000" })]).ok, true);
});

test("times a published head or a workspace answer carries are not this computer's and are ignored", () => {
  const A = head({ seq: 50, digest: "1", at: "10:00:00.000", sent: "09:59:59.900", received: "10:00:00.100" });
  // A published head issued after A, with times that would make it look held here before A's delivery left.
  const P = { ...head({ seq: 100, digest: "2", at: "10:30:00.000" }), local: { sent_at: "2000-01-01T00:00:00.000Z", received_at: "2000-01-01T00:00:00.000Z" } };
  assert.deepEqual(checkChainHeads([A], [P]), { ok: true, problems: [], chains: 1, matched: 1 });
  // Kept times that are not times are ignored, never a crash.
  const odd = { ...head({ seq: 40, digest: "3", at: "10:40:00.000" }), local: { sent_at: 7, received_at: { at: "x" } } };
  assert.doesNotThrow(() => checkChainHeads([A, odd, { ...A, local: null }]));
});
