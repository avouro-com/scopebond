<<<<<<< HEAD
// What the workspace can learn about records a bounded queue could not keep. A record dropped at capacity takes a
// number before it is dropped, so the numbers the workspace sees leave a hole where it was, and the exporter reports
// the drop to its gap handler.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAttester, createGateway, createCloudExporter, createMemoryCloudOutbox, LOSSLESS_CLOUD_OUTBOX } from "../dist/index.js";
=======
// What the queue keeps about records it could not deliver: a lifetime total and a count per reason that outlive the trimmed
// gap rows, so the computer can report them to the workspace (the hook sends them on its rules check).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createAttester, createGateway, createCloudExporter, createMemoryCloudOutbox } from "../dist/index.js";
>>>>>>> origin/fix/delivery-gaps-reported
import { SqliteCloudOutbox } from "../dist/node.js";

const policy = {
  vocabulary_version: "1.0", policy_id: "gaps", version: 1,
<<<<<<< HEAD
  clauses: [{ id: "allowed", type: "action_allowlist", mode: "enforce", action_types: ["shell.exec", "git.push"] }],
};
const attester = createAttester();
async function receipts(n, from = 0) {
  const gw = createGateway({ authentication: { mode: "insecure-development" }, mode: "check_only", attester, policy });
  const out = [];
  for (let i = from; i < from + n; i++) out.push((await gw.check({ intent: { action_type: "shell.exec", params: { command: `echo ${i}`, program: "echo" } } })).receipt);
  return out;
}
/** The workspace's accounting: numbers between the lowest and highest seen that never arrived. */
function workspaceMissing(bodies) {
  const seen = new Set(bodies.flatMap((b) => (b.seq ?? []).filter((s) => s !== null)));
  if (!seen.size) return 0;
  const first = Math.min(...seen), max = Math.max(...seen);
  return Math.max(0, max - first + 1 - seen.size);
}
=======
  clauses: [{ id: "allowed", type: "action_allowlist", mode: "enforce", action_types: ["shell.exec"] }],
};
const attester = createAttester();
async function receipts(n) {
  const gw = createGateway({ authentication: { mode: "insecure-development" }, mode: "check_only", attester, policy });
  const out = [];
  for (let i = 0; i < n; i++) out.push((await gw.check({ intent: { action_type: "shell.exec", params: { command: `echo ${i}`, program: "echo" } } })).receipt);
  return out;
}
>>>>>>> origin/fix/delivery-gaps-reported
function workspace() {
  const bodies = [];
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    return { ok: true, status: 200, json: async () => ({ accepted: body.receipts.length }), text: async () => "{}", headers: new Map() };
  };
  return { bodies, fetch };
}

<<<<<<< HEAD
const outboxes = {
  sqlite: (o) => new SqliteCloudOutbox(join(mkdtempSync(join(tmpdir(), "sb-gaps-")), "o.db"), o),
  memory: (o) => createMemoryCloudOutbox(o),
};

for (const [kind, open] of Object.entries(outboxes)) {
  test(`${kind}: a record dropped at capacity takes a number, is reported, and shows as missing to the workspace`, async () => {
    const rs = await receipts(5);
    const outbox = open({ maxPending: 3 });
    const ws = workspace();
    const gaps = [];
    const exporter = createCloudExporter({ url: "https://ws.example", credential: "sbm_x", outbox, flushMs: 1e9, fetch: ws.fetch, onGap: (g) => gaps.push(g) });
    for (const r of rs) exporter.enqueue(r);
    const st = exporter.status();
    assert.equal(st.gaps, 2);
    assert.deepEqual(gaps.map((g) => g.reason), ["capacity", "capacity"]);
    assert.deepEqual(gaps.map((g) => g.seq), [4, 5], "each dropped record took the next number");
    assert.equal(st.seqAssigned, 5, "the dropped records were numbered before they were dropped");
    await exporter.flush();
    // The next record that fits carries a number past the dropped ones, so the hole is counted.
    for (const r of await receipts(1, 5)) exporter.enqueue(r);
    await exporter.flush();
    exporter.stop();
    assert.deepEqual(ws.bodies.flatMap((b) => b.seq).sort((x, y) => x - y), [1, 2, 3, 6]);
    assert.equal(workspaceMissing(ws.bodies), 2, "the workspace counts both dropped records as missing");
  });

  test(`${kind}: a lossless queue keeps more than the default cap`, async () => {
    const outbox = open(LOSSLESS_CLOUD_OUTBOX);
    const base = (await receipts(1))[0];
    for (let i = 0; i < 10_050; i++) outbox.enqueue({ ...base, payload: { ...base.payload, action_ref: { ...base.payload.action_ref, action_id: `a${i}` } } });
    const st = outbox.status();
    outbox.close?.();
    assert.equal(st.gaps, 0);
    assert.equal(st.pending, 10_050);
  });
}
=======
test("a bounded queue that drops records at capacity counts them by reason, for the lifetime of the queue", async () => {
  const rs = await receipts(5);
  const dir = mkdtempSync(join(tmpdir(), "sb-gaps-g1-"));
  try {
    const outbox = new SqliteCloudOutbox(join(dir, "o.db"), { maxPending: 3, maxGapRecords: 1 });
    const ws = workspace();
    const gaps = [];
    const exporter = createCloudExporter({ url: "https://ws.example", credential: "sbm_x", outbox, flushMs: 1e9, fetch: ws.fetch, onGap: (g) => gaps.push(g.reason) });
    for (const r of rs) exporter.enqueue(r);
    await exporter.flush();
    const st = exporter.status();
    exporter.stop();
    assert.deepEqual(gaps, ["capacity", "capacity"]);
    assert.equal(st.gaps, 2, "the lifetime total");
    assert.equal(st.retainedGapRecords, 1, "only the newest gap row is retained");
    assert.deepEqual(st.gapsByReason, { capacity: 2 }, "the count per reason covers every gap, not only the retained rows");
    // Kept across a reopen.
    const again = new SqliteCloudOutbox(join(dir, "o.db"));
    try {
      assert.deepEqual(again.status().gapsByReason, { capacity: 2 });
      assert.deepEqual(again.gapsByReason(), { capacity: 2 });
    } finally { again.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a queue made before counts by reason starts from its retained gap rows", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-gaps-old-"));
  try {
    const path = join(dir, "o.db");
    const first = new SqliteCloudOutbox(path);
    first.recordGap("action:a-0001", "rejected");
    first.recordGap("action:a-0002", "rejected");
    first.recordGap("action:a-0003", "rekeyed");
    first.close();
    // An older version had no per-reason table.
    const db = new DatabaseSync(path);
    db.exec("DROP TABLE cloud_gap_reasons");
    db.close();
    const reopened = new SqliteCloudOutbox(path);
    try {
      assert.deepEqual(reopened.status().gapsByReason, { rejected: 2, rekeyed: 1 });
      reopened.recordGap("action:a-0004", "rejected");
      assert.deepEqual(reopened.status().gapsByReason, { rejected: 3, rekeyed: 1 });
      assert.equal(reopened.status().gaps, 4);
    } finally { reopened.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the in-memory queue counts gaps by reason too", async () => {
  const rs = await receipts(3);
  const outbox = createMemoryCloudOutbox({ maxPending: 1 });
  for (const r of rs) outbox.enqueue(r);
  assert.deepEqual(outbox.status().gapsByReason, { capacity: 2 });
});

test("a queue whose write lock is held fails within its busy timeout, and records still flush once it is free", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-gaps-busy-"));
  try {
    const path = join(dir, "o.db");
    const outbox = new SqliteCloudOutbox(path, { busyTimeoutMs: 200 });
    const [r] = await receipts(1);
    const holder = new DatabaseSync(path);
    holder.exec("BEGIN IMMEDIATE");
    const started = Date.now();
    assert.throws(() => outbox.enqueue(r), /locked|busy/i);
    assert.ok(Date.now() - started < 5_000);
    holder.exec("ROLLBACK");
    holder.close();
    outbox.setBusyTimeout(15_000);
    assert.equal(outbox.enqueue(r).queued, true);
    assert.deepEqual([...outbox.known([r.payload.action_ref.action_id, "action:unknown-0001"])], [r.payload.action_ref.action_id]);
    outbox.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
>>>>>>> origin/fix/delivery-gaps-reported
