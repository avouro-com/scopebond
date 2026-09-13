// Optional gateway → Scopebond Cloud exporter. When configured, every receipt the
// gateway stores is also pushed to a hosted control plane (POST /v1/ingest) for
// retention, the dashboard, and hosted verification — batched, not per-request
// (the D49 cost guardrail). Fully opt-in; the gateway works without it.

import type { ReceiptStore, SignedReceipt } from "./receipts.js";

export interface CloudExporter {
  enqueue(r: SignedReceipt): void;
  flush(): Promise<void>;
  stop(): void;
  pending(): number;
}

export interface CloudExporterOptions {
  /** Base URL of the control plane, e.g. https://cloud.scopebond.com */
  url: string;
  /** Tenant API key (sbk_…). */
  apiKey: string;
  /** Max receipts per POST (default 200). */
  batchSize?: number;
  /** Flush interval in ms (default 15000). */
  flushMs?: number;
  /** Injectable fetch (defaults to global). */
  fetch?: typeof fetch;
  onError?: (e: unknown) => void;
}

export function createCloudExporter(opts: CloudExporterOptions): CloudExporter {
  const doFetch = opts.fetch ?? fetch;
  const batchSize = opts.batchSize ?? 200;
  const endpoint = opts.url.replace(/\/+$/, "") + "/v1/ingest";
  let buffer: SignedReceipt[] = [];
  let sending = false;

  async function flush(): Promise<void> {
    if (sending || buffer.length === 0) return;
    sending = true;
    try {
      while (buffer.length) {
        const batch = buffer.slice(0, batchSize);
        const res = await doFetch(endpoint, {
          method: "POST",
          headers: { authorization: "Bearer " + opts.apiKey, "content-type": "application/json" },
          body: JSON.stringify({ receipts: batch }),
        });
        if (!res.ok) throw new Error("ingest failed: HTTP " + res.status);
        buffer = buffer.slice(batch.length); // only drop what was accepted
      }
    } catch (e) {
      opts.onError?.(e); // keep the remaining buffer to retry on the next flush
    } finally {
      sending = false;
    }
  }

  const timer = setInterval(() => { void flush(); }, opts.flushMs ?? 15000) as unknown as { unref?: () => void };
  timer.unref?.();

  return {
    enqueue(r) { buffer.push(structuredClone(r)); if (buffer.length >= batchSize) void flush(); },
    flush,
    stop() { clearInterval(timer as unknown as ReturnType<typeof setInterval>); },
    pending() { return buffer.length; },
  };
}

/** Wrap a ReceiptStore so every stored receipt is also queued for Cloud export.
 *  All other operations delegate unchanged. */
export function withCloudExporter(store: ReceiptStore, exporter: CloudExporter): ReceiptStore {
  return {
    put: async (r) => { await store.put(r); exporter.enqueue(r); },
    list: () => store.list(),
    executed: () => store.executed(),
    ...(store.close ? { close: () => store.close!() } : {}),
    ...(store.putAnchor ? { putAnchor: (a) => store.putAnchor!(a) } : {}),
    ...(store.anchors ? { anchors: () => store.anchors!() } : {}),
    ...(store.reserveAction ? { reserveAction: store.reserveAction.bind(store) } : {}),
    ...(store.finalizeAction ? { finalizeAction: async (actionId, receipt, state) => {
      await store.finalizeAction!(actionId, receipt, state);
      exporter.enqueue(receipt);
    } } : {}),
    ...(store.getStopState ? { getStopState: () => store.getStopState!() } : {}),
    ...(store.setStopped ? { setStopped: (target, stopped) => store.setStopped!(target, stopped) } : {}),
  };
}
