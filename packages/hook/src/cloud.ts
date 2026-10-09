// scopebond-hook → Scopebond Cloud: enroll the machine's countersigning key with a
// workspace and auto-export signed receipts to the hosted portal, so a connected
// hook starts monitoring automatically. Reuses the gateway's enrollment and bounded
// durable exporter (D40 — no new transport). The machine credential and the complete
// receipt log stay local-first; export is best-effort and never blocks a tool call.

import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CloudEnrollmentError, completeCloudEnrollment, createCloudExporter, withCloudExporter,
  type Attester, type CloudDeliveryGap, type CloudEnrollmentBundle, type CloudEnrollmentResult, type CloudExporter,
  type CloudSequenceProofOptions, type ReceiptStore,
} from "@scopebond/gateway";
import { SqliteCloudOutbox, loadOrCreateAttester } from "@scopebond/gateway/node";
import { LOSSLESS_OUTBOX } from "./delivery-report.js";
import { forgetCached, readTextCached } from "./config-cache.js";
import { summaryOptions } from "./evidence-detail.js";

/** The persisted connection between this machine and a Cloud workspace. Holds the
 *  scoped machine credential; treat cloud.json as a secret (written 0600). */
export interface HookConnection extends CloudEnrollmentResult {
  url: string;
  /** The workspace's installation id for this machine. An enrollment answer names it
   *  `installation_id`, or (older answers) as `gateway_id`, which is the same identifier;
   *  observations use `gateway_id` when the explicit field is absent. */
  installation_id?: string;
  /** The installation generation the enrollment created. Only the workspace can say what it
   *  is, so there is no fallback: without it the hook reports observations unsupported
   *  rather than guessing a generation. */
  installation_generation?: number;
  /** Where this machine sends its records: the workspace's regional ingest address, named by
   *  the enrollment answer. Absent from older answers and connections; `url` is used then. */
  ingest_url?: string;
}

/** The address records, observations and recovery go to: the enrollment's `ingest_url` when it
 *  is a valid HTTPS origin (or localhost in development), otherwise the workspace URL. Sign-in,
 *  policy and the portal always use `url`. */
export function ingestUrl(connection: Pick<HookConnection, "url" | "ingest_url">): string {
  return safeIngestOrigin(connection.ingest_url) ?? connection.url;
}

function safeIngestOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const parsed = new URL(value);
    const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    if ((parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) || parsed.username || parsed.password) return null;
    return parsed.origin;
  } catch { return null; }
}

export const connectionPath = (dir: string): string => join(dir, "cloud.json");

/** Read the persisted connection, or null when the hook is not connected to Cloud. */
export function loadConnection(dir: string): HookConnection | null {
  const path = connectionPath(dir);
  try {
    const text = readTextCached(path);
    if (text === null) return null;
    const parsed = JSON.parse(text.replace(/^\uFEFF/, "")) as Partial<HookConnection>;
    // The credential goes only to an HTTPS workspace (or localhost in development), as `login` requires, even if the file was edited.
    if (typeof parsed.url === "string" && typeof parsed.credential === "string" && safeIngestOrigin(parsed.url) !== null) return parsed as HookConnection;
  } catch { /* fall through */ }
  return null;
}

/** Enroll the machine's attester with a workspace using the portal's one-use handoff,
 *  then persist the scoped machine credential. The attester whose possession is proved
 *  here is the same key the hook countersigns receipts with, so ingest accepts them.
 *
 *  A workspace refuses a key it already knows — one revoked when the computer was
 *  replaced or disconnected, or one already enrolled elsewhere — without spending the
 *  token. Reconnecting then replaces the key and enrolls again with the same token, so a
 *  second `login` always works; the old key is kept under retired-keys/, and queued
 *  receipts it signed leave the delivery queue (they stay in the local log for
 *  `recover`), because the new connection can never deliver them. */
export async function connectCloud(
  dir: string, url: string, bundle: CloudEnrollmentBundle, fetchImpl?: typeof fetch,
): Promise<HookConnection & { rotatedFrom?: string; setAside?: number }> {
  let { attester } = loadOrCreateAttester({ file: join(dir, "attester.key") });
  const { attester: agent } = loadOrCreateAttester({ file: join(dir, "agent.key") });
  let rotatedFrom: string | undefined;
  let result;
  try {
    result = await completeCloudEnrollment({ url, bundle, attester, agent, fetch: fetchImpl });
  } catch (error) {
    if (!(error instanceof CloudEnrollmentError) || error.code !== "gateway_key_conflict") throw error;
    rotatedFrom = attester.kid;
    retireAttesterKey(dir, attester.kid);
    attester = loadOrCreateAttester({ file: join(dir, "attester.key") }).attester;
    result = await completeCloudEnrollment({ url, bundle, attester, agent, fetch: fetchImpl });
  }
  const { ingest_url: offered, ...enrolled } = result as typeof result & { ingest_url?: unknown };
  const ingest = safeIngestOrigin(offered);
  const connection: HookConnection = { url, ...enrolled, ...(ingest ? { ingest_url: ingest } : {}) };
  forgetCached(connectionPath(dir));
  writeFileSync(connectionPath(dir), JSON.stringify(connection, null, 2) + "\n", { mode: 0o600 });
  let setAside = 0;
  const outboxPath = join(dir, "receipts.db.cloud-outbox.db");
  if (existsSync(outboxPath)) {
    const outbox = new SqliteCloudOutbox(outboxPath);
    try { setAside = outbox.discardNotSignedBy(attester.kid); } finally { outbox.close(); }
  }
  return { ...connection, ...(rotatedFrom ? { rotatedFrom } : {}), ...(setAside ? { setAside } : {}) };
}

/** Where a replaced countersigning key is kept: receipts it signed stay verifiable, and
 *  `recover` can still deliver the ones the workspace never received. */
export const retiredKeysDir = (dir: string): string => join(dir, "retired-keys");

/** Move the current countersigning key aside so the next load creates a fresh one. */
export function retireAttesterKey(dir: string, kid: string): string {
  const target = join(retiredKeysDir(dir), `${kid.replace(/[^A-Za-z0-9_-]/g, "-")}.key`);
  const destination = existsSync(target) ? `${target}.${Date.now()}` : target;
  mkdirSync(retiredKeysDir(dir), { recursive: true });
  renameSync(join(dir, "attester.key"), destination);
  return destination;
}

/** Wrap a receipt store so every stored receipt is enqueued to a durable outbox and
 *  exported to Cloud. Returns the wrapped store and the exporter (flush + stop). */
/** The delivery queue could not be opened or written: a full disk, a read-only or locked file. The
 *  decision still happens and the record stays in the local log; the runtime reports this error (file and fix,
 *  since `init` does not) as `deliveryUnavailable`, notes the record, and queues it once the queue can be written again
 *  (delivery-repair.ts). The queue is never deleted: it holds waiting records. */
export class DeliveryQueueError extends Error {
  readonly repair: string;
  constructor(file: string, cause: unknown) {
    super(`Scopebond could not write its delivery queue (${file}): ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "DeliveryQueueError";
    this.repair = "Free some disk space, or make that file and its -wal and -shm files beside it writable for your user (it holds records waiting to be sent: do not delete it)";
  }
}

/** How this computer signs each batch's record numbers: the enrolled key (the one that signs its receipts) and the machine
 *  credential's id from the connection. None when either is missing, or when the key on disk is not the one this connection
 *  enrolled, since a proof under any other key could never verify. */
export function sequenceProofFor(
  connection: Pick<HookConnection, "credential_id" | "attester_kid">, attester: Attester | undefined,
): CloudSequenceProofOptions | undefined {
  if (!attester || typeof connection.credential_id !== "string" || !connection.credential_id.trim()) return undefined;
  if (typeof connection.attester_kid === "string" && connection.attester_kid !== attester.kid) return undefined;
  return { attester, credentialId: connection.credential_id };
}

export function attachExporter(
  outboxDbPath: string, connection: HookConnection, store: ReceiptStore, fetchImpl?: typeof fetch,
  options: { busyTimeoutMs?: number; onGap?: (gap: CloudDeliveryGap) => void } = {},
): { store: ReceiptStore; exporter: CloudExporter; outbox: SqliteCloudOutbox } {
  // Lossless (SB275): no cap and no expiry. A record leaves the queue only when the workspace
  // accepts it, or when a key change makes it undeliverable (`recover` then sends it). The
  // gateway's defaults (10,000 records, 64 MiB, 7 days) dropped the newest records once a long
  // outage filled the queue.
  let outbox: SqliteCloudOutbox;
  try { outbox = new SqliteCloudOutbox(outboxDbPath, { ...LOSSLESS_OUTBOX, ...(options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs }) }); }
  catch (error) { throw new DeliveryQueueError(outboxDbPath, error); }
  // `onGap`: a record the queue could not take (its write failed after the local write) is kept as a gap by the caller.
  const summaries = summaryOptions(dirname(outboxDbPath));
  const sequenceProof = sequenceProofFor(connection, summaries?.attester);
  const exporter = createCloudExporter({ url: ingestUrl(connection), credential: connection.credential, outbox, fetch: fetchImpl,
    summaries, ...(sequenceProof ? { sequenceProof } : {}), ...(options.onGap ? { onGap: options.onGap } : {}) });
  return { store: withCloudExporter(store, exporter), exporter, outbox };
}

/** Attempt delivery with a bounded timeout so a per-invocation hook never hangs the
 *  agent; undelivered receipts stay in the durable outbox and flush next time. A hook call passes `routine: false`: with
 *  summaries on, it sends only when it queued a notable record (the agent and `flush` send the summaries). */
export async function flushBounded(exporter: CloudExporter, timeoutMs = 3000, options: { routine?: boolean } = {}): Promise<boolean> {
  // Resolves true only when the time limit ran out first: a flush that had nothing to do, or was waiting out a retry, is not a
  // cut-off delivery.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    exporter.flush(options).then(() => false, () => false),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), Math.max(0, timeoutMs)); timer.unref?.(); }),
  ]);
  if (timer) clearTimeout(timer);
  return timedOut;
}

export interface UninstallReport { workspace: string; told: boolean; authorized: boolean | null }

/** Tell the workspace this computer is removing Scopebond, before anything is removed. Unless an owner or admin disconnected
 *  the computer or allowed its removal first, the workspace raises a critical alert. Bounded: an unreachable workspace never
 *  stops the person's uninstall; the line printed says the workspace was not told. */
export async function reportUninstall(connection: HookConnection, details: { purge: boolean; hookVersion: string }, fetchImpl: typeof fetch = fetch, timeoutMs = 4000): Promise<UninstallReport> {
  const workspace = connection.url;
  try {
    const res = await fetchImpl(`${ingestUrl(connection)}/v1/uninstall`, {
      method: "POST",
      headers: { authorization: `Bearer ${connection.credential}`, "content-type": "application/json" },
      body: JSON.stringify({ purge: details.purge, hook_version: details.hookVersion }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { workspace, told: false, authorized: null };
    const body = await res.json().catch(() => ({})) as { authorized?: unknown };
    return { workspace, told: true, authorized: typeof body.authorized === "boolean" ? body.authorized : null };
  } catch {
    return { workspace, told: false, authorized: null };
  }
}

