import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCloudExporter, createMemoryCloudOutbox, checkChainHeads } from "../dist/index.js";
import { CHAIN_HEADS_FILE, chainHeadRecorder, keptHeads, mergeChainHead, readChainHeads } from "../dist/node.js";

// A workspace's delivery answer carries the environment chain's head; the exporter hands it to the caller, and the node
// store keeps it beside the receipts so the heads can be checked later against published anchors and segments.

const ANCHOR = "a".repeat(64);
const head = (seq, at, segment = null, anchor = ANCHOR) => ({
  head: { type: "scopebond:chain-head", version: 1, anchor_id: anchor, ingest_seq: seq, segment, issued_at: at },
  signed: false, signature: null,
});
const receipt = (id) => ({ payload: { action_ref: { action_id: id } }, signature: { alg: "Ed25519", sig: "fixture" } });

function workspace(answers) {
  let n = 0;
  return async () => {
    const body = answers[Math.min(n++, answers.length - 1)];
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body), headers: new Map() };
  };
}

test("the exporter hands each answer's chain head to the caller, and ignores a malformed one or a failing callback", async () => {
  const seen = [];
  const good = head(3, "2026-10-07T10:00:00.000Z", { digest: "c".repeat(64), last_ingest_seq: 3 });
  const ex = createCloudExporter({
    url: "https://ws.example", credential: "sbm_x", outbox: createMemoryCloudOutbox(), batchSize: 1, flushMs: 1e9,
    fetch: workspace([{ ok: true, chain_head: good }, { ok: true, chain_head: { head: { anchor_id: "x" } } }, { ok: true }]),
    onChainHead: (h) => { seen.push(h); throw new Error("a broken callback"); },
  });
  for (const id of ["action:chain-head-1", "action:chain-head-2", "action:chain-head-3"]) ex.enqueue(receipt(id));
  await ex.flush();
  const status = ex.status();
  ex.stop();
  assert.deepEqual(seen, [good]);
  assert.equal(status.pending, 0, "every record was delivered despite the callback");
  assert.equal(status.lastError, null);
});

test("the node store keeps a day's newest head and every head that disagrees with the one before", () => {
  let state = { version: 1, chains: {} };
  state = mergeChainHead(state, head(3, "2026-10-07T10:00:00.000Z"));
  state = mergeChainHead(state, head(6, "2026-10-07T11:00:00.000Z"));
  assert.deepEqual(state.chains[ANCHOR].map((h) => h.head.ingest_seq), [6], "the day's newer head replaces the older");
  state = mergeChainHead(state, head(9, "2026-10-08T01:00:00.000Z"));
  state = mergeChainHead(state, head(8, "2026-10-08T02:00:00.000Z"));
  state = mergeChainHead(state, head(12, "2026-10-08T03:00:00.000Z"));
  assert.deepEqual(state.chains[ANCHOR].map((h) => h.head.ingest_seq), [6, 9, 8, 12], "a head that went back is kept, and so is the one after it");
  assert.match(checkChainHeads(keptHeads(state)).problems.join("\n"), /went back: sequence 9/);
  assert.equal(mergeChainHead(state, { head: { anchor_id: "x" } }), state, "a malformed head is not kept");
});

test("chainHeadRecorder writes the heads file atomically and survives a damaged file", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-chain-heads-"));
  try {
    const file = join(dir, CHAIN_HEADS_FILE);
    const record = chainHeadRecorder(file);
    record(head(3, "2026-10-07T10:00:00.000Z"));
    record(head(1, "2026-10-07T10:00:00.000Z", null, "b".repeat(64)));
    const kept = readChainHeads(file);
    assert.deepEqual(Object.keys(kept.chains).sort(), [ANCHOR, "b".repeat(64)]);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).version, 1);
    writeFileSync(file, "{ not json");
    assert.deepEqual(readChainHeads(file), { version: 1, chains: {} });
    record(head(4, "2026-10-07T12:00:00.000Z"));
    assert.equal(readChainHeads(file).chains[ANCHOR][0].head.ingest_seq, 4);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
