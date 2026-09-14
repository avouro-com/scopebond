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
}

export interface CloudDeliveryGap {
  id: string | null;
  reason: "missing_action_id" | "id_conflict" | "capacity" | "expired" | "outbox_error";
  at: number;
}

export interface CloudOutboxStatus {
  pending: number;
  pendingBytes: number;
  oldestEnqueuedAt: number | null;
  gaps: number;
  retainedGapRecords: number;
  latestGap: CloudDeliveryGap | null;
}

export interface CloudOutbox {
  enqueue(receipt: SignedReceipt): { queued: boolean; duplicate: boolean; gap?: CloudDeliveryGap };
  peek(limit: number, now: number): CloudOutboxEntry[];
  acknowledge(entries: Array<{ id: string; payloadHash: string }>): void;
  status(): CloudOutboxStatus;
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
      entries.set(id, { id, payloadHash, receipt: structuredClone(receipt), enqueuedAt: now(), bytes });
      return { queued: true, duplicate: false };
    },
    peek(limit, at) {
      expire(at);
      return [...entries.values()].slice(0, Math.max(1, Math.min(100, Math.trunc(limit))));
    },
    acknowledge(sent) {
      for (const item of sent) {
        const entry = entries.get(item.id);
        if (entry?.payloadHash === item.payloadHash) entries.delete(item.id);
      }
    },
    status,
  };
}

export function createCloudExporter(opts: CloudExporterOptions): CloudExporter {
  if (!opts.url.trim()) throw new TypeError("Cloud export URL is required");
  if (!opts.credential.trim()) throw new TypeError("Cloud machine credential is required");
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const batchSize = Math.max(1, Math.min(100, Math.trunc(opts.batchSize ?? 100)));
  const flushMs = Math.max(100, Math.trunc(opts.flushMs ?? 15_000));
  const maxRetryMs = Math.max(flushMs, Math.trunc(opts.maxRetryMs ?? 60_000));
  const endpoint = opts.url.replace(/\/+$/, "") + "/v1/ingest";
  let sending = false;
  let stopped = false;
  let consecutiveFailures = 0;
  let nextAttemptAt: number | null = null;
  let lastSuccessAt: number | null = null;
  let lastError: string | null = null;

  const fail = (error: unknown) => {
    consecutiveFailures += 1;
    const delay = Math.min(maxRetryMs, flushMs * (2 ** Math.min(consecutiveFailures - 1, 10)));
    nextAttemptAt = now() + delay;
    lastError = error instanceof Error ? error.message : String(error);
    opts.onError?.(error);
  };

  async function flush(): Promise<void> {
    if (sending || stopped || (nextAttemptAt !== null && now() < nextAttemptAt)) return;
    sending = true;
    try {
      for (;;) {
        const batch = opts.outbox.peek(batchSize, now());
        if (!batch.length) break;
        const res = await doFetch(endpoint, {
          method: "POST",
          headers: { authorization: "Bearer " + opts.credential, "content-type": "application/json" },
          body: JSON.stringify({ receipts: batch.map((entry) => entry.receipt) }),
        });
        if (!res.ok) throw new Error("ingest failed: HTTP " + res.status);
        opts.outbox.acknowledge(batch.map(({ id, payloadHash }) => ({ id, payloadHash })));
        consecutiveFailures = 0;
        nextAttemptAt = null;
        lastError = null;
        lastSuccessAt = now();
      }
    } catch (error) {
      fail(error);
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
        if (result.queued && !result.duplicate && opts.outbox.status().pending >= batchSize) void flush();
      } catch (error) {
        const gap = { id: receipt.payload.action_ref?.action_id ?? null, reason: "outbox_error" as const, at: now() };
        opts.onGap?.(gap);
        opts.onError?.(error);
      }
    },
    flush,
    stop() { stopped = true; clearInterval(timer as unknown as ReturnType<typeof setInterval>); opts.outbox.close?.(); },
    pending() { return opts.outbox.status().pending; },
    status() { return { ...opts.outbox.status(), consecutiveFailures, nextAttemptAt, lastSuccessAt, lastError }; },
  };
}

export function withCloudExporter(store: ReceiptStore, exporter: CloudExporter): ReceiptStore {
  return {
    put: async (r) => { await store.put(r); exporter.enqueue(r); },
    list: () => store.list(),
    executed: () => store.executed(),
    ...(store.close ? { close: () => store.close!() } : {}),
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
