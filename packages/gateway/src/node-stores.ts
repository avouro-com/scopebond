// Node-only durable ReceiptStore implementations (D40: the ReceiptStore interface
// lives in the core with an in-memory implementation; these are durable local
// implementations for the Node server. On Cloudflare, D1/KV are the edge ones.)

import { appendFileSync, readFileSync, existsSync, mkdirSync, truncateSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";
import { keepOwnerOnly, placeOwnerOnly, prepareOwnerOnlyDatabase } from "./node-files.js";

/** `node:sqlite` from Node's built-ins (a bundled build cannot resolve it through a module path), else by require. */
function nodeSqlite(): unknown {
  return process.getBuiltinModule?.("node:sqlite") ?? createRequire(import.meta.url)("node:sqlite");
}
import { canonical, sha256 } from "./crypto.js";
import { randomQueueId, type CloudDeliveryGap, type CloudOutbox, type CloudOutboxEntry, type CloudOutboxStatus, WINDOW_LEASE_MS } from "./cloud.js";
import type {
  ReceiptStore, SignedReceipt, Anchor, AuthorityReservation,
  AuthorityReservationResult, AuthorityFinalState, StopState, ActionLifecycleRecord, RealtimeResult, PriorScope,
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
      if (!isLast || text.endsWith("\n")) throw new Error(`${file}: corrupt record on line ${i + 1}: ${(error as Error).message}`, { cause: error });
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
function openSqlite(path: string, fresh?: string, busyTimeoutMs = 15_000): SqliteDb {
  ensureDir(path);
  const { DatabaseSync } = nodeSqlite() as { DatabaseSync: new (p: string) => SqliteDb };
  // The database and its journal files hold signed evidence: readable by their owner alone from their first byte, and
  // restricted when an older version made them (on Windows a new file would inherit its folder's ACL).
  prepareOwnerOnlyDatabase(path);
  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(busyTimeoutMs))};`);
    // Page size and vacuum mode are fixed once a file is in WAL mode, so a new file gets them first.
    if (fresh && Number(Object.values((db.prepare("PRAGMA page_count").all() as Record<string, number>[])[0] ?? {})[0] ?? 0) === 0) db.exec(fresh);
    whileBusy(() => db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;"), busyTimeoutMs);
    // A bounded page cache (8 MB) and temporary tables in memory: a hook call stays a few megabytes above Node itself
    // however large the file grows. No memory map: every page it touched counted toward the process's memory, so an
    // upkeep pass over a large file doubled a hook call's peak.
    db.exec("PRAGMA cache_size = -8000; PRAGMA temp_store = MEMORY;");
  }
  catch (error) { try { db.close(); } catch { /* already failing */ } throw error; }
  return db;
}

/** Run one step again while the database is locked, for up to 15 seconds. Switching a log to WAL takes a
 *  lock that busy_timeout does not always wait for: on Windows, a dozen hook processes opening the same
 *  log at once failed closed with "database is locked" before this. */
export function whileBusy<T>(step: () => T, limitMs = 15_000): T {
  const deadline = Date.now() + limitMs;
  for (let wait = 5; ; wait = Math.min(wait * 2, 200)) {
    try { return step(); } catch (error) {
      if (!/database is locked|SQLITE_BUSY/i.test((error as Error).message ?? "") || Date.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait + Math.floor(Math.random() * wait));
    }
  }
}

/** Whether this Node has the built-in `node:sqlite` module. */
function sqliteAvailable(): boolean {
  try { nodeSqlite(); return true; } catch { return false; }
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
    // Logs an older version made are restricted to their owner when opened.
    for (const log of [file, this.anchorFile, this.stopFile]) if (existsSync(log)) keepOwnerOnly(log);
    if (existsSync(file)) this.cache.push(...readJsonl<SignedReceipt>(file));
    if (existsSync(this.anchorFile)) this.anchorLog.push(...readJsonl<Anchor>(this.anchorFile));
    if (existsSync(this.stopFile)) {
      for (const event of readJsonl<{ target: string; stopped: boolean }>(this.stopFile)) {
        if (event.stopped) this.stops.add(event.target); else this.stops.delete(event.target);
      }
    }
  }
  private append(file: string, line: string): void {
    // A new log holds signed evidence: it is created exclusively with its first record, readable by its owner alone from
    // its first byte (the existence check only saves work; the exclusive create is the check). Otherwise the record is
    // appended.
    if (!existsSync(file) && placeOwnerOnly(file, line + "\n", true)) return;
    appendFileSync(file, line + "\n", { mode: 0o600, flag: "a" });
  }
  put(r: SignedReceipt): void {
    const serialized = JSON.stringify(r);
    this.append(this.file, serialized);
    this.cache.push(JSON.parse(serialized) as SignedReceipt);
  }
  list(): SignedReceipt[] { return structuredClone(this.cache); }
  recent(limit: number): SignedReceipt[] { return structuredClone(this.cache.slice(-Math.max(1, Math.floor(limit))).reverse()); }
  count(): number { return this.cache.length; }
  executed(scope?: PriorScope): Receipt[] {
    if (scope?.kind === "none") return [];
    return structuredClone(this.cache.map((r) => r.payload as unknown as Receipt));
  }
  putAnchor(a: Anchor): void { this.append(this.anchorFile, JSON.stringify(a)); this.anchorLog.push(a); }
  anchors(): Anchor[] { return this.anchorLog.slice(); }
  getStopState(): StopState { return { global: this.stops.has("global"), agents: [...this.stops].filter((key) => key !== "global") }; }
  setStopped(target: string, stopped: boolean): void {
    this.append(this.stopFile, JSON.stringify({ target, stopped }));
    if (stopped) this.stops.add(target); else this.stops.delete(target);
  }
}

/** What one bounded maintenance pass did. */
export interface StoreMaintenanceReport {
  /** Older rows rewritten to the current layout this pass, and whether any are left. */
  migrated: number;
  layoutCurrent: boolean;
  /** Receipts removed because the workspace acknowledged them before the retention window. */
  receiptsRemoved: number;
  /** Why receipts were not considered for removal, when they were not. */
  receiptsKept?: "no_retention" | "anchored" | "no_delivery_queue";
  /** Finished authority records removed after `stateRetentionMs`. */
  stateRemoved: number;
  /** Pages returned to the filesystem, and whether a full rewrite was needed to switch on incremental vacuum. */
  pagesFreed: number;
  fullVacuum: boolean;
  /** Free space only a full rewrite can return (an older file without incremental vacuum); run one with `allowFullVacuum`. */
  rewriteWanted: boolean;
  /** Whether more work is left (call again). */
  more: boolean;
}

export interface StoreMaintenanceOptions {
  now?: number;
  /** Remove receipts the workspace acknowledged more than this long ago, recorded before the same time. Omit to keep every receipt. */
  retainAcknowledgedMs?: number;
  /** The delivery queue whose acknowledgements say which receipts the workspace holds. Without one, no receipt is removed. */
  outboxPath?: string;
  /** Keep finished authority records this long (default seven days; a signed authorization lives five minutes). */
  stateRetentionMs?: number;
  /** Rows per step (default 2,000). */
  batch?: number;
  /** Stop starting new steps after this long (default 2 seconds). */
  budgetMs?: number;
  /** Allow a one-time full rewrite of the file when that is the only way to return its free space. Off for per-call processes. */
  allowFullVacuum?: boolean;
}

const LAYOUT_VERSION = 2;
const HELD_STATES = "('reserved','dispatching','outcome_unknown')";

/** SQLite-backed receipt store using Node's built-in `node:sqlite` (no native
 *  dependency). Durable and queryable; mirrors the D1 store used at the edge.
 *
 *  Layout 2 keeps each policy once (`policy_snapshots`, referenced by digest), each receipt once (`receipts`; a finished
 *  action points at its row), and no lifecycle row for an action that finished without being dispatched. Layout 1
 *  copied the policy into every action twice and the receipt twice: about 89% of a long-used file. Older rows are
 *  rewritten in bounded steps by `maintain()`, and are read correctly until then. */
export class SqliteReceiptStore implements ReceiptStore {
  private readonly db: SqliteDb;
  private readonly snapshots = new Map<string, string>();
  /** `busyTimeoutMs`: how long a statement waits for another process's write lock (15 s by default; upkeep that must
   *  not hold up a tool call passes a short one and skips the pass when the file is busy). */
  constructor(path: string, options: { busyTimeoutMs?: number } = {}) {
    // A receipt is about 2 KB: 8 KB pages hold four, where 4 KB pages held one. Incremental vacuum returns free pages in
    // steps. Both are chosen when the file is made; an older file switches during a full rewrite in `maintain()`.
    this.db = openSqlite(path, FRESH_STORE_PRAGMAS, options.busyTimeoutMs);
    try {
      const fresh = (this.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master").all() as { n: number }[])[0]?.n === 0;
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
         );
         CREATE TABLE IF NOT EXISTS policy_snapshots (
           digest TEXT PRIMARY KEY,
           policy_json TEXT NOT NULL
         ) WITHOUT ROWID;
         CREATE TABLE IF NOT EXISTS store_metadata (
           key TEXT PRIMARY KEY,
           value TEXT NOT NULL
         ) WITHOUT ROWID;
         CREATE INDEX IF NOT EXISTS receipts_timestamp ON receipts (timestamp);`,
      );
      addColumn(this.db, "receipts", "action_id", "TEXT");
      addColumn(this.db, "authority_actions", "created_at", "TEXT");
      addColumn(this.db, "authority_actions", "terminal_receipt_id", "INTEGER");
      if (fresh) {
        this.db.exec("CREATE INDEX IF NOT EXISTS receipts_action ON receipts (action_id) WHERE action_id IS NOT NULL;");
        this.db.prepare("INSERT OR IGNORE INTO store_metadata (key, value) VALUES ('layout', ?)").run(String(LAYOUT_VERSION));
      }
    } catch (error) {
      try { this.db.close(); } catch { /* already failing */ }
      throw error;
    }
  }
  private insertReceipt(r: SignedReceipt): number {
    const p = r.payload;
    const result = this.db
      .prepare(`INSERT INTO receipts (intent_hash,policy_hash,realtime_result,executed,timestamp,receipt_json,action_id) VALUES (?,?,?,?,?,?,?)`)
      .run(p.intent_hash, p.policy_hash, p.realtime_result, p.executed ? 1 : 0, p.timestamp, JSON.stringify(r), p.action_ref?.action_id ?? null) as { lastInsertRowid?: number | bigint };
    return Number(result.lastInsertRowid ?? 0);
  }
  put(r: SignedReceipt): void {
    this.insertReceipt(r);
  }
  list(): SignedReceipt[] {
    const rows = this.db.prepare(`SELECT receipt_json FROM receipts ORDER BY id`).all() as { receipt_json: string }[];
    return rows.map((row) => JSON.parse(row.receipt_json) as SignedReceipt);
  }
  /** Prior receipts for an evaluation. A policy that reads no history costs no query; a
   *  windowed one reads only the indexed tail since `scope.since`. This is the per-tool-call
   *  path of the hook, so it must not grow with the log. */
  executed(scope?: PriorScope): Receipt[] {
    if (scope?.kind === "none") return [];
    const stored = scope?.kind === "since"
      ? this.db.prepare(`SELECT receipt_json FROM receipts INDEXED BY receipts_timestamp WHERE timestamp >= ? ORDER BY id`)
        .all(scope.since) as { receipt_json: string }[]
      : this.db.prepare(`SELECT receipt_json FROM receipts ORDER BY id`).all() as { receipt_json: string }[];
    const receipts = stored.map((row) => (JSON.parse(row.receipt_json) as SignedReceipt).payload as unknown as Receipt);
    const rows = this.db.prepare(
      `SELECT candidate_json FROM authority_actions WHERE state IN ${HELD_STATES} ORDER BY rowid`,
    ).all() as { candidate_json: string }[];
    return [...receipts, ...rows.map((row) => JSON.parse(row.candidate_json) as Receipt)];
  }
  /** One indexed lookup instead of the whole log: the authority table holds every id an action consumed, and the
   *  receipt tail since `since` covers a receipt written without a reservation. */
  authorizationUsed(kind: "request_id" | "approval_id", id: string, since: string): boolean {
    if (this.db.prepare(`SELECT 1 FROM authority_consumptions WHERE kind = ? AND value = ? LIMIT 1`).all(kind, id).length > 0) return true;
    const path = kind === "request_id" ? "$.payload.authorization.agent.request_id" : "$.payload.authorization.approval.approval_id";
    return this.db.prepare(
      `SELECT 1 FROM receipts INDEXED BY receipts_timestamp WHERE timestamp >= ? AND json_extract(receipt_json, ?) = ? LIMIT 1`,
    ).all(since, path, id).length > 0;
  }
  /** Keep a policy once and return the reference stored in its place. */
  private policyRef(snapshot: string): string {
    const digest = sha256(snapshot);
    // Always written (a no-op when present): the call runs inside the caller's transaction, and a cache that skipped the
    // insert would point later actions at a row a rolled-back transaction never kept.
    this.db.prepare(`INSERT OR IGNORE INTO policy_snapshots (digest, policy_json) VALUES (?, ?)`).run(digest, snapshot);
    return `${POLICY_REF_PREFIX}${digest}`;
  }
  /** The policy text for a stored value: the text itself (layout 1) or a reference to `policy_snapshots`. */
  private policyText(stored: string): string {
    if (!stored.startsWith(POLICY_REF_PREFIX)) return stored;
    const digest = stored.slice(POLICY_REF_PREFIX.length);
    const cached = this.snapshots.get(digest);
    if (cached !== undefined) return cached;
    const rows = this.db.prepare(`SELECT policy_json FROM policy_snapshots WHERE digest = ?`).all(digest) as { policy_json: string }[];
    if (!rows[0]) throw new Error(`the policy ${digest} recorded for an action is missing from the store`);
    this.snapshots.set(digest, rows[0].policy_json);
    return rows[0].policy_json;
  }
  reserveAction<T extends { allow: boolean }>(
    reservation: AuthorityReservation,
    decide: (prior: Receipt[]) => T,
    scope?: PriorScope,
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
      const decision = decide(this.executed(scope));
      const policyRef = this.policyRef(reservation.policy_snapshot);
      this.db.prepare(
        `INSERT INTO authority_actions (action_id,state,candidate_json,policy_ref_json,policy_snapshot,created_at) VALUES (?,?,?,?,?,?)`,
      ).run(
        reservation.action_id,
        decision.allow ? "reserved" : "denied",
        JSON.stringify(reservation.candidate),
        JSON.stringify(reservation.policy_ref),
        policyRef,
        new Date().toISOString(),
      );
      for (const [kind, value] of Object.entries(reservation.authorization_ids ?? {})) {
        if (value) this.db.prepare(
          `INSERT INTO authority_consumptions (kind,value,action_id) VALUES (?,?,?)`,
        ).run(kind, value, reservation.action_id);
      }
      const realtimeResult = "realtime_result" in decision ? decision.realtime_result as RealtimeResult : null;
      // The candidate, policy reference and policy are already in `authority_actions`; the lifecycle row keeps the rest.
      const rest: Partial<AuthorityReservation> = { ...reservation };
      delete rest.candidate; delete rest.policy_ref; delete rest.policy_snapshot;
      this.db.prepare(
        `INSERT INTO authority_lifecycle (action_id,reservation_json,realtime_result) VALUES (?,?,?)`,
      ).run(reservation.action_id, JSON.stringify({ ...rest, [SLIM_RESERVATION]: 1 }), realtimeResult);
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
      const receiptId = this.insertReceipt(receipt);
      this.db.prepare(`UPDATE authority_actions SET state = ?, terminal_receipt_id = ? WHERE action_id = ?`).run(state, receiptId, actionId);
      // An action that was never dispatched (a check-only decision, a denial) has nothing left to reconcile: its receipt
      // is the record, so neither the lifecycle row nor the candidate copy is kept. A dispatched one keeps both (adapter,
      // pre-dispatch attestation) for reconciliation.
      const removed = this.db.prepare(`DELETE FROM authority_lifecycle WHERE action_id = ? AND adapter_id IS NULL`).run(actionId) as { changes?: number | bigint };
      if (Number(removed.changes ?? 0) > 0) this.db.prepare(`UPDATE authority_actions SET candidate_json = '{}' WHERE action_id = ?`).run(actionId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private lifecycleRows(where: string, ...args: unknown[]): ActionLifecycleRecord[] {
    const rows = this.db.prepare(
      `SELECT a.action_id,a.state,a.candidate_json,a.policy_ref_json,a.policy_snapshot,
              l.reservation_json,l.realtime_result,l.adapter_id,l.pre_receipt_json,
              COALESCE(l.terminal_receipt_json, r.receipt_json) AS terminal_receipt_json
         FROM authority_actions a
         LEFT JOIN authority_lifecycle l ON l.action_id = a.action_id
         LEFT JOIN receipts r ON r.id = a.terminal_receipt_id
        WHERE ${where} ORDER BY a.rowid`,
    ).all(...args) as LifecycleRow[];
    return rows.map((row) => rowToLifecycle(row, (stored) => this.policyText(stored)));
  }
  getAction(actionId: string): ActionLifecycleRecord | null {
    return this.lifecycleRows("a.action_id = ?", actionId)[0] ?? null;
  }
  unresolvedActions(): ActionLifecycleRecord[] {
    return this.lifecycleRows(`a.state IN ${HELD_STATES}`);
  }
  /** Actions decided but never finished, reserved before `isoBefore`: the process deciding them was stopped (a coding agent's
   *  hook time limit, a crash) between the reservation and the receipt, so they have no receipt and were never dispatched.
   *  Read from the lifecycle table, which holds only actions still open or dispatched, so the query stays small. */
  interruptedActions(isoBefore: string, limit = 50): ActionLifecycleRecord[] {
    const ids = (this.db.prepare(
      `SELECT l.action_id FROM authority_lifecycle l JOIN authority_actions a ON a.action_id = l.action_id
        WHERE l.adapter_id IS NULL AND l.terminal_receipt_json IS NULL AND a.terminal_receipt_id IS NULL
          AND a.state IN ('reserved','denied')
          AND COALESCE(a.created_at, json_extract(a.candidate_json, '$.timestamp')) < ?
        ORDER BY l.rowid LIMIT ?`,
    ).all(isoBefore, Math.max(1, Math.floor(limit))) as { action_id: string }[]).map((row) => row.action_id);
    if (!ids.length) return [];
    return this.lifecycleRows(`a.action_id IN (SELECT value FROM json_each(?))`, JSON.stringify(ids));
  }
  /** Close an interrupted action with its receipt, only if it is still open (another process may have closed it first, or the
   *  process deciding it may have finished after all). Returns whether this call closed it. */
  settleAction(actionId: string, receipt: SignedReceipt, state: AuthorityFinalState): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const open = this.db.prepare(
        `SELECT 1 FROM authority_lifecycle l JOIN authority_actions a ON a.action_id = l.action_id
          WHERE a.action_id = ? AND l.adapter_id IS NULL AND l.terminal_receipt_json IS NULL AND a.terminal_receipt_id IS NULL
            AND a.state IN ('reserved','denied')`,
      ).all(actionId);
      if (!open.length) { this.db.exec("ROLLBACK"); return false; }
      const receiptId = this.insertReceipt(receipt);
      this.db.prepare(`UPDATE authority_actions SET state = ?, terminal_receipt_id = ?, candidate_json = '{}' WHERE action_id = ?`).run(state, receiptId, actionId);
      this.db.prepare(`DELETE FROM authority_lifecycle WHERE action_id = ?`).run(actionId);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  /** The row id of the newest receipt (0 when there is none): receipts written later have larger ids. */
  lastId(): number {
    const rows = this.db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM receipts`).all() as { id: number }[];
    return Number(rows[0]?.id ?? 0);
  }
  /** How long a statement waits for another process's write lock from now on. */
  setBusyTimeout(ms: number): void {
    this.db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(ms))};`);
  }
  getStopState(): StopState {
    const rows = this.db.prepare(`SELECT target FROM gateway_stops WHERE stopped = 1 ORDER BY target`).all() as { target: string }[];
    const targets = rows.map((row) => row.target);
    return { global: targets.includes("global"), agents: targets.filter((target) => target !== "global") };
  }
  setStopped(target: string, stopped: boolean): void {
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
  /** The most recent `limit` receipts, newest first. `list()` reads and parses the whole
   *  log, which is right for verification and wasteful for "show me the last 20": a
   *  caller that wants a tail should not pay for the history. */
  recent(limit: number): SignedReceipt[] {
    const rows = this.db
      .prepare(`SELECT receipt_json FROM receipts ORDER BY id DESC LIMIT ?`)
      .all(Math.max(1, Math.floor(limit))) as { receipt_json: string }[];
    return rows.map((row) => JSON.parse(row.receipt_json) as SignedReceipt);
  }
  /** Receipts in log order after the row `afterId`, at most `limit` of them, with their row
   *  ids — for walking a large log without holding it in memory. */
  page(afterId: number, limit: number): Array<{ id: number; receipt: SignedReceipt }> {
    const rows = this.db
      .prepare(`SELECT id, receipt_json FROM receipts WHERE id > ? ORDER BY id LIMIT ?`)
      .all(Math.max(0, Math.floor(afterId)), Math.max(1, Math.floor(limit))) as { id: number; receipt_json: string }[];
    return rows.map((row) => ({ id: Number(row.id), receipt: JSON.parse(row.receipt_json) as SignedReceipt }));
  }
  /** How many receipts are stored, without reading any of them. */
  count(): number {
    const rows = this.db.prepare(`SELECT COUNT(*) AS n FROM receipts`).all() as { n: number }[];
    return Number(rows[0]?.n ?? 0);
  }
  /** Receipts recorded strictly before an ISO timestamp — what a prune would remove.
   *  Separate from the removal itself so a caller can archive them first, and so a
   *  dry run costs nothing. */
  before(isoTimestamp: string): SignedReceipt[] {
    const rows = this.db
      .prepare(`SELECT receipt_json FROM receipts WHERE timestamp < ? ORDER BY id`)
      .all(isoTimestamp) as { receipt_json: string }[];
    return rows.map((row) => JSON.parse(row.receipt_json) as SignedReceipt);
  }
  /** Remove receipts recorded before an ISO timestamp, the finished authority records of the same age, and return
   *  the space.
   *
   *  A receipt's position in `list()` is its anchor leaf index, so removing one changes
   *  every later index and makes an existing anchor unverifiable. This therefore refuses
   *  outright once anything has been anchored — the caller cannot opt out, because the
   *  alternative is silently invalidating published evidence. */
  removeBefore(isoTimestamp: string): { removed: number } {
    if (this.anchored()) {
      throw new Error(
        "this log has anchors: a receipt's position is its anchor leaf index, so removing older receipts would make an existing anchor unverifiable. Archive the database instead of pruning it.",
      );
    }
    const doomed = this.db.prepare(`SELECT COUNT(*) AS n FROM receipts WHERE timestamp < ?`).all(isoTimestamp) as { n: number }[];
    const removed = Number(doomed[0]?.n ?? 0);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // Never the consumed ids of the last day, whatever the cutoff: an authorization that may still be valid keeps its
      // replay protection.
      const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      this.removeFinishedState(isoTimestamp < dayAgo ? isoTimestamp : dayAgo, Number.MAX_SAFE_INTEGER);
      if (removed > 0) this.db.prepare(`DELETE FROM receipts WHERE timestamp < ?`).run(isoTimestamp);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    if (removed === 0) return { removed: 0 };
    // VACUUM is what actually returns the pages to the filesystem; without it the file
    // keeps its high-water mark and the prune looks like it did nothing. It also switches
    // an older file to incremental vacuum, so later maintenance can shrink it in steps.
    if (!this.rewriteFile()) { /* a locked db keeps its size; rows are still gone */ }
    return { removed };
  }
  private anchored(): boolean {
    const rows = this.db.prepare(`SELECT COUNT(*) AS n FROM anchors`).all() as { n: number }[];
    return Number(rows[0]?.n ?? 0) > 0;
  }
  /** Finished authority records created before `isoTimestamp`, at most `limit`. Held ones (reserved, dispatching,
   *  outcome unknown) are never removed: they still count against limits until they are reconciled. */
  private removeFinishedState(isoTimestamp: string, limit: number): number {
    const doomed = this.db.prepare(
      `SELECT action_id FROM authority_actions
        WHERE state NOT IN ${HELD_STATES}
          AND COALESCE(created_at, json_extract(candidate_json, '$.timestamp')) < ?
        LIMIT ?`,
    ).all(isoTimestamp, limit) as { action_id: string }[];
    if (!doomed.length) return 0;
    const ids = JSON.stringify(doomed.map((row) => row.action_id));
    this.db.prepare(`DELETE FROM authority_consumptions WHERE action_id IN (SELECT value FROM json_each(?))`).run(ids);
    this.db.prepare(`DELETE FROM authority_lifecycle WHERE action_id IN (SELECT value FROM json_each(?))`).run(ids);
    this.db.prepare(`DELETE FROM authority_actions WHERE action_id IN (SELECT value FROM json_each(?))`).run(ids);
    return doomed.length;
  }
  /** Whether every row is in the current layout. */
  layoutCurrent(): boolean {
    const rows = this.db.prepare(`SELECT value FROM store_metadata WHERE key = 'layout'`).all() as { value: string }[];
    return Number(rows[0]?.value ?? 1) >= LAYOUT_VERSION;
  }
  /** One bounded pass of upkeep: rewrite older rows to the current layout, remove what the retention rules allow, and
   *  return free pages to the filesystem. Safe to run from several processes; each step is its own short transaction,
   *  so a hook call deciding an action waits at most one step. Call again while `more` is true. */
  maintain(options: StoreMaintenanceOptions = {}): StoreMaintenanceReport {
    const now = options.now ?? Date.now();
    const batch = Math.max(1, Math.floor(options.batch ?? 2_000));
    const deadline = Date.now() + Math.max(0, options.budgetMs ?? 2_000);
    const report: StoreMaintenanceReport = {
      migrated: 0, layoutCurrent: this.layoutCurrent(), receiptsRemoved: 0, stateRemoved: 0, pagesFreed: 0, fullVacuum: false, rewriteWanted: false, more: false,
    };
    const step = (work: () => number): number => {
      this.db.exec("BEGIN IMMEDIATE");
      try { const n = work(); this.db.exec("COMMIT"); return n; }
      catch (error) { this.db.exec("ROLLBACK"); throw error; }
    };
    const timeLeft = () => Date.now() < deadline;

    // 1. Layout: each policy once, receipts numbered by action, finished actions without lifecycle rows.
    for (let first = true; !report.layoutCurrent && (first || timeLeft()); first = false) {
      const n = step(() => this.migrateStep(batch));
      report.migrated += n;
      if (n === 0) {
        this.db.prepare(`INSERT OR REPLACE INTO store_metadata (key, value) VALUES ('layout', ?)`).run(String(LAYOUT_VERSION));
        report.layoutCurrent = true;
      }
    }

    // 2. Finished authority records: a signed authorization lives minutes, so after a week they protect nothing.
    const stateCutoff = new Date(now - (options.stateRetentionMs ?? 7 * 24 * 60 * 60 * 1000)).toISOString();
    for (let n = batch, first = true; n === batch && (first || timeLeft()); first = false) {
      n = step(() => this.removeFinishedState(stateCutoff, batch));
      report.stateRemoved += n;
    }

    // 3. Receipts the workspace acknowledged before the retention window. Never one it has not acknowledged, never in
    //    an anchored log, and only once the layout says which action each receipt belongs to.
    if (options.retainAcknowledgedMs === undefined) report.receiptsKept = "no_retention";
    else if (!options.outboxPath || !existsSync(options.outboxPath)) report.receiptsKept = "no_delivery_queue";
    else if (this.anchored()) report.receiptsKept = "anchored";
    else if (report.layoutCurrent) {
      const cutoffMs = now - Math.max(0, options.retainAcknowledgedMs);
      const cutoff = new Date(cutoffMs).toISOString();
      this.db.prepare(`ATTACH DATABASE ? AS delivery`).run(options.outboxPath);
      try {
        const hasAcks = this.db.prepare(
          `SELECT 1 FROM delivery.sqlite_master WHERE type = 'table' AND name = 'cloud_acknowledged'`,
        ).all().length > 0;
        if (!hasAcks) report.receiptsKept = "no_delivery_queue";
        for (let n = batch, first = true; hasAcks && n === batch && (first || timeLeft()); first = false) {
          n = step(() => {
            // Checked inside each step's transaction: an anchor made during a long pass stops the rest of it.
            if (this.anchored()) { report.receiptsKept = "anchored"; return 0; }
            const doomed = this.db.prepare(
              `SELECT r.id, r.action_id FROM receipts r INDEXED BY receipts_timestamp
                 JOIN delivery.cloud_acknowledged a ON a.event_id = r.action_id
                WHERE r.timestamp < ? AND a.acked_at < ?
                ORDER BY r.timestamp LIMIT ?`,
            ).all(cutoff, cutoffMs, batch) as { id: number; action_id: string }[];
            if (!doomed.length) return 0;
            this.db.prepare(`DELETE FROM receipts WHERE id IN (SELECT value FROM json_each(?))`).run(JSON.stringify(doomed.map((d) => d.id)));
            this.db.prepare(`DELETE FROM delivery.cloud_acknowledged WHERE event_id IN (SELECT value FROM json_each(?))`)
              .run(JSON.stringify(doomed.map((d) => d.action_id)));
            return doomed.length;
          });
          report.receiptsRemoved += n;
        }
      } finally {
        try { this.db.exec(`DETACH DATABASE delivery`); } catch { /* released on close */ }
      }
    }

    // 4. Space: an incremental-vacuum file returns free pages in steps; an older file needs one full rewrite first.
    const pragma = (sql: string) => Number(Object.values((this.db.prepare(sql).all() as Record<string, number>[])[0] ?? {})[0] ?? 0);
    const free = pragma("PRAGMA freelist_count");
    if (free > 0) {
      if (pragma("PRAGMA auto_vacuum") === 2) {
        this.db.exec(`PRAGMA incremental_vacuum(${Math.min(free, 25_000)});`);
        report.pagesFreed = free - pragma("PRAGMA freelist_count");
      } else if (options.allowFullVacuum && report.layoutCurrent && timeLeft()) {
        report.fullVacuum = this.rewriteFile();
        if (report.fullVacuum) report.pagesFreed = free;
      }
      report.rewriteWanted = !report.fullVacuum && pragma("PRAGMA auto_vacuum") !== 2;
    }
    report.more = !report.layoutCurrent || !timeLeft();
    return report;
  }
  /** Rewrite the whole file once with the current page size and incremental vacuum. The page size can only change outside
   *  WAL mode, which needs the file to itself; when another process has it open, the rewrite keeps the page size. */
  private rewriteFile(): boolean {
    try {
      this.db.exec("PRAGMA journal_mode = DELETE;");
      try { this.db.exec(`${FRESH_STORE_PRAGMAS} VACUUM;`); }
      finally { whileBusy(() => this.db.exec("PRAGMA journal_mode = WAL;")); }
      return true;
    } catch { /* fall through: another process holds the file */ }
    try { this.db.exec("PRAGMA auto_vacuum = INCREMENTAL; VACUUM;"); return true; }
    catch { return false; } // the next pass tries again
  }
  /** Rewrite up to `limit` layout-1 rows. Returns how many changed (0 when the layout is current). */
  private migrateStep(limit: number): number {
    // Policies copied into each action become one row referenced by digest. A file holds few distinct policies, so each
    // step takes one of them and replaces its copies inside SQLite (the copies never pass through this process's memory).
    const sample = this.db.prepare(
      `SELECT policy_snapshot FROM authority_actions WHERE policy_snapshot NOT LIKE '${POLICY_REF_PREFIX}%' LIMIT 1`,
    ).all() as { policy_snapshot: string }[];
    const inline = sample[0]
      ? this.db.prepare(
        `UPDATE authority_actions SET policy_snapshot = ? WHERE action_id IN (
           SELECT action_id FROM authority_actions WHERE policy_snapshot = ? LIMIT ?)`,
      ).run(this.policyRef(sample[0].policy_snapshot), sample[0].policy_snapshot, limit) as { changes?: number | bigint }
      : { changes: 0 };
    // Receipts learn which action they record, so retention can match them to the workspace's acknowledgements and a
    // finished action can point at its receipt. This finishes before the lifecycle rows go (they hold the receipt copy).
    const numbered = this.db.prepare(
      `UPDATE receipts SET action_id = json_extract(receipt_json, '$.payload.action_ref.action_id')
        WHERE id IN (SELECT id FROM receipts WHERE action_id IS NULL
                       AND json_extract(receipt_json, '$.payload.action_ref.action_id') IS NOT NULL LIMIT ?)`,
    ).run(limit) as { changes?: number | bigint };
    if (Number(numbered.changes ?? 0) > 0) return Number(inline.changes ?? 0) + Number(numbered.changes ?? 0);
    this.db.exec(`CREATE INDEX IF NOT EXISTS receipts_action ON receipts (action_id) WHERE action_id IS NOT NULL;`);
    // A finished action that was never dispatched keeps no lifecycle row and no candidate copy: it points at its receipt.
    const finishedIds = JSON.stringify((this.db.prepare(
      `SELECT l.action_id FROM authority_lifecycle l JOIN authority_actions a ON a.action_id = l.action_id
        WHERE l.adapter_id IS NULL AND a.state NOT IN ${HELD_STATES} LIMIT ?`,
    ).all(limit) as { action_id: string }[]).map((row) => row.action_id));
    this.db.prepare(
      `UPDATE authority_actions
          SET terminal_receipt_id = COALESCE(terminal_receipt_id, (SELECT MAX(r.id) FROM receipts r WHERE r.action_id = authority_actions.action_id)),
              created_at = COALESCE(created_at, json_extract(candidate_json, '$.timestamp')), candidate_json = '{}'
        WHERE action_id IN (SELECT value FROM json_each(?))`,
    ).run(finishedIds);
    const finished = this.db.prepare(
      `DELETE FROM authority_lifecycle WHERE action_id IN (SELECT value FROM json_each(?))`,
    ).run(finishedIds) as { changes?: number | bigint };
    return Number(inline.changes ?? 0) + Number(finished.changes ?? 0);
  }
  close(): void {
    // Checkpoint before releasing the handle. A short-lived writer that exits without
    // closing leaves its WAL frames on disk, and the next process appends to the same
    // WAL rather than starting clean: measured at ~11 KiB of WAL per receipt against
    // ~1.7 KiB once the handle is closed. It also releases the file lock, which on
    // Windows is what stops `.scopebond` being removable after a run.
    try { this.db.exec("PRAGMA wal_checkpoint(PASSIVE);"); } catch { /* best effort */ }
    this.db.close();
  }
}

const POLICY_REF_PREFIX = "policy-ref:sha256:";
const FRESH_STORE_PRAGMAS = "PRAGMA page_size = 8192; PRAGMA auto_vacuum = INCREMENTAL;";
const SLIM_RESERVATION = "scopebond_slim";

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

function rowToLifecycle(row: LifecycleRow, policyText: (stored: string) => string): ActionLifecycleRecord {
  const fromAction = () => ({
    action_id: row.action_id,
    candidate: JSON.parse(row.candidate_json) as Receipt,
    policy_ref: JSON.parse(row.policy_ref_json),
    policy_snapshot: policyText(row.policy_snapshot),
  });
  let reservation: AuthorityReservation;
  if (!row.reservation_json) reservation = fromAction();
  else {
    const stored = JSON.parse(row.reservation_json) as AuthorityReservation & Record<string, unknown>;
    if (stored[SLIM_RESERVATION]) {
      const rest: Record<string, unknown> = { ...stored };
      delete rest[SLIM_RESERVATION];
      reservation = { ...(rest as Partial<AuthorityReservation>), ...fromAction() };
    } else reservation = stored;
  }
  const terminal = row.terminal_receipt_json ? JSON.parse(row.terminal_receipt_json) as SignedReceipt : null;
  return {
    action_id: row.action_id,
    state: row.state,
    reservation,
    realtime_result: row.realtime_result ?? terminal?.payload.realtime_result ?? null,
    adapter_id: row.adapter_id,
    pre_receipt: row.pre_receipt_json ? JSON.parse(row.pre_receipt_json) as SignedReceipt : null,
    terminal_receipt: terminal,
  };
}

/** Add a column to a table made by an older version. Two processes can open an old file at once: the one that loses
 *  the race finds the column already added, which is the state it wanted. */
function addColumn(db: SqliteDb, table: string, column: string, definition: string): void {
  const has = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === column);
  if (has) return;
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`); }
  catch (error) { if (!/duplicate column/i.test((error as Error).message)) throw error; }
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
  /** How long a statement waits for another process's write lock (15 s by default). A per-call process that must stay inside
   *  a coding agent's hook time limit passes a short one: a write that fails then is the caller's to record and retry. */
  busyTimeoutMs?: number;
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
    this.db = openSqlite(path, undefined, options.busyTimeoutMs);
    // A queue that cannot be set up (a full disk, a read-only file) must not leave its handle open:
    // the next open of the same file in this process would reuse it and stay read-only.
    try {
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
        CREATE TABLE IF NOT EXISTS cloud_gap_reasons (
          reason TEXT PRIMARY KEY,
          n INTEGER NOT NULL CHECK (n >= 0)
        ) WITHOUT ROWID;
        INSERT OR IGNORE INTO cloud_gap_reasons (reason, n)
          SELECT reason, COUNT(*) FROM cloud_delivery_gaps
           WHERE NOT EXISTS (SELECT 1 FROM cloud_gap_reasons) GROUP BY reason;
        CREATE TABLE IF NOT EXISTS cloud_acknowledged (
          event_id TEXT PRIMARY KEY,
          acked_at INTEGER NOT NULL
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS cloud_summary_windows (
          window_start INTEGER PRIMARY KEY,
          summary_id TEXT,
          claimed_at INTEGER NOT NULL DEFAULT 0,
          sent INTEGER NOT NULL DEFAULT 0,
          full_count INTEGER NOT NULL DEFAULT 0,
          touched_at INTEGER NOT NULL
        );
      `);
      // SB289: a number per queued record, kept across restarts. Queues made before it get the columns
      // here; records already in them stay unnumbered.
      const has = (table: string, column: string) =>
        (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === column);
      // Two processes (parallel hook calls, or the hook and the agent) can open an old queue at once: the
      // one that loses the race finds the column already added, which is the state it wanted.
      const addColumn = (table: string, column: string, definition: string) => {
        if (has(table, column)) return;
        try { this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`); }
        catch (error) { if (!/duplicate column/i.test((error as Error).message)) throw error; }
      };
      addColumn("cloud_outbox", "seq", "INTEGER");
      addColumn("cloud_outbox_metadata", "next_seq", "INTEGER NOT NULL DEFAULT 1");
      // SB289: the queue's id, made once. Two processes opening a new queue at once both try; the
      // first write wins and both read the same id back.
      addColumn("cloud_outbox_metadata", "queue_id", "TEXT");
      // SB406: the queue's totals, kept here instead of counted on every record. NULL means "count once": a queue made
      // before them. A total an older version left behind is corrected whenever `status()` runs.
      addColumn("cloud_outbox_metadata", "pending_count", "INTEGER");
      addColumn("cloud_outbox_metadata", "pending_bytes", "INTEGER");
      this.db.prepare("UPDATE cloud_outbox_metadata SET queue_id = ? WHERE singleton = 1 AND queue_id IS NULL").run(randomQueueId());
    } catch (error) {
      try { this.db.close(); } catch { /* already failing */ }
      throw error;
    }
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
      const totals = this.totals();
      const takeSeq = (): number | null => (this.db.prepare(
        "UPDATE cloud_outbox_metadata SET next_seq = next_seq + 1 WHERE singleton = 1 RETURNING next_seq - 1 AS seq",
      ).all() as Array<{ seq: number }>)[0]?.seq ?? null;
      if (totals.count >= this.maxPending || totals.bytes + bytes > this.maxBytes) {
        // The dropped record still takes its number, so the workspace sees a hole where it was.
        const dropped = takeSeq();
        const gap = this.gap(id, "capacity", at);
        this.db.exec("COMMIT");
        return { queued: false, duplicate: false, gap: dropped === null ? gap : { ...gap, seq: dropped } };
      }
      const seq = takeSeq();
      this.db.prepare(
        "INSERT INTO cloud_outbox (event_id, payload_hash, receipt_json, enqueued_at, bytes, seq) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(id, payloadHash, receiptJson, at, bytes, seq);
      this.db.prepare(
        "UPDATE cloud_outbox_metadata SET pending_count = ?, pending_bytes = ? WHERE singleton = 1",
      ).run(totals.count + 1, totals.bytes + bytes);
      this.db.exec("COMMIT");
      return { queued: true, duplicate: false };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  peek(limit: number, at: number, exclude?: ReadonlySet<string>): CloudOutboxEntry[] {
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
      `SELECT event_id, payload_hash, receipt_json, enqueued_at, bytes, seq
         FROM cloud_outbox WHERE event_id NOT IN (SELECT value FROM json_each(?)) ORDER BY enqueued_at, event_id LIMIT ?`,
    ).all(JSON.stringify(exclude ? [...exclude] : []), bounded) as Array<{
      event_id: string; payload_hash: string; receipt_json: string; enqueued_at: number; bytes: number; seq: number | null;
    }>;
    return rows.map((row) => ({
      id: row.event_id,
      payloadHash: row.payload_hash,
      receipt: JSON.parse(row.receipt_json) as SignedReceipt,
      enqueuedAt: row.enqueued_at,
      bytes: row.bytes,
      ...(row.seq === null ? {} : { seq: row.seq }),
    }));
  }

  acknowledge(entries: Array<{ id: string; payloadHash: string }>, held?: ReadonlySet<string>): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const remove = this.db.prepare("DELETE FROM cloud_outbox WHERE event_id = ? AND payload_hash = ? RETURNING bytes");
      const acked = this.db.prepare("INSERT OR REPLACE INTO cloud_acknowledged (event_id, acked_at) VALUES (?, ?)");
      const at = this.now();
      let count = 0;
      let bytes = 0;
      for (const entry of entries) {
        for (const row of remove.all(entry.id, entry.payloadHash) as Array<{ bytes: number }>) {
          count++;
          bytes += Number(row.bytes);
          // D144: retention removes a local receipt only after the workspace holds it; this row is that proof. A record
          // that left the queue because the workspace refused it is not held, and stays in the local log.
          if (held?.has(entry.id)) acked.run(entry.id, at);
        }
      }
      this.adjustTotals(-count, -bytes);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** After the machine's countersigning key is replaced, queued receipts signed by an earlier
   *  key can never be delivered by the new connection: the workspace refuses them, and a
   *  refused batch would hold up every newer receipt behind it. They are taken out of the
   *  queue as `rekeyed` gaps; the receipts themselves stay in the local log, from which
   *  `recover` delivers them once the workspace approves. Returns how many were set aside. */
  discardNotSignedBy(kid: string): number {
    const at = this.now();
    const rows = this.db.prepare(
      "SELECT event_id FROM cloud_outbox WHERE json_extract(receipt_json, '$.payload.attester.kid') IS NOT ?",
    ).all(kid) as Array<{ event_id: string }>;
    if (!rows.length) return 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const remove = this.db.prepare("DELETE FROM cloud_outbox WHERE event_id = ?");
      for (const row of rows) { remove.run(row.event_id); this.gap(row.event_id, "rekeyed", at); }
      this.resetTotals();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return rows.length;
  }

  /** Records the workspace accepted outside this queue (`recover` sends them itself): they become eligible for retention. */
  /** Summaries: a window is summarised once by this queue, whichever process flushes. The claim is a lease taken in one
   *  transaction; a lease older than WINDOW_LEASE_MS was abandoned and is taken over under the same summary id. Windows older
   *  than a week are forgotten; records that old are sent in full anyway. */
  claimWindow(windowStart: number, summaryId: string, now: number): { state: "claimed" | "busy" | "sent"; summaryId: string } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM cloud_summary_windows WHERE touched_at < ?").run(now - 7 * 24 * 60 * 60 * 1000);
      this.db.prepare("INSERT OR IGNORE INTO cloud_summary_windows (window_start, touched_at) VALUES (?, ?)").run(windowStart, now);
      const row = this.db.prepare("SELECT summary_id, claimed_at, sent FROM cloud_summary_windows WHERE window_start = ?").all(windowStart)[0] as { summary_id: string | null; claimed_at: number; sent: number };
      let answer: { state: "claimed" | "busy" | "sent"; summaryId: string };
      if (row.sent) answer = { state: "sent", summaryId: row.summary_id ?? summaryId };
      else if (row.summary_id && now - row.claimed_at < WINDOW_LEASE_MS) answer = { state: "busy", summaryId: row.summary_id };
      else {
        const id = row.summary_id ?? summaryId;
        this.db.prepare("UPDATE cloud_summary_windows SET summary_id = ?, claimed_at = ?, touched_at = ? WHERE window_start = ?").run(id, now, now, windowStart);
        answer = { state: "claimed", summaryId: id };
      }
      this.db.exec("COMMIT");
      return answer;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  releaseWindow(windowStart: number): void {
    this.db.prepare("UPDATE cloud_summary_windows SET claimed_at = 0 WHERE window_start = ? AND sent = 0").run(windowStart);
  }

  markWindowSent(windowStart: number): void {
    this.db.prepare("UPDATE cloud_summary_windows SET sent = 1 WHERE window_start = ?").run(windowStart);
  }

  countFull(windowStart: number, n: number): void {
    this.db.prepare(
      `INSERT INTO cloud_summary_windows (window_start, full_count, touched_at) VALUES (?, ?, ?)
       ON CONFLICT (window_start) DO UPDATE SET full_count = full_count + excluded.full_count, touched_at = excluded.touched_at`,
    ).run(windowStart, n, Date.now());
  }

  fullCount(windowStart: number): number {
    return (this.db.prepare("SELECT full_count FROM cloud_summary_windows WHERE window_start = ?").all(windowStart)[0] as { full_count: number } | undefined)?.full_count ?? 0;
  }

  markAcknowledged(ids: string[]): void {
    const acked = this.db.prepare("INSERT OR REPLACE INTO cloud_acknowledged (event_id, acked_at) VALUES (?, ?)");
    const at = this.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const id of ids) acked.run(id, at);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  pendingCount(): number {
    return this.totals().count;
  }

  /** The kept totals, counted once when missing. */
  private totals(): { count: number; bytes: number } {
    const kept = this.db.prepare(
      "SELECT pending_count AS count, pending_bytes AS bytes FROM cloud_outbox_metadata WHERE singleton = 1",
    ).all() as Array<{ count: number | null; bytes: number | null }>;
    if (kept[0] && kept[0].count !== null && kept[0].bytes !== null) return { count: Number(kept[0].count), bytes: Number(kept[0].bytes) };
    return this.resetTotals();
  }

  private resetTotals(): { count: number; bytes: number } {
    const counted = (this.db.prepare(
      "SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes FROM cloud_outbox",
    ).all() as Array<{ count: number; bytes: number }>)[0] ?? { count: 0, bytes: 0 };
    this.db.prepare("UPDATE cloud_outbox_metadata SET pending_count = ?, pending_bytes = ? WHERE singleton = 1")
      .run(Number(counted.count), Number(counted.bytes));
    return { count: Number(counted.count), bytes: Number(counted.bytes) };
  }

  private adjustTotals(count: number, bytes: number): void {
    if (count === 0 && bytes === 0) return;
    this.db.prepare(
      `UPDATE cloud_outbox_metadata SET pending_count = MAX(0, pending_count + ?), pending_bytes = MAX(0, pending_bytes + ?)
        WHERE singleton = 1 AND pending_count IS NOT NULL AND pending_bytes IS NOT NULL`,
    ).run(count, bytes);
  }

  status(): CloudOutboxStatus {
    const total = this.db.prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes,
              MIN(enqueued_at) AS oldest FROM cloud_outbox`,
    ).all() as Array<{ count: number; bytes: number; oldest: number | null }>;
    // The exact count corrects a kept total that an older version (which keeps none) left behind.
    try {
      this.db.prepare(
        `UPDATE cloud_outbox_metadata SET pending_count = ?, pending_bytes = ?
          WHERE singleton = 1 AND (pending_count IS NOT ? OR pending_bytes IS NOT ?)`,
      ).run(total[0]?.count ?? 0, total[0]?.bytes ?? 0, total[0]?.count ?? 0, total[0]?.bytes ?? 0);
    } catch { /* a read-only queue still reports */ }
    const gapCount = this.db.prepare(
      "SELECT total_gaps AS count, queue_id, next_seq FROM cloud_outbox_metadata WHERE singleton = 1",
    ).all() as Array<{ count: number; queue_id: string | null; next_seq: number }>;
    const retainedGapCount = this.db.prepare(
      "SELECT COUNT(*) AS count FROM cloud_delivery_gaps",
    ).all() as Array<{ count: number }>;
    const latest = this.db.prepare(
      "SELECT event_id, reason, created_at FROM cloud_delivery_gaps ORDER BY seq DESC LIMIT 1",
    ).all() as Array<{ event_id: string | null; reason: CloudDeliveryGap["reason"]; created_at: number }>;
    return {
      gapsByReason: this.gapsByReason(),
      pending: total[0]?.count ?? 0,
      pendingBytes: total[0]?.bytes ?? 0,
      oldestEnqueuedAt: total[0]?.oldest ?? null,
      gaps: gapCount[0]?.count ?? 0,
      retainedGapRecords: retainedGapCount[0]?.count ?? 0,
      latestGap: latest[0] ? { id: latest[0].event_id, reason: latest[0].reason, at: latest[0].created_at } : null,
      ...(gapCount[0]?.queue_id ? { queueId: gapCount[0].queue_id } : {}),
      seqAssigned: Math.max(0, Number(gapCount[0]?.next_seq ?? 1) - 1),
    };
  }

  close(): void {
    // Same reason as the receipt store: a per-tool-call process that exits without
    // closing leaves its write-ahead log behind for the next one to extend.
    try { this.db.exec("PRAGMA wal_checkpoint(PASSIVE);"); } catch { /* best effort */ }
    this.db.close();
  }

  private expire(at: number): void {
    const expired = this.db.prepare(
      "SELECT event_id FROM cloud_outbox WHERE enqueued_at < ? ORDER BY enqueued_at, event_id",
    ).all(at - this.maxAgeMs) as Array<{ event_id: string }>;
    for (const row of expired) this.gap(row.event_id, "expired", at);
    if (!expired.length) return;
    this.db.prepare("DELETE FROM cloud_outbox WHERE enqueued_at < ?").run(at - this.maxAgeMs);
    this.resetTotals();
  }

  /** Delivery gaps by reason over the queue's lifetime, not only the retained gap rows (for a machine-readable status and the
   *  rules check). A queue made before these counts starts from the rows it had kept. */
  gapsByReason(): Record<string, number> {
    const rows = this.db.prepare("SELECT reason, n FROM cloud_gap_reasons WHERE n > 0 ORDER BY reason").all() as Array<{ reason: string; n: number }>;
    return Object.fromEntries(rows.map((r) => [r.reason, Number(r.n)]));
  }

  /** How long a statement waits for another process's write lock from now on. */
  setBusyTimeout(ms: number): void {
    this.db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(ms))};`);
  }

  /** Which of these action ids this queue already knows: waiting, accepted by the workspace, or set aside as a gap for a
   *  reason other than a failed queue write. A record it does not know was never queued, and may be queued again. */
  known(ids: string[]): Set<string> {
    if (!ids.length) return new Set();
    const list = JSON.stringify(ids);
    const rows = this.db.prepare(
      `SELECT event_id FROM cloud_outbox WHERE event_id IN (SELECT value FROM json_each(?))
       UNION SELECT event_id FROM cloud_acknowledged WHERE event_id IN (SELECT value FROM json_each(?))
       UNION SELECT event_id FROM cloud_delivery_gaps WHERE reason <> 'outbox_error' AND event_id IN (SELECT value FROM json_each(?))`,
    ).all(list, list, list) as Array<{ event_id: string }>;
    return new Set(rows.map((row) => row.event_id));
  }

  /** A gap learned from the workspace (a record refused on its own). */
  recordGap(id: string | null, reason: CloudDeliveryGap["reason"]): CloudDeliveryGap {
    return this.gap(id, reason, this.now());
  }

  private gap(id: string | null, reason: CloudDeliveryGap["reason"], at: number): CloudDeliveryGap {
    this.db.prepare(
      "INSERT INTO cloud_delivery_gaps (event_id, reason, created_at) VALUES (?, ?, ?)",
    ).run(id, reason, at);
    this.db.prepare(
      "UPDATE cloud_outbox_metadata SET total_gaps = total_gaps + 1 WHERE singleton = 1",
    ).run();
    this.db.prepare(
      "INSERT INTO cloud_gap_reasons (reason, n) VALUES (?, 1) ON CONFLICT (reason) DO UPDATE SET n = n + 1",
    ).run(reason);
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
