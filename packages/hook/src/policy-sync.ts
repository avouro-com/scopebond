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
//
// A signed answer (a rules document, or `{ type: "scopebond:managed-rules", managed: false, … }` with 200 for "no rules")
// must verify against a pinned workspace key (policy-signature.ts). In the default `dual` mode an unsigned answer is still
// accepted and recorded as `unsigned_policy`; in `enforce` mode it is refused, and so are a 204 and a 401, which carry no
// signature: the rules in force stay, and the computer never falls back to no rules on an answer it cannot verify.

import { closeSync, existsSync, fstatSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { connectionPath, loadConnection } from "./cloud.js";
import { readDeliveryState, recordRulesCredential } from "./delivery-state.js";
import { queueStatus } from "./delivery-report.js";
import { refreshIfDue } from "./credential-refresh.js";
import { recommendedFrom } from "./client-health.js";
import { retentionDaysFrom } from "./store-upkeep.js";
import { evidenceDetailFrom } from "./evidence-detail.js";
import { receiptContextFrom } from "./receipt-context.js";
import { admitSigned, checkPolicySignature, readSignatureState, signatureMode, workspaceIdOf, type SignatureReason, type SignatureState } from "./policy-signature.js";
import { HOOK_VERSION_HEADER, versionedFetch } from "./workspace-fetch.js";

/** What this computer sends the workspace about its own delivery queue with each rules check, so
 *  the portal can say "checking in but not delivering" instead of "reporting". Counts and one
 *  error line only; never a record. */
function deliveryHeaders(dir: string): Record<string, string> {
  try {
    const { pending, oldest, queueId, seqAssigned, gapsTotal, gapsByReason } = queueStatus(dir);
    const state = readDeliveryState(dir);
    return {
      "x-scopebond-pending": String(pending),
      ...(oldest !== null ? { "x-scopebond-oldest-pending-at": String(oldest) } : {}),
      // The oldest time is in this computer's clock; sending the clock beside it lets the workspace measure how long records
      // have waited on its own clock, and see a clock running ahead (its records are then refused as signed in the future).
      ...(oldest !== null ? { "x-scopebond-clock": String(Date.now()) } : {}),
      // Which queue, and the highest number it has given a record. If this queue is later
      // removed, the workspace knows how many of its numbers never arrived.
      ...(queueId ? { "x-scopebond-queue-id": queueId, "x-scopebond-seq-assigned": String(seqAssigned ?? 0) } : {}),
      // Records that missed normal delivery (refused, a failed queue write, set aside after a key change...): the queue's
      // lifetime total and its counts by reason code, so the workspace sees them and not only a hole in the numbering.
      ...(gapsTotal > 0 ? { "x-scopebond-gaps-total": String(gapsTotal), "x-scopebond-gaps-by-reason": JSON.stringify(gapsByReason) } : {}),
      ...(state.last_error ? { "x-scopebond-last-error": state.last_error.replace(/[^\x20-\x7e]/g, " ").slice(0, 200) } : {}),
      // The rule settings this computer runs and who set each, so the workspace shows what is true here.
      ...rulesHeader(dir),
      // How the last answer's signature was checked (verified, unsigned and accepted, or refused, and why).
      ...signatureHeader(dir),
    };
  } catch { return {}; }
}
/** Whether the workspace document in force lets people change rules on this computer. */
function installedLocalChanges(dir: string): boolean {
  try { return (JSON.parse(readFileSync(join(dir, MANAGED_DOC_FILE), "utf8")) as { local_changes?: unknown }).local_changes === true; } catch { return false; }
}
/** The tool settings mark of the workspace document in force (managed.ts `toolSettingsMark`). */
function installedToolSettingsMark(dir: string): string | null {
  try { return toolSettingsMark(JSON.parse(readFileSync(join(dir, MANAGED_DOC_FILE), "utf8"))); } catch { return null; }
}
function rulesHeader(dir: string): Record<string, string> {
  const report = ruleReport(dir);
  return report ? { "x-scopebond-rules": JSON.stringify(report) } : {};
}
function signatureHeader(dir: string): Record<string, string> {
  const state = readSignatureState(dir);
  return state ? { "x-scopebond-policy-signature": JSON.stringify({ mode: state.mode, last: state.last, reason: state.reason }) } : {};
}
/** The refusal reason the confirmation carries for a signature refusal, in the words the workspace already reads. */
const ackReasonFor = (reason: SignatureReason): RefusalReason =>
  reason === "wrong_computer" ? "wrong_computer" : reason === "replayed" ? "stale_revision" : "invalid_document";
import {
  ruleReport, toolSettingsMark, inspectManaged, installManaged, isManaged, isUnmanagedAnswer, MANAGED_DOC_FILE, readMeta, restoreLocal, writeMeta, type ManagedMeta, type RefusalReason,
} from "./managed.js";
import { SERVICE_RULES_CAPABILITY } from "./service-rules.js";

/** What this hook reads in a workspace's rules document beyond what its version implies, as `x-scopebond-hook-capabilities`
 *  says it: allowances (and "Block, person may ask"), session budgets, and blocked services (service-rules.ts). */
export const HOOK_CAPABILITIES = ["allowances", "session_budgets", SERVICE_RULES_CAPABILITY] as const;

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
  | { state: "refused"; revision: number | null; reason: RefusalReason; message: string; signature?: SignatureReason }
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
  /** A request the workspace carries once on the rules check (`x-scopebond-request`): send now, or run the self-check.
   *  Only the Scopebond Agent passes this; a hook call ignores the header. */
  onRequest?: (kind: "flush" | "self_check") => void;
  /** The Scopebond Agent's version (`x-scopebond-agent-version`): a workspace sends tool settings only to an agent that applies
   *  them. Only the agent passes this. */
  agentVersion?: string;
  /** The agent's report of the tool settings it last applied (`x-scopebond-tool-settings`, JSON); null when there is none. */
  toolSettingsReport?: () => string | null;
}

/** The longest tool settings report a rules check carries. */
export const MAX_TOOL_SETTINGS_REPORT = 4_000;
// eslint-disable-next-line security/detect-unsafe-regex -- linear: anchored, bounded fields, one optional bounded suffix
const VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,3}(-[0-9A-Za-z.-]{1,32})?$/;
function toolSettingsHeaders(options: SyncOptions): Record<string, string> {
  const headers: Record<string, string> = {};
  if (options.agentVersion && VERSION.test(options.agentVersion)) headers["x-scopebond-agent-version"] = options.agentVersion;
  try {
    const report = options.toolSettingsReport?.();
    if (report && report.length <= MAX_TOOL_SETTINGS_REPORT && /^[\x20-\x7e]+$/.test(report)) headers["x-scopebond-tool-settings"] = report;
  } catch { /* the report is best effort */ }
  return headers;
}

export async function syncPolicy(dir: string, options: SyncOptions): Promise<SyncOutcome> {
  const connection = loadConnection(dir);
  if (!connection) return { state: "not_connected" };
  // Every call to the workspace says which hook version makes it (the rules check below sets it itself).
  const fetchImpl = versionedFetch(options.fetchImpl ?? fetch, options.hookVersion);
  const now = (options.now ?? (() => new Date()))();
  const installationId = (connection as { installation_id?: string }).installation_id ?? connection.gateway_id;
  const mode = signatureMode(connection);
  const base = connection.url.replace(/\/+$/, "");
  const auth = { authorization: `Bearer ${connection.credential}` };
  const meta = readMeta(dir);
  // The workspace's recommended versions ride on every rules check; kept with the rules' state.
  let recommended = meta.recommended ?? null;
  // So does the local retention the workspace chose.
  let retention = meta.local_retention_days ?? null;
  // And the evidence detail: what this computer sends.
  let detail = meta.evidence_detail ?? null;
  // A workspace that reads a heartbeat's interval says so; until then heartbeats stay every 60 s.
  let heartbeatInterval = meta.heartbeat_interval_s ?? null;
  // Whether the workspace reads receipt context: each full rules check answer says it (`x-scopebond-receipt-context: 1`), and a
  // full answer (200 or 204) without it turns it off again, so a workspace that stops reading it is not sent a key it would
  // refuse. A 304 or an error answer leaves it as it was.
  let receiptContext = meta.receipt_context ?? null;
  const save = (patch: Partial<ManagedMeta>) => writeMeta(dir, { ...meta, recommended, local_retention_days: retention, evidence_detail: detail, heartbeat_interval_s: heartbeatInterval, receipt_context: receiptContext, ...patch, checked_at: now.toISOString() });

  const ack = async (body: { export_id: string; revision: number; rules_digest: string; result: "loaded" | "rejected"; reason?: RefusalReason }): Promise<ManagedMeta["last_ack"]> => {
    try {
      const res = await fetchImpl(`${base}/v1/policy/ack`, {
        // The same capabilities as the rules check: the workspace rebuilds the document it expects from them to compare the
        // digest this confirms (with blocked services, the digest covers the list).
        method: "POST", headers: { ...auth, "content-type": "application/json", "x-scopebond-hook-capabilities": HOOK_CAPABILITIES.join(",") }, redirect: "error", signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
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
      // The settings this hook understands beyond its version (the workspace sends allowances, "Block, person may ask"
      // and the always/requests terms, session budgets and blocked services only to a hook that says so).
      // Whether this caller acts on a request from the workspace's computer page: a workspace that reads this header leaves
      // the request in place for the Scopebond Agent instead of handing it to a hook call that would drop it.
      headers: { ...auth, "x-scopebond-hook-capabilities": HOOK_CAPABILITIES.join(","), "x-scopebond-accepts-requests": options.onRequest ? "flush,self_check" : "none", ...(options.hookVersion ? { [HOOK_VERSION_HEADER]: options.hookVersion } : {}), ...(isManaged(dir) && meta.etag ? { "if-none-match": meta.etag } : {}), ...deliveryHeaders(dir), ...toolSettingsHeaders(options) },
      redirect: "error", signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    save({ last_error: `could not reach the workspace (${(error as Error).name}); the rules in force stay` });
    return { state: "unavailable", message: "could not reach the workspace" };
  }

  recommended = recommendedFrom(res.headers) ?? recommended;
  const asked = res.headers?.get?.("x-scopebond-request")?.trim();
  if (options.onRequest && (asked === "flush" || asked === "self_check")) { try { options.onRequest(asked); } catch { /* the request is best effort */ } }
  retention = retentionDaysFrom(res.headers) ?? retention;
  detail = evidenceDetailFrom(res.headers) ?? detail;
  heartbeatInterval = heartbeatIntervalFrom(res.headers) ?? heartbeatInterval;
  if (receiptContextFrom(res.headers)) receiptContext = true;
  else if (res.status === 200 || res.status === 204) receiptContext = false;
  recordRulesCredential(dir, res.status !== 401, now.getTime());
  // A working connection renews its credential in its last 30 days (the workspace answers "not due" before that).
  if (res.status !== 401) await refreshIfDue(dir, connection, { fetchImpl, now: now.getTime(), timeoutMs: options.timeoutMs ?? REQUEST_TIMEOUT_MS });
  const at = now.toISOString();
  // Replay protection holds per workspace: a computer connected to another workspace starts again (an answer from the old
  // one can never verify here, since the signature binds the workspace id).
  const workspaceId = workspaceIdOf(connection);
  const lastIssuedAt = (): string | null => (meta.policy_issued_workspace ?? null) === workspaceId ? meta.policy_issued_at ?? null : null;
  const issued = (issuedAt: string | null) => (issuedAt ? { policy_issued_at: issuedAt, policy_issued_workspace: workspaceId } : {});
  const signed = (raw: Record<string, unknown>, managed: boolean) => {
    const check = checkPolicySignature(raw, { workspace: workspaceId, computer: installationId, managed, lastIssuedAt: lastIssuedAt(), now });
    return { issuedAt: check.result === "verified" ? check.issuedAt : null, admitted: admitSigned(check, mode, at) };
  };
  if (res.status === 401) {
    // A 401 carries no signature. In enforce mode it is not reason enough to drop the workspace's rules: they stay in
    // force until the person signs in again (or disconnects this computer), so a forged 401 never relaxes them.
    if (mode === "enforce" && isManaged(dir)) {
      const state: SignatureState = { mode, last: "refused", reason: "unsigned_policy", at };
      save({ policy_signature: state, last_error: "the workspace connection is no longer valid; in enforce mode the workspace rules in force stay until this computer signs in again or is disconnected" });
      return { state: "disconnected" };
    }
    backToOwnRules();
    save({ revision: null, rules_digest: null, export_id: null, etag: null, last_error: "the workspace connection is no longer valid; this computer uses its own rules" });
    return { state: "disconnected" };
  }
  /** The workspace sets no rules for this computer (a 204, or its signed 200 form): back to its own rules, once admitted. */
  const toOwnRules = async (admitted: ReturnType<typeof admitSigned>, issuedAt: string | null): Promise<SyncOutcome> => {
    if (!admitted.ok) {
      const confirmed = await ack({ export_id: `rev-0-${installationId}`, revision: 0, rules_digest: UNMANAGED_DIGEST, result: "rejected", reason: ackReasonFor(admitted.reason) });
      save({ last_ack: confirmed, policy_signature: admitted.state, last_error: admitted.message });
      return { state: "refused", revision: null, reason: ackReasonFor(admitted.reason), message: admitted.message, signature: admitted.reason };
    }
    const changed = backToOwnRules();
    const last = meta.last_ack;
    const confirmed = changed || !last || last.revision !== 0 || last.result !== "loaded"
      ? await ack({ export_id: `rev-0-${installationId}`, revision: 0, rules_digest: UNMANAGED_DIGEST, result: "loaded" }) : last;
    save({ revision: null, rules_digest: null, export_id: null, etag: null, last_ack: confirmed, last_error: null, policy_signature: admitted.state, ...issued(issuedAt) });
    return { state: "own_rules", changed };
  };
  if (res.status === 204) return toOwnRules(admitSigned({ result: "unsigned" }, mode, at), null);
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
  // "No rules for this computer" as a (signed) body: the same as a 204 once its signature is admitted.
  if (isUnmanagedAnswer(raw)) {
    if (r.installation_id !== installationId) {
      const state: SignatureState = { mode, last: "refused", reason: "wrong_computer", at };
      const message = "the workspace's answer was issued for a different computer; the rules in force stay";
      save({ policy_signature: state, last_error: message });
      return { state: "refused", revision: null, reason: "wrong_computer", message, signature: "wrong_computer" };
    }
    const { issuedAt, admitted } = signed(r, false);
    return toOwnRules(admitted, issuedAt);
  }
  // Whether people may change rules on this computer is outside the rules digest, so the same version can arrive
  // with only that switch changed; it is a change to install, not "unchanged".
  const sameVersion = isManaged(dir) && r.revision === meta.revision && r.rules_digest === meta.rules_digest && meta.revision !== null;
  // So are the tool settings (signed on their own): a section with another digest or key is a change to install. An answer
  // without the section changes nothing here (a hook call is not sent it; only the Scopebond Agent is).
  const switchChanged = sameVersion && ((r.local_changes === true) !== installedLocalChanges(dir)
    || (toolSettingsMark(r) !== null && toolSettingsMark(r) !== installedToolSettingsMark(dir)));
  // The same version already in force: confirm it again if the last confirmation did not land.
  if (sameVersion && !switchChanged) {
    // Checked like a new answer: the version in force served again without its signature (or with a bad one) is not
    // confirmed as loaded, and what `status` says about the last answer stays true.
    const again = signed(r, true);
    if (!again.admitted.ok) {
      const reason = ackReasonFor(again.admitted.reason);
      const confirmed = await ack({ export_id: meta.export_id!, revision: meta.revision!, rules_digest: meta.rules_digest!, result: "rejected", reason });
      save({ last_ack: confirmed, policy_signature: again.admitted.state, last_error: again.admitted.message });
      return { state: "refused", revision: meta.revision, reason, message: again.admitted.message, signature: again.admitted.reason };
    }
    const confirmed = meta.last_ack?.revision === meta.revision && meta.last_ack.result === "loaded" ? meta.last_ack
      : await ack({ export_id: meta.export_id!, revision: meta.revision!, rules_digest: meta.rules_digest!, result: "loaded" });
    save({ etag, last_ack: confirmed, last_error: null, policy_signature: again.admitted.state, ...issued(again.issuedAt) });
    return { state: "unchanged", revision: meta.revision! };
  }
  const inspected = inspectManaged(raw, switchChanged ? { installationId, currentRevision: null }
    : { installationId, currentRevision: isManaged(dir) ? meta.revision : null, currentDigest: isManaged(dir) ? meta.rules_digest : null });
  const echo = typeof r.export_id === "string" && Number.isInteger(r.revision) && typeof r.rules_digest === "string" && /^[0-9a-f]{64}$/.test(r.rules_digest)
    ? { export_id: r.export_id, revision: r.revision as number, rules_digest: r.rules_digest } : null;
  if (!inspected.ok) {
    const confirmed = echo ? await ack({ ...echo, result: "rejected", reason: inspected.reason }) : meta.last_ack;
    save({ last_ack: confirmed, last_error: inspected.message });
    return { state: "refused", revision: echo?.revision ?? null, reason: inspected.reason, message: inspected.message };
  }
  const doc = inspected.doc;
  // A well-formed document must also pass its signature check before anything changes.
  const { issuedAt, admitted } = signed(r, true);
  if (!admitted.ok) {
    const reason = ackReasonFor(admitted.reason);
    const confirmed = await ack({ export_id: doc.export_id, revision: doc.revision, rules_digest: doc.rules_digest, result: "rejected", reason });
    save({ last_ack: confirmed, policy_signature: admitted.state, last_error: admitted.message });
    return { state: "refused", revision: doc.revision, reason, message: admitted.message, signature: admitted.reason };
  }
  const installed = installManaged(dir, doc, options.agentKid, options.policyBuilds);
  if (!installed.ok) {
    const confirmed = await ack({ export_id: doc.export_id, revision: doc.revision, rules_digest: doc.rules_digest, result: "rejected", reason: installed.reason });
    save({ last_ack: confirmed, last_error: installed.message });
    return { state: "refused", revision: doc.revision, reason: installed.reason, message: installed.message };
  }
  options.afterPolicyWrite?.(dir);
  const confirmed = await ack({ export_id: doc.export_id, revision: doc.revision, rules_digest: doc.rules_digest, result: "loaded" });
  save({ revision: doc.revision, rules_digest: doc.rules_digest, export_id: doc.export_id, etag, last_ack: confirmed, last_error: null,
    policy_signature: admitted.state, ...issued(issuedAt) });
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
    if (!claimSyncLock(join(dir, LOCK_FILE), now)) return null;
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

/** Take the sync lock. The exclusive create is the check: when the lock is held, its age is read from the open file, and a
 *  lock older than LOCK_STALE_MS is removed and taken once more. False when another check holds a fresh lock; throws when
 *  the lock cannot be taken. */
function claimSyncLock(lock: string, now: number): boolean {
  for (let attempt = 0; ; attempt++) {
    try {
      const fd = openSync(lock, "wx");
      try { writeSync(fd, String(process.pid)); } finally { closeSync(fd); }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 0) throw error;
    }
    const held = openSync(lock, "r");
    let mtimeMs: number;
    try { mtimeMs = fstatSync(held).mtimeMs; } finally { closeSync(held); }
    if (now - mtimeMs < LOCK_STALE_MS) return false;
    rmSync(lock, { force: true });
  }
}

export function releaseSyncLock(dir: string): void {
  try { rmSync(join(dir, LOCK_FILE), { force: true }); } catch { /* expires on its own */ }
}

/** The heartbeat interval a workspace allows (`x-scopebond-heartbeat-interval-s`, 60–900), or null when it does not say. */
export function heartbeatIntervalFrom(headers: { get(name: string): string | null } | undefined): number | null {
  const raw = headers?.get?.("x-scopebond-heartbeat-interval-s")?.trim() ?? "";
  if (!/^\d{2,3}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 60 && n <= 900 ? n : null;
}
