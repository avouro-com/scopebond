// Optional gateway → Scopebond Cloud exporter. The gateway stores locally first;
// a bounded outbox then retries evidence-v1 receipts without weakening execution.

import { canonical, sha256 } from "./crypto.js";
import type { ReceiptStore, SignedReceipt } from "./receipts.js";

export interface CloudOutboxEntry {
  id: string;
  payloadHash: string;
  receipt: SignedReceipt;
  enqueuedAt: number;
  bytes: number;
  /** SB289: this computer's number for the record, 1, 2, 3… in the order it was queued, never reused.
   *  The workspace compares the numbers it has seen with how many it received, so a record lost on
   *  the computer (aged out, or a queue that was deleted) shows as missing instead of silently absent.
   *  Absent for a record queued before numbering existed. */
  seq?: number;
}

export interface CloudDeliveryGap {
  id: string | null;
  reason: "missing_action_id" | "id_conflict" | "capacity" | "expired" | "outbox_error" | "rekeyed" | "rejected";
  at: number;
}

export interface CloudOutboxStatus {
  pending: number;
  pendingBytes: number;
  oldestEnqueuedAt: number | null;
  gaps: number;
  retainedGapRecords: number;
  latestGap: CloudDeliveryGap | null;
  /** SB289: this queue's own id, made once when the queue is created. A queue that was removed and
   *  made again gets a new id, so the workspace can tell numbering that restarted from a resend. */
  queueId?: string;
  /** SB289: the highest number this queue has given a record so far (0 before the first). */
  seqAssigned?: number;
}

export interface CloudOutbox {
  enqueue(receipt: SignedReceipt): { queued: boolean; duplicate: boolean; gap?: CloudDeliveryGap };
  /** The oldest records first; `exclude` leaves out records this flush already kept back (a clock ahead). */
  peek(limit: number, now: number, exclude?: ReadonlySet<string>): CloudOutboxEntry[];
  acknowledge(entries: Array<{ id: string; payloadHash: string }>): void;
  status(): CloudOutboxStatus;
  /** How many records wait, from a kept total rather than a count of the queue. Optional; `status().pending` otherwise. */
  pendingCount?(): number;
  /** Record a delivery gap the exporter learned of (a record the workspace refused on its own). */
  recordGap?(id: string | null, reason: CloudDeliveryGap["reason"]): CloudDeliveryGap;
  close?(): void;
}

export interface CloudExporterStatus extends CloudOutboxStatus {
  consecutiveFailures: number;
  nextAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
}

export interface CloudExporter {
  enqueue(r: SignedReceipt): void;
  flush(): Promise<void>;
  stop(): void;
  pending(): number;
  status(): CloudExporterStatus;
}

export interface CloudExporterOptions {
  url: string;
  /** Scoped machine credential returned once by gateway enrollment. */
  credential: string;
  /** Durable outbox. The CLI supplies a SQLite implementation. */
  outbox: CloudOutbox;
  /** Max receipts per POST (Cloud accepts at most 100). */
  batchSize?: number;
  flushMs?: number;
  maxRetryMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
  onError?: (e: unknown) => void;
  onGap?: (gap: CloudDeliveryGap) => void;
  /** Compress a batch with gzip once the workspace has said it reads gzip (`Accept-Encoding: gzip` on an
   *  ingest answer), when the batch is at least this many bytes. Default 1024; 0 turns compression off. */
  gzipMinBytes?: number;
}

/** A batch body as gzip bytes. */
async function gzipBody(text: string): Promise<ArrayBuffer> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

export interface MemoryCloudOutboxOptions {
  maxPending?: number;
  maxBytes?: number;
  maxAgeMs?: number;
  now?: () => number;
}

export function createMemoryCloudOutbox(options: MemoryCloudOutboxOptions = {}): CloudOutbox {
  const maxPending = options.maxPending ?? 10_000;
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  const maxAgeMs = options.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000;
  const now = options.now ?? Date.now;
  const entries = new Map<string, CloudOutboxEntry>();
  let nextSeq = 1;
  let queueId: string | undefined;
  let gapCount = 0;
  let latestGap: CloudDeliveryGap | null = null;

  const recordGap = (id: string | null, reason: CloudDeliveryGap["reason"]): CloudDeliveryGap => {
    const gap = { id, reason, at: now() };
    gapCount += 1;
    latestGap = gap;
    return gap;
  };
  const expire = (at: number) => {
    for (const [id, entry] of entries) {
      if (at - entry.enqueuedAt <= maxAgeMs) continue;
      entries.delete(id);
      recordGap(id, "expired");
    }
  };
  const status = (): CloudOutboxStatus => {
    const values = [...entries.values()];
    return {
      pending: values.length,
      pendingBytes: values.reduce((total, entry) => total + entry.bytes, 0),
      oldestEnqueuedAt: values[0]?.enqueuedAt ?? null,
      gaps: gapCount,
      retainedGapRecords: latestGap ? 1 : 0,
      latestGap,
      queueId: (queueId ??= randomQueueId()),
      seqAssigned: nextSeq - 1,
    };
  };

  return {
    enqueue(receipt) {
      expire(now());
      const id = receipt.payload.action_ref?.action_id;
      if (!id) return { queued: false, duplicate: false, gap: recordGap(null, "missing_action_id") };
      const receiptJson = canonical(receipt);
      const payloadHash = sha256(receiptJson);
      const existing = entries.get(id);
      if (existing) {
        if (existing.payloadHash === payloadHash) return { queued: true, duplicate: true };
        return { queued: false, duplicate: false, gap: recordGap(id, "id_conflict") };
      }
      const bytes = new TextEncoder().encode(receiptJson).byteLength;
      const current = status();
      if (current.pending >= maxPending || current.pendingBytes + bytes > maxBytes) {
        return { queued: false, duplicate: false, gap: recordGap(id, "capacity") };
      }
      entries.set(id, { id, payloadHash, receipt: structuredClone(receipt), enqueuedAt: now(), bytes, seq: nextSeq++ });
      return { queued: true, duplicate: false };
    },
    peek(limit, at, exclude) {
      expire(at);
      return [...entries.values()].filter((e) => !exclude?.has(e.id)).slice(0, Math.max(1, Math.min(100, Math.trunc(limit))));
    },
    acknowledge(sent) {
      for (const item of sent) {
        const entry = entries.get(item.id);
        if (entry?.payloadHash === item.payloadHash) entries.delete(item.id);
      }
    },
    status,
    recordGap,
  };
}

/** A random queue id: 32 hex characters, no dependency on node:crypto (the gateway also runs in Workers). */
export function randomQueueId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** "ingest failed: HTTP 401" plus, when the workspace named one, its refusal code and the one
 *  thing to do ("ingest failed: HTTP 401 (credential_refused): Sign it in again ..."). The prefix
 *  never changes, so anything that reads the status from it keeps working. Bounded and never throws. */
function refusalMessage(status: number, text: string): string {
  const base = "ingest failed: HTTP " + status;
  try {
    const body = JSON.parse(text) as { code?: unknown; remediation?: unknown };
    const code = typeof body.code === "string" && /^[a-z_]{1,40}$/.test(body.code) ? body.code : null;
    const remediation = typeof body.remediation === "string" ? body.remediation.replace(/[^\x20-\x7e]/g, " ").slice(0, 240) : null;
    return code ? `${base} (${code})${remediation ? ": " + remediation : ""}` : base;
  } catch {
    return base;
  }
}

/** A refused batch that no retry can deliver, settled so it never holds up the records behind it
 *  (DIC-1). Without this the exporter sent the same batch forever and every newer record waited.
 *  - 400 where the workspace refused every record on its own as invalid_receipt: each becomes a
 *    "rejected" gap, as it would inside an accepted batch. Any other code (a timestamp ahead of the
 *    workspace's clock, a key the connection did not enroll) can still be delivered: retried.
 *  - 409 id_conflict (an action id already used with different evidence): in a batch of several,
 *    "isolate" sends the rest one at a time to find the record; alone, it becomes an "id_conflict"
 *    gap. Any other 409 (an attester briefly unavailable) is retried.
 *  Anything else: null, and the batch is retried with backoff, as before. */
export function settleRefusal(status: number, text: string, batch: Array<Pick<CloudOutboxEntry, "id" | "enqueuedAt">>, at = Date.now()): Array<{ id: string; reason: CloudDeliveryGap["reason"] }> | "isolate" | null {
  let body: { code?: unknown; rejected?: unknown } | null;
  try { body = JSON.parse(text) as { code?: unknown; rejected?: unknown }; } catch { return null; }
  if (status === 400 && Array.isArray(body?.rejected)) {
    const rejected = body.rejected as Array<{ index?: unknown; code?: unknown }>;
    // Only records refused for good. A timestamp ahead of the workspace clock is accepted once the time
    // passes, and a key the connection did not enroll is delivered after signing in again: both are retried.
    // A record refused for a reason that can pass is settled too once it has been kept CLOCK_AHEAD_KEEP_MS.
    if (rejected.some((r) => r?.code !== "invalid_receipt" && !(RETRYABLE.has(String(r?.code)) && typeof r.index === "number" && batch[r.index] && !keepForClock(batch[r.index], r.code, at)))) return null;
    const indexes = new Set(rejected.flatMap((r) => (typeof r?.index === "number" ? [r.index] : [])));
    return batch.length > 0 && batch.every((_, i) => indexes.has(i)) ? batch.map((entry) => ({ id: entry.id, reason: "rejected" as const })) : null;
  }
  if (status === 409 && (body?.code === "id_conflict" || body?.code === "idempotency_conflict") && batch.length > 0) {
    return batch.length > 1 ? "isolate" : [{ id: batch[0].id, reason: "id_conflict" }];
  }
  return null;
}

/** Retry-After in milliseconds (seconds or an HTTP date), or 0. */
function retryAfter(res: Response, at: number): number {
  const value = res.headers?.get?.("retry-after")?.trim();
  if (!value) return 0;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const until = Date.parse(value);
  return Number.isFinite(until) ? Math.max(0, until - at) : 0;
}

/** The action ids of records a successful response lists as refused (`rejected[].index`). */
async function refusedIn(res: Response, batch: CloudOutboxEntry[]): Promise<Array<{ entry: CloudOutboxEntry; code: string | null }>> {
  try {
    if (typeof res.json !== "function") return [];
    const body = await res.json() as { rejected?: Array<{ index?: unknown; code?: unknown }> };
    if (!Array.isArray(body?.rejected)) return [];
    return body.rejected.flatMap((r) => typeof r?.index === "number" && batch[r.index]
      ? [{ entry: batch[r.index], code: typeof r.code === "string" ? r.code : null }] : []);
  } catch { return []; }
}

/** A refusal (400, or 409 for a key) that lists every record of the batch as refused for a reason that
 *  can pass, each still within CLOCK_AHEAD_KEEP_MS: the batch is kept back, not retried at once. */
function allRetryable(status: number, text: string, batch: Array<Pick<CloudOutboxEntry, "enqueuedAt">>, at: number): boolean {
  if (status !== 400 && status !== 409) return false;
  let body: { rejected?: unknown };
  try { body = JSON.parse(text) as { rejected?: unknown }; } catch { return false; }
  if (!Array.isArray(body?.rejected)) return false;
  const byIndex = new Map((body.rejected as Array<{ index?: unknown; code?: unknown }>).flatMap((r) => (typeof r?.index === "number" ? [[r.index, r.code] as const] : [])));
  return batch.length > 0 && batch.every((entry, i) => byIndex.has(i) && keepForClock(entry, byIndex.get(i), at));
}

/** Refusals that can pass: a timestamp ahead of the workspace's clock (accepted once the time passes)
 *  and a key the connection did not enroll (delivered after signing in again). */
const RETRYABLE = new Set(["future_timestamp", "attester_mismatch"]);
/** How long a record refused for one of those reasons is kept and sent again. After that it is settled
 *  as a gap, so a clock that is badly wrong, or a key that never comes back, cannot hold the queue for ever. */
export const CLOCK_AHEAD_KEEP_MS = 24 * 60 * 60 * 1000;
const keepForClock = (entry: Pick<CloudOutboxEntry, "enqueuedAt">, code: unknown, at: number) =>
  RETRYABLE.has(String(code)) && at - entry.enqueuedAt < CLOCK_AHEAD_KEEP_MS;

export function createCloudExporter(opts: CloudExporterOptions): CloudExporter {
  if (!opts.url.trim()) throw new TypeError("Cloud export URL is required");
  if (!opts.credential.trim()) throw new TypeError("Cloud machine credential is required");
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const batchSize = Math.max(1, Math.min(100, Math.trunc(opts.batchSize ?? 100)));
  const flushMs = Math.max(100, Math.trunc(opts.flushMs ?? 15_000));
  const maxRetryMs = Math.max(flushMs, Math.trunc(opts.maxRetryMs ?? 60_000));
  let base = opts.url;
  while (base.endsWith("/")) base = base.slice(0, -1);
  const endpoint = base + "/v1/ingest";
  let sending = false;
  let stopped = false;
  let consecutiveFailures = 0;
  let nextAttemptAt: number | null = null;
  let lastSuccessAt: number | null = null;
  let lastError: string | null = null;
  // Learned from the workspace's answers: only a workspace that says it reads gzip is sent gzip.
  let workspaceReadsGzip = false;
  const gzipMinBytes = Math.max(0, Math.trunc(opts.gzipMinBytes ?? 1024));

  const fail = (error: unknown, retryAfterMs = 0) => {
    consecutiveFailures += 1;
    const delay = Math.min(maxRetryMs, flushMs * (2 ** Math.min(consecutiveFailures - 1, 10)));
    // A workspace that asks to wait (429 or 503 with Retry-After) is not asked again sooner; at most an hour.
    nextAttemptAt = now() + Math.max(delay, Math.min(retryAfterMs, 3_600_000));
    lastError = error instanceof Error ? error.message : String(error);
    opts.onError?.(error);
  };

  async function flush(): Promise<void> {
    if (sending || stopped || (nextAttemptAt !== null && now() < nextAttemptAt)) return;
    sending = true;
    // After a 409 id_conflict on a batch, the rest of this flush goes one record at a time.
    let isolate = false;
    let queue: string | undefined | null = null;
    // Records kept back this flush (refused for a reason that can pass) are not sent again in it, so
    // they never hold up the records behind them or go out once per batch.
    const keptThisFlush = new Set<string>();
    let movedThisFlush = false;
    try {
      for (;;) {
        const batch = opts.outbox.peek(isolate ? 1 : batchSize, now(), keptThisFlush.size ? keptThisFlush : undefined);
        if (!batch.length) break;
        const numbered = batch.some((entry) => entry.seq !== undefined);
        if (numbered && queue === null) queue = opts.outbox.status().queueId;
        // SB289: each record's number travels beside it (the signed receipt is unchanged); a workspace
        // that does not read it ignores it.
        // The queue's id says which numbering the numbers belong to.
        const json = JSON.stringify(numbered
          ? { receipts: batch.map((entry) => entry.receipt), seq: batch.map((entry) => entry.seq ?? null), ...(numbered && queue ? { queue } : {}) }
          : { receipts: batch.map((entry) => entry.receipt) });
        const compress = workspaceReadsGzip && gzipMinBytes > 0 && json.length >= gzipMinBytes && typeof CompressionStream === "function";
        const res = await doFetch(endpoint, {
          method: "POST",
          headers: { authorization: "Bearer " + opts.credential, "content-type": "application/json", ...(compress ? { "content-encoding": "gzip" } : {}) },
          body: compress ? await gzipBody(json) : json,
        });
        if (/\bgzip\b/i.test(res.headers?.get?.("accept-encoding") ?? "")) workspaceReadsGzip = true;
        let refused: Array<{ id: string; reason: CloudDeliveryGap["reason"] }>;
        let kept = new Set<string>();
        if (res.ok) {
          // A record the workspace refused on its own (the rest of the batch was stored) can never be
          // accepted as it is: it leaves the queue as a "rejected" gap, so it never holds up the records
          // behind it. It stays in the local log.
          const listed = await refusedIn(res, batch);
          // A record refused for a reason that can pass (a clock ahead, a key not enrolled) stays queued and is sent again.
          kept = new Set(listed.filter((r) => keepForClock(r.entry, r.code, now())).map((r) => r.entry.id));
          refused = listed.filter((r) => !kept.has(r.entry.id)).map((r) => ({ id: r.entry.id, reason: "rejected" as const }));
          for (const id of kept) keptThisFlush.add(id);
        } else {
          const text = (typeof res.text === "function" ? await res.text().catch(() => "") : "").slice(0, 262_144);
          // Every record refused for a reason that can pass: keep them back and go on with the rest.
          if (allRetryable(res.status, text, batch, now())) { for (const entry of batch) keptThisFlush.add(entry.id); continue; }
          const settled = settleRefusal(res.status, text, batch, now());
          if (settled === "isolate") { isolate = true; continue; }
          if (!settled) throw Object.assign(new Error(refusalMessage(res.status, text.slice(0, 4096))), { retryAfterMs: retryAfter(res, now()) });
          refused = settled;
          // The conflicting record is found: the rest of the queue goes in batches again.
          if (refused.some((r) => r.reason === "id_conflict")) isolate = false;
        }
        opts.outbox.acknowledge(batch.filter((entry) => !kept.has(entry.id)).map(({ id, payloadHash }) => ({ id, payloadHash })));
        for (const { id, reason } of refused) {
          const gap = opts.outbox.recordGap?.(id, reason) ?? { id, reason, at: now() };
          opts.onGap?.(gap);
        }
        // Only a batch where something left the queue counts as progress.
        if (kept.size < batch.length) {
          consecutiveFailures = 0;
          nextAttemptAt = null;
          lastError = null;
          lastSuccessAt = now();
          movedThisFlush = true;
        }
      }
      // Only records that are kept back remain and nothing moved: wait before sending them again.
      if (keptThisFlush.size && !movedThisFlush) throw new Error("ingest refused every waiting record for a reason that can pass (a clock ahead, a key not enrolled); retrying");
    } catch (error) {
      fail(error, (error as { retryAfterMs?: number } | null)?.retryAfterMs ?? 0);
    } finally {
      sending = false;
    }
  }

  const timer = setInterval(() => { void flush(); }, flushMs) as unknown as { unref?: () => void };
  timer.unref?.();

  return {
    enqueue(receipt) {
      try {
        const result = opts.outbox.enqueue(structuredClone(receipt));
        if (result.gap) opts.onGap?.(result.gap);
        if (result.queued && !result.duplicate && (opts.outbox.pendingCount?.() ?? opts.outbox.status().pending) >= batchSize) void flush();
      } catch (error) {
        const gap = { id: receipt.payload.action_ref?.action_id ?? null, reason: "outbox_error" as const, at: now() };
        opts.onGap?.(gap);
        opts.onError?.(error);
      }
    },
    flush,
    stop() { stopped = true; clearInterval(timer as unknown as ReturnType<typeof setInterval>); opts.outbox.close?.(); },
    pending() { return opts.outbox.pendingCount?.() ?? opts.outbox.status().pending; },
    status() { return { ...opts.outbox.status(), consecutiveFailures, nextAttemptAt, lastSuccessAt, lastError }; },
  };
}

export function withCloudExporter(store: ReceiptStore, exporter: CloudExporter): ReceiptStore {
  return {
    put: async (r) => { await store.put(r); exporter.enqueue(r); },
    list: () => store.list(),
    executed: (scope) => store.executed(scope),
    ...(store.close ? { close: () => store.close!() } : {}),
    ...(store.recent ? { recent: (limit) => store.recent!(limit) } : {}),
    ...(store.count ? { count: () => store.count!() } : {}),
    ...(store.authorizationUsed ? { authorizationUsed: (kind, id, since) => store.authorizationUsed!(kind, id, since) } : {}),
    ...(store.putAnchor ? { putAnchor: (a) => store.putAnchor!(a) } : {}),
    ...(store.anchors ? { anchors: () => store.anchors!() } : {}),
    ...(store.reserveAction ? { reserveAction: store.reserveAction.bind(store) } : {}),
    ...(store.prepareDispatch ? { prepareDispatch: store.prepareDispatch.bind(store) } : {}),
    ...(store.getAction ? { getAction: store.getAction.bind(store) } : {}),
    ...(store.unresolvedActions ? { unresolvedActions: store.unresolvedActions.bind(store) } : {}),
    ...(store.finalizeAction ? { finalizeAction: async (actionId, receipt, state) => {
      await store.finalizeAction!(actionId, receipt, state);
      exporter.enqueue(receipt);
    } } : {}),
    ...(store.getStopState ? { getStopState: () => store.getStopState!() } : {}),
    ...(store.setStopped ? { setStopped: (target, stopped) => store.setStopped!(target, stopped) } : {}),
  };
}
