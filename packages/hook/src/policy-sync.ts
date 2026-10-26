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
// Once an answer from the workspace has verified, the computer is latched to enforce mode for it, every signed answer's
// freshness proof is kept, a 304 renews nothing without a verified proof, and a 401 drops the rules only with a verified
// revocation (policy-freshness.ts).

import { closeSync, existsSync, fstatSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { connectionPath, loadConnection } from "./cloud.js";
import { machineIdHeaders } from "@scopebond/gateway";
import { machineIdFor } from "./machine-id.js";
import { readDeliveryState, recordRulesCredential } from "./delivery-state.js";
import { queueStatus } from "./delivery-report.js";
import { refreshIfDue } from "./credential-refresh.js";
import { recommendedFrom } from "./client-health.js";
import { retentionDaysFrom } from "./store-upkeep.js";
import { evidenceDetailFrom } from "./evidence-detail.js";
import { receiptContextFrom } from "./receipt-context.js";
import { admitSigned, checkAnswerSignature, digestGrants, readSignatureState, workspaceIdOf, type SignatureReason, type SignatureState } from "./policy-signature.js";
import { pinNextKey, signatureModeAt, useNextKey } from "./policy-next-key.js";
import { checkFreshness, checkRevocation, decodeFreshnessHeader, laterOf, latchedTo, FRESHNESS_HEADER, type FreshnessCheck, type StoredFreshness, type StoredLatch } from "./policy-freshness.js";
import { HOOK_VERSION_HEADER, versionedFetch } from "./workspace-fetch.js";
import { packsHeaderValue, restampPacks, syncPacks, PACK_ENGINE_HEADER, PACKS_HEADER } from "./pack-sync.js";
import { packEngineLevel } from "./pack-store.js";
import { fatigueHeaderValue, FATIGUE_HEADER } from "./fatigue.js";
import { HOOK_FAILURES_CAPABILITY, HOOK_FAILURES_HEADER, hookFailuresHeaderValue } from "./hook-errors.js";
import { removeBlocklist, syncInstallBlocklist, SAFE_INSTALL_HEADER } from "./install-verdicts.js";
import { checkTrust, forgetTrustRecord, hasTrustRecord, rebindPackFiles, recordTrustedAnswer } from "./policy-trust.js";

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
      // The packs in force, those not taken and why, and this engine's level (pack-sync.ts).
      ...packsHeader(dir),
      // How often the person was interrupted today: toasts and prompts, counts only (fatigue.ts).
      ...fatigueHeader(dir),
      // Actions blocked in the last day because the hook itself failed, and the newest kind (hook-errors.ts).
      ...hookFailuresHeader(dir),
    };
  } catch { return {}; }
}
/** Whether the rules file in force parses. One that is missing or does not (a disk error, a hand edit) blocks every action,
 *  so the next check fetches and installs the workspace's rules again instead of answering "unchanged". */
function policyFileParses(dir: string): boolean {
  try { JSON.parse(readFileSync(join(dir, "policy.json"), "utf8").replace(/^\uFEFF/, "")); return true; } catch { return false; }
}
/** Whether the workspace's rules on this computer still match the verified answer they came from (policy-trust.ts), and that
 *  answer is the version the rules state says is in force (an older answer and its files put back are not "unchanged"). True
 *  where the check does not apply. */
function trustIntact(dir: string, meta: ManagedMeta): boolean {
  const check = checkTrust(dir);
  if (!check.applies) return true;
  return check.ok && check.revision === meta.revision && check.rulesDigest === meta.rules_digest;
}
/** The grants digest (policy-signature.ts `digestGrants`) of the workspace document in force, or null. */
function installedGrantsDigest(dir: string): string | null {
  try { return digestGrants(JSON.parse(readFileSync(join(dir, MANAGED_DOC_FILE), "utf8")) as Record<string, unknown>); } catch { return null; }
}
/** The tool settings mark of the workspace document in force (managed.ts `toolSettingsMark`). */
function installedToolSettingsMark(dir: string): string | null {
  try { return toolSettingsMark(JSON.parse(readFileSync(join(dir, MANAGED_DOC_FILE), "utf8"))); } catch { return null; }
}
function rulesHeader(dir: string): Record<string, string> {
  const report = ruleReport(dir);
  return report ? { "x-scopebond-rules": JSON.stringify(report) } : {};
}
function fatigueHeader(dir: string): Record<string, string> {
  const value = fatigueHeaderValue(dir);
  return value !== null ? { [FATIGUE_HEADER]: value } : {};
}
function hookFailuresHeader(dir: string): Record<string, string> {
  const value = hookFailuresHeaderValue(dir);
  return value !== null ? { [HOOK_FAILURES_HEADER]: value } : {};
}
function packsHeader(dir: string): Record<string, string> {
  const value = packsHeaderValue(dir);
  return value !== null ? { [PACKS_HEADER]: value } : {};
}
function signatureHeader(dir: string): Record<string, string> {
  const state = readSignatureState(dir);
  return state ? { "x-scopebond-policy-signature": JSON.stringify({ mode: state.mode, last: state.last, reason: state.reason }) } : {};
}
/** The refusal reason the confirmation carries for a signature refusal, in the words the workspace already reads. */
const ackReasonFor = (reason: SignatureReason): RefusalReason =>
  reason === "wrong_computer" ? "wrong_computer" : reason === "replayed" ? "stale_revision" : "invalid_document";
import {
  allowsLocalChanges, ruleReport, toolSettingsMark, inspectManaged, installManaged, isManaged, isUnmanagedAnswer, MANAGED_DOC_FILE, readMeta, restoreLocal, writeMeta, type ManagedMeta, type RefusalReason,
} from "./managed.js";
import { SERVICE_RULES_CAPABILITY } from "./service-rules.js";
import { trimEndChars } from "./text.js";
import { EXCEPTIONS_CAPABILITY } from "./rule-exceptions.js";
import { QUIET_PATTERNS_CAPABILITY } from "./tune-digest.js";
import { SIGNED_ARTIFACTS_CAPABILITY, syncArtifacts } from "./signed-artifacts.js";
import { setting } from "./env-trust.js";

/** What this hook reads in a workspace's rules document beyond what its version implies, as `x-scopebond-hook-capabilities`
 *  says it: allowances (and "Block, person may ask"), session budgets, blocked services (service-rules.ts), the one length an
 *  unblock lasts and its review (`unblock_terms`), "unlimited" for an override's `minutes` and `daily_limit`
 *  (`unlimited_terms`; an older hook gets numbers), and the signed list of rule packs to hold (`packs`, pack-sync.ts), and the
 *  lengths a person's unblock may last (`answer_lengths`: an override's `lengths`, managed.ts), who may allow "Similar commands in this project"
 *  (`pattern_allowances`: an override's `patterns`, pattern-recipes.ts), and the modes of the rule packs'
 *  rules (`pack_rules`, managed.ts; an unknown rule id is skipped and reported, never a refusal), and pack engine level 2
 *  (`pack_engine_2`: a pack list's `requires_engine`, `shadow` and `killed`, and the taxonomy extension, pack-sync.ts), and the
 *  blocks the workspace keeps quiet (`quiet_patterns`: blocked without asking or a notification, tune-digest.ts), and signed
 *  artifacts for the plugin slot (`signed_artifacts_1`: a pack list's `artifacts`, signed-artifacts.ts). */
export const HOOK_CAPABILITIES = ["allowances", "session_budgets", SERVICE_RULES_CAPABILITY, "unblock_terms", "unlimited_terms", "packs", "optional_reason", "rule_off", EXCEPTIONS_CAPABILITY, "answer_lengths", "pattern_allowances", "pack_rules", "pack_engine_2", QUIET_PATTERNS_CAPABILITY, SIGNED_ARTIFACTS_CAPABILITY, HOOK_FAILURES_CAPABILITY] as const;

/** The capabilities this hook reports now: `HOOK_CAPABILITIES`, without `pack_engine_2` while the pack engine level is lowered
 *  below 2 (`SCOPEBOND_PACK_ENGINE_LEVEL`, pack-store.ts). */
export function hookCapabilities(level: number = packEngineLevel()): string[] {
  return HOOK_CAPABILITIES.filter((c) => c !== "pack_engine_2" || level >= 2);
}

export const SYNC_INTERVAL_MS = 5 * 60 * 1000;
/** How often the check runs while the workspace's rules here do not match their signed answer (policy-trust.ts). */
export const TRUST_RETRY_MS = 30 * 1000;
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
  // The next policy-signing key pinned here is trusted with the pinned ones; it may also make this computer enforce signatures.
  useNextKey(dir);
  const mode = signatureModeAt(dir, connection);
  const base = trimEndChars(connection.url, "/");
  // This computer's machine id (a hash; machine-id.ts) rides on the rules check and its confirmation.
  const auth = { authorization: `Bearer ${connection.credential}`, ...machineIdHeaders(() => machineIdFor(dir, connection.organization_id)) };
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
  // And the rule packs the workspace names (pack-sync.ts).
  let packState = meta.packs ?? null;
  // And what became of the last next-key document the workspace sent.
  let nextKey = meta.next_key ?? null;
  // Replay protection, the latch and freshness hold per workspace: a computer connected to another workspace starts again (an
  // answer from the old one can never verify here, since the signature binds the workspace id).
  const workspaceId = workspaceIdOf(connection);
  // Latched to signed answers once one verified (policy-freshness.ts); `mode` above is then already `enforce`.
  let latch: StoredLatch | null = meta.policy_latch ?? null;
  const latched = latchedTo(meta, workspaceId);
  // The newest verified freshness proof, for this workspace only.
  let freshness: StoredFreshness | null = meta.policy_freshness?.workspace === workspaceId ? meta.policy_freshness : null;
  // Every check records when it was tried; only a successful one (it clears the error: rules applied, unchanged, or the
  // workspace's own-rules answer) moves `checked_at`, so "Rules updated" is the last check that worked. A failed one keeps
  // `checked_at` and says why in `last_error`.
  const save = (patch: Partial<ManagedMeta>) => writeMeta(dir, { ...meta, recommended, local_retention_days: retention, evidence_detail: detail, heartbeat_interval_s: heartbeatInterval, receipt_context: receiptContext, packs: packState, next_key: nextKey, policy_latch: latch, policy_freshness: freshness, ...patch,
    last_attempt_at: now.toISOString(), ...(patch.last_error === null ? { checked_at: now.toISOString(), checked_ok_at: now.toISOString() } : {}) });

  const ack = async (body: { export_id: string; revision: number; rules_digest: string; result: "loaded" | "rejected"; reason?: RefusalReason; skipped_rules?: string[] }): Promise<ManagedMeta["last_ack"]> => {
    try {
      const res = await fetchImpl(`${base}/v1/policy/ack`, {
        // The same capabilities as the rules check: the workspace rebuilds the document it expects from them to compare the
        // digest this confirms (with blocked services, the digest covers the list).
        method: "POST", headers: { ...auth, "content-type": "application/json", "x-scopebond-hook-capabilities": hookCapabilities().join(",") }, redirect: "error", signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
        // The rule ids the document named that this version skipped are sent only when there are some.
        body: JSON.stringify({ ...body, reason: body.reason ?? null, hook_version: options.hookVersion, skipped_rules: body.skipped_rules?.length ? body.skipped_rules : undefined }),
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

  // A rules file that no longer parses, or workspace rules that no longer match their signed answer (policy-trust.ts), are
  // fetched in full and installed again.
  const intact = policyFileParses(dir) && trustIntact(dir, meta);
  let res: Response;
  try {
    res = await fetchImpl(`${base}/v1/policy`, {
      // The hook's version tells the workspace which settings this computer understands (for example exact-target
      // exclusions), so it is never sent a document an older hook would refuse.
      // The settings this hook understands beyond its version (the workspace sends allowances, "Block, person may ask"
      // and the always/requests terms, session budgets and blocked services only to a hook that says so).
      // Whether this caller acts on a request from the workspace's computer page: a workspace that reads this header leaves
      // the request in place for the Scopebond Agent instead of handing it to a hook call that would drop it.
      headers: { ...auth, "x-scopebond-hook-capabilities": hookCapabilities().join(","), [PACK_ENGINE_HEADER]: String(packEngineLevel()), "x-scopebond-accepts-requests": options.onRequest ? "flush,self_check" : "none", ...(options.hookVersion ? { [HOOK_VERSION_HEADER]: options.hookVersion } : {}), ...(isManaged(dir) && meta.etag && meta.grants_digest && intact ? { "if-none-match": meta.etag } : {}), ...deliveryHeaders(dir), ...toolSettingsHeaders(options) },
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
  // Safe Install's signed block list (install-verdicts.ts): a workspace that offers this computer the check says so on every rules
  // answer (`x-scopebond-safe-install: 1`); the list is then checked at most every six hours. An answer without the offer (the
  // computer is not licensed for it, or an older workspace) or a refused connection drops the list, which turns the check off.
  if (res.headers?.get?.(SAFE_INSTALL_HEADER) === "1" && res.status !== 401) {
    await syncInstallBlocklist(dir, { base, headers: auth, fetchImpl, now: now.getTime(), timeoutMs: options.timeoutMs ?? REQUEST_TIMEOUT_MS });
  } else if (res.status === 401 || res.status === 200 || res.status === 204 || res.status === 304) removeBlocklist(dir);
  const at = now.toISOString();
  const lastIssuedAt = (): string | null => (meta.policy_issued_workspace ?? null) === workspaceId ? meta.policy_issued_at ?? null : null;
  const issued = (issuedAt: string | null) => (issuedAt ? { policy_issued_at: issuedAt, policy_issued_workspace: workspaceId } : {});
  /** Bring the pack cache in step with an answer whose rules signature was admitted. An answer that names no packs changes
   *  nothing. Never throws. */
  const syncPackList = async (raw: Record<string, unknown>): Promise<void> => {
    const result = await syncPacks(dir, raw, { base, headers: auth, fetchImpl, workspace: workspaceId, computer: installationId, lastIssuedAt: lastIssuedAt(), now, timeoutMs: options.timeoutMs ?? REQUEST_TIMEOUT_MS });
    // The signed artifacts the same list names (signed-artifacts.ts); they never hold back the packs, and the packs never them.
    await syncArtifacts(dir, raw, { base, headers: { ...auth, [PACK_ENGINE_HEADER]: String(packEngineLevel()) }, fetchImpl, workspace: workspaceId, computer: installationId, lastIssuedAt: lastIssuedAt(), now, timeoutMs: options.timeoutMs ?? REQUEST_TIMEOUT_MS });
    if (result.state === "not_named") return;
    const error = result.state === "synced" ? null : result.state === "refused" ? result.message : result.failed.map((f) => `${f.ref}: ${f.message}`).join("; ");
    packState = {
      at, digest: typeof raw.packs_digest === "string" ? raw.packs_digest : null, complete: result.state === "synced", error: error === null ? null : error.slice(0, 300),
      ...(result.state === "partial" ? { failed: result.failed.map((f) => ({ id: f.id, version: f.version, reason: f.message.slice(0, 300), code: f.code, ...(f.needs !== undefined ? { needs: f.needs } : {}), held: f.held, held_until: f.held_until })) } : {}),
    };
  };
  /** Latch this computer to signed answers from the workspace once one verified (policy-freshness.ts). */
  const latchOn = (keyId: string): void => {
    if (workspaceId && !latchedTo({ policy_latch: latch }, workspaceId)) latch = { workspace: workspaceId, at, key_id: keyId };
  };
  const signed = (raw: Record<string, unknown>, managed: boolean) => {
    const check = checkAnswerSignature(raw, { workspace: workspaceId, computer: installationId, managed, lastIssuedAt: lastIssuedAt(), now }, mode);
    if (check.result === "verified") latchOn(check.keyId);
    return { issuedAt: check.result === "verified" ? check.issuedAt : null, admitted: admitSigned(check, mode, at) };
  };
  /** Check a freshness proof for the answer in hand and keep it when it verifies. */
  const takeFreshness = (value: unknown, context: { revision: number; managed: boolean; etag: string | null }): FreshnessCheck => {
    const check = checkFreshness(value, { workspace: workspaceId, computer: installationId, ...context, lastIssuedAt: freshness?.issued_at ?? null, now });
    if (check.result === "verified") { freshness = check.freshness; latchOn(check.freshness.key_id); }
    return check;
  };
  if (res.status === 401) {
    // A signed revocation in the body (policy-freshness.ts) is the workspace's own word that this computer is disconnected.
    let body: unknown;
    try { body = await res.json(); } catch { body = null; }
    const revocation = body && typeof body === "object" ? (body as Record<string, unknown>).revocation : undefined;
    const revoked = checkRevocation(revocation, { workspace: workspaceId, computer: installationId, lastIssuedAt: laterOf(lastIssuedAt(), freshness?.issued_at), now });
    if (revoked.result === "verified") latchOn(revoked.keyId);
    // Otherwise a 401 carries no signature. In enforce mode (and once latched) it is not reason enough to drop the workspace's
    // rules: they stay in force until the person signs in again (or disconnects this computer), so a forged 401 never relaxes them.
    if (revoked.result !== "verified" && mode === "enforce" && isManaged(dir)) {
      const reason: SignatureReason = revoked.result === "refused" ? revoked.reason : "unsigned_policy";
      const state: SignatureState = { mode, last: "refused", reason, at };
      save({ policy_signature: state, last_error: revoked.result === "refused"
        ? `the workspace connection is no longer valid, but its revocation was refused (${revoked.message}); the workspace rules in force stay until this computer signs in again or is disconnected`
        : "the workspace connection is no longer valid; in enforce mode the workspace rules in force stay until this computer signs in again or is disconnected" });
      return { state: "disconnected" };
    }
    const dropped = backToOwnRules();
    save({ revision: null, rules_digest: null, export_id: null, etag: null, policy_trust: null, last_error: "the workspace connection is no longer valid; this computer uses its own rules",
      ...(revoked.result === "verified" ? { policy_signature: { mode, last: "verified", reason: null, at }, ...issued(revoked.issuedAt) } : {}),
      ...(dropped ? { rules_dropped_at: at, rules_dropped_told: false } : {}) });
    return { state: "disconnected" };
  }
  /** The workspace sets no rules for this computer (a 204, or its signed 200 form): back to its own rules, once admitted. */
  const toOwnRules = async (admitted: ReturnType<typeof admitSigned>, issuedAt: string | null, raw?: Record<string, unknown>): Promise<SyncOutcome> => {
    if (!admitted.ok) {
      const confirmed = await ack({ export_id: `rev-0-${installationId}`, revision: 0, rules_digest: UNMANAGED_DIGEST, result: "rejected", reason: ackReasonFor(admitted.reason) });
      save({ last_ack: confirmed, policy_signature: admitted.state, last_error: admitted.message });
      return { state: "refused", revision: null, reason: ackReasonFor(admitted.reason), message: admitted.message, signature: admitted.reason };
    }
    const changed = backToOwnRules();
    // The signed "no rules" answer's freshness proof is for "unmanaged" (policy-freshness.ts).
    if (raw && issuedAt) takeFreshness(raw.freshness, { revision: 0, managed: false, etag: null });
    if (raw) await syncPackList(raw);
    const last = meta.last_ack;
    const confirmed = changed || !last || last.revision !== 0 || last.result !== "loaded"
      ? await ack({ export_id: `rev-0-${installationId}`, revision: 0, rules_digest: UNMANAGED_DIGEST, result: "loaded" }) : last;
    // Accepted again and the workspace sets no rules: its own rules are what the workspace asks for, nothing was dropped.
    save({ revision: null, rules_digest: null, export_id: null, etag: null, last_ack: confirmed, last_error: null, policy_signature: admitted.state, ...issued(issuedAt), rules_dropped_at: null, rules_dropped_told: null, policy_trust: null });
    return { state: "own_rules", changed };
  };
  if (res.status === 204) return toOwnRules(admitSigned({ result: "unsigned" }, mode, at), null);
  if (res.status === 304 && isManaged(dir) && meta.revision !== null) {
    // The 304's freshness proof (policy-freshness.ts), for the ETag in force. Once latched, only a verified one renews anything:
    // a 304 without one keeps the rules and renews nothing (neither the proof's validity nor the packs' clock).
    const header = res.headers?.get?.(FRESHNESS_HEADER) ?? null;
    const fresh = takeFreshness(decodeFreshnessHeader(header), { revision: meta.revision, managed: true, etag: meta.etag });
    const renews = !latched || fresh.result === "verified";
    // Not modified covers the pack list too: every pack it confirmed is renewed by this check-in; a pack it named at a version
    // this computer could not fetch or check keeps its own clock. A list that was refused as a whole renews nothing.
    if (renews && (packState?.complete || packState?.failed)) {
      restampPacks(dir, now, packState.failed?.map((f) => f.id) ?? []);
      // The renewed index is what the answer in force explains, when the files matched it before the renewal (policy-trust.ts).
      if (intact) rebindPackFiles(dir);
    }
    const confirmed = meta.last_ack?.revision === meta.revision && meta.last_ack.result === "loaded" ? meta.last_ack
      : await ack({ export_id: meta.export_id!, revision: meta.revision, rules_digest: meta.rules_digest!, result: "loaded" });
    save({ last_ack: confirmed, last_error: fresh.result === "refused" ? `${fresh.message}; the rules in force stay and nothing was renewed` : null, ...(intact ? { policy_trust: null } : {}) });
    return { state: "unchanged", revision: meta.revision };
  }
  if (res.status !== 200) {
    save({ last_error: `the workspace answered ${res.status}; the rules in force stay` });
    return { state: "unavailable", message: `the workspace answered ${res.status}` };
  }

  let raw: unknown;
  try { raw = await res.json(); } catch { raw = null; }
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  // The next policy-signing key, signed by the current one (policy-next-key.ts): checked on its own and pinned, whatever the
  // rest of the answer turns out to be. It takes effect from the next check.
  if (r.policy_next_key !== undefined) {
    const pinned = pinNextKey(dir, r.policy_next_key, { now });
    nextKey = { state: pinned.state, at, ...(pinned.state === "refused" ? { message: pinned.message.slice(0, 300) } : {}) };
  }
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
    return toOwnRules(admitted, issuedAt, r);
  }
  // Whether people may change rules on this computer is outside the rules digest, so the same version can arrive
  // with only that switch changed; it is a change to install, not "unchanged".
  const sameVersion = intact && isManaged(dir) && r.revision === meta.revision && r.rules_digest === meta.rules_digest && meta.revision !== null;
  // So are the tool settings (signed on their own): a section with another digest or key is a change to install. An answer
  // without the section changes nothing here (a hook call is not sent it; only the Scopebond Agent is).
  // And so are the allowances, revoked allowances, session budgets and request answers: a revoked allowance arrives at the same
  // version with the same rules digest, and must reach the computer.
  const switchChanged = sameVersion && ((r.local_changes === true) !== allowsLocalChanges(dir)
    || (toolSettingsMark(r) !== null && toolSettingsMark(r) !== installedToolSettingsMark(dir))
    || digestGrants(r) !== installedGrantsDigest(dir));
  // The same version already in force: confirm it again if the last confirmation did not land.
  // A verified answer for rules installed without one (before this computer latched, or by an older version) is installed
  // again instead, so the rules in force are kept with the signed answer that explains them (policy-trust.ts).
  let reinstall = false;
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
    reinstall = again.issuedAt !== null && !hasTrustRecord(dir);
    if (!reinstall) {
      if (again.issuedAt) takeFreshness(r.freshness, { revision: meta.revision!, managed: true, etag });
      await syncPackList(r);
      // The pack list just renewed is the answer in force's, and the files matched it ("same version" needs that).
      rebindPackFiles(dir);
      const confirmed = meta.last_ack?.revision === meta.revision && meta.last_ack.result === "loaded" ? meta.last_ack
        : await ack({ export_id: meta.export_id!, revision: meta.revision!, rules_digest: meta.rules_digest!, result: "loaded" });
      save({ etag, grants_digest: digestGrants(r), last_ack: confirmed, last_error: null, policy_signature: again.admitted.state, ...issued(again.issuedAt), policy_trust: null });
      return { state: "unchanged", revision: meta.revision! };
    }
  }
  // Reinstalling the version in force (a switch changed, or the rules file on disk no longer parses) is not a stale revision.
  const inspected = inspectManaged(raw, switchChanged || reinstall || !intact ? { installationId, currentRevision: null }
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
  // A verified answer is kept as received beside what it compiled to, and the files are checked against it on every change
  // (policy-trust.ts); rules installed from an unsigned answer (dual mode, never latched) are not covered.
  if (issuedAt) recordTrustedAnswer(dir, r); else forgetTrustRecord(dir);
  options.afterPolicyWrite?.(dir);
  if (issuedAt) takeFreshness(r.freshness, { revision: doc.revision, managed: true, etag });
  await syncPackList(r);
  if (issuedAt) rebindPackFiles(dir);
  const confirmed = await ack({ export_id: doc.export_id, revision: doc.revision, rules_digest: doc.rules_digest, result: "loaded", skipped_rules: inspected.skipped });
  save({ revision: doc.revision, rules_digest: doc.rules_digest, export_id: doc.export_id, etag, grants_digest: digestGrants(r), last_ack: confirmed, last_error: null, rule_notes: inspected.notes.length ? inspected.notes : null, skipped_rules: inspected.skipped.length ? inspected.skipped : null,
    policy_signature: admitted.state, ...issued(issuedAt), rules_dropped_at: null, rules_dropped_told: null, policy_trust: null });
  return { state: "applied", revision: doc.revision };
}

/** Called on every tool call: when this computer is connected and has not checked in five minutes, run the check, capped at
 *  `budgetMs`. Resolves `null` when no check was due, another one is running, or the cap was reached first (the check then
 *  finishes if the process lives long enough, else runs again on a later call). Never throws. `makeOptions` is called only when a
 *  check is due, so an ordinary call pays nothing but two file reads. */
export async function syncIfDue(dir: string, makeOptions: () => SyncOptions, budgetMs = Number(setting("SCOPEBOND_POLICY_SYNC_MS") ?? INLINE_BUDGET_MS), now = Date.now()): Promise<SyncOutcome | null> {
  try {
    if (setting("SCOPEBOND_POLICY_SYNC") === "off") return null;
    if (!existsSync(connectionPath(dir))) return null;
    // Due five minutes after the last attempt, whether it worked or not: a workspace that cannot be reached is not tried again
    // on every tool call.
    const meta = readMeta(dir);
    const last = Math.max(meta.checked_at ? Date.parse(meta.checked_at) : 0, meta.last_attempt_at ? Date.parse(meta.last_attempt_at) : 0);
    // Workspace rules that no longer match their signed answer (policy-trust.ts) are fetched again at once, then every 30 s
    // while they still do not.
    const mismatch = meta.policy_trust ? Date.parse(meta.policy_trust.at) : NaN;
    const due = Number.isFinite(mismatch) ? mismatch > last || now - last >= TRUST_RETRY_MS : now - last >= SYNC_INTERVAL_MS;
    if (last && !due) return null;
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

function releaseSyncLock(dir: string): void {
  try { rmSync(join(dir, LOCK_FILE), { force: true }); } catch { /* expires on its own */ }
}

/** The heartbeat interval a workspace allows (`x-scopebond-heartbeat-interval-s`, 60–900), or null when it does not say. */
function heartbeatIntervalFrom(headers: { get(name: string): string | null } | undefined): number | null {
  const raw = headers?.get?.("x-scopebond-heartbeat-interval-s")?.trim() ?? "";
  if (!/^\d{2,3}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 60 && n <= 900 ? n : null;
}

/** The one-time notice that the workspace's rules stopped applying here after a refused connection, or null when there is none
 *  to give (never dropped, already told, or back on the workspace's rules). */
export function rulesDroppedNotice(dir: string, loginCommand: string): string | null {
  const meta = readMeta(dir);
  if (!meta.rules_dropped_at || meta.rules_dropped_told) return null;
  return `Scopebond: your workspace's rules stopped applying on this computer at ${meta.rules_dropped_at} because the workspace refused its connection; this computer's own rules apply until you sign in again with ${loginCommand}.`;
}

/** Mark the notice given, so it is said once. Never throws. */
export function markRulesDroppedTold(dir: string): void {
  try { writeMeta(dir, { ...readMeta(dir), rules_dropped_told: true }); } catch { /* said again next time: better than never */ }
}
