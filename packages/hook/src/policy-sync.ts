// Keep a connected computer's rules in step with its Scopebond Cloud workspace.
//
// `syncPolicy` asks the workspace for this computer's rules (`GET /v1/policy`), installs a newer version when there is one, and
// tells the workspace exactly what it loaded or why it could not (`POST /v1/policy/ack`). A tool call checks two small files;
// at most every five minutes it also runs the check (`syncIfDue`), in parallel with the delivery of its activity record and
// capped at about one and a half seconds, so a change made in the workspace applies within a few minutes of the agent's next
// action. It runs in the hook's own process on purpose: a detached helper process inherits the hook's output pipe on Windows,
// which makes the coding agent wait for the helper. Any failure or timeout keeps the rules already in force; an interrupted
// write cannot leave a half-written policy, because every write is a temp file and a rename.
//
// Answers from the workspace:
//   204  the workspace does not set rules for this computer: use (or go back to) its own rules
//   304  nothing changed since the last check
//   200  a rules document: checked, installed if newer, confirmed
//   401  the connection is no longer valid (revoked, expired, removed): go back to this computer's own rules

import { closeSync, existsSync, openSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { connectionPath, loadConnection } from "./cloud.js";
import { readDeliveryState, recordRulesCredential } from "./delivery-state.js";
import { queueStatus } from "./delivery-report.js";
import { refreshIfDue } from "./credential-refresh.js";

/** What this computer sends the workspace about its own delivery queue with each rules check, so
 *  the portal can say "checking in but not delivering" instead of "reporting". Counts and one
 *  error line only; never a record. */
function deliveryHeaders(dir: string): Record<string, string> {
  try {
    const { pending, oldest, queueId, seqAssigned } = queueStatus(dir);
    const state = readDeliveryState(dir);
    return {
      "x-scopebond-pending": String(pending),
      ...(oldest !== null ? { "x-scopebond-oldest-pending-at": String(oldest) } : {}),
      // SB289: which queue, and the highest number it has given a record. If this queue is later
      // removed, the workspace knows how many of its numbers never arrived.
      ...(queueId ? { "x-scopebond-queue-id": queueId, "x-scopebond-seq-assigned": String(seqAssigned ?? 0) } : {}),
      ...(state.last_error ? { "x-scopebond-last-error": state.last_error.replace(/[^\x20-\x7e]/g, " ").slice(0, 200) } : {}),
      // D140: the rule settings this computer runs and who set each, so the workspace shows what is true here.
      ...rulesHeader(dir),
    };
  } catch { return {}; }
}
function rulesHeader(dir: string): Record<string, string> {
  const report = ruleReport(dir);
  return report ? { "x-scopebond-rules": JSON.stringify(report) } : {};
}
import {
  ruleReport, inspectManaged, installManaged, isManaged, readMeta, restoreLocal, writeMeta, type ManagedMeta, type RefusalReason,
} from "./managed.js";

export const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const LOCK_FILE = "managed-sync.lock";
const LOCK_STALE_MS = 2 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5_000;
/** How long a tool call may spend on the five-minute check, at most (`SCOPEBOND_POLICY_SYNC_MS` overrides). */
export const INLINE_BUDGET_MS = 1_500;
const UNMANAGED_DIGEST = "0".repeat(64);

export type SyncOutcome =
  | { state: "not_connected" }
  | { state: "own_rules"; changed: boolean }
  | { state: "unchanged"; revision: number }
  | { state: "applied"; revision: number }
  | { state: "refused"; revision: number | null; reason: RefusalReason; message: string }
  | { state: "disconnected" }
  | { state: "unavailable"; message: string };

export interface SyncOptions {
  agentKid: string;
  hookVersion: string;
  policyBuilds: (policy: Record<string, unknown>) => boolean;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Recompute a project's trust pin after its policy.json changed (the same step `rules apply` takes). */
  afterPolicyWrite?: (dir: string) => void;
  /** Per-request timeout; defaults to five seconds. */
  timeoutMs?: number;
}

export async function syncPolicy(dir: string, options: SyncOptions): Promise<SyncOutcome> {
  const connection = loadConnection(dir);
  if (!connection) return { state: "not_connected" };
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = (options.now ?? (() => new Date()))();
  const installationId = (connection as { installation_id?: string }).installation_id ?? connection.gateway_id;
  const base = connection.url.replace(/\/+$/, "");
  const auth = { authorization: `Bearer ${connection.credential}` };
  const meta = readMeta(dir);
  const save = (patch: Partial<ManagedMeta>) => writeMeta(dir, { ...meta, ...patch, checked_at: now.toISOString() });

  const ack = async (body: { export_id: string; revision: number; rules_digest: string; result: "loaded" | "rejected"; reason?: RefusalReason }): Promise<ManagedMeta["last_ack"]> => {
    try {
      const res = await fetchImpl(`${base}/v1/policy/ack`, {
        method: "POST", headers: { ...auth, "content-type": "application/json" }, redirect: "error", signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
        body: JSON.stringify({ ...body, reason: body.reason ?? null, hook_version: options.hookVersion }),
      });
      return res.ok ? { revision: body.revision, result: body.result, at: now.toISOString() } : meta.last_ack;
    } catch { return meta.last_ack; }
  };
  const backToOwnRules = (): boolean => {
    if (!isManaged(dir)) return false;
    restoreLocal(dir, options.agentKid);
    options.afterPolicyWrite?.(dir);
    return true;
  };

  let res: Response;
  try {
    res = await fetchImpl(`${base}/v1/policy`, {
      // The hook's version tells the workspace which settings this computer understands (for example exact-target
      // exclusions), so it is never sent a document an older hook would refuse.
      headers: { ...auth, ...(options.hookVersion ? { "x-scopebond-hook-version": options.hookVersion } : {}), ...(isManaged(dir) && meta.etag ? { "if-none-match": meta.etag } : {}), ...deliveryHeaders(dir) },
      redirect: "error", signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    save({ last_error: `could not reach the workspace (${(error as Error).name}); the rules in force stay` });
    return { state: "unavailable", message: "could not reach the workspace" };
  }

  recordRulesCredential(dir, res.status !== 401, now.getTime());
  // A working connection renews its credential in its last 30 days (the workspace answers "not due" before that).
  if (res.status !== 401) await refreshIfDue(dir, connection, { fetchImpl, now: now.getTime(), timeoutMs: options.timeoutMs ?? REQUEST_TIMEOUT_MS });
  if (res.status === 401) {
    backToOwnRules();
    save({ revision: null, rules_digest: null, export_id: null, etag: null, last_error: "the workspace connection is no longer valid; this computer uses its own rules" });
    return { state: "disconnected" };
  }
  if (res.status === 204) {
    const changed = backToOwnRules();
    const last = meta.last_ack;
    const confirmed = changed || !last || last.revision !== 0
      ? await ack({ export_id: `rev-0-${installationId}`, revision: 0, rules_digest: UNMANAGED_DIGEST, result: "loaded" }) : last;
    save({ revision: null, rules_digest: null, export_id: null, etag: null, last_ack: confirmed, last_error: null });
    return { state: "own_rules", changed };
  }
  if (res.status === 304 && isManaged(dir) && meta.revision !== null) {
    const confirmed = meta.last_ack?.revision === meta.revision && meta.last_ack.result === "loaded" ? meta.last_ack
      : await ack({ export_id: meta.export_id!, revision: meta.revision, rules_digest: meta.rules_digest!, result: "loaded" });
    save({ last_ack: confirmed, last_error: null });
    return { state: "unchanged", revision: meta.revision };
  }
  if (res.status !== 200) {
    save({ last_error: `the workspace answered ${res.status}; the rules in force stay` });
    return { state: "unavailable", message: `the workspace answered ${res.status}` };
  }

  let raw: unknown;
  try { raw = await res.json(); } catch { raw = null; }
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const etag = res.headers.get("etag");
  // The same version already in force: confirm it again if the last confirmation did not land.
  if (isManaged(dir) && r.revision === meta.revision && r.rules_digest === meta.rules_digest && meta.revision !== null) {
    const confirmed = meta.last_ack?.revision === meta.revision ? meta.last_ack
      : await ack({ export_id: meta.export_id!, revision: meta.revision, rules_digest: meta.rules_digest!, result: "loaded" });
    save({ etag, last_ack: confirmed, last_error: null });
    return { state: "unchanged", revision: meta.revision };
  }
  const inspected = inspectManaged(raw, { installationId, currentRevision: isManaged(dir) ? meta.revision : null, currentDigest: isManaged(dir) ? meta.rules_digest : null });
  const echo = typeof r.export_id === "string" && Number.isInteger(r.revision) && typeof r.rules_digest === "string" && /^[0-9a-f]{64}$/.test(r.rules_digest)
    ? { export_id: r.export_id, revision: r.revision as number, rules_digest: r.rules_digest } : null;
  if (!inspected.ok) {
    const confirmed = echo ? await ack({ ...echo, result: "rejected", reason: inspected.reason }) : meta.last_ack;
    save({ last_ack: confirmed, last_error: inspected.message });
    return { state: "refused", revision: echo?.revision ?? null, reason: inspected.reason, message: inspected.message };
  }
  const doc = inspected.doc;
  const installed = installManaged(dir, doc, options.agentKid, options.policyBuilds);
  if (!installed.ok) {
    const confirmed = await ack({ export_id: doc.export_id, revision: doc.revision, rules_digest: doc.rules_digest, result: "rejected", reason: installed.reason });
    save({ last_ack: confirmed, last_error: installed.message });
    return { state: "refused", revision: doc.revision, reason: installed.reason, message: installed.message };
  }
  options.afterPolicyWrite?.(dir);
  const confirmed = await ack({ export_id: doc.export_id, revision: doc.revision, rules_digest: doc.rules_digest, result: "loaded" });
  save({ revision: doc.revision, rules_digest: doc.rules_digest, export_id: doc.export_id, etag, last_ack: confirmed, last_error: null });
  return { state: "applied", revision: doc.revision };
}

/** Called on every tool call: when this computer is connected and has not checked in five minutes, run the check, capped at
 *  `budgetMs`. Resolves `null` when no check was due, another one is running, or the cap was reached first (the check then
 *  finishes if the process lives long enough, else runs again on a later call). Never throws. `makeOptions` is called only when a
 *  check is due, so an ordinary call pays nothing but two file reads. */
export async function syncIfDue(dir: string, makeOptions: () => SyncOptions, budgetMs = Number(process.env.SCOPEBOND_POLICY_SYNC_MS ?? INLINE_BUDGET_MS), now = Date.now()): Promise<SyncOutcome | null> {
  try {
    if (process.env.SCOPEBOND_POLICY_SYNC === "off") return null;
    if (!existsSync(connectionPath(dir))) return null;
    const checked = readMeta(dir).checked_at;
    if (checked && now - Date.parse(checked) < SYNC_INTERVAL_MS) return null;
    const lock = join(dir, LOCK_FILE);
    if (existsSync(lock)) {
      if (now - statSync(lock).mtimeMs < LOCK_STALE_MS) return null;
      rmSync(lock, { force: true });
    }
    const fd = openSync(lock, "wx");
    writeSync(fd, String(process.pid));
    closeSync(fd);
    const budget = Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : INLINE_BUDGET_MS;
    const work = Promise.resolve()
      .then(() => syncPolicy(dir, { ...makeOptions(), timeoutMs: budget }))
      .catch((): SyncOutcome => ({ state: "unavailable", message: "the check failed" }))
      .finally(() => releaseSyncLock(dir));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const capped = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), budget); });
    const outcome = await Promise.race([work, capped]);
    if (timer) clearTimeout(timer);
    return outcome;
  } catch { return null; }
}

export function releaseSyncLock(dir: string): void {
  try { rmSync(join(dir, LOCK_FILE), { force: true }); } catch { /* expires on its own */ }
}
