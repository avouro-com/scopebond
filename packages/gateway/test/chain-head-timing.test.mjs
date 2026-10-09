import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCloudExporter, createMemoryCloudOutbox, checkChainHeads } from "../dist/index.js";
import { CHAIN_HEADS_FILE, chainHeadRecorder, keptHeads, mergeChainHead, readChainHeads, recordChainHead } from "../dist/node.js";

// Beside each kept head the computer keeps its own times: when the delivery that the head answered was sent, and by when
// the head was held. The workspace signs `issued_at` and can choose it; these it cannot, so they are what orders a
// rollback check.

const ANCHOR = "a".repeat(64);
const head = (seq, at, digest = "1") => ({
  head: { type: "scopebond:chain-head", version: 1, anchor_id: ANCHOR, ingest_seq: seq, segment: { digest: digest.repeat(64), last_ingest_seq: seq }, issued_at: at },
  signed: false, signature: null,
});
const receipt = (id) => ({ payload: { action_ref: { action_id: id } }, signature: { alg: "Ed25519", sig: "fixture" } });
const iso = (ms) => new Date(ms).toISOString();

test("the exporter hands the caller when each delivery was sent and when its answer arrived", async () => {
  let clock = Date.parse("2026-10-09T10:00:00.000Z");
  const seen = [];
  const answer = { ok: true, chain_head: head(3, "2026-10-09T10:00:00.500Z") };
  const ex = createCloudExporter({
    url: "https://ws.example", credential: "sbm_x", outbox: createMemoryCloudOutbox(), batchSize: 1, flushMs: 1e9, now: () => clock,
    fetch: async () => { clock += 750; return { ok: true, status: 200, json: async () => answer, text: async () => JSON.stringify(answer), headers: new Map() }; },
    onChainHead: (h, delivery) => seen.push({ h, delivery }),
  });
  ex.enqueue(receipt("action:chain-head-timing-1"));
  await ex.flush();
  ex.stop();
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].delivery, { sentAt: Date.parse("2026-10-09T10:00:00.000Z"), receivedAt: Date.parse("2026-10-09T10:00:00.750Z") });
});

test("the store keeps this computer's times with each head, and nothing else the workspace put beside the head", () => {
  const planted = { ...head(3, "2026-10-09T10:00:00.000Z"), local: { sent_at: "2000-01-01T00:00:00.000Z", received_at: "2099-01-01T00:00:00.000Z" }, note: "x" };
  const local = { sent_at: "2026-10-09T10:00:00.000Z", received_at: "2026-10-09T10:00:00.400Z" };
  const state = mergeChainHead({ version: 1, chains: {} }, planted, local);
  assert.deepEqual(state.chains[ANCHOR], [{ head: planted.head, signed: false, signature: null, local }]);
  const unknown = mergeChainHead({ version: 1, chains: {} }, planted);
  assert.deepEqual(unknown.chains[ANCHOR], [{ head: planted.head, signed: false, signature: null }], "no times are invented");
});

test("heads kept without times are marked held by the time the store next writes", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-chain-timing-"));
  try {
    const file = join(dir, CHAIN_HEADS_FILE);
    // Written by an earlier version: no times; and one with a time later than now, which cannot be.
    writeFileSync(file, JSON.stringify({ version: 1, chains: { [ANCHOR]: [head(100, "2026-10-08T10:00:00.000Z"), { ...head(101, "2026-10-08T11:00:00.000Z", "2"), local: { received_at: "2099-01-01T00:00:00.000Z" } }] } }));
    const before = Date.now();
    recordChainHead(file, head(102, "2026-10-09T10:00:00.000Z", "3"), { sentAt: before - 500, receivedAt: before - 100 });
    const after = Date.now();
    const kept = readChainHeads(file).chains[ANCHOR];
    assert.deepEqual(kept.map((h) => h.head.ingest_seq), [100, 101, 102]);
    for (const h of kept.slice(0, 2)) {
      const held = Date.parse(h.local.received_at);
      assert.ok(held >= before && held <= after, `held by the write: ${h.local.received_at}`);
      assert.equal(h.local.sent_at, undefined);
    }
    assert.deepEqual(kept[2].local, { sent_at: iso(before - 500), received_at: iso(before - 100), clock: kept[0].local.clock });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a rolled-back chain whose new head is backdated, or stamped at the same instant, is reported from the kept heads", () => {
  // The audit case: seq 100 is kept, then the workspace answers a later delivery with seq 50 issued at or before it.
  for (const at of ["2026-10-09T09:59:59.000Z", "2026-10-09T10:00:00.000Z"]) {
    const dir = mkdtempSync(join(tmpdir(), "sb-chain-timing-"));
    try {
      const file = join(dir, CHAIN_HEADS_FILE);
      const record = chainHeadRecorder(file);
      const t = Date.now();
      record(head(100, "2026-10-09T10:00:00.000Z", "1"), { sentAt: t - 2000, receivedAt: t - 1900 });
      record(head(50, at, "2"), { sentAt: t - 1000, receivedAt: t - 900 });
      const state = readChainHeads(file);
      assert.deepEqual(state.chains[ANCHOR].map((h) => h.head.ingest_seq), [100, 50], "both heads are kept as evidence");
      const check = checkChainHeads(keptHeads(state));
      assert.equal(check.ok, false, `${at}: ${JSON.stringify(check)}`);
      assert.match(check.problems.join("\n"), /went back: sequence 100 \(kept/);
      assert.equal(JSON.parse(readFileSync(file, "utf8")).version, 1, "the file stays readable by earlier versions");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});
