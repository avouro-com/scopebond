// The replay check answers from an index of the request and approval ids receipts carry, written with each receipt in
// the same transaction (by any writer, an older version too), so a decision does not read the receipts of the replay
// window. A store made before the index reads those receipts only while the window still reaches back before the index
// existed; retention removes old index rows with the other finished authority records.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { SqliteReceiptStore } from "../dist/node.js";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), "sb-replay-index-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A receipt as the gateway stores it, with the ids it names. */
function receipt({ at = Date.now(), requestId = null, approvalId = null, actionId = randomUUID() } = {}) {
  const authorization = {};
  if (requestId) authorization.agent = { kid: "agent-1", request_id: requestId };
  if (approvalId) authorization.approval = { approval_id: approvalId };
  return {
    payload: {
      action_ref: { action_id: actionId }, timestamp: new Date(at).toISOString(), intent_hash: "h", policy_hash: "p",
      realtime_result: "allow", executed: false, authorization,
    },
    signature: "s",
  };
}

const sinceWindow = (now = Date.now()) => new Date(now - 65 * MINUTE).toISOString();
const one = (db, sql, ...args) => Object.values(db.prepare(sql).get(...args) ?? {})[0];

/** The tables an earlier version made, without the index, holding `receipts`. */
function olderStore(path, receipts) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE receipts (id INTEGER PRIMARY KEY AUTOINCREMENT, intent_hash TEXT NOT NULL, policy_hash TEXT NOT NULL,
      realtime_result TEXT NOT NULL, executed INTEGER NOT NULL, timestamp TEXT NOT NULL, receipt_json TEXT NOT NULL, action_id TEXT);
    CREATE TABLE store_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
    INSERT INTO store_metadata VALUES ('layout', '2');
    CREATE INDEX receipts_timestamp ON receipts (timestamp);`);
  for (const r of receipts) insertRaw(db, r);
  db.close();
}

/** Insert a receipt the way a writer that knows nothing of the index does. */
function insertRaw(db, r) {
  db.prepare("INSERT INTO receipts (intent_hash,policy_hash,realtime_result,executed,timestamp,receipt_json,action_id) VALUES ('h','p','allow',0,?,?,?)")
    .run(r.payload.timestamp, JSON.stringify(r), r.payload.action_ref.action_id);
}

test("a request or approval id a receipt names is refused by one indexed lookup, whoever wrote the receipt", () => {
  const { dir, cleanup } = tmp();
  try {
    const path = join(dir, "receipts.db");
    const store = new SqliteReceiptStore(path);
    try {
      store.put(receipt({ requestId: "req-put", approvalId: "appr-put" }));
      // Another process (an older version) writing straight into the table: the index row comes with its receipt.
      const other = new DatabaseSync(path);
      try { insertRaw(other, receipt({ requestId: "req-raw" })); } finally { other.close(); }
      const since = sinceWindow();
      assert.equal(store.authorizationUsed("request_id", "req-put", since), true);
      assert.equal(store.authorizationUsed("approval_id", "appr-put", since), true);
      assert.equal(store.authorizationUsed("request_id", "req-raw", since), true);
      assert.equal(store.authorizationUsed("request_id", "appr-put", since), false, "the kinds are kept apart");
      assert.equal(store.authorizationUsed("request_id", "req-never", since), false);
    } finally { store.close(); }
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(one(db, "SELECT COUNT(*) FROM authorization_ids"), 3);
      assert.equal(one(db, "SELECT action_id FROM authorization_ids WHERE kind = 'request_id' AND value = 'req-put'") !== null, true);
    } finally { db.close(); }
  } finally { cleanup(); }
});

test("an id seen is refused for as long as its index row is kept, also after the replay window", () => {
  const { dir, cleanup } = tmp();
  try {
    const store = new SqliteReceiptStore(join(dir, "receipts.db"));
    try {
      store.put(receipt({ at: Date.now() - 3 * 60 * MINUTE, requestId: "req-old" }));
      assert.equal(store.authorizationUsed("request_id", "req-old", sinceWindow()), true);
    } finally { store.close(); }
  } finally { cleanup(); }
});

test("a store made before the index reads the receipts of the window only until the index covers it", () => {
  const { dir, cleanup } = tmp();
  try {
    const path = join(dir, "receipts.db");
    olderStore(path, [receipt({ at: Date.now() - 10 * MINUTE, requestId: "req-before-index" })]);
    let store = new SqliteReceiptStore(path);
    try {
      // The receipt has no index row, and is still found: the window reaches back before the index existed.
      assert.equal(store.authorizationUsed("request_id", "req-before-index", sinceWindow()), true);
      store.put(receipt({ requestId: "req-after-index" }));
      assert.equal(store.authorizationUsed("request_id", "req-after-index", sinceWindow()), true);
    } finally { store.close(); }
    const db = new DatabaseSync(path);
    let made;
    try {
      made = Date.parse(one(db, "SELECT value FROM store_metadata WHERE key = 'authorization_ids_since'"));
      assert.ok(Math.abs(made - Date.now()) < 5 * MINUTE, "the index records when it was made");
      assert.equal(one(db, "SELECT COUNT(*) FROM authorization_ids WHERE value = 'req-before-index'"), 0, "older receipts are not rewritten on open");
    } finally { db.close(); }
    // Two hours later the window starts after the index was made: only the index is read.
    store = new SqliteReceiptStore(path);
    try {
      assert.equal(store.authorizationUsed("request_id", "req-before-index", sinceWindow(made + 2 * 60 * MINUTE)), false, "the receipts are not read");
      assert.equal(store.authorizationUsed("request_id", "req-after-index", sinceWindow(made + 2 * 60 * MINUTE)), true);
      // A window that starts before the index was made is still answered from the receipts too.
      assert.equal(store.authorizationUsed("request_id", "req-before-index", sinceWindow(made)), true);
    } finally { store.close(); }
  } finally { cleanup(); }
});

test("a new store indexes every receipt from the first and never reads the receipts for the replay check", () => {
  const { dir, cleanup } = tmp();
  try {
    const path = join(dir, "receipts.db");
    const store = new SqliteReceiptStore(path);
    try {
      store.put(receipt({ requestId: "req-fresh" }));
      const db = new DatabaseSync(path);
      try {
        assert.equal(Date.parse(one(db, "SELECT value FROM store_metadata WHERE key = 'authorization_ids_since'")), 0);
        db.prepare("DELETE FROM authorization_ids WHERE value = 'req-fresh'").run(); // only to show the receipts are not read
      } finally { db.close(); }
      assert.equal(store.authorizationUsed("request_id", "req-fresh", sinceWindow()), false);
    } finally { store.close(); }
  } finally { cleanup(); }
});

test("retention removes index rows older than the authority records it keeps, never one of the last day", () => {
  const { dir, cleanup } = tmp();
  try {
    const path = join(dir, "receipts.db");
    const now = Date.now();
    const store = new SqliteReceiptStore(path);
    try {
      store.put(receipt({ at: now - 10 * DAY, requestId: "req-10d" }));
      store.put(receipt({ at: now - 3 * DAY, requestId: "req-3d" }));
      store.put(receipt({ at: now - 2 * MINUTE, requestId: "req-now" }));
      store.maintain({ now });
      assert.equal(store.authorizationUsed("request_id", "req-10d", sinceWindow(now)), false, "past the seven days authority records are kept");
      assert.equal(store.authorizationUsed("request_id", "req-3d", sinceWindow(now)), true);
      store.removeBefore(new Date(now).toISOString());
      assert.equal(store.authorizationUsed("request_id", "req-3d", sinceWindow(now)), false);
      assert.equal(store.authorizationUsed("request_id", "req-now", sinceWindow(now)), true, "the last day keeps its replay protection");
    } finally { store.close(); }
  } finally { cleanup(); }
});

test("a later use of an id keeps its index row as long as the later receipt", () => {
  const { dir, cleanup } = tmp();
  try {
    const now = Date.now();
    const store = new SqliteReceiptStore(join(dir, "receipts.db"));
    try {
      store.put(receipt({ at: now - 10 * DAY, requestId: "req-again" }));
      store.put(receipt({ at: now - DAY, requestId: "req-again" }));
      store.maintain({ now });
      assert.equal(store.authorizationUsed("request_id", "req-again", sinceWindow(now)), true);
    } finally { store.close(); }
  } finally { cleanup(); }
});
