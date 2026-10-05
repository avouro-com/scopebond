// The local observation outbox.
//
// One SQLite file (`observations.db`, beside the receipts) holds everything that must
// survive a process exit, because the hook is a short-lived process per tool call:
//
//   state     the installation generation, the next sequence to allocate, the upload
//             capability (active / unsupported / blocked) and a backoff deadline
//   pending   signed observations not yet acknowledged, in sequence order
//   terminal  observations the server refused permanently (or a stale generation made
//             unsendable). They are kept, visible in `status`, and never retried.
//   sessions  which harness sessions are active, and the heartbeat owner lease
//   calls     the operation of each dispatched tool call, so the after-action hook can
//             echo the same binding
//
// Sequence allocation and the pending row are written in ONE `BEGIN IMMEDIATE`
// transaction, so a crash between the two cannot leave a gap or a reused number, and two
// hook processes cannot allocate the same one. An observation id is unique, so a resend
// of the same logical record returns the row that exists rather than allocating again.

import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MAX_BATCH_BODY_BYTES, MAX_BATCH_ITEMS, observationHash, type ObservationDraft, type ObservationPayload, type SignedObservation, type EnvelopeContext, buildPayload, signObservation, type ObservationSigner } from "./observation.js";

interface SqliteStatement { run(...args: unknown[]): unknown; all(...args: unknown[]): unknown[]; get(...args: unknown[]): unknown }
interface SqliteDb { exec(sql: string): void; prepare(sql: string): SqliteStatement; close(): void }

export const OBSERVATION_DB = "observations.db";

/** Bounds on the local queue. Past them new observations are counted as dropped (visible
 *  in `status`) rather than growing without limit; enforcement never depends on the queue. */
export const MAX_PENDING = 5_000;
export const MAX_PENDING_BYTES = 32 * 1024 * 1024;
export const MAX_TERMINAL = 1_000;
/** How long a route found missing is left alone before one upload probes it again. */
/** How long a batch stays reserved for the process that took it. */
export const INFLIGHT_MS = 30_000;
export const UNSUPPORTED_RECHECK_MS = 24 * 60 * 60 * 1000;

export type Capability = "active" | "unsupported" | "blocked";

export interface StoreState {
  generation: number;
  next_sequence: number;
  capability: Capability;
  reason: string | null;
  capability_at: number | null;
  backoff_until: number;
  last_error: string | null;
  last_upload_at: number | null;
  dropped: number;
  batch_limit: number;
}

export interface PendingRow {
  sequence: number;
  generation: number;
  observation_id: string;
  observation_hash: string;
  kind: string;
  wrapper: SignedObservation;
  bytes: number;
  enqueued_at: number;
  attempts: number;
  next_attempt_at: number;
}

export interface TerminalRow {
  id: number;
  generation: number;
  sequence: number;
  observation_id: string;
  kind: string;
  code: string;
  at: number;
  wrapper: SignedObservation | null;
}

export interface SessionRow {
  session_id: string;
  state: "active" | "stopped";
  started_at: number;
  last_activity_at: number;
  last_heartbeat_at: number;
  heartbeat_lease_until: number;
  repository_id: string | null;
  stopped_reason: string | null;
}

export interface CallRow {
  call_key: string;
  parent_action_id: string;
  source_receipt_hash: string;
  session_id: string | null;
  operation: Record<string, unknown>;
  at: number;
}

export type EnqueueResult =
  | { queued: true; duplicate: boolean; sequence: number; observation_id: string }
  | { queued: false; reason: "unsupported" | "blocked" | "capacity" | "oversize" | "generation_mismatch"; detail?: string };

function open(path: string): SqliteDb {
  mkdirSync(dirname(path), { recursive: true });
  const require = createRequire(import.meta.url);
  const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (p: string) => SqliteDb };
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
  return db;
}

export class ObservationStore {
  private readonly db: SqliteDb;

  constructor(path: string, private readonly now: () => number = Date.now) {
    this.db = open(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        generation INTEGER NOT NULL, next_sequence INTEGER NOT NULL,
        capability TEXT NOT NULL DEFAULT 'active', reason TEXT, capability_at INTEGER,
        backoff_until INTEGER NOT NULL DEFAULT 0, last_error TEXT, last_upload_at INTEGER,
        dropped INTEGER NOT NULL DEFAULT 0, batch_limit INTEGER NOT NULL DEFAULT ${MAX_BATCH_ITEMS}
      );
      CREATE TABLE IF NOT EXISTS pending (
        generation INTEGER NOT NULL, sequence INTEGER NOT NULL,
        observation_id TEXT NOT NULL UNIQUE, observation_hash TEXT NOT NULL, kind TEXT NOT NULL,
        wrapper TEXT NOT NULL, bytes INTEGER NOT NULL, enqueued_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (generation, sequence)
      );
      CREATE TABLE IF NOT EXISTS terminal (
        id INTEGER PRIMARY KEY AUTOINCREMENT, generation INTEGER NOT NULL, sequence INTEGER NOT NULL,
        observation_id TEXT NOT NULL, kind TEXT NOT NULL, code TEXT NOT NULL, at INTEGER NOT NULL, wrapper TEXT
      );
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY, state TEXT NOT NULL, started_at INTEGER NOT NULL,
        last_activity_at INTEGER NOT NULL, last_heartbeat_at INTEGER NOT NULL DEFAULT 0,
        heartbeat_lease_until INTEGER NOT NULL DEFAULT 0, repository_id TEXT, stopped_reason TEXT
      );
      CREATE TABLE IF NOT EXISTS calls (
        call_key TEXT PRIMARY KEY, parent_action_id TEXT NOT NULL, source_receipt_hash TEXT NOT NULL,
        session_id TEXT, operation TEXT NOT NULL, at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS marks (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
    `);
  }

  close(): void { try { this.db.close(); } catch { /* already closed */ } }

  private tx<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = work(); this.db.exec("COMMIT"); return result; }
    catch (error) { try { this.db.exec("ROLLBACK"); } catch { /* the original error matters */ } throw error; }
  }

  state(): StoreState | null {
    return (this.db.prepare("SELECT generation, next_sequence, capability, reason, capability_at, backoff_until, last_error, last_upload_at, dropped, batch_limit FROM state WHERE singleton = 1").get() as StoreState | undefined) ?? null;
  }

  /**
   * Bind the outbox to the installation generation the workspace enrolled. A higher
   * generation than the stored one means the key or credential was rotated: sequence
   * restarts at 1, and everything still pending under the old generation moves to the
   * terminal queue as `stale_generation` (kept locally, never uploaded). A generation
   * lower than the stored one is a stale connection file and reported, not adopted.
   */
  bindGeneration(generation: number): { ok: true; retired: number } | { ok: false; reason: string } {
    return this.tx(() => {
      const state = this.state();
      const at = this.now();
      if (!state) {
        this.db.prepare("INSERT INTO state (singleton, generation, next_sequence) VALUES (1, ?, 1)").run(generation);
        return { ok: true as const, retired: 0 };
      }
      if (generation < state.generation) return { ok: false as const, reason: `connection generation ${generation} is older than the local generation ${state.generation}` };
      if (generation === state.generation) return { ok: true as const, retired: 0 };
      const stale = this.db.prepare("SELECT generation, sequence, observation_id, kind, wrapper FROM pending WHERE generation < ?").all(generation) as Array<{ generation: number; sequence: number; observation_id: string; kind: string; wrapper: string }>;
      for (const row of stale) {
        this.db.prepare("INSERT INTO terminal (generation, sequence, observation_id, kind, code, at, wrapper) VALUES (?, ?, ?, ?, 'stale_generation', ?, ?)").run(row.generation, row.sequence, row.observation_id, row.kind, at, row.wrapper);
      }
      this.db.prepare("DELETE FROM pending WHERE generation < ?").run(generation);
      this.db.prepare("UPDATE state SET generation = ?, next_sequence = 1, capability = CASE WHEN capability = 'blocked' THEN 'active' ELSE capability END, reason = CASE WHEN capability = 'blocked' THEN NULL ELSE reason END, backoff_until = 0 WHERE singleton = 1").run(generation);
      this.trimTerminal();
      return { ok: true as const, retired: stale.length };
    });
  }

  /**
   * Allocate the next sequence, build and sign the payload, and store it, atomically.
   * `observationId` makes the call idempotent: an id already stored (pending or already
   * sent) returns without consuming a sequence.
   */
  enqueue(draft: ObservationDraft, context: EnvelopeContext, signer: ObservationSigner): EnqueueResult {
    return this.tx((): EnqueueResult => {
      const state = this.state();
      const at = this.now();
      if (!state || state.generation !== context.generation) return { queued: false, reason: "generation_mismatch" };
      if (draft.observationId) {
        const existing = this.db.prepare("SELECT sequence FROM pending WHERE observation_id = ?").get(draft.observationId) as { sequence: number } | undefined;
        if (existing) return { queued: true, duplicate: true, sequence: existing.sequence, observation_id: draft.observationId };
      }
      if (state.capability === "blocked") return { queued: false, reason: "blocked", detail: state.reason ?? undefined };
      if (state.capability === "unsupported") {
        if ((state.capability_at ?? 0) + UNSUPPORTED_RECHECK_MS > at) return { queued: false, reason: "unsupported", detail: state.reason ?? undefined };
        // One probe after the recheck interval: the server may have been upgraded.
        this.db.prepare("UPDATE state SET capability = 'active', reason = NULL, capability_at = NULL, backoff_until = 0 WHERE singleton = 1").run();
      }
      const totals = this.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM pending").get() as { n: number; b: number };
      const sequence = state.next_sequence;
      let wrapper: SignedObservation;
      try { wrapper = signObservation(buildPayload(draft, context, sequence), signer); }
      catch (error) {
        if (error instanceof RangeError) return { queued: false, reason: "oversize", detail: error.message };
        throw error;
      }
      const json = JSON.stringify(wrapper);
      const bytes = Buffer.byteLength(json, "utf8");
      if (totals.n >= MAX_PENDING || totals.b + bytes > MAX_PENDING_BYTES) {
        this.db.prepare("UPDATE state SET dropped = dropped + 1 WHERE singleton = 1").run();
        return { queued: false, reason: "capacity" };
      }
      this.db.prepare("INSERT INTO pending (generation, sequence, observation_id, observation_hash, kind, wrapper, bytes, enqueued_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(context.generation, sequence, wrapper.payload.observation_id, observationHash(wrapper.payload), wrapper.payload.kind, json, bytes, at);
      this.db.prepare("UPDATE state SET next_sequence = ? WHERE singleton = 1").run(sequence + 1);
      return { queued: true, duplicate: false, sequence, observation_id: wrapper.payload.observation_id };
    });
  }

  private rowToPending(row: Record<string, unknown>): PendingRow {
    return { ...(row as unknown as PendingRow), wrapper: JSON.parse(String(row.wrapper)) as SignedObservation };
  }

  /** The next batch to send: current generation, in sequence order, due now, within the
   *  item and body limits. With `lease`, the rows are marked in flight for INFLIGHT_MS in the
   *  same transaction, so a second hook process uploading at the same moment skips them
   *  instead of sending the same items again. The sender releases or defers them afterwards
   *  (a crashed sender's lease simply lapses). */
  nextBatch(limit?: number, lease = false): PendingRow[] {
    return this.tx(() => {
      const state = this.state();
      if (!state || state.capability !== "active") return [];
      const at = this.now();
      if (state.backoff_until > at) return [];
      const rows = this.db.prepare("SELECT * FROM pending WHERE generation = ? AND next_attempt_at <= ? ORDER BY sequence LIMIT ?")
        .all(state.generation, at, Math.max(1, Math.min(limit ?? state.batch_limit, state.batch_limit, MAX_BATCH_ITEMS))) as Array<Record<string, unknown>>;
      const out: PendingRow[] = [];
      let body = 64;
      for (const row of rows) {
        const bytes = Number(row.bytes) + 1;
        if (out.length > 0 && body + bytes > MAX_BATCH_BODY_BYTES) break;
        body += bytes;
        out.push(this.rowToPending(row));
      }
      if (lease) for (const row of out) this.db.prepare("UPDATE pending SET next_attempt_at = ? WHERE observation_id = ?").run(at + INFLIGHT_MS, row.observation_id);
      return out;
    });
  }

  /** Give leased rows back without counting an attempt (the send did not happen). */
  release(observationIds: string[]): void {
    this.tx(() => { for (const id of observationIds) this.db.prepare("UPDATE pending SET next_attempt_at = 0 WHERE observation_id = ?").run(id); });
  }

  pendingSummary(): { count: number; oldest_at: number | null } {
    const row = this.db.prepare("SELECT COUNT(*) AS n, MIN(enqueued_at) AS o FROM pending").get() as { n: number; o: number | null };
    return { count: row.n, oldest_at: row.o };
  }

  /** Remove acknowledged items (accepted, duplicate, pending_link) — and only those. */
  acknowledge(observationIds: string[]): void {
    this.tx(() => { for (const id of observationIds) this.db.prepare("DELETE FROM pending WHERE observation_id = ?").run(id); });
    this.mark("last_ack", this.now());
    this.db.prepare("UPDATE state SET last_upload_at = ?, last_error = NULL WHERE singleton = 1").run(this.now());
  }

  /** Move permanently refused items to the visible terminal queue. */
  reject(items: Array<{ observation_id: string; code: string }>): void {
    this.tx(() => {
      const at = this.now();
      for (const item of items) {
        const row = this.db.prepare("SELECT generation, sequence, kind, wrapper FROM pending WHERE observation_id = ?").get(item.observation_id) as { generation: number; sequence: number; kind: string; wrapper: string } | undefined;
        if (!row) continue;
        this.db.prepare("INSERT INTO terminal (generation, sequence, observation_id, kind, code, at, wrapper) VALUES (?, ?, ?, ?, ?, ?, ?)").run(row.generation, row.sequence, item.observation_id, row.kind, item.code, at, row.wrapper);
        this.db.prepare("DELETE FROM pending WHERE observation_id = ?").run(item.observation_id);
      }
      this.trimTerminal();
    });
  }

  /** Keep items pending but retry them later (server said deferred, or the send failed). */
  defer(observationIds: string[], delayMs: number): void {
    const at = this.now() + Math.max(0, delayMs);
    this.tx(() => { for (const id of observationIds) this.db.prepare("UPDATE pending SET attempts = attempts + 1, next_attempt_at = ? WHERE observation_id = ?").run(at, id); });
  }

  setBackoff(untilMs: number, error: string | null): void {
    this.db.prepare("UPDATE state SET backoff_until = ?, last_error = ? WHERE singleton = 1").run(untilMs, error);
  }

  setBatchLimit(limit: number): void {
    this.db.prepare("UPDATE state SET batch_limit = ? WHERE singleton = 1").run(Math.max(1, Math.min(MAX_BATCH_ITEMS, Math.trunc(limit))));
  }

  /** Mark the capability unsupported (route missing, batch version refused) or blocked
   *  (stale generation). New observations are then not queued; local enforcement is
   *  untouched. Pending items are kept. */
  setCapability(capability: Capability, reason: string | null): void {
    this.db.prepare("UPDATE state SET capability = ?, reason = ?, capability_at = ? WHERE singleton = 1").run(capability, reason, capability === "active" ? null : this.now());
  }

  /** Move everything pending to the terminal queue with `code` (a stale generation makes
   *  the whole backlog unsendable). */
  rejectAllPending(code: string): number {
    const ids = (this.db.prepare("SELECT observation_id FROM pending").all() as Array<{ observation_id: string }>).map((r) => r.observation_id);
    this.reject(ids.map((observation_id) => ({ observation_id, code })));
    return ids.length;
  }

  terminal(limit = 50): TerminalRow[] {
    return (this.db.prepare("SELECT * FROM terminal ORDER BY id DESC LIMIT ?").all(limit) as Array<Record<string, unknown>>)
      .map((r) => ({ ...(r as unknown as TerminalRow), wrapper: r.wrapper ? (JSON.parse(String(r.wrapper)) as SignedObservation) : null }));
  }

  terminalCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.db.prepare("SELECT code, COUNT(*) AS n FROM terminal GROUP BY code").all() as Array<{ code: string; n: number }>) out[r.code] = r.n;
    return out;
  }

  private trimTerminal(): void {
    this.db.prepare("DELETE FROM terminal WHERE id NOT IN (SELECT id FROM terminal ORDER BY id DESC LIMIT ?)").run(MAX_TERMINAL);
  }

  // ---- marks (small named integers, e.g. when queue telemetry last ran) --------------------

  mark(name: string, value: number): void {
    this.db.prepare("INSERT INTO marks (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value").run(name, value);
  }
  getMark(name: string): number | null {
    const row = this.db.prepare("SELECT value FROM marks WHERE name = ?").get(name) as { value: number } | undefined;
    return row ? row.value : null;
  }

  // ---- sessions and the heartbeat lease --------------------------------------------------------

  session(sessionId: string): SessionRow | null {
    return (this.db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(sessionId) as SessionRow | undefined) ?? null;
  }

  /** Begin (or resume) a session. Returns true when the session was not active before,
   *  so the caller emits exactly one start. */
  activateSession(sessionId: string, repositoryId: string | null): boolean {
    return this.tx(() => {
      const at = this.now();
      const row = this.session(sessionId);
      if (row?.state === "active") {
        this.db.prepare("UPDATE sessions SET last_activity_at = ? WHERE session_id = ?").run(at, sessionId);
        return false;
      }
      this.db.prepare("INSERT INTO sessions (session_id, state, started_at, last_activity_at, repository_id) VALUES (?, 'active', ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET state = 'active', stopped_reason = NULL, started_at = excluded.started_at, last_activity_at = excluded.last_activity_at, heartbeat_lease_until = 0, repository_id = excluded.repository_id")
        .run(sessionId, at, at, repositoryId);
      return true;
    });
  }

  touchSession(sessionId: string): void {
    this.db.prepare("UPDATE sessions SET last_activity_at = ? WHERE session_id = ? AND state = 'active'").run(this.now(), sessionId);
  }

  /** End a session. Returns true when it was active, so exactly one stop is emitted. */
  deactivateSession(sessionId: string, reason: string): boolean {
    return this.tx(() => {
      const row = this.session(sessionId);
      if (!row || row.state !== "active") return false;
      this.db.prepare("UPDATE sessions SET state = 'stopped', stopped_reason = ?, heartbeat_lease_until = 0 WHERE session_id = ?").run(reason, sessionId);
      return true;
    });
  }

  activeSessions(): SessionRow[] {
    return this.db.prepare("SELECT * FROM sessions WHERE state = 'active' ORDER BY started_at").all() as unknown as SessionRow[];
  }

  /** Claim the single heartbeat loop for a session, or refuse when another live loop
   *  already holds it. The lease is short and renewed each tick, so a crashed loop frees
   *  the claim within `leaseMs`. This is what keeps the number of helper processes at one
   *  per active session no matter how many hook calls run. */
  claimHeartbeat(sessionId: string, leaseMs: number): boolean {
    return this.tx(() => {
      const row = this.session(sessionId);
      const at = this.now();
      if (!row || row.state !== "active" || row.heartbeat_lease_until > at) return false;
      this.db.prepare("UPDATE sessions SET heartbeat_lease_until = ? WHERE session_id = ?").run(at + leaseMs, sessionId);
      return true;
    });
  }

  /** Renew the loop's own claim; false when the session ended or the claim was lost. */
  renewHeartbeat(sessionId: string, leaseMs: number, sentHeartbeat: boolean): boolean {
    return this.tx(() => {
      const row = this.session(sessionId);
      if (!row || row.state !== "active") return false;
      const at = this.now();
      this.db.prepare("UPDATE sessions SET heartbeat_lease_until = ?, last_heartbeat_at = CASE WHEN ? THEN ? ELSE last_heartbeat_at END WHERE session_id = ?").run(at + leaseMs, sentHeartbeat ? 1 : 0, at, sessionId);
      return true;
    });
  }

  releaseHeartbeat(sessionId: string): void {
    this.db.prepare("UPDATE sessions SET heartbeat_lease_until = 0 WHERE session_id = ?").run(sessionId);
  }

  // ---- dispatched-call records -----------------------------------------------------------------

  recordCall(call: Omit<CallRow, "at">): void {
    const at = this.now();
    this.tx(() => {
      this.db.prepare("INSERT OR REPLACE INTO calls (call_key, parent_action_id, source_receipt_hash, session_id, operation, at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(call.call_key, call.parent_action_id, call.source_receipt_hash, call.session_id, JSON.stringify(call.operation), at);
      // Calls whose outcome never arrived (a denied action, a crashed tool) are dropped after a day.
      this.db.prepare("DELETE FROM calls WHERE at < ?").run(at - 24 * 60 * 60 * 1000);
    });
  }

  /** The calls recorded under a harness call id, consumed by the after-action hook. */
  takeCalls(callPrefix: string): CallRow[] {
    return this.tx(() => {
      const rows = this.db.prepare("SELECT * FROM calls WHERE call_key LIKE ? ESCAPE '\\' ORDER BY call_key").all(`${callPrefix.replace(/[\\%_]/g, "\\$&")}%`) as Array<Record<string, unknown>>;
      this.db.prepare("DELETE FROM calls WHERE call_key LIKE ? ESCAPE '\\'").run(`${callPrefix.replace(/[\\%_]/g, "\\$&")}%`);
      return rows.map((r) => ({ ...(r as unknown as CallRow), operation: JSON.parse(String(r.operation)) as Record<string, unknown> }));
    });
  }
}

/** Convenience for callers that only have a payload. */
export type { ObservationPayload };
