// The local SQLite store keeps each policy once, each receipt once and nothing it no longer needs (layout 2), rewrites an
// older file in bounded steps, removes receipts only after the workspace acknowledged them, and answers the replay check
// with one lookup instead of reading the whole log.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createGateway, StaticPrincipalKeyRegistry } from "../dist/index.js";
import { SqliteReceiptStore, SqliteCloudOutbox } from "../dist/node.js";
import { createSigner } from "@scopebond/sdk";

const policy = {
  vocabulary_version: "1.0", policy_id: "layout", version: 1,
  clauses: [{ id: "cap", type: "spend_limit", mode: "enforce", asset: "USDC", max_per_action: 1000000 }],
};
const DAY = 24 * 60 * 60 * 1000;

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), "sb-layout-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function signedGateway(store, now = () => new Date().toISOString()) {
  const agent = createSigner();
  const keys = new StaticPrincipalKeyRegistry([{ kid: agent.kid, publicKeyPem: agent.publicKeyPem, purposes: ["agent"], status: "active" }]);
  const gateway = createGateway({ authentication: { keys }, policy, now, mode: "check_only", store });
  const act = async (amount, requestId) => {
    const signed = agent.sign({ action_type: "payout.create", asset: "USDC", amount }, requestId ? { requestId, issuedAt: now() } : { issuedAt: now() });
    return gateway.check({ intent: signed.intent, authorization: signed.authorization });
  };
  return { gateway, agent, act };
}

const one = (db, sql, ...args) => Object.values(db.prepare(sql).get(...args) ?? {})[0];

test("a new store keeps each policy once, each receipt once, and no lifecycle row for a finished check", async () => {
  const { dir, cleanup } = tmp();
  try {
    const path = join(dir, "receipts.db");
    const store = new SqliteReceiptStore(path);
    const { act } = signedGateway(store);
    const ids = [];
    for (const amount of [100, 200, 2_000_000]) ids.push((await act(amount)).receipt.payload.action_ref.action_id);
    store.close();

    const db = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(one(db, "PRAGMA page_size"), 8192, "8 KB pages hold four receipts");
      assert.equal(one(db, "PRAGMA auto_vacuum"), 2, "incremental vacuum");
      assert.equal(one(db, "SELECT COUNT(*) FROM policy_snapshots"), 1, "the policy is stored once");
      assert.equal(one(db, "SELECT COUNT(*) FROM authority_actions WHERE policy_snapshot NOT LIKE 'policy-ref:sha256:%'"), 0);
      assert.equal(one(db, "SELECT COUNT(*) FROM authority_lifecycle"), 0, "a finished check keeps no lifecycle row");
      assert.equal(one(db, "SELECT COUNT(*) FROM authority_actions WHERE candidate_json <> '{}'"), 0, "nor a candidate copy");
      assert.equal(one(db, "SELECT COUNT(*) FROM receipts"), 3);
      assert.equal(one(db, "SELECT COUNT(*) FROM receipts WHERE action_id IS NULL"), 0, "each receipt names its action");
    } finally { db.close(); }

    const reopened = new SqliteReceiptStore(path);
    try {
      const record = reopened.getAction(ids[2]);
      assert.equal(record.state, "denied");
      assert.equal(record.terminal_receipt.payload.action_ref.action_id, ids[2], "the receipt is found through its row id");
      assert.equal(record.realtime_result, "deny", "the result comes from the receipt");
      assert.deepEqual(JSON.parse(record.reservation.policy_snapshot), policy, "the policy resolves from its digest");
    } finally { reopened.close(); }
  } finally { cleanup(); }
});

test("a reused request id is refused by one lookup, also for a receipt written without a reservation", async () => {
  const { dir, cleanup } = tmp();
  try {
    const store = new SqliteReceiptStore(join(dir, "receipts.db"));
    const { act } = signedGateway(store);
    const first = await act(100, "req:layout-replay-0001");
    assert.equal(first.allowed, true, first.reason);
    await assert.rejects(() => act(100, "req:layout-replay-0001"), /request_id has already been used/);

    // A receipt that reached the log by `put` (no authority row) is still seen inside the authorization's lifetime.
    const since = new Date(Date.now() - 60_000).toISOString();
    assert.equal(store.authorizationUsed("request_id", "req:layout-replay-0001", since), true);
    store.put({ ...first.receipt, payload: { ...first.receipt.payload, authorization: { ...first.receipt.payload.authorization, agent: { ...first.receipt.payload.authorization.agent, request_id: "req:put-only-0001" } } } });
    assert.equal(store.authorizationUsed("request_id", "req:put-only-0001", since), true);
    assert.equal(store.authorizationUsed("request_id", "req:never-used-0001", since), false);
    store.close();
  } finally { cleanup(); }
});

/** A layout-1 file: the policy inline in every action and in its reservation, the receipt in the lifecycle row too. */
function legacyStore(path, actions, at) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE receipts (id INTEGER PRIMARY KEY AUTOINCREMENT, intent_hash TEXT NOT NULL, policy_hash TEXT NOT NULL,
      realtime_result TEXT NOT NULL, executed INTEGER NOT NULL, timestamp TEXT NOT NULL, receipt_json TEXT NOT NULL);
    CREATE TABLE anchors (seq INTEGER PRIMARY KEY, anchor_json TEXT NOT NULL);
    CREATE TABLE authority_actions (action_id TEXT PRIMARY KEY, state TEXT NOT NULL, candidate_json TEXT NOT NULL,
      policy_ref_json TEXT NOT NULL, policy_snapshot TEXT NOT NULL);
    CREATE TABLE authority_consumptions (kind TEXT NOT NULL, value TEXT NOT NULL, action_id TEXT NOT NULL, PRIMARY KEY (kind, value));
    CREATE TABLE authority_lifecycle (action_id TEXT PRIMARY KEY, reservation_json TEXT NOT NULL, realtime_result TEXT,
      adapter_id TEXT, pre_receipt_json TEXT, terminal_receipt_json TEXT);
    CREATE TABLE gateway_stops (target TEXT PRIMARY KEY, stopped INTEGER NOT NULL);
    CREATE INDEX receipts_timestamp ON receipts (timestamp);`);
  const text = JSON.stringify(policy);
  for (let i = 0; i < actions; i++) {
    const id = `legacy-${i}`;
    const timestamp = new Date(at - (actions - i) * 1000).toISOString();
    const receipt = JSON.stringify({ payload: { action_ref: { action_id: id }, timestamp, realtime_result: "allow", intent_hash: "h", policy_hash: "p", executed: false, authorization: { agent: { request_id: id } } }, signature: "s" });
    const candidate = JSON.stringify({ action_id: id, timestamp, intent: { action_type: "payout.create" } });
    db.prepare("INSERT INTO receipts (intent_hash,policy_hash,realtime_result,executed,timestamp,receipt_json) VALUES ('h','p','allow',0,?,?)").run(timestamp, receipt);
    db.prepare("INSERT INTO authority_actions VALUES (?,?,?,?,?)").run(id, "cooperative_allow", candidate, "{}", text);
    db.prepare("INSERT INTO authority_consumptions VALUES ('request_id',?,?)").run(id, id);
    db.prepare("INSERT INTO authority_lifecycle (action_id,reservation_json,realtime_result,terminal_receipt_json) VALUES (?,?,?,?)")
      .run(id, JSON.stringify({ action_id: id, candidate: JSON.parse(candidate), policy_ref: {}, policy_snapshot: text }), "allow", receipt);
  }
  db.close();
}

test("an older file is rewritten in bounded steps and keeps every receipt", () => {
  const { dir, cleanup } = tmp();
  try {
    const path = join(dir, "receipts.db");
    legacyStore(path, 120, Date.now());
    const store = new SqliteReceiptStore(path);
    assert.equal(store.layoutCurrent(), false);
    const first = store.maintain({ batch: 50, budgetMs: 0 });
    assert.ok(first.migrated > 0 && first.migrated <= 150, `one step of at most a batch per kind (${first.migrated})`);
    assert.equal(first.more, true);
    let report = first;
    for (let i = 0; i < 20 && report.more; i++) report = store.maintain({ batch: 50, allowFullVacuum: true });
    assert.equal(report.layoutCurrent, true);
    assert.equal(store.count(), 120, "no receipt was removed");
    assert.equal(store.authorizationUsed("request_id", "legacy-3", new Date(0).toISOString()), true, "consumed ids are kept");
    store.close();
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(one(db, "SELECT COUNT(*) FROM policy_snapshots"), 1);
      assert.equal(one(db, "SELECT COUNT(*) FROM authority_lifecycle"), 0);
      assert.equal(one(db, "SELECT COUNT(*) FROM receipts WHERE action_id IS NULL"), 0);
      assert.equal(one(db, "PRAGMA auto_vacuum"), 2, "the full rewrite switched on incremental vacuum");
    } finally { db.close(); }
  } finally { cleanup(); }
});

test("retention removes only receipts the workspace acknowledged before the window, never in an anchored log", () => {
  const { dir, cleanup } = tmp();
  try {
    const now = Date.now();
    const path = join(dir, "receipts.db");
    const outboxPath = join(dir, "receipts.db.cloud-outbox.db");
    legacyStore(path, 10, now - 40 * DAY); // ten receipts recorded 40 days ago
    const outbox = new SqliteCloudOutbox(outboxPath, { now: () => now - 35 * DAY });
    outbox.markAcknowledged(["legacy-0", "legacy-1", "legacy-2"]); // acknowledged 35 days ago
    outbox.close();
    const fresh = new SqliteCloudOutbox(outboxPath, { now: () => now - 2 * DAY });
    fresh.markAcknowledged(["legacy-3"]); // acknowledged recently: kept for the window
    fresh.close();

    const store = new SqliteReceiptStore(path);
    const keep = store.maintain({ now, outboxPath });
    assert.equal(keep.receiptsKept, "no_retention", "no window, nothing removed");
    assert.equal(keep.stateRemoved, 10, "finished check records older than a week go");
    assert.equal(store.count(), 10);
    assert.equal(store.maintain({ now, retainAcknowledgedMs: 30 * DAY }).receiptsKept, "no_delivery_queue");
    const report = store.maintain({ now, retainAcknowledgedMs: 30 * DAY, outboxPath });
    assert.equal(report.receiptsRemoved, 3, "three acknowledged more than 30 days ago");
    assert.equal(store.count(), 7, "the unacknowledged and the recently acknowledged stay");

    store.putAnchor({ seq: 1, root: "r" });
    const anchored = store.maintain({ now: now + 400 * DAY, retainAcknowledgedMs: 30 * DAY, outboxPath });
    assert.equal(anchored.receiptsKept, "anchored");
    assert.equal(store.count(), 7);
    store.close();
  } finally { cleanup(); }
});

test("a record the workspace refused is never recorded as held, so retention keeps it (review finding 1)", async () => {
  const { dir, cleanup } = tmp();
  try {
    const { createCloudExporter } = await import("../dist/index.js");
    const path = join(dir, "outbox.db");
    const outbox = new SqliteCloudOutbox(path);
    const receipt = (id) => ({ payload: { action_ref: { action_id: id }, attester: { kid: "k1" }, timestamp: new Date().toISOString() }, signature: "s" });
    // The workspace stores "good" and refuses "bad" on its own (invalid_receipt), in one 200 answer.
    const fetch = async (_url, init) => {
      const index = JSON.parse(init.body).receipts.findIndex((r) => r.payload.action_ref.action_id === "bad");
      return new Response(JSON.stringify({ accepted: 1, rejected: [{ index, code: "invalid_receipt" }] }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const exporter = createCloudExporter({ url: "https://cloud.example/", credential: "sbm_x", outbox, batchSize: 10, flushMs: 1e9, fetch });
    exporter.enqueue(receipt("good")); exporter.enqueue(receipt("bad"));
    await exporter.flush();
    exporter.stop();
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      assert.deepEqual(db.prepare("SELECT event_id FROM cloud_acknowledged ORDER BY event_id").all().map((r) => r.event_id), ["good"]);
      assert.equal(one(db, "SELECT COUNT(*) FROM cloud_outbox"), 0, "both left the queue");
    } finally { db.close(); }
  } finally { cleanup(); }
});

test("a rolled-back action never leaves later actions pointing at a missing policy (review finding 2)", async () => {
  const { dir, cleanup } = tmp();
  try {
    const path = join(dir, "receipts.db");
    const store = new SqliteReceiptStore(path);
    const reservation = (id) => ({ action_id: id, candidate: { action_id: id, timestamp: new Date().toISOString() }, policy_ref: { id: "layout", version: 1, digest: "d" }, policy_snapshot: JSON.stringify(policy), authorization_ids: {} });
    assert.throws(() => store.reserveAction(reservation("a1"), () => { throw new Error("decision failed"); }));
    const second = store.reserveAction(reservation("a2"), () => ({ allow: true }));
    assert.equal(second.duplicate, false);
    assert.deepEqual(JSON.parse(store.getAction("a2").reservation.policy_snapshot), policy);
    assert.equal(store.unresolvedActions().length, 1);
    store.close();
  } finally { cleanup(); }
});

test("a migrated finished action still finds its final receipt (review finding 3)", () => {
  const { dir, cleanup } = tmp();
  try {
    const path = join(dir, "receipts.db");
    legacyStore(path, 6, Date.now());
    const store = new SqliteReceiptStore(path);
    for (let i = 0; i < 10 && !store.layoutCurrent(); i++) store.maintain({ batch: 4 });
    assert.equal(store.layoutCurrent(), true);
    const record = store.getAction("legacy-2");
    assert.equal(record.terminal_receipt?.payload.action_ref.action_id, "legacy-2");
    assert.equal(record.realtime_result, "allow");
    store.close();
  } finally { cleanup(); }
});

test("upkeep with a short lock wait gives up quickly when another process holds the file (review finding 4)", () => {
  const { dir, cleanup } = tmp();
  try {
    const path = join(dir, "receipts.db");
    new SqliteReceiptStore(path).close();
    const holder = new DatabaseSync(path);
    holder.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE;");
    try {
      const started = Date.now();
      const store = new SqliteReceiptStore(path, { busyTimeoutMs: 100 });
      assert.throws(() => store.maintain({ now: Date.now(), budgetMs: 0 }), /locked|busy/i);
      store.close();
      assert.ok(Date.now() - started < 3_000, `waited ${Date.now() - started} ms`);
    } finally { holder.exec("ROLLBACK"); holder.close(); }
  } finally { cleanup(); }
});

test("the queue keeps its totals, records acknowledgements, and status() corrects a wrong total", () => {
  const { dir, cleanup } = tmp();
  try {
    const path = join(dir, "outbox.db");
    const outbox = new SqliteCloudOutbox(path);
    const receipt = (id) => ({ payload: { action_ref: { action_id: id }, attester: { kid: "k1" } }, signature: "s" });
    for (const id of ["a", "b", "c"]) outbox.enqueue(receipt(id));
    assert.equal(outbox.pendingCount(), 3);
    const [first] = outbox.peek(1, Date.now());
    outbox.acknowledge([{ id: first.id, payloadHash: first.payloadHash }], new Set([first.id]));
    assert.equal(outbox.pendingCount(), 2);
    assert.equal(outbox.status().pending, 2);
    outbox.close();

    const db = new DatabaseSync(path);
    assert.equal(one(db, "SELECT COUNT(*) FROM cloud_acknowledged WHERE event_id = ?", first.id), 1);
    db.prepare("UPDATE cloud_outbox_metadata SET pending_count = 99").run(); // as an older version could leave it
    db.close();
    const again = new SqliteCloudOutbox(path);
    assert.equal(again.status().pending, 2);
    assert.equal(again.pendingCount(), 2, "status() rewrote the kept total");
    again.close();
    assert.ok(statSync(path).size > 0);
  } finally { cleanup(); }
});
