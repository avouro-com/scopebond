// Records that did not reach the delivery queue, and actions whose evaluation never finished, are put right on the next flush.
//
// 1. A failed queue write. The receipt is written to the local log first and queued second. When the queue cannot be opened,
//    or its write lock is held past the short wait a tool call allows, the action stays allowed and its receipt stays in the
//    local log, and the miss is noted in a small file beside the log (the queue itself is the thing that failed). The next
//    flush keeps each miss as an `outbox_error` gap in the queue, which the rules check reports to the workspace, and queues
//    every receipt written since the miss that the queue does not know yet, in log order.
// 2. An interrupted evaluation. A hook process stopped between reserving an action and writing its receipt (the coding agent's
//    hook time limit, a crash) leaves the action open with no receipt. Once it is older than any hook time limit Scopebond
//    installs, the next flush (a hook call or the Scopebond Agent) closes it with a signed receipt that says the outcome is
//    unknown, and queues it like any other.

import { appendFileSync, closeSync, constants as fsConstants, existsSync, fstatSync, futimesSync, openSync, readFileSync, renameSync, unlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { errorCode, readIfPresent } from "./safe-fs.js";
import { SqliteReceiptStore } from "@scopebond/gateway/node";
import { attesterFromPrivateKeyPem, buildReceipt, type ActionLifecycleRecord, type Attester, type AuthorityFinalState, type SignedReceipt } from "@scopebond/gateway";

/** Misses noted while the queue could not be written, one JSON line each: `{ after, id, at }` (`after`: the newest local
 *  receipt row before the miss; `id`: the action id, or null for a line that only resumes a backfill). */
export const BACKFILL_FILE = "delivery-backfill.jsonl";
const WORK_FILE = "delivery-backfill.work.jsonl";
/** A backfill another process started and has not finished within this long is taken over. */
const WORK_STALE_MS = 2 * 60_000;
/** Local receipts one flush looks at for backfill; the rest wait for the next flush. */
const BACKFILL_ROWS = 2_000;

/** An evaluation still open after this long was stopped: well past the longest hook time limit Scopebond installs (Claude Code's
 *  60 s default; the Codex entry says 30 s). */
export const INTERRUPTED_AFTER_MS = 5 * 60_000;
/** The execution reference of a receipt that closes an interrupted evaluation. */
export const INTERRUPTED_REFERENCE = "scopebond:evaluation-interrupted";

/** The receipt store calls this module needs (the SQLite store has them). */
export interface RepairableStore {
  page(afterId: number, limit: number): Array<{ id: number; receipt: SignedReceipt }>;
  lastId(): number;
  interruptedActions(isoBefore: string, limit?: number): ActionLifecycleRecord[];
  settleAction(actionId: string, receipt: SignedReceipt, state: AuthorityFinalState): boolean;
}
/** The delivery queue calls this module needs. */
export interface RepairableQueue {
  enqueue(receipt: SignedReceipt): { queued: boolean; duplicate: boolean };
  known(ids: string[]): Set<string>;
  recordGap(id: string | null, reason: "outbox_error"): unknown;
}

export function isRepairableStore(store: unknown): store is RepairableStore {
  const s = store as Partial<RepairableStore> | null;
  return !!s && typeof s.page === "function" && typeof s.lastId === "function" && typeof s.interruptedActions === "function" && typeof s.settleAction === "function";
}

/** Note that a receipt was kept locally but not queued. Never throws: the decision is already made. */
export function noteQueueMiss(dir: string, after: number, actionId: string | null, at = Date.now()): void {
  try { appendFileSync(join(dir, BACKFILL_FILE), JSON.stringify({ after: Math.max(0, Math.trunc(after)), id: actionId, at }) + "\n"); }
  catch { /* the queue error itself is what status and doctor report */ }
}

interface MissLine { after: number; id: string | null; at?: number }

function readLines(file: string): MissLine[] {
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { return []; }
  return text.split("\n").flatMap((line) => {
    try {
      const parsed = JSON.parse(line) as Partial<MissLine>;
      return typeof parsed.after === "number" && Number.isFinite(parsed.after)
        ? [{ after: parsed.after, id: typeof parsed.id === "string" ? parsed.id : null, ...(typeof parsed.at === "number" ? { at: parsed.at } : {}) }] : [];
    } catch { return []; }
  });
}

/** Take the noted misses for this process to work on, or null when there are none (or another process is on them). */
function claim(dir: string, now: number): string | null {
  const main = join(dir, BACKFILL_FILE);
  const work = join(dir, WORK_FILE);
  try {
    // Open an existing work file (never create one): its age and the take-over below use this one descriptor.
    let fd: number | undefined;
    try { fd = openSync(work, fsConstants.O_RDWR | fsConstants.O_APPEND); }
    catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
    if (fd !== undefined) {
      try {
        if (now - fstatSync(fd).mtimeMs < WORK_STALE_MS) return null;
        // A process stopped while backfilling: take its work over, with anything noted since.
        const noted = readIfPresent(main);
        if (noted !== undefined) { appendFileSync(fd, noted); unlinkSync(main); }
        futimesSync(fd, new Date(now), new Date(now));
      } finally { closeSync(fd); }
      return work;
    }
    try { renameSync(main, work); }
    catch (error) { if (errorCode(error) === "ENOENT") return null; throw error; }
    utimesSync(work, new Date(now), new Date(now));
    return work;
  } catch { return null; }
}

/** Queue the receipts the queue never got. Returns how many gaps were kept and how many receipts were queued. */
export function backfillQueue(dir: string, store: RepairableStore, queue: RepairableQueue, options: { now?: number; kid?: string | null } = {}): { gaps: number; queued: number } {
  const now = options.now ?? Date.now();
  const work = claim(dir, now);
  if (!work) return { gaps: 0, queued: 0 };
  const lines = readLines(work);
  let queued = 0;
  try {
    let after = lines.length ? Math.min(...lines.map((l) => l.after)) : Number.POSITIVE_INFINITY;
    let seen = 0;
    while (Number.isFinite(after) && seen < BACKFILL_ROWS) {
      const page = store.page(after, 200);
      if (!page.length) { after = Number.POSITIVE_INFINITY; break; }
      seen += page.length;
      const ids = page.flatMap((row) => (row.receipt.payload.action_ref?.action_id ? [row.receipt.payload.action_ref.action_id] : []));
      const known = queue.known(ids);
      for (const row of page) {
        const id = row.receipt.payload.action_ref?.action_id;
        // A receipt without an action id cannot be queued; one signed by an earlier key is `recover`'s to send.
        if (!id || known.has(id) || (options.kid && row.receipt.payload.attester?.kid !== options.kid)) continue;
        const result = queue.enqueue(row.receipt);
        if (result.queued && !result.duplicate) queued++;
      }
      after = page[page.length - 1].id;
    }
    // Each miss is kept as a gap once, after its receipts are queued (a failure above leaves the noted misses for next time).
    // A line without a time only resumes a backfill.
    let kept = 0;
    for (const line of lines) {
      if (line.at === undefined) continue;
      queue.recordGap(line.id, "outbox_error");
      kept++;
    }
    // Rows left for the next flush.
    if (Number.isFinite(after)) appendFileSync(join(dir, BACKFILL_FILE), JSON.stringify({ after, id: null }) + "\n");
    unlinkSync(work);
    return { gaps: kept, queued };
  } catch {
    // The queue failed again: give the noted misses back for the next flush.
    try { appendFileSync(join(dir, BACKFILL_FILE), readFileSync(work, "utf8")); unlinkSync(work); } catch { /* the work file is taken over later */ }
    return { gaps: 0, queued };
  }
}

/** Close evaluations that were stopped before their receipt, each with a signed receipt saying the outcome is unknown: the
 *  decision the policy made stays in it, and whether the coding agent ran the action is not known (a hook that times out may
 *  let the action run). Without a key to sign with, nothing is closed. Returns the receipts written. */
export async function settleInterruptedActions(store: RepairableStore, attester: Attester | null, options: { now?: number; limit?: number } = {}): Promise<SignedReceipt[]> {
  if (!attester) return [];
  const now = options.now ?? Date.now();
  const settled: SignedReceipt[] = [];
  for (const record of store.interruptedActions(new Date(now - INTERRUPTED_AFTER_MS).toISOString(), options.limit ?? 20)) {
    const context = record.reservation.receipt_context;
    if (!context) continue; // an action reserved by a version that kept no receipt context
    const denied = record.state === "denied";
    const receipt = await buildReceipt({
      ...context,
      attester: { kind: "gateway", kid: attester.kid },
      realtime_result: record.realtime_result ?? (denied ? "deny" : "allow"),
      executed: false,
      execution_ref: INTERRUPTED_REFERENCE,
      execution: { state: "outcome_unknown", assertion: "adapter_outcome_unknown", reference: INTERRUPTED_REFERENCE, external_effect: "not_independently_verified" },
    }, attester);
    if (store.settleAction(record.action_id, receipt, denied ? "denied" : "cooperative_allow")) settled.push(receipt);
  }
  return settled;
}

/** One repair pass: close interrupted evaluations, then queue what the queue never got. `queue` null: it cannot be opened
 *  now, so closing receipts are noted for the next pass (when `connected`). Never throws. */
export async function repairDelivery(input: {
  dir: string; store: RepairableStore; queue: RepairableQueue | null; attester: Attester | null; connected: boolean; now?: number;
}): Promise<{ settled: number; gaps: number; queued: number }> {
  const now = input.now ?? Date.now();
  let settled = 0;
  try {
    const before = input.store.lastId();
    const receipts = await settleInterruptedActions(input.store, input.attester, { now });
    settled = receipts.length;
    for (const receipt of receipts) {
      const id = receipt.payload.action_ref?.action_id ?? null;
      if (!input.queue) { if (input.connected) noteQueueMiss(input.dir, before, id, now); continue; }
      try { input.queue.enqueue(receipt); } catch { noteQueueMiss(input.dir, before, id, now); }
    }
  } catch { /* the next pass tries again */ }
  if (!input.queue) return { settled, gaps: 0, queued: 0 };
  try { return { settled, ...backfillQueue(input.dir, input.store, input.queue, { now, kid: input.attester?.kid ?? null }) }; }
  catch { return { settled, gaps: 0, queued: 0 }; }
}

/** The Scopebond Agent's repair pass over `<dir>/receipts.db`, with the queue it delivers from. Signs with the computer's own
 *  countersigning key when there is one (never makes a key). Never throws. */
export async function repairDeliveryAt(dir: string, queue: RepairableQueue, now = Date.now()): Promise<{ settled: number; gaps: number; queued: number }> {
  const none = { settled: 0, gaps: 0, queued: 0 };
  const dbPath = join(dir, "receipts.db");
  if (!existsSync(dbPath)) return none;
  try {
    const keyFile = join(dir, "attester.key");
    const attester = existsSync(keyFile) ? attesterFromPrivateKeyPem(readFileSync(keyFile, "utf8")) : null;
    const store = new SqliteReceiptStore(dbPath);
    try {
      if (!store.layoutCurrent()) return none; // upkeep migrates an older file first
      return await repairDelivery({ dir, store, queue, attester, connected: true, now });
    } finally { store.close(); }
  } catch { return none; }
}
