// Node-only durable ReceiptStore implementations (D40: the ReceiptStore interface
// lives in the core with an in-memory implementation; these are durable local
// implementations for the Node server. On Cloudflare, D1/KV are the edge ones.)

import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";
import type {
  ReceiptStore, SignedReceipt, Anchor, AuthorityReservation,
  AuthorityReservationResult, AuthorityFinalState, StopState,
} from "./receipts.js";
import type { Receipt } from "@scopebond/verify";

function ensureDir(file: string): void {
  const dir = dirname(file);
  if (dir) mkdirSync(dir, { recursive: true });
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
    if (existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        const t = line.trim();
        if (t) this.cache.push(JSON.parse(t) as SignedReceipt);
      }
    }
    if (existsSync(this.anchorFile)) {
      for (const line of readFileSync(this.anchorFile, "utf8").split("\n")) {
        const t = line.trim();
        if (t) this.anchorLog.push(JSON.parse(t) as Anchor);
      }
    }
    if (existsSync(this.stopFile)) {
      for (const line of readFileSync(this.stopFile, "utf8").split("\n")) {
        const text = line.trim();
        if (!text) continue;
        const event = JSON.parse(text) as { target: string; stopped: boolean };
        if (event.stopped) this.stops.add(event.target); else this.stops.delete(event.target);
      }
    }
  }
  put(r: SignedReceipt): void {
    const serialized = JSON.stringify(r);
    appendFileSync(this.file, serialized + "\n");
    this.cache.push(JSON.parse(serialized) as SignedReceipt);
  }
  list(): SignedReceipt[] { return structuredClone(this.cache); }
  executed(): Receipt[] { return structuredClone(this.cache.map((r) => r.payload as unknown as Receipt)); }
  putAnchor(a: Anchor): void { appendFileSync(this.anchorFile, JSON.stringify(a) + "\n"); this.anchorLog.push(a); }
  anchors(): Anchor[] { return this.anchorLog.slice(); }
  getStopState(): StopState { return { global: this.stops.has("global"), agents: [...this.stops].filter((key) => key !== "global") }; }
  setStopped(target: "global" | string, stopped: boolean): void {
    appendFileSync(this.stopFile, JSON.stringify({ target, stopped }) + "\n");
    if (stopped) this.stops.add(target); else this.stops.delete(target);
  }
}

/** SQLite-backed receipt store using Node's built-in `node:sqlite` (no native
 *  dependency). Durable and queryable; mirrors the D1 store used at the edge. */
export class SqliteReceiptStore implements ReceiptStore {
  private readonly db: { exec(sql: string): void; prepare(sql: string): { run(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] }; close(): void };
  constructor(path: string) {
    ensureDir(path);
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (p: string) => SqliteReceiptStore["db"] };
    this.db = new DatabaseSync(path);
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
      `SELECT candidate_json FROM authority_actions WHERE state IN ('reserved', 'outcome_unknown') ORDER BY rowid`,
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
      this.db.exec("COMMIT");
      return { duplicate: false, decision };
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
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
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

/** Open a durable store: SQLite when `db` is given (falls back to the JSONL file
 *  if node:sqlite is unavailable), otherwise the append-only file. */
export function openReceiptStore(opts: { db?: string; file?: string }): { store: ReceiptStore; kind: "sqlite" | "file"; path: string } {
  if (opts.db) {
    try {
      return { store: new SqliteReceiptStore(opts.db), kind: "sqlite", path: opts.db };
    } catch {
      // node:sqlite not available (older Node) — fall back to the file store.
    }
  }
  const file = opts.file ?? "scopebond-receipts.jsonl";
  return { store: new FileReceiptStore(file), kind: "file", path: file };
}
