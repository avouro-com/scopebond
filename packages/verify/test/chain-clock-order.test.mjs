import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import { checkChainHeads, CHAIN_HEAD_CONTEXT } from "../dist/chain.js";
import { canonical } from "../dist/violates.js";

// This computer's order is checked on one clock only. A head whose answer is marked held before its request was sent was
// timed across a clock step back, so its sent time orders nothing; heads that name different computers' clocks (a folder
// two computers share) are not ordered by each other's times. A rollback on one clock is still reported, also when the
// workspace backdates the lower head or stamps it at the same instant.

const sha = (t) => createHash("sha256").update(t).digest("hex");
const ANCHOR = "c".repeat(64);
const DAY = "2026-10-09";
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const spki = publicKey.export({ format: "der", type: "spki" }).toString("base64");
const kid = "seg_" + sha(spki).slice(0, 16);

function head({ seq, digest, at, sent, received, clock }) {
  const body = { type: "scopebond:chain-head", version: 1, anchor_id: ANCHOR, ingest_seq: seq, segment: { digest: digest.repeat(64), last_ingest_seq: seq }, issued_at: `${DAY}T${at}Z` };
  const signed = { head: body, signed: true, signature: { alg: "Ed25519", kid, sig: edSign(null, Buffer.from(CHAIN_HEAD_CONTEXT + canonical(body)), privateKey).toString("base64") } };
  return { ...signed, local: { ...(sent ? { sent_at: `${DAY}T${sent}Z` } : {}), received_at: `${DAY}T${received}Z`, ...(clock ? { clock } : {}) } };
}

test("heads timed across a clock step back (as an earlier store wrote them) are not a rollback", () => {
  // Y (seq 120) arrived before the clock was put back an hour, and the next write marked it held by the corrected time;
  // X (seq 110) was sent before the step and answered after it. Both were issued in order.
  const Y = head({ seq: 120, digest: "1", at: "10:00:00.300", sent: "11:00:00.100", received: "10:00:00.501" });
  const X = head({ seq: 110, digest: "2", at: "10:00:00.200", sent: "11:00:00.000", received: "10:00:00.500" });
  assert.deepEqual(checkChainHeads([Y, X]), { ok: true, problems: [], chains: 1, matched: 0 });
  // Y still bounds what is sent after it was held on the corrected clock.
  const later = head({ seq: 115, digest: "3", at: "10:00:00.100", sent: "10:01:00.000", received: "10:01:00.100" });
  assert.match(checkChainHeads([Y, X, later]).problems.join("\n"), /went back: sequence 120 \(kept/);
});

test("heads of two computers' clocks are not ordered by each other's times", () => {
  const Y = head({ seq: 120, digest: "1", at: "10:00:01.500", sent: "09:58:01.000", received: "09:58:02.000", clock: "aaaaaaaaaaaaaaaa" });
  const X = head({ seq: 110, digest: "2", at: "10:00:00.500", sent: "10:00:00.000", received: "10:00:03.000", clock: "bbbbbbbbbbbbbbbb" });
  assert.equal(checkChainHeads([Y, X]).ok, true);
  const sameClock = { ...X, local: { ...X.local, clock: "aaaaaaaaaaaaaaaa" } };
  assert.match(checkChainHeads([Y, sameClock]).problems.join("\n"), /went back: sequence 120 \(kept/);
  // Issue order still covers heads of every clock.
  const issuedLater = head({ seq: 100, digest: "3", at: "10:05:00.000", sent: "10:04:59.000", received: "10:05:01.000", clock: "bbbbbbbbbbbbbbbb" });
  assert.match(checkChainHeads([Y, issuedLater]).problems.join("\n"), /went back: sequence 120 \(kept, 2026-10-09T10:00:01.500Z\) then 100/);
});

test("a rollback on one clock is reported whether the workspace backdates the lower head or stamps it at the same instant", () => {
  const A = head({ seq: 100, digest: "1", at: "10:00:00.300", sent: "10:00:00.200", received: "10:00:00.400", clock: "aaaaaaaaaaaaaaaa" });
  for (const at of ["09:59:59.000", "10:00:00.300"]) {
    const B = head({ seq: 50, digest: "2", at, sent: "10:05:00.000", received: "10:05:00.200", clock: "aaaaaaaaaaaaaaaa" });
    const check = checkChainHeads([A, B]);
    assert.equal(check.problems.length, 1, `${at}: ${check.problems.join("\n")}`);
    assert.match(check.problems[0], /went back: sequence 100 \(kept/);
    // A head kept before clocks were named is compared with every clock, as before.
    const legacy = { ...A, local: { sent_at: A.local.sent_at, received_at: A.local.received_at } };
    assert.match(checkChainHeads([legacy, B]).problems.join("\n"), /went back: sequence 100 \(kept/);
  }
});
