import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import { checkChainHeads, CHAIN_HEAD_CONTEXT } from "../dist/chain.js";
import { canonical } from "../dist/violates.js";

// Kept heads are listed in the order this computer received them. A head received after a higher one went back, whatever
// issue time the workspace signed on it, unless this computer's own times show the two deliveries were out together (and
// so may have been answered out of order). A head with no such times is judged by the order it was received in.

const sha = (t) => createHash("sha256").update(t).digest("hex");
const ANCHOR = "d".repeat(64);
const DAY = "2026-10-09";
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const spki = publicKey.export({ format: "der", type: "spki" }).toString("base64");
const kid = "seg_" + sha(spki).slice(0, 16);

function head({ seq, digest, at, local }) {
  const body = { type: "scopebond:chain-head", version: 1, anchor_id: ANCHOR, ingest_seq: seq, segment: { digest: digest.repeat(64), last_ingest_seq: seq }, issued_at: `${DAY}T${at}Z` };
  const signed = { head: body, signed: true, signature: { alg: "Ed25519", kid, sig: edSign(null, Buffer.from(CHAIN_HEAD_CONTEXT + canonical(body)), privateKey).toString("base64") } };
  return local ? { ...signed, local } : signed;
}
const t = (time) => `${DAY}T${time}Z`;

test("a head received after a higher one went back, whatever issue time the workspace put on it", () => {
  const A = head({ seq: 100, digest: "1", at: "10:00:00.000" });
  for (const at of ["10:05:00.000", "09:59:59.000", "10:00:00.000"]) {
    const B = head({ seq: 50, digest: "2", at });
    const check = checkChainHeads([A, B]);
    assert.equal(check.ok, false, `${at}: ${JSON.stringify(check)}`);
    assert.equal(check.problems.length, 1, `${at}: one problem per head that went back: ${check.problems.join("\n")}`);
    assert.match(check.problems[0], /chain dddddddddddd went back: sequence 100 \(kept/, at);
  }
  // Received the other way round, the lower head came first: nothing went back.
  assert.deepEqual(checkChainHeads([head({ seq: 50, digest: "2", at: "09:59:59.000" }), A]), { ok: true, problems: [], chains: 1, matched: 0 });
});

test("a backdated head received later stays reported beside a published list that agrees with it", () => {
  const A = head({ seq: 100, digest: "1", at: "10:00:00.000" });
  const B = head({ seq: 50, digest: "2", at: "09:59:59.000" });
  const check = checkChainHeads([A, B], [B]);
  assert.equal(check.ok, false, JSON.stringify(check));
  assert.equal(check.matched, 1);
  assert.match(check.problems.join("\n"), /went back: sequence 100 \(kept/);
});

test("heads marked held by one write, with no sent times, are judged by the order they were received in", () => {
  // Kept before delivery times were recorded, then marked held by the same later write: the times order nothing.
  const local = { received_at: t("11:00:00.000"), clock: "aaaaaaaaaaaaaaaa" };
  const A = head({ seq: 100, digest: "1", at: "10:00:00.000", local });
  const B = head({ seq: 50, digest: "2", at: "09:59:59.000", local });
  assert.match(checkChainHeads([A, B]).problems.join("\n"), /went back: sequence 100 \(kept/);
  // A head with times received after one without: the earlier head has no time to show they were out together.
  const timed = head({ seq: 50, digest: "2", at: "09:59:59.000", local: { sent_at: t("10:05:00.000"), received_at: t("10:05:00.200") } });
  assert.match(checkChainHeads([head({ seq: 100, digest: "1", at: "10:00:00.000" }), timed]).problems.join("\n"), /went back: sequence 100 \(kept/);
});

test("deliveries this computer's times show were out together are still not a rollback", () => {
  // The lower head's delivery left before the higher head arrived.
  const A = head({ seq: 103, digest: "1", at: "10:00:00.500", local: { sent_at: t("10:00:00.000"), received_at: t("10:00:00.700") } });
  const B = head({ seq: 100, digest: "2", at: "10:00:00.400", local: { sent_at: t("10:00:00.100"), received_at: t("10:00:00.900") } });
  assert.deepEqual(checkChainHeads([A, B]), { ok: true, problems: [], chains: 1, matched: 0 });
  // Heads of two computers sharing a folder are not ordered by each other.
  const mine = head({ seq: 120, digest: "3", at: "10:00:01.500", local: { received_at: t("10:00:02.000"), clock: "aaaaaaaaaaaaaaaa" } });
  const theirs = head({ seq: 110, digest: "4", at: "10:00:00.500", local: { received_at: t("10:00:03.000"), clock: "bbbbbbbbbbbbbbbb" } });
  assert.equal(checkChainHeads([mine, theirs]).ok, true);
});
