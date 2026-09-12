// Node-only durable ReceiptStore implementations (D40: the ReceiptStore interface
// lives in the core with an in-memory implementation; these are durable local
// implementations for the Node server. On Cloudflare, D1/KV are the edge ones.)

import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";
import type { ReceiptStore, SignedReceipt } from "./receipts.js";
import type { Receipt } from "@scopebond/verify";

function ensureDir(file: string): void {
  const dir = dirname(file);
  if (dir) mkdirSync(dir, { recursive: true });
}

/** Append-only JSONL receipt log: durable, dependency-free, append-only (so the
 *  record is not silently rewritten). Loads the log into memory on open. */
export class FileReceiptStore implements ReceiptStore {
  private cache: SignedReceipt[] = [];
  constructor(private readonly file: string) {
    ensureDir(file);
    if (existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        const t = line.trim();
        if (t) this.cache.push(JSON.parse(t) as SignedReceipt);
      }
    }
  }
  put(r: SignedReceipt): void {
    appendFileSync(this.file, JSON.stringify(r) + "\n");
    this.cache.push(r);
  }
  list(): SignedReceipt[] { return this.cache.slice(); }
  executed(): Receipt[] { return this.cache.map((r) => r.payload as unknown as Receipt); }
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
  executed(): Receipt[] { return this.list().map((r) => r.payload as unknown as Receipt); }
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
