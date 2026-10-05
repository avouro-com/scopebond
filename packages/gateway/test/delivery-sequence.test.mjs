// SB289: each queued record carries this computer's number for it, so the workspace can tell a
// record lost on the computer from one that was never made.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createCloudExporter, createMemoryCloudOutbox } from "../dist/index.js";
import { SqliteCloudOutbox } from "../dist/node.js";

const receipt = (id) => ({ payload: { action_ref: { action_id: id } }, signature: { alg: "Ed25519", sig: "fixture" } });

test("the memory outbox numbers records 1, 2, 3 in the order queued; a duplicate gets no new number", () => {
  const outbox = createMemoryCloudOutbox();
  outbox.enqueue(receipt("action:seq-0001"));
  outbox.enqueue(receipt("action:seq-0002"));
  outbox.enqueue(receipt("action:seq-0001"));
  outbox.enqueue(receipt("action:seq-0003"));
  assert.deepEqual(outbox.peek(10, Date.now()).map((e) => e.seq), [1, 2, 3]);
});

test("the durable outbox keeps numbering across restarts and after its queue empties", () => {
  const path = join(mkdtempSync(join(tmpdir(), "sb-seq-")), "outbox.db");
  let outbox = new SqliteCloudOutbox(path);
  outbox.enqueue(receipt("action:seq-0101"));
  outbox.enqueue(receipt("action:seq-0102"));
  const first = outbox.peek(10, Date.now());
  assert.deepEqual(first.map((e) => e.seq), [1, 2]);
  outbox.acknowledge(first.map(({ id, payloadHash }) => ({ id, payloadHash })));
  outbox.close();
  outbox = new SqliteCloudOutbox(path);
  outbox.enqueue(receipt("action:seq-0103"));
  assert.deepEqual(outbox.peek(10, Date.now()).map((e) => e.seq), [3], "never reused, even with nothing left in the queue");
  outbox.close();
});

test("a queue made before numbering is upgraded in place; its waiting records stay unnumbered", () => {
  const path = join(mkdtempSync(join(tmpdir(), "sb-seq-old-")), "outbox.db");
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE cloud_outbox (event_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, receipt_json TEXT NOT NULL, enqueued_at INTEGER NOT NULL, bytes INTEGER NOT NULL CHECK (bytes > 0));
    CREATE TABLE cloud_delivery_gaps (seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT, reason TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE cloud_outbox_metadata (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), total_gaps INTEGER NOT NULL CHECK (total_gaps >= 0));
    INSERT INTO cloud_outbox_metadata VALUES (1, 0);
  `);
  db.prepare("INSERT INTO cloud_outbox VALUES (?, ?, ?, ?, ?)").run("action:seq-old-0001", "h", JSON.stringify(receipt("action:seq-old-0001")), Date.now(), 10);
  db.close();
  const outbox = new SqliteCloudOutbox(path);
  outbox.enqueue(receipt("action:seq-new-0001"));
  const entries = outbox.peek(10, Date.now());
  assert.equal(entries.find((e) => e.id === "action:seq-old-0001").seq, undefined);
  assert.equal(entries.find((e) => e.id === "action:seq-new-0001").seq, 1);
  outbox.close();
});

test("the exporter sends each record's number beside it, and nothing extra for unnumbered records", async () => {
  const bodies = [];
  const fetchImpl = async (_url, init) => { bodies.push(JSON.parse(init.body)); return new Response(JSON.stringify({ ok: true }), { status: 200 }); };
  const outbox = createMemoryCloudOutbox();
  const ex = createCloudExporter({ url: "https://cloud.example", credential: "sbm_x", outbox, flushMs: 1e9, fetch: fetchImpl });
  ex.enqueue(receipt("action:seq-x-0001"));
  ex.enqueue(receipt("action:seq-x-0002"));
  await ex.flush();
  ex.stop();
  assert.equal(bodies[0].receipts.length, 2);
  assert.deepEqual(bodies[0].seq, [1, 2]);
  const legacy = { peek: () => [{ id: "a", payloadHash: "h", receipt: receipt("a"), enqueuedAt: 0, bytes: 1 }], acknowledge() {}, enqueue: () => ({ queued: true, duplicate: false }), status: () => ({ pending: 0 }) };
  const bodies2 = [];
  const ex2 = createCloudExporter({ url: "https://cloud.example", credential: "sbm_x", outbox: { ...legacy, peek: (() => { let once = true; return () => (once ? (once = false, legacy.peek()) : []); })() }, flushMs: 1e9, fetch: async (_u, init) => { bodies2.push(JSON.parse(init.body)); return new Response("{}", { status: 200 }); } });
  await ex2.flush();
  ex2.stop();
  assert.equal("seq" in bodies2[0], false);
});
