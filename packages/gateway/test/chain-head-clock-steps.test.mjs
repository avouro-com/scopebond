// The kept chain heads are ordered by this computer's own clock, which the workspace cannot choose. A clock that steps back
// while deliveries are in flight, or a folder two computers with different clocks share, must not turn heads that are in
// issue order into a "went back" report; a real rollback on one computer's clock is still reported.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkChainHeads } from "../dist/index.js";
import { CHAIN_HEADS_FILE, keptHeads, mergeChainHead, readChainHeads, recordChainHead } from "../dist/node.js";

const ANCHOR = "b".repeat(64);
const head = (seq, at) => ({
  head: { type: "scopebond:chain-head", version: 1, anchor_id: ANCHOR, ingest_seq: seq, segment: { digest: String(seq % 10).repeat(64), last_ingest_seq: seq }, issued_at: at },
  signed: false, signature: null,
});
const empty = { version: 1, chains: {} };

test("one computer: a clock stepped back while two deliveries were in flight is not a rollback", () => {
  // Clock one hour fast. X sent 11:00:00.000 local (10:00:00.000 real), Y sent 11:00:00.100 local. The workspace admits X
  // (seq 110, issued 10:00:00.200) then Y (seq 120, issued 10:00:00.300). Y's answer arrives first (11:00:00.400 local);
  // the clock is then corrected; X's answer arrives at 10:00:00.500. Every head is in issue order: nothing went back.
  const state = mergeChainHead(empty, head(120, "2026-10-09T10:00:00.300Z"), { sent_at: "2026-10-09T11:00:00.100Z", received_at: "2026-10-09T11:00:00.400Z" }, "2026-10-09T11:00:00.401Z");
  const withHeldBy = mergeChainHead(state, head(110, "2026-10-09T10:00:00.200Z"), { sent_at: "2026-10-09T11:00:00.000Z", received_at: "2026-10-09T10:00:00.500Z" }, "2026-10-09T10:00:00.501Z");
  const withoutHeldBy = mergeChainHead(state, head(110, "2026-10-09T10:00:00.200Z"), { sent_at: "2026-10-09T11:00:00.000Z", received_at: "2026-10-09T10:00:00.500Z" });
  const a = checkChainHeads(keptHeads(withHeldBy));
  const b = checkChainHeads(keptHeads(withoutHeldBy));
  assert.equal(b.ok, true, `without the write's time: ${b.problems.join("; ")}`);
  assert.equal(a.ok, true, `false rollback report: ${a.problems.join("; ")}`);
  // No head is kept with an answer before its request: a time taken on the clock before it went back is not kept.
  for (const h of keptHeads(withHeldBy)) {
    const { sent_at, received_at } = h.local;
    assert.ok(sent_at === undefined || Date.parse(sent_at) <= Date.parse(received_at), JSON.stringify(h.local));
  }
  assert.deepEqual(withHeldBy.chains[ANCHOR][0].local, { received_at: "2026-10-09T10:00:00.501Z" }, "Y is held by the write on the corrected clock");
});

test("two computers sharing the folder, one clock two minutes slow, are not compared by each other's clock", () => {
  // M2 (accurate) sends X at 10:00:00.000; M1 (2 min slow) sends Y at real 10:00:01 (local 09:58:01). The workspace admits X
  // (seq 110, 10:00:00.500) then Y (seq 120, 10:00:01.500). M1 holds Y at local 09:58:02; M2 holds X at 10:00:03.
  const y = head(120, "2026-10-09T10:00:01.500Z");
  const x = head(110, "2026-10-09T10:00:00.500Z");
  const yTimes = { sent_at: "2026-10-09T09:58:01.000Z", received_at: "2026-10-09T09:58:02.000Z" };
  const xTimes = { sent_at: "2026-10-09T10:00:00.000Z", received_at: "2026-10-09T10:00:03.000Z" };
  let shared = mergeChainHead(empty, y, { ...yTimes, clock: "m1-0000000000000" }, "2026-10-09T09:58:02.001Z");
  shared = mergeChainHead(shared, x, { ...xTimes, clock: "m2-0000000000000" }, "2026-10-09T10:00:03.001Z");
  const r = checkChainHeads(keptHeads(shared));
  assert.equal(r.ok, true, `false rollback report: ${r.problems.join("; ")}`);
  // The same times on one computer's clock are a rollback: seq 120 was held before the delivery answered with 110 was sent.
  let one = mergeChainHead(empty, y, { ...yTimes, clock: "m1-0000000000000" }, "2026-10-09T09:58:02.001Z");
  one = mergeChainHead(one, x, { ...xTimes, clock: "m1-0000000000000" }, "2026-10-09T10:00:03.001Z");
  assert.match(checkChainHeads(keptHeads(one)).problems.join("\n"), /went back: sequence 120 \(kept/);
});

test("a write leaves another computer's times as that computer kept them", () => {
  const other = { sent_at: "2026-10-09T10:02:00.000Z", received_at: "2026-10-09T10:02:01.000Z", clock: "m1-0000000000000" };
  // Issued on another day, so the next head is kept beside it rather than replacing it as the day's newest.
  let state = mergeChainHead(empty, head(120, "2026-10-08T10:00:01.500Z"), other, "2026-10-09T10:02:01.001Z");
  state = mergeChainHead(state, head(121, "2026-10-09T10:00:02.500Z"), { sent_at: "2026-10-09T10:00:02.000Z", received_at: "2026-10-09T10:00:03.000Z", clock: "m2-0000000000000" }, "2026-10-09T10:00:03.001Z");
  assert.deepEqual(state.chains[ANCHOR][0].local, other, "M1's clock is ahead of M2's: that is not a clock step on M2");
});

test("the store names this computer's clock beside the times it keeps", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sb-chain-clock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, CHAIN_HEADS_FILE);
  const now = Date.now();
  recordChainHead(file, head(100, new Date(now - 86_400_000).toISOString()), { sentAt: now - 2100, receivedAt: now - 1900 });
  recordChainHead(file, head(101, new Date(now - 1000).toISOString()), { sentAt: now - 1100, receivedAt: now - 900 });
  const kept = readChainHeads(file).chains[ANCHOR];
  assert.equal(kept.length, 2);
  assert.match(kept[0].local.clock, /^[0-9a-f]{16}$/);
  assert.equal(kept[1].local.clock, kept[0].local.clock, "one id for every process on this computer");
});
