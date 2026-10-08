// Optional gateway → Scopebond Cloud exporter. The gateway stores locally first;
// a bounded outbox then retries evidence-v1 receipts without weakening execution.

import { canonical, sha256 } from "./crypto.js";
import type { Attester, ReceiptPayload, ReceiptStore, SignedReceipt } from "./receipts.js";
import { buildSummary, isNotable } from "./summary.js";

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
  /** The record's number in this queue, when it had one. A record dropped at capacity takes the next number before it is
   *  dropped, so the numbers the workspace sees leave a hole where it was. */
  seq?: number;
}

/** Outbox options with no cap and no expiry: nothing is ever dropped for space or age. The hook and the agent open their
 *  queue this way; any exporter that must not lose records should too. */
export const LOSSLESS_CLOUD_OUTBOX = { maxPending: Number.MAX_SAFE_INTEGER, maxBytes: Number.MAX_SAFE_INTEGER, maxAgeMs: Number.MAX_SAFE_INTEGER } as const;

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
  /** Gaps by reason over the queue's lifetime (`gaps` is their total), kept apart from the gap rows, which are trimmed to
   *  the newest ones. A queue made before these counts starts from its retained rows, so the counts may sum below `gaps`. */
  gapsByReason?: Record<string, number>;
}

export interface CloudOutbox {
  enqueue(receipt: SignedReceipt): { queued: boolean; duplicate: boolean; gap?: CloudDeliveryGap };
  /** The oldest records first; `exclude` leaves out records this flush already kept back (a clock ahead). */
  peek(limit: number, now: number, exclude?: ReadonlySet<string>): CloudOutboxEntry[];
  /** Take records out of the queue. `held` names those the workspace accepted (stored or already had); only they may later
   *  be removed from the local log by retention. A refused record leaves the queue as a gap and is never in `held`. */
  acknowledge(entries: Array<{ id: string; payloadHash: string }>, held?: ReadonlySet<string>): void;
  status(): CloudOutboxStatus;
  /** How many records wait, from a kept total rather than a count of the queue. Optional; `status().pending` otherwise. */
  pendingCount?(): number;
  /** Record a delivery gap the exporter learned of (a record the workspace refused on its own). */
  recordGap?(id: string | null, reason: CloudDeliveryGap["reason"]): CloudDeliveryGap;
  /** Summaries: claim a window so it is summarised once by this queue, whichever process flushes. `claimed`: build and send
   *  its summary under `summaryId` (the one first chosen for it, so a retried summary is the same summary); `busy`: another
   *  flush is sending it now (its records wait); `sent`: it was summarised (a record for it that turns up now goes in full).
   *  An outbox without claims is never sent summaries. */
  claimWindow?(windowStart: number, summaryId: string, now: number): { state: "claimed" | "busy" | "sent"; summaryId: string };
  /** Let a claim go without sending (another flush may take it at once, under the same summary id). */
  releaseWindow?(windowStart: number): void;
  /** The workspace has the window's summary. */
  markWindowSent?(windowStart: number): void;
  /** Records of a window sent in full (notable, or late), counted so its summary can say how many. */
  countFull?(windowStart: number, n: number): void;
  fullCount?(windowStart: number): number;
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
  /** `routine: false` (a per-call process with summaries on): run only when a notable record was queued since the last flush. */
  flush(options?: { routine?: boolean }): Promise<void>;
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
  /** Summary records (evidence detail "standard"): routine receipts leave as one signed summary per window instead of one
   *  record each; notable ones are sent in full at once. Without this, or while `detail()` says "full", every receipt is sent. */
  summaries?: CloudSummaryOptions;
  /** How long one delivery request may take, the answer's body included, before it is abandoned and counted as a failure
   *  (the records stay queued). Default 30 seconds. A connection that never answers (a half-open socket after sleep or a
   *  network change) would otherwise hold the flush, and every later one, for good. */
  requestTimeoutMs?: number;
  /** Sign each batch's record numbers with this computer's enrolled key (`seq_proof` beside `seq`), so a party holding
   *  only the bearer credential cannot attach numbers to records of its choosing. Needs both the key and the machine
   *  credential's id; without them the numbers are sent unsigned, as before. */
  sequenceProof?: CloudSequenceProofOptions;
}

export interface CloudSequenceProofOptions {
  /** The key the workspace enrolled for this computer (the one that signs its receipts). */
  attester: Attester;
  /** The machine credential's id, as the enrollment answer named it (`credential_id`). */
  credentialId: string;
}

/** The domain prefix of a batch's sequence proof; the signed string is this followed by the canonical JSON. */
export const DELIVERY_SEQUENCE_CONTEXT = "scopebond:delivery-sequence/v1\n";

/** The exact string a batch's `seq_proof.signature` covers: the credential's id, the queue id (or null when the body
 *  names none), the numbers as sent, and the SHA-256 of each receipt's canonical JSON in body order. */
export function deliverySequenceMaterial(credentialId: string, queue: string | null, seq: Array<number | null>, receipts: unknown[]): string {
  return DELIVERY_SEQUENCE_CONTEXT + canonical({ credential_id: credentialId, queue, seq, receipts: receipts.map((r) => sha256(canonical(r))) });
}

export interface CloudSummaryOptions {
  /** The workspace's evidence detail, read at each flush. */
  detail(): "full" | "standard";
  /** The key that signs this computer's receipts; it signs the summaries too. */
  attester: Attester;
  /** This computer's digest key (64 hex) for the summaries' working-folder digests, so one folder groups under one keyed
   *  digest across summaries. Without it, a random key for the process is used. */
  digestKey?: string;
  /** One summary per window of this length (default five minutes). A window is summarised once it has closed. */
  windowMs?: number;
  /** An extra test for receipts that must be sent in full (for example, an action a Monitor rule matches). */
  notable?: (payload: ReceiptPayload) => boolean;
}

/** How many queued records one summarising pass looks at. */
const SUMMARY_PEEK = 2_000;
/** A window is summarised this long after it ends, so a record finishing late still lands in it. */
const SUMMARY_GRACE_MS = 30_000;
/** Summaries per POST. */
const SUMMARIES_PER_POST = 20;
/** How long a flush holds a window's claim while it sends; a claim older than this was abandoned (a process that exited) and is
 *  taken over, under the same summary id. */
export const WINDOW_LEASE_MS = 120_000;
/** A computer without the agent sends routine records' summaries from a hook call once the oldest waiting record is this old. */
const ROUTINE_MAX_WAIT_MS = 30 * 60_000;

/** The record numbers a summary covers, as closed ranges. Records queued before numbering are counted apart. */
export function seqRanges(seqs: Array<number | undefined>): { ranges: Array<[number, number]>; unnumbered: number } {
  const sorted = seqs.filter((s): s is number => typeof s === "number").sort((a, b) => a - b);
  const ranges: Array<[number, number]> = [];
  for (const s of sorted) {
    const last = ranges.at(-1);
    if (last && s === last[1] + 1) last[1] = s;
    else if (!last || s > last[1]) ranges.push([s, s]);
  }
  return { ranges, unnumbered: seqs.length - sorted.length };
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
  const windows = new Map<number, { summaryId: string | null; claimedAt: number; sent: boolean; full: number }>();
  let nextSeq = 1;
  let queueId: string | undefined;
  let gapCount = 0;
  const gapsByReason: Record<string, number> = {};
  let latestGap: CloudDeliveryGap | null = null;

  const recordGap = (id: string | null, reason: CloudDeliveryGap["reason"]): CloudDeliveryGap => {
    const gap = { id, reason, at: now() };
    gapCount += 1;
    gapsByReason[reason] = (gapsByReason[reason] ?? 0) + 1;
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
      gapsByReason: { ...gapsByReason },
    };
  };

  return {
    claimWindow(windowStart: number, summaryId: string, at: number) {
      const w = windows.get(windowStart) ?? { summaryId: null as string | null, claimedAt: 0, sent: false, full: 0 };
      windows.set(windowStart, w);
      if (w.sent) return { state: "sent" as const, summaryId: w.summaryId ?? summaryId };
      if (w.summaryId && at - w.claimedAt < WINDOW_LEASE_MS) return { state: "busy" as const, summaryId: w.summaryId };
      w.summaryId ??= summaryId;
      w.claimedAt = at;
      return { state: "claimed" as const, summaryId: w.summaryId };
    },
    releaseWindow(windowStart: number): void { const w = windows.get(windowStart); if (w) w.claimedAt = 0; },
    markWindowSent(windowStart: number): void { const w = windows.get(windowStart); if (w) w.sent = true; },
    countFull(windowStart: number, n: number): void {
      const w = windows.get(windowStart) ?? { summaryId: null, claimedAt: 0, sent: false, full: 0 };
      w.full += n;
      windows.set(windowStart, w);
    },
    fullCount(windowStart: number): number { return windows.get(windowStart)?.full ?? 0; },
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
        // The dropped record still takes its number, so the workspace sees a hole where it was.
        return { queued: false, duplicate: false, gap: { ...recordGap(id, "capacity"), seq: nextSeq++ } };
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
  const rawFetch = opts.fetch ?? fetch;
  const requestTimeoutMs = Math.max(1, Math.trunc(opts.requestTimeoutMs ?? 30_000));
  // The signal also ends a body that trickles: reading the answer fails once it fires.
  const doFetch: typeof fetch = (input, init) => rawFetch(input, { ...init, signal: AbortSignal.timeout(requestTimeoutMs) });
  const now = opts.now ?? Date.now;
  const batchSize = Math.max(1, Math.min(100, Math.trunc(opts.batchSize ?? 100)));
  const flushMs = Math.max(100, Math.trunc(opts.flushMs ?? 15_000));
  const maxRetryMs = Math.max(flushMs, Math.trunc(opts.maxRetryMs ?? 60_000));
  let base = opts.url;
  while (base.endsWith("/")) base = base.slice(0, -1);
  const endpoint = base + "/v1/ingest";
  const summaryEndpoint = base + "/v1/summaries";
  // A workspace without summaries (404 or 405) is sent every receipt, as before, for the life of this exporter.
  let summariesRefused = false;
  const summarising = () => !!opts.summaries && !summariesRefused && !!opts.outbox.claimWindow && opts.summaries.detail() === "standard";
  const notable = (payload: ReceiptPayload) => {
    try { return isNotable(payload) || !Number.isFinite(Date.parse(payload.timestamp)) || (opts.summaries?.notable?.(payload) ?? false); }
    catch { return true; }
  };
  let sending = false;
  // A notable record was queued since the last flush started.
  let notableQueued = false;
  let stopped = false;
  let consecutiveFailures = 0;
  let nextAttemptAt: number | null = null;
  let lastSuccessAt: number | null = null;
  let lastError: string | null = null;
  // Learned from the workspace's answers: only a workspace that says it reads gzip is sent gzip.
  let workspaceReadsGzip = false;
  const gzipMinBytes = Math.max(0, Math.trunc(opts.gzipMinBytes ?? 1024));
  // Both parts or none: a proof without the credential's id (or the key) could never verify.
  const proofKey = opts.sequenceProof?.attester && typeof opts.sequenceProof.credentialId === "string" && opts.sequenceProof.credentialId.trim()
    ? opts.sequenceProof : null;

  const fail = (error: unknown, retryAfterMs = 0) => {
    consecutiveFailures += 1;
    const delay = Math.min(maxRetryMs, flushMs * (2 ** Math.min(consecutiveFailures - 1, 10)));
    // A workspace that asks to wait (429 or 503 with Retry-After) is not asked again sooner; at most an hour.
    nextAttemptAt = now() + Math.max(delay, Math.min(retryAfterMs, 3_600_000));
    lastError = error instanceof Error ? error.message : String(error);
    opts.onError?.(error);
  };

  /** Send the closed windows' routine records as summaries. `sent`: some left the queue; `late`: records of a window already
   *  summarised, to send in full. Without summaries at the workspace nothing is sent here (the records then go as receipts).
   *  Throws for a failure worth retrying. */
  async function sendSummaries(entries: CloudOutboxEntry[], notableByWindow: Map<number, number>, queue: string | undefined | null): Promise<{ sent: boolean; late: CloudOutboxEntry[]; busy: CloudOutboxEntry[] }> {
    const s = opts.summaries!;
    const windowMs = Math.max(60_000, Math.trunc(s.windowMs ?? 300_000));
    const groups = new Map<number, CloudOutboxEntry[]>();
    for (const e of entries) {
      const w = Math.floor(Date.parse(e.receipt.payload.timestamp) / windowMs);
      groups.set(w, [...(groups.get(w) ?? []), e]);
    }
    // Each window is summarised once by this queue. Records for a window already summarised go in full, so a window's summary
    // covers exactly its routine records that were not sent in full; a window another flush is sending waits for it.
    const late: CloudOutboxEntry[] = [];
    const busy: CloudOutboxEntry[] = [];
    const claimed: Array<[number, CloudOutboxEntry[], string]> = [];
    for (const [w, group] of groups) {
      const claim = opts.outbox.claimWindow!(w * windowMs, `sum_${randomQueueId()}`, now());
      if (claim.state === "claimed") claimed.push([w, group, claim.summaryId]);
      else if (claim.state === "sent") late.push(...group);
      else busy.push(...group);
    }
    const items = await Promise.all(claimed.map(async ([w, group, id]) => ({
      group, w, id,
      body: {
        summary: await buildSummary(group.map((e) => e.receipt), { summaryId: id,
          attester: s.attester, ...(s.digestKey ? { digestKey: s.digestKey } : {}), notableCount: (opts.outbox.fullCount?.(w * windowMs) ?? 0) + (notableByWindow.get(w) ?? 0), now: new Date(now()),
          window: { kind: "interval", start: new Date(w * windowMs).toISOString(), end: new Date((w + 1) * windowMs - 1).toISOString() },
        }),
        // Beside the signed summary, like a receipt's number: which of this queue's records it stands for.
        seq: seqRanges(group.map((e) => e.seq)),
      },
    })));
    const release = (from: number) => { for (const p of items.slice(from)) opts.outbox.releaseWindow?.(p.w * windowMs); };
    for (let i = 0; i < items.length; i += SUMMARIES_PER_POST) {
      const part = items.slice(i, i + SUMMARIES_PER_POST);
      let res: Response;
      try {
        res = await doFetch(summaryEndpoint, {
          method: "POST",
          headers: { authorization: "Bearer " + opts.credential, "content-type": "application/json" },
          body: JSON.stringify({ summaries: part.map((p) => p.body), ...(queue ? { queue } : {}) }),
        });
      } catch (error) { release(i); throw error; }
      if (res.status === 404 || res.status === 405) { release(i); summariesRefused = true; return { sent: false, late: [], busy }; }
      if (!res.ok) {
        release(i);
        const text = (typeof res.text === "function" ? await res.text().catch(() => "") : "").slice(0, 4096);
        // A summary the workspace refuses as it is: send those records in full instead, for the life of this exporter.
        if (res.status === 400 || res.status === 413 || res.status === 422) { summariesRefused = true; opts.onError?.(new Error(refusalMessage(res.status, text))); return { sent: false, late: [], busy }; }
        throw Object.assign(new Error(refusalMessage(res.status, text)), { retryAfterMs: retryAfter(res, now()) });
      }
      // Only what the workspace says it has leaves the queue: a summary it refused on its own sends its records in full; a
      // count that does not add up is a failure, retried under the same summary ids.
      const answer = await (typeof res.json === "function" ? res.json().catch(() => null) : Promise.resolve(null)) as { accepted?: unknown; duplicates?: unknown; rejected?: Array<{ index?: unknown }> } | null;
      const refusedAt = new Set((Array.isArray(answer?.rejected) ? answer!.rejected : []).map((r) => Number(r?.index)).filter((n) => Number.isInteger(n)));
      const held = Number(answer?.accepted ?? NaN) + Number(answer?.duplicates ?? 0);
      if (!Number.isFinite(held) || held + refusedAt.size < part.length) {
        release(i);
        throw new Error(`the workspace answered for ${Number.isFinite(held) ? held : "none"} of ${part.length} summaries; retrying`);
      }
      for (const [k, p] of part.entries()) {
        opts.outbox.markWindowSent?.(p.w * windowMs);
        if (refusedAt.has(k)) { late.push(...p.group); continue; }
        opts.outbox.acknowledge(p.group.map(({ id, payloadHash }) => ({ id, payloadHash })), new Set(p.group.map((e) => e.id)));
      }
    }
    return { sent: items.length > 0, late, busy };
  }

  // A flush asked for while one is sending waits for that one instead of returning at once, so a caller that bounds its wait
  // (a hook call) waits on real work, and can tell when its time ran out.
  let inflight: Promise<void> | null = null;
  function flush(options: { routine?: boolean } = {}): Promise<void> {
    if (inflight) return inflight;
    const run = flushOnce(options);
    if (!sending) return run; // nothing was due: it settled at once
    inflight = run.finally(() => { inflight = null; });
    return inflight;
  }

  async function flushOnce(options: { routine?: boolean } = {}): Promise<void> {
    if (sending || stopped || (nextAttemptAt !== null && now() < nextAttemptAt)) return;
    // Routine records wait for their summary; a per-call flush with nothing notable to send has nothing to do.
    if (options.routine === false && summarising() && !notableQueued) {
      // Without an agent, a hook call still sends the summaries once routine records have waited long enough.
      const oldest = opts.outbox.status().oldestEnqueuedAt;
      if (oldest === null || now() - oldest < ROUTINE_MAX_WAIT_MS) return;
    }
    notableQueued = false;
    sending = true;
    // After a 409 id_conflict on a batch, the rest of this flush goes one record at a time.
    let isolate = false;
    let queue: string | undefined | null = null;
    // Records kept back this flush (refused for a reason that can pass) are not sent again in it, so
    // they never hold up the records behind them or go out once per batch.
    const keptThisFlush = new Set<string>();
    let movedThisFlush = false;
    // Routine records of a window this queue already summarised: they go in full.
    const lateThisFlush = new Set<string>();
    const skip = () => (keptThisFlush.size ? keptThisFlush : undefined);
    try {
      for (;;) {
        let batch: CloudOutboxEntry[];
        if (summarising()) {
          const windowMs = Math.max(60_000, Math.trunc(opts.summaries!.windowMs ?? 300_000));
          // Gather up to SUMMARY_PEEK of the oldest records (the outbox hands out a hundred at a time).
          const seen: CloudOutboxEntry[] = [];
          const seenIds = new Set<string>(skip() ?? []);
          for (;;) {
            const part = opts.outbox.peek(100, now(), seenIds.size ? seenIds : undefined);
            for (const e of part) { seen.push(e); seenIds.add(e.id); }
            if (part.length < 100 || seen.length >= SUMMARY_PEEK) break;
          }
          if (!seen.length) break;
          // A window counts as complete only when every record queued until it closed was seen: with more records waiting
          // beyond this pass, only windows that closed before the newest record seen was queued.
          const truncated = seen.length >= SUMMARY_PEEK;
          const cutoff = truncated ? Math.min(now(), Math.max(...seen.map((e) => e.enqueuedAt))) : now();
          const full: CloudOutboxEntry[] = [];
          const closed: CloudOutboxEntry[] = [];
          const open: CloudOutboxEntry[] = [];
          const notableByWindow = new Map<number, number>();
          for (const e of seen) {
            const w = Math.floor(Date.parse(e.receipt.payload.timestamp) / windowMs);
            if (notable(e.receipt.payload)) { full.push(e); notableByWindow.set(w, (notableByWindow.get(w) ?? 0) + 1); }
            else if (lateThisFlush.has(e.id)) continue; // added to the full list below
            else if ((w + 1) * windowMs + SUMMARY_GRACE_MS <= cutoff) closed.push(e);
            else open.push(e);
          }
          // One window busier than a whole pass would never complete: its oldest records go in full rather than wait forever.
          if (truncated && !closed.length && !full.length) for (const e of open.slice(0, batchSize)) lateThisFlush.add(e.id);
          // Records in a window still open stay queued; each pass looks at them again, so a window that closes meanwhile is whole.
          // Notable records go first: a block or an allow must not wait behind the summaries.
          for (const e of seen) if (lateThisFlush.has(e.id)) full.push(e);
          if (full.length) {
            batch = full.slice(0, isolate ? 1 : batchSize);
          } else if (closed.length) {
            if (queue === null) queue = opts.outbox.status().queueId;
            const outcome = await sendSummaries(closed, notableByWindow, queue);
            if (outcome.sent) { consecutiveFailures = 0; nextAttemptAt = null; lastError = null; lastSuccessAt = now(); movedThisFlush = true; }
            for (const e of outcome.busy) keptThisFlush.add(e.id); // another flush is sending their summary
            for (const e of outcome.late) lateThisFlush.add(e.id);
            if (outcome.sent || outcome.late.length || outcome.busy.length) continue; // look again
            continue; // no summaries after all: every record goes as a receipt
          } else {
            batch = [];
          }
          if (!batch.length) break; // only records in open windows (or windows another flush is sending) are left
        } else {
          batch = opts.outbox.peek(isolate ? 1 : batchSize, now(), skip());
        }
        if (!batch.length) break;
        const numbered = batch.some((entry) => entry.seq !== undefined);
        if (numbered && queue === null) queue = opts.outbox.status().queueId;
        // SB289: each record's number travels beside it (the signed receipt is unchanged); a workspace
        // that does not read it ignores it.
        // The queue's id says which numbering the numbers belong to.
        let body: Record<string, unknown> = { receipts: batch.map((entry) => entry.receipt) };
        if (numbered) {
          const receipts = batch.map((entry) => entry.receipt);
          const seq = batch.map((entry) => entry.seq ?? null);
          body = { receipts, seq, ...(queue ? { queue } : {}) };
          // The numbers are signed with the enrolled key over exactly what is sent. A signing failure throws (the batch is
          // retried): numbers are never sent with a partial proof.
          if (proofKey) {
            const signature = await proofKey.attester.sign(deliverySequenceMaterial(proofKey.credentialId, queue ? queue : null, seq, receipts));
            if (typeof signature !== "string" || !signature) throw new Error("the delivery sequence could not be signed; retrying");
            body.seq_proof = { kid: proofKey.attester.kid, signature };
          }
        }
        const json = JSON.stringify(body);
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
        const leaving = batch.filter((entry) => !kept.has(entry.id));
        const refusedIds = new Set(refused.map((r) => r.id));
        opts.outbox.acknowledge(leaving.map(({ id, payloadHash }) => ({ id, payloadHash })), new Set(leaving.filter((entry) => !refusedIds.has(entry.id)).map((entry) => entry.id)));
        // With summaries, a window's summary says how many of its records went in full.
        if (summarising() && opts.outbox.countFull) {
          const windowMs = Math.max(60_000, Math.trunc(opts.summaries!.windowMs ?? 300_000));
          const byWindow = new Map<number, number>();
          for (const entry of leaving) {
            const t = Date.parse(entry.receipt.payload.timestamp);
            if (Number.isFinite(t)) byWindow.set(Math.floor(t / windowMs) * windowMs, (byWindow.get(Math.floor(t / windowMs) * windowMs) ?? 0) + 1);
          }
          for (const [w, n] of byWindow) opts.outbox.countFull(w, n);
        }
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
        // With summaries, enqueueing never starts a flush: routine records wait for their window, and the caller flushes after a
        // notable one (a per-call process must not exit while a flush it did not await is sending).
        const notableRecord = summarising() && notable(receipt.payload);
        if (notableRecord) notableQueued = true;
        const flushNow = !summarising() && (opts.outbox.pendingCount?.() ?? opts.outbox.status().pending) >= batchSize;
        if (result.queued && !result.duplicate && flushNow) void flush();
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
