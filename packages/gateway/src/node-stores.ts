// Node-only durable ReceiptStore implementations (D40: the ReceiptStore interface
// lives in the core with an in-memory implementation; these are durable local
// implementations for the Node server. On Cloudflare, D1/KV are the edge ones.)

import { appendFileSync, readFileSync, existsSync, mkdirSync, truncateSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";
import { canonical, sha256 } from "./crypto.js";
import type { CloudDeliveryGap, CloudOutbox, CloudOutboxEntry, CloudOutboxStatus } from "./cloud.js";
import type {
  ReceiptStore, SignedReceipt, Anchor, AuthorityReservation,
  AuthorityReservationResult, AuthorityFinalState, StopState, ActionLifecycleRecord, RealtimeResult,
} from "./receipts.js";
import type { Receipt } from "@scopebond/verify";

function ensureDir(file: string): void {
  const dir = dirname(file);
  if (dir) mkdirSync(dir, { recursive: true });
}

/** Parse a JSONL log. A torn final line (a crash mid-append, so the file does not end
 *  in a newline) is not a record: it is truncated away so the log stays well formed.
 *  A corrupt line anywhere else is an error: skipping it would hide a rewritten record. */
function readJsonl<T>(file: string): T[] {
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  const items: T[] = [];
  let torn = false;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    try { items.push(JSON.parse(t) as T); }
    catch (error) {
      const isLast = lines.slice(i + 1).every((rest) => !rest.trim());
      if (!isLast || text.endsWith("\n")) throw new Error(`${file}: corrupt record on line ${i + 1}: ${(error as Error).message}`);
      torn = true;
    }
  }
  if (torn) truncateSync(file, Buffer.byteLength(text.slice(0, text.lastIndexOf("\n") + 1)));
  return items;
}

type SqliteDb = { exec(sql: string): void; prepare(sql: string): { run(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] }; close(): void };

/** Open a node:sqlite database that tolerates concurrent writers: coding agents run
 *  tool calls in parallel, so several hook processes can append at once. WAL lets
 *  readers and a writer proceed together, and busy_timeout waits for the write lock
 *  instead of failing immediately with SQLITE_BUSY. */
function openSqlite(path: string): SqliteDb {
  ensureDir(path);
  const require = createRequire(import.meta.url);
  const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (p: string) => SqliteDb };
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
  return db;
}

/** Whether this Node has the built-in `node:sqlite` module. */
function sqliteAvailable(): boolean {
  try { createRequire(import.meta.url)("node:sqlite"); return true; } catch { return false; }
}

/** Append-only JSONL receipt log: durable, dependency-free, append-only (so the
 *  record is not silently rewritten). Loads the log into memory on open. */
export class FileReceiptStore implements ReceiptStore {
  private cache: SignedReceipt[] = [];
  private anchorLog: Anchor[] = [];
  private readonly anchorFile: string;
  private readonly stopFile: string;
  private stops = new Set<string>();
  constructor(private readonly file: string) {
    ensureDir(file);
    this.anchorFile = file + ".anchors";
    this.stopFile = file + ".stops";
    if (existsSync(file)) this.cache.push(...readJsonl<SignedReceipt>(file));
    if (existsSync(this.anchorFile)) this.anchorLog.push(...readJsonl<Anchor>(this.anchorFile));
    if (existsSync(this.stopFile)) {
      for (const event of readJsonl<{ target: string; stopped: boolean }>(this.stopFile)) {
        if (event.stopped) this.stops.add(event.target); else this.stops.delete(event.target);
      }
    }
  }
  private append(file: string, line: string): void {
    appendFileSync(file, line + "\n");
  }
  put(r: SignedReceipt): void {
    const serialized = JSON.stringify(r);
    this.append(this.file, serialized);
    this.cache.push(JSON.parse(serialized) as SignedReceipt);
  }
  list(): SignedReceipt[] { return structuredClone(this.cache); }
  executed(): Receipt[] { return structuredClone(this.cache.map((r) => r.payload as unknown as Receipt)); }
  putAnchor(a: Anchor): void { this.append(this.anchorFile, JSON.stringify(a)); this.anchorLog.push(a); }
  anchors(): Anchor[] { return this.anchorLog.slice(); }
  getStopState(): StopState { return { global: this.stops.has("global"), agents: [...this.stops].filter((key) => key !== "global") }; }
  setStopped(target: "global" | string, stopped: boolean): void {
    this.append(this.stopFile, JSON.stringify({ target, stopped }));
    if (stopped) this.stops.add(target); else this.stops.delete(target);
  }
}

/** SQLite-backed receipt store using Node's built-in `node:sqlite` (no native
 *  dependency). Durable and queryable; mirrors the D1 store used at the edge. */
export class SqliteReceiptStore implements ReceiptStore {
  private readonly db: SqliteDb;
  constructor(path: string) {
    this.db = openSqlite(path);
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS receipts (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         intent_hash TEXT NOT NULL,
         policy_hash TEXT NOT NULL,
         realtime_result TEXT NOT NULL,
         executed INTEGER NOT NULL,
         timestamp TEXT NOT NULL,
         receipt_json TEXT NOT NULL
       );
       CREATE TABLE IF NOT EXISTS anchors (
         seq INTEGER PRIMARY KEY,
         anchor_json TEXT NOT NULL
       );
       CREATE TABLE IF NOT EXISTS authority_actions (
         action_id TEXT PRIMARY KEY,
         state TEXT NOT NULL,
         candidate_json TEXT NOT NULL,
         policy_ref_json TEXT NOT NULL,
         policy_snapshot TEXT NOT NULL
       );
       CREATE TABLE IF NOT EXISTS authority_consumptions (
         kind TEXT NOT NULL,
         value TEXT NOT NULL,
         action_id TEXT NOT NULL,
         PRIMARY KEY (kind, value)
       );
       CREATE TABLE IF NOT EXISTS authority_lifecycle (
         action_id TEXT PRIMARY KEY,
         reservation_json TEXT NOT NULL,
         realtime_result TEXT,
         adapter_id TEXT,
         pre_receipt_json TEXT,
         terminal_receipt_json TEXT
       );
       CREATE TABLE IF NOT EXISTS gateway_stops (
         target TEXT PRIMARY KEY,
         stopped INTEGER NOT NULL
       );`,
    );
  }
  put(r: SignedReceipt): void {
    const p = r.payload;
    this.db
      .prepare(`INSERT INTO receipts (intent_hash,policy_hash,realtime_result,executed,timestamp,receipt_json) VALUES (?,?,?,?,?,?)`)
      .run(p.intent_hash, p.policy_hash, p.realtime_result, p.executed ? 1 : 0, p.timestamp, JSON.stringify(r));
  }
  list(): SignedReceipt[] {
    const rows = this.db.prepare(`SELECT receipt_json FROM receipts ORDER BY id`).all() as { receipt_json: string }[];
    return rows.map((row) => JSON.parse(row.receipt_json) as SignedReceipt);
  }
  executed(): Receipt[] {
    const receipts = this.list().map((r) => r.payload as unknown as Receipt);
    const rows = this.db.prepare(
      `SELECT candidate_json FROM authority_actions WHERE state IN ('reserved', 'dispatching', 'outcome_unknown') ORDER BY rowid`,
    ).all() as { candidate_json: string }[];
    return [...receipts, ...rows.map((row) => JSON.parse(row.candidate_json) as Receipt)];
  }
  reserveAction<T extends { allow: boolean }>(
    reservation: AuthorityReservation,
    decide: (prior: Receipt[]) => T,
  ): AuthorityReservationResult<T> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const duplicate = this.db.prepare(`SELECT action_id FROM authority_actions WHERE action_id = ?`).all(reservation.action_id);
      if (duplicate.length > 0) {
        this.db.exec("ROLLBACK");
        return { duplicate: true };
      }
      for (const [kind, value] of Object.entries(reservation.authorization_ids ?? {})) {
        if (!value) continue;
        const consumed = this.db.prepare(
          `SELECT action_id FROM authority_consumptions WHERE kind = ? AND value = ?`,
        ).all(kind, value);
        if (consumed.length > 0) {
          this.db.exec("ROLLBACK");
          return { duplicate: true };
        }
      }
      const decision = decide(this.executed());
      this.db.prepare(
        `INSERT INTO authority_actions (action_id,state,candidate_json,policy_ref_json,policy_snapshot) VALUES (?,?,?,?,?)`,
      ).run(
        reservation.action_id,
        decision.allow ? "reserved" : "denied",
        JSON.stringify(reservation.candidate),
        JSON.stringify(reservation.policy_ref),
         reservation.policy_snapshot,
       );
      for (const [kind, value] of Object.entries(reservation.authorization_ids ?? {})) {
        if (value) this.db.prepare(
          `INSERT INTO authority_consumptions (kind,value,action_id) VALUES (?,?,?)`,
        ).run(kind, value, reservation.action_id);
      }
      const realtimeResult = "realtime_result" in decision ? decision.realtime_result as RealtimeResult : null;
      this.db.prepare(
        `INSERT INTO authority_lifecycle (action_id,reservation_json,realtime_result) VALUES (?,?,?)`,
      ).run(reservation.action_id, JSON.stringify(reservation), realtimeResult);
      this.db.exec("COMMIT");
      return { duplicate: false, decision };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  prepareDispatch(actionId: string, receipt: SignedReceipt, adapterId: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db.prepare(`SELECT state FROM authority_actions WHERE action_id = ?`).all(actionId) as { state: string }[];
      if (rows[0]?.state !== "reserved") throw new Error(`action ${actionId} is not reserved for dispatch`);
      this.db.prepare(`UPDATE authority_actions SET state = 'dispatching' WHERE action_id = ?`).run(actionId);
      this.db.prepare(
        `UPDATE authority_lifecycle SET adapter_id = ?, pre_receipt_json = ? WHERE action_id = ?`,
      ).run(adapterId, JSON.stringify(receipt), actionId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  finalizeAction(actionId: string, receipt: SignedReceipt, state: AuthorityFinalState): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db.prepare(`SELECT action_id FROM authority_actions WHERE action_id = ?`).all(actionId);
      if (rows.length === 0) throw new Error(`unknown authority reservation ${actionId}`);
      const p = receipt.payload;
      this.db
        .prepare(`INSERT INTO receipts (intent_hash,policy_hash,realtime_result,executed,timestamp,receipt_json) VALUES (?,?,?,?,?,?)`)
        .run(p.intent_hash, p.policy_hash, p.realtime_result, p.executed ? 1 : 0, p.timestamp, JSON.stringify(receipt));
      this.db.prepare(`UPDATE authority_actions SET state = ? WHERE action_id = ?`).run(state, actionId);
      this.db.prepare(
        `UPDATE authority_lifecycle SET terminal_receipt_json = ? WHERE action_id = ?`,
      ).run(JSON.stringify(receipt), actionId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  getAction(actionId: string): ActionLifecycleRecord | null {
    const rows = this.db.prepare(
      `SELECT a.action_id,a.state,a.candidate_json,a.policy_ref_json,a.policy_snapshot,
              l.reservation_json,l.realtime_result,l.adapter_id,l.pre_receipt_json,l.terminal_receipt_json
         FROM authority_actions a LEFT JOIN authority_lifecycle l ON l.action_id = a.action_id
        WHERE a.action_id = ?`,
    ).all(actionId) as LifecycleRow[];
    return rows[0] ? rowToLifecycle(rows[0]) : null;
  }
  unresolvedActions(): ActionLifecycleRecord[] {
    const rows = this.db.prepare(
      `SELECT a.action_id,a.state,a.candidate_json,a.policy_ref_json,a.policy_snapshot,
              l.reservation_json,l.realtime_result,l.adapter_id,l.pre_receipt_json,l.terminal_receipt_json
         FROM authority_actions a LEFT JOIN authority_lifecycle l ON l.action_id = a.action_id
        WHERE a.state IN ('reserved','dispatching','outcome_unknown') ORDER BY a.rowid`,
    ).all() as LifecycleRow[];
    return rows.map(rowToLifecycle);
  }
  getStopState(): StopState {
    const rows = this.db.prepare(`SELECT target FROM gateway_stops WHERE stopped = 1 ORDER BY target`).all() as { target: string }[];
    const targets = rows.map((row) => row.target);
    return { global: targets.includes("global"), agents: targets.filter((target) => target !== "global") };
  }
  setStopped(target: "global" | string, stopped: boolean): void {
    this.db.prepare(
      `INSERT INTO gateway_stops (target, stopped) VALUES (?, ?) ON CONFLICT(target) DO UPDATE SET stopped = excluded.stopped`,
    ).run(target, stopped ? 1 : 0);
  }
  putAnchor(a: Anchor): void {
    this.db.prepare(`INSERT OR REPLACE INTO anchors (seq, anchor_json) VALUES (?, ?)`).run(a.seq, JSON.stringify(a));
  }
  anchors(): Anchor[] {
    const rows = this.db.prepare(`SELECT anchor_json FROM anchors ORDER BY seq`).all() as { anchor_json: string }[];
    return rows.map((row) => JSON.parse(row.anchor_json) as Anchor);
  }
  close(): void { this.db.close(); }
}

interface LifecycleRow {
  action_id: string;
  state: ActionLifecycleRecord["state"];
  candidate_json: string;
  policy_ref_json: string;
  policy_snapshot: string;
  reservation_json: string | null;
  realtime_result: RealtimeResult | null;
  adapter_id: string | null;
  pre_receipt_json: string | null;
  terminal_receipt_json: string | null;
}

function rowToLifecycle(row: LifecycleRow): ActionLifecycleRecord {
  const reservation = row.reservation_json
    ? JSON.parse(row.reservation_json) as AuthorityReservation
    : {
        action_id: row.action_id,
        candidate: JSON.parse(row.candidate_json) as Receipt,
        policy_ref: JSON.parse(row.policy_ref_json),
        policy_snapshot: row.policy_snapshot,
      };
  return {
    action_id: row.action_id,
    state: row.state,
    reservation,
    realtime_result: row.realtime_result,
    adapter_id: row.adapter_id,
    pre_receipt: row.pre_receipt_json ? JSON.parse(row.pre_receipt_json) as SignedReceipt : null,
    terminal_receipt: row.terminal_receipt_json ? JSON.parse(row.terminal_receipt_json) as SignedReceipt : null,
  };
}

/** Open a durable store: SQLite when `db` is given, otherwise the append-only file.
 *  Only a Node without `node:sqlite` falls back to a JSONL file, placed beside the
 *  requested database (never in the current directory, where it could be committed
 *  or missed by `verify`). A database that exists but cannot be opened — locked,
 *  corrupt, unwritable — is an error, not a silent switch to a different log. */
export function openReceiptStore(opts: { db?: string; file?: string }): { store: ReceiptStore; kind: "sqlite" | "file"; path: string } {
  if (opts.db) {
    if (sqliteAvailable()) return { store: new SqliteReceiptStore(opts.db), kind: "sqlite", path: opts.db };
    const beside = opts.file ?? opts.db.replace(/\.db$/i, "") + ".jsonl";
    return { store: new FileReceiptStore(beside), kind: "file", path: beside };
  }
  const file = opts.file ?? "scopebond-receipts.jsonl";
  return { store: new FileReceiptStore(file), kind: "file", path: file };
}

export interface SqliteCloudOutboxOptions {
  maxPending?: number;
  maxBytes?: number;
  maxAgeMs?: number;
  maxGapRecords?: number;
  now?: () => number;
}

/** Durable, bounded Cloud delivery queue. Rejections and expiry are retained as
 * explicit gap rows so a local receipt never disappears without evidence. */
export class SqliteCloudOutbox implements CloudOutbox {
  private readonly db: SqliteDb;
  private readonly maxPending: number;
  private readonly maxBytes: number;
  private readonly maxAgeMs: number;
  private readonly maxGapRecords: number;
  private readonly now: () => number;

  constructor(path: string, options: SqliteCloudOutboxOptions = {}) {
    this.db = openSqlite(path);
    this.maxPending = positiveInteger(options.maxPending, 10_000);
    this.maxBytes = positiveInteger(options.maxBytes, 64 * 1024 * 1024);
    this.maxAgeMs = positiveInteger(options.maxAgeMs, 7 * 24 * 60 * 60 * 1000);
    this.maxGapRecords = positiveInteger(options.maxGapRecords, 10_000);
    this.now = options.now ?? Date.now;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cloud_outbox (
        event_id TEXT PRIMARY KEY,
        payload_hash TEXT NOT NULL,
        receipt_json TEXT NOT NULL,
        enqueued_at INTEGER NOT NULL,
        bytes INTEGER NOT NULL CHECK (bytes > 0)
      );
      CREATE INDEX IF NOT EXISTS cloud_outbox_order ON cloud_outbox (enqueued_at, event_id);
      CREATE TABLE IF NOT EXISTS cloud_delivery_gaps (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cloud_outbox_metadata (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        total_gaps INTEGER NOT NULL CHECK (total_gaps >= 0)
      );
      INSERT OR IGNORE INTO cloud_outbox_metadata (singleton, total_gaps)
        SELECT 1, COUNT(*) FROM cloud_delivery_gaps;
    `);
  }

  enqueue(receipt: SignedReceipt): { queued: boolean; duplicate: boolean; gap?: CloudDeliveryGap } {
    const at = this.now();
    const id = receipt.payload.action_ref?.action_id;
    if (!id) return { queued: false, duplicate: false, gap: this.gap(null, "missing_action_id", at) };
    const receiptJson = canonical(receipt);
    const payloadHash = sha256(receiptJson);
    const bytes = Buffer.byteLength(receiptJson);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.expire(at);
      const existing = this.db.prepare(
        "SELECT payload_hash FROM cloud_outbox WHERE event_id = ?",
      ).all(id) as { payload_hash: string }[];
      if (existing[0]) {
        if (existing[0].payload_hash === payloadHash) {
          this.db.exec("COMMIT");
          return { queued: true, duplicate: true };
        }
        const gap = this.gap(id, "id_conflict", at);
        this.db.exec("COMMIT");
        return { queued: false, duplicate: false, gap };
      }
      const totals = this.db.prepare(
        "SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes FROM cloud_outbox",
      ).all() as Array<{ count: number; bytes: number }>;
      if ((totals[0]?.count ?? 0) >= this.maxPending || (totals[0]?.bytes ?? 0) + bytes > this.maxBytes) {
        const gap = this.gap(id, "capacity", at);
        this.db.exec("COMMIT");
        return { queued: false, duplicate: false, gap };
      }
      this.db.prepare(
        "INSERT INTO cloud_outbox (event_id, payload_hash, receipt_json, enqueued_at, bytes) VALUES (?, ?, ?, ?, ?)",
      ).run(id, payloadHash, receiptJson, at, bytes);
      this.db.exec("COMMIT");
      return { queued: true, duplicate: false };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  peek(limit: number, at: number): CloudOutboxEntry[] {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.expire(at);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    const bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
    const rows = this.db.prepare(
      `SELECT event_id, payload_hash, receipt_json, enqueued_at, bytes
         FROM cloud_outbox ORDER BY enqueued_at, event_id LIMIT ?`,
    ).all(bounded) as Array<{
      event_id: string; payload_hash: string; receipt_json: string; enqueued_at: number; bytes: number;
    }>;
    return rows.map((row) => ({
      id: row.event_id,
      payloadHash: row.payload_hash,
      receipt: JSON.parse(row.receipt_json) as SignedReceipt,
      enqueuedAt: row.enqueued_at,
      bytes: row.bytes,
    }));
  }

  acknowledge(entries: Array<{ id: string; payloadHash: string }>): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const remove = this.db.prepare("DELETE FROM cloud_outbox WHERE event_id = ? AND payload_hash = ?");
      for (const entry of entries) remove.run(entry.id, entry.payloadHash);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  status(): CloudOutboxStatus {
    const total = this.db.prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes,
              MIN(enqueued_at) AS oldest FROM cloud_outbox`,
    ).all() as Array<{ count: number; bytes: number; oldest: number | null }>;
    const gapCount = this.db.prepare(
      "SELECT total_gaps AS count FROM cloud_outbox_metadata WHERE singleton = 1",
    ).all() as Array<{ count: number }>;
    const retainedGapCount = this.db.prepare(
      "SELECT COUNT(*) AS count FROM cloud_delivery_gaps",
    ).all() as Array<{ count: number }>;
    const latest = this.db.prepare(
      "SELECT event_id, reason, created_at FROM cloud_delivery_gaps ORDER BY seq DESC LIMIT 1",
    ).all() as Array<{ event_id: string | null; reason: CloudDeliveryGap["reason"]; created_at: number }>;
    return {
      pending: total[0]?.count ?? 0,
      pendingBytes: total[0]?.bytes ?? 0,
      oldestEnqueuedAt: total[0]?.oldest ?? null,
      gaps: gapCount[0]?.count ?? 0,
      retainedGapRecords: retainedGapCount[0]?.count ?? 0,
      latestGap: latest[0] ? { id: latest[0].event_id, reason: latest[0].reason, at: latest[0].created_at } : null,
    };
  }

  close(): void { this.db.close(); }

  private expire(at: number): void {
    const expired = this.db.prepare(
      "SELECT event_id FROM cloud_outbox WHERE enqueued_at < ? ORDER BY enqueued_at, event_id",
    ).all(at - this.maxAgeMs) as Array<{ event_id: string }>;
    for (const row of expired) this.gap(row.event_id, "expired", at);
    this.db.prepare("DELETE FROM cloud_outbox WHERE enqueued_at < ?").run(at - this.maxAgeMs);
  }

  private gap(id: string | null, reason: CloudDeliveryGap["reason"], at: number): CloudDeliveryGap {
    this.db.prepare(
      "INSERT INTO cloud_delivery_gaps (event_id, reason, created_at) VALUES (?, ?, ?)",
    ).run(id, reason, at);
    this.db.prepare(
      "UPDATE cloud_outbox_metadata SET total_gaps = total_gaps + 1 WHERE singleton = 1",
    ).run();
    this.db.prepare(
      `DELETE FROM cloud_delivery_gaps WHERE seq <= (
         SELECT COALESCE(MAX(seq), 0) - ? FROM cloud_delivery_gaps
       )`,
    ).run(this.maxGapRecords);
    return { id, reason, at };
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}
