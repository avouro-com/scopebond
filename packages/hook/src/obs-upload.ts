// Batch upload of the local observation outbox to `POST /v1/observations`.
//
// Request: `{ version: "1.0", items: [SignedObservation] }`, at most 100 items and 1 MiB.
// Response (HTTP 200): `{ version: "1.0", results: [{ index, observation_id, status, code,
// retryable, observation_hash? }], retry_after_seconds? }`.
//
// What the client does with each answer:
//
//   accepted / duplicate / pending_link   durably acknowledged: removed from the outbox
//   deferred                              kept and retried later, same id and sequence
//   rejected                              permanent: moved to the local terminal-error
//                                         queue (visible in `status`), never retried
//   no result for an item, an unknown status, or an item id that does not match the one
//   sent at that index: treated as NOT acknowledged and kept
//
// Request-level answers: 429 keeps everything and waits for Retry-After; 402 (plan-paused agent)
// keeps everything and looks again in half an hour or more; 401/403 keep
// everything and back off (credential or plan problem, reported honestly); 413 halves the
// batch size; 400 keeps everything and backs off; 422 (unsupported batch version) and
// 404/405 (no such route: an older workspace) mark the capability unsupported. A stale
// generation in any item blocks further upload until the enrollment generation moves.
//
// Nothing here can change or delay a policy decision: the caller bounds it with a timeout
// and treats every failure as "try again later".

import { MAX_BATCH_BODY_BYTES, MAX_BATCH_ITEMS } from "./observation.js";
import type { ObservationStore, PendingRow } from "./obs-store.js";

export const OBSERVATIONS_PATH = "/v1/observations";
export const BATCH_VERSION = "1.0";

const ACKNOWLEDGED = new Set(["accepted", "duplicate", "pending_link"]);
const MAX_BACKOFF_MS = 60 * 60 * 1000;
const BASE_BACKOFF_MS = 15 * 1000;
/** Upper bound honoured for a server-supplied Retry-After, so a hostile or mistaken value
 *  cannot park the queue for days. */
const MAX_RETRY_AFTER_MS = 6 * 60 * 60 * 1000;

export interface UploadOutcome {
  /** What happened, for `status` and tests. */
  result: "empty" | "paused" | "sent" | "unsupported" | "blocked" | "backoff" | "error";
  acknowledged: number;
  deferred: number;
  rejected: number;
  detail?: string;
}

export interface UploadOptions {
  url: string;
  credential: string;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  /** Send at most this many batches in one call. */
  maxBatches?: number;
}

/** Parse Retry-After: delta-seconds or an HTTP date. Bounded; undefined when unusable. */
export function parseRetryAfter(header: string | null, now: number): number | undefined {
  if (!header) return undefined;
  const value = header.trim();
  let ms: number | undefined;
  if (/^\d{1,9}$/.test(value)) ms = Number(value) * 1000;
  else { const date = Date.parse(value); if (Number.isFinite(date)) ms = date - now; }
  return ms === undefined ? undefined : Math.max(0, Math.min(ms, MAX_RETRY_AFTER_MS));
}

const backoffFor = (attempts: number): number => Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.min(attempts, 12));

interface ItemResult { index: number; observation_id: string | null; status: string; code?: string; retryable?: boolean }

function parseResults(body: unknown, sent: PendingRow[]): { results: Map<number, ItemResult>; retryAfterSeconds?: number } | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as { version?: unknown; results?: unknown; retry_after_seconds?: unknown };
  if (b.version !== BATCH_VERSION || !Array.isArray(b.results) || b.results.length > MAX_BATCH_ITEMS) return null;
  const results = new Map<number, ItemResult>();
  for (const raw of b.results) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Partial<ItemResult>;
    if (!Number.isInteger(r.index) || (r.index as number) < 0 || (r.index as number) >= sent.length) continue;
    if (typeof r.status !== "string") continue;
    // A result only counts for the item it names at that index. The workspace reports a null
    // id only for an item it refused before it could read one, and only as refused or
    // deferred; that answer is bound to the item by its index. A durable acknowledgement
    // always names the item.
    if (r.observation_id === null) { if (r.status !== "rejected" && r.status !== "deferred") continue; }
    else if (typeof r.observation_id !== "string" || r.observation_id !== sent[r.index as number].observation_id) continue;
    if (!results.has(r.index as number)) results.set(r.index as number, r as ItemResult);
  }
  const retryAfterSeconds = typeof b.retry_after_seconds === "number" && Number.isFinite(b.retry_after_seconds) && b.retry_after_seconds >= 0 ? b.retry_after_seconds : undefined;
  return { results, retryAfterSeconds };
}

export async function uploadPending(store: ObservationStore, options: UploadOptions): Promise<UploadOutcome> {
  const now = options.now ?? Date.now;
  const doFetch = options.fetch ?? fetch;
  const outcome: UploadOutcome = { result: "empty", acknowledged: 0, deferred: 0, rejected: 0 };
  const endpoint = new URL(OBSERVATIONS_PATH, options.url);
  if (endpoint.protocol !== "https:" && endpoint.hostname !== "localhost" && endpoint.hostname !== "127.0.0.1") {
    store.setCapability("unsupported", "the workspace URL is not HTTPS");
    return { ...outcome, result: "unsupported", detail: "the workspace URL is not HTTPS" };
  }
  const deadline = now() + (options.timeoutMs ?? 5000);
  for (let round = 0; round < (options.maxBatches ?? 10); round += 1) {
    const state = store.state();
    if (!state) return outcome;
    if (state.capability !== "active") return { ...outcome, result: state.capability === "unsupported" ? "unsupported" : "blocked", detail: state.reason ?? undefined };
    const batch = store.nextBatch(undefined, true);
    if (batch.length === 0) return outcome.acknowledged || outcome.rejected || outcome.deferred ? { ...outcome, result: "sent" } : (state.backoff_until > now() ? { ...outcome, result: "paused" } : outcome);
    const remaining = deadline - now();
    if (remaining <= 0) { store.release(batch.map((r) => r.observation_id)); return { ...outcome, result: "sent" }; }

    const body = JSON.stringify({ version: BATCH_VERSION, items: batch.map((row) => row.wrapper) });
    if (Buffer.byteLength(body, "utf8") > MAX_BATCH_BODY_BYTES) { store.release(batch.map((r) => r.observation_id)); store.setBatchLimit(Math.max(1, Math.floor(batch.length / 2))); continue; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    let response: Response;
    try {
      response = await doFetch(endpoint, {
        method: "POST", redirect: "error", signal: controller.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${options.credential}` },
        body,
      });
    } catch (error) {
      clearTimeout(timer);
      const attempts = Math.max(...batch.map((r) => r.attempts)) + 1;
      store.defer(batch.map((r) => r.observation_id), backoffFor(attempts));
      store.setBackoff(now() + backoffFor(attempts), `send failed: ${(error as Error).name === "AbortError" ? "timeout" : (error as Error).message.slice(0, 120)}`);
      return { ...outcome, result: "error", detail: "the workspace could not be reached" };
    }
    clearTimeout(timer);

    if (response.status === 429) {
      const wait = parseRetryAfter(response.headers.get("retry-after"), now()) ?? backoffFor(1);
      store.release(batch.map((r) => r.observation_id));
      store.setBackoff(now() + wait, "rate limited (429)");
      return { ...outcome, result: "backoff", detail: `rate limited; retry after ${Math.ceil(wait / 1000)}s` };
    }
    if (response.status === 404 || response.status === 405) {
      store.release(batch.map((r) => r.observation_id));
      store.setCapability("unsupported", `the workspace does not offer ${OBSERVATIONS_PATH} (HTTP ${response.status})`);
      return { ...outcome, result: "unsupported", detail: `the workspace does not offer ${OBSERVATIONS_PATH}` };
    }
    if (response.status === 422) {
      store.release(batch.map((r) => r.observation_id));
      store.setCapability("unsupported", "the workspace does not accept this observation batch version (HTTP 422)");
      return { ...outcome, result: "unsupported", detail: "batch version not accepted" };
    }
    if (response.status === 413) {
      if (batch.length === 1) { store.reject([{ observation_id: batch[0].observation_id, code: "oversize" }]); outcome.rejected += 1; continue; }
      store.release(batch.map((r) => r.observation_id));
      store.setBatchLimit(Math.floor(batch.length / 2));
      continue;
    }
    if (response.status === 402) {
      // The workspace's plan has paused this agent. Nothing is lost: keep the queue, look again later.
      const attempts = Math.max(...batch.map((r) => r.attempts)) + 1;
      const wait = Math.max(backoffFor(attempts), 30 * 60 * 1000);
      store.defer(batch.map((r) => r.observation_id), wait);
      store.setBackoff(now() + wait, "the workspace plan has paused this agent (HTTP 402)");
      return { ...outcome, result: "error", detail: "HTTP 402: the workspace plan has paused this agent" };
    }
    if (response.status === 401 || response.status === 403 || response.status === 400 || response.status >= 500 || response.status !== 200) {
      const attempts = Math.max(...batch.map((r) => r.attempts)) + 1;
      const wait = response.status === 401 || response.status === 403 ? Math.max(backoffFor(attempts), 5 * 60 * 1000) : backoffFor(attempts);
      store.defer(batch.map((r) => r.observation_id), wait);
      store.setBackoff(now() + wait, `HTTP ${response.status}`);
      return { ...outcome, result: "error", detail: `HTTP ${response.status}` };
    }

    let json: unknown;
    try { json = await response.json(); } catch { json = null; }
    const parsed = parseResults(json, batch);
    if (!parsed) {
      // A 200 we cannot read acknowledges nothing: keep the whole batch and resend it
      // unchanged; the server dedupes per item.
      const attempts = Math.max(...batch.map((r) => r.attempts)) + 1;
      store.defer(batch.map((r) => r.observation_id), backoffFor(attempts));
      store.setBackoff(now() + backoffFor(attempts), "unreadable batch response");
      return { ...outcome, result: "error", detail: "unreadable response" };
    }
    const acked: string[] = [];
    const rejected: Array<{ observation_id: string; code: string }> = [];
    const deferred: string[] = [];
    let staleGeneration = false;
    batch.forEach((row, index) => {
      const r = parsed.results.get(index);
      if (!r) { deferred.push(row.observation_id); return; }
      if (ACKNOWLEDGED.has(r.status)) acked.push(row.observation_id);
      else if (r.status === "rejected") {
        rejected.push({ observation_id: row.observation_id, code: typeof r.code === "string" && r.code ? r.code.slice(0, 64) : "rejected" });
        if (r.code === "stale_generation") staleGeneration = true;
      } else deferred.push(row.observation_id); // deferred, or a status this client does not know
    });
    if (acked.length) store.acknowledge(acked);
    if (rejected.length) store.reject(rejected);
    if (deferred.length) {
      const attempts = Math.max(...batch.filter((r) => deferred.includes(r.observation_id)).map((r) => r.attempts)) + 1;
      const wait = parsed.retryAfterSeconds !== undefined ? Math.min(parsed.retryAfterSeconds * 1000, MAX_RETRY_AFTER_MS) : backoffFor(attempts);
      store.defer(deferred, wait);
      store.setBackoff(now() + wait, null);
    }
    outcome.acknowledged += acked.length;
    outcome.rejected += rejected.length;
    outcome.deferred += deferred.length;
    if (staleGeneration) {
      // Everything under this generation is unsendable. Keep it locally for a separately
      // authorized archive import and stop until enrollment moves the generation.
      outcome.rejected += store.rejectAllPending("stale_generation");
      store.setCapability("blocked", "the workspace reports this installation generation is stale; reconnect to enroll a new one");
      return { ...outcome, result: "blocked", detail: "stale generation" };
    }
    if (deferred.length) return { ...outcome, result: "sent" };
  }
  return { ...outcome, result: "sent" };
}
