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

test("several processes opening the same old queue at once all succeed (the column is added once)", async () => {
  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const path = join(mkdtempSync(join(tmpdir(), "sb-seq-race-")), "outbox.db");
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE cloud_outbox (event_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, receipt_json TEXT NOT NULL, enqueued_at INTEGER NOT NULL, bytes INTEGER NOT NULL CHECK (bytes > 0));
    CREATE TABLE cloud_delivery_gaps (seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT, reason TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE cloud_outbox_metadata (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), total_gaps INTEGER NOT NULL CHECK (total_gaps >= 0));
    INSERT INTO cloud_outbox_metadata VALUES (1, 0);
  `);
  db.close();
  const nodeModule = new URL("../dist/node.js", import.meta.url).href;
  void fileURLToPath;
  const code = `import { SqliteCloudOutbox } from ${JSON.stringify(nodeModule)}; const o = new SqliteCloudOutbox(${JSON.stringify(path)}); process.stdout.write(o.status().queueId); o.close();`;
  const results = await Promise.all(Array.from({ length: 6 }, () => new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
    let err = "", out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (status) => resolve({ status, err, out }));
  })));
  for (const r of results) assert.equal(r.status, 0, r.err);
  assert.equal(new Set(results.map((r) => r.out)).size, 1, "every process reads the same queue id");
});

test("each queue has its own id, kept across restarts; the exporter names it beside the numbers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-seq-queue-"));
  let outbox = new SqliteCloudOutbox(join(dir, "outbox.db"));
  const id = outbox.status().queueId;
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.equal(outbox.status().seqAssigned, 0);
  outbox.enqueue(receipt("action:seq-q-0001"));
  outbox.enqueue(receipt("action:seq-q-0002"));
  assert.equal(outbox.status().seqAssigned, 2);
  outbox.close();
  outbox = new SqliteCloudOutbox(join(dir, "outbox.db"));
  assert.equal(outbox.status().queueId, id, "the same queue keeps its id");
  outbox.close();
  // A queue made again (the file was removed) is a different queue: numbering restarts under a new id.
  const again = new SqliteCloudOutbox(join(dir, "outbox-again.db"));
  assert.notEqual(again.status().queueId, id);
  again.close();

  const bodies = [];
  const memory = createMemoryCloudOutbox();
  const ex = createCloudExporter({ url: "https://cloud.example", credential: "sbm_x", outbox: memory, flushMs: 1e9, fetch: async (_u, init) => { bodies.push(JSON.parse(init.body)); return new Response("{}", { status: 200 }); } });
  ex.enqueue(receipt("action:seq-q-0003"));
  await ex.flush();
  ex.stop();
  assert.equal(bodies[0].queue, memory.status().queueId);
  assert.deepEqual(bodies[0].seq, [1]);
});

test("a queue that cannot be opened for writing leaves no handle behind: it opens normally once writable", async () => {
  const { chmodSync } = await import("node:fs");
  const path = join(mkdtempSync(join(tmpdir(), "sb-seq-ro-")), "outbox.db");
  new SqliteCloudOutbox(path).close();
  chmodSync(path, 0o444);
  try {
    // Writable for root on Linux: only assert the failure where the file really is read-only.
    try { new SqliteCloudOutbox(path).close(); } catch (error) { assert.match(error.message, /readonly|read-only/i); }
  } finally { chmodSync(path, 0o644); }
  const outbox = new SqliteCloudOutbox(path);
  assert.deepEqual(outbox.enqueue(receipt("action:seq-ro-0001")), { queued: true, duplicate: false });
  outbox.close();
});
