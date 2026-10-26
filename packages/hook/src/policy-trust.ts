// Verify on use: the workspace's rules on this computer are checked against the signed answer they came from whenever the
// files change, not only when the answer is downloaded.
//
// When a rules check installs a workspace document whose signature verified (policy-sync.ts), the answer is kept exactly as
// received in `managed-answer.json`, beside the compiled policy, with the sha256 of each file it explains:
//
//   { v: 1, answer, files: { "policy.json": <sha256>, "managed-rules.json": <sha256>,
//                            "packs/index.json": <sha256> | null, "packs/sidecar/flags.json": <sha256> | null }, binding }
//
// `policy.json` is what the answer compiled to on this computer when it was installed; the pack index and its flags are
// covered when the answer names rule packs (its pack list is signed with it; `null` when the file is absent), and left out
// (`"packs/index.json"` absent from `files`) when it names none. `binding` is the sha256 of the canonical JSON of
// `{ v, answer: <sha256 of the answer's canonical JSON>, files }`: no recorded hash changes without the answer's digest changing.
//
// On load (createHookRuntime, and the start of each rules check) a computer the workspace manages under a verified answer
// checks that:
//   - the record parses and its binding holds;
//   - the stored answer's rules and grants signatures verify against the pinned keys, for this computer and workspace
//     (checked as of the answer's own `issued_at`: replay and freshness are the rules check's business, policy-freshness.ts);
//   - managed-rules.json is the stored answer (the same canonical JSON);
//   - every covered file's sha256 is the one recorded.
// The result is cached by each file's size, modification time and change time (`managed-trust-check.json`, and in memory),
// so a tool call pays a few file stats and the full check runs once per change.
//
// A mismatch fails closed: createHookRuntime throws (the call is denied and the reason recorded as a hook error), the rules
// state records the mismatch (`policy_trust` in managed-meta.json), and the next rules check runs at once, without
// If-None-Match, and installs the workspace's rules again, which writes a new record.
//
// Which computers are checked: one with a record, or one latched to signed answers (policy-freshness.ts) while a workspace's
// rules are in force (a document, or a revision in the rules state). A computer that never verified a workspace answer has
// neither and behaves exactly as before. Only the hook writes these files: the folder is under the always-on floor.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { canonical } from "@scopebond/gateway";
import { loadConnection, type HookConnection } from "./cloud.js";
import { isManaged, readMeta, writeAtomic, writeMeta, MANAGED_DOC_FILE, TRUST_CHECK_FILE, TRUSTED_ANSWER_FILE, type ManagedMeta } from "./managed.js";
import { checkAnswerSignature, workspaceIdOf } from "./policy-signature.js";

export const POLICY_FILE = "policy.json";
export const PACK_INDEX_PATH = "packs/index.json";
export const PACK_FLAGS_PATH = "packs/sidecar/flags.json";
/** The files a record may cover. */
export type TrustedFile = typeof POLICY_FILE | typeof MANAGED_DOC_FILE | typeof PACK_INDEX_PATH | typeof PACK_FLAGS_PATH;
const PACK_FILES: readonly TrustedFile[] = [PACK_INDEX_PATH, PACK_FLAGS_PATH];
/** What the cache key stats: the record and every file it may cover. A function, not a constant: managed.ts and this module
 *  load each other through runtime.ts, so its constants are read only once both have loaded. */
const stamped = (): string[] => [TRUSTED_ANSWER_FILE, POLICY_FILE, MANAGED_DOC_FILE, PACK_INDEX_PATH, PACK_FLAGS_PATH];

export interface TrustRecord {
  v: 1;
  answer: Record<string, unknown>;
  files: Partial<Record<TrustedFile, string | null>>;
  binding: string;
}

export type TrustCheck =
  /** Not a computer the workspace manages under a verified answer: nothing is checked. */
  | { applies: false }
  | { applies: true; ok: true; revision: number | null; rulesDigest: string | null }
  | { applies: true; ok: false; reason: string };

const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const fileHash = (dir: string, rel: string): string | null => {
  try { return sha256(readFileSync(join(dir, rel))); } catch { return null; }
};
const bindingOf = (answer: Record<string, unknown>, files: TrustRecord["files"]): string =>
  sha256(canonical({ v: 1, answer: sha256(canonical(answer)), files }));
/** The files an answer explains: the compiled policy and the document always, the pack index and flags when it names packs. */
const coveredBy = (answer: Record<string, unknown>): TrustedFile[] =>
  [POLICY_FILE, MANAGED_DOC_FILE, ...(answer.packs !== undefined ? PACK_FILES : [])];

/** The record, or null when there is none or it is not the documented shape. */
export function readTrustRecord(dir: string): TrustRecord | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, TRUSTED_ANSWER_FILE), "utf8")) as Record<string, unknown>;
    if (!isObject(raw) || raw.v !== 1 || !isObject(raw.answer) || !isObject(raw.files) || typeof raw.binding !== "string") return null;
    return raw as unknown as TrustRecord;
  } catch { return null; }
}

/** Whether a record is kept here. */
export const hasTrustRecord = (dir: string): boolean => existsSync(join(dir, TRUSTED_ANSWER_FILE));

/** Keep a verified answer, exactly as received, with the hashes of the files it explains as they are now. Call it right after
 *  the answer is installed. */
export function recordTrustedAnswer(dir: string, answer: Record<string, unknown>): void {
  const files: TrustRecord["files"] = {};
  for (const rel of coveredBy(answer)) files[rel] = fileHash(dir, rel);
  writeRecord(dir, { v: 1, answer, files, binding: bindingOf(answer, files) });
}

/** Record the current hashes of `which` (those the record covers) after the hook itself rewrote them from what the answer
 *  explains: the pack index after a rules check renewed it, the compiled policy after a person's own choice where the
 *  workspace allows one. The caller checks the files first (`checkTrust`): this never makes a changed file trusted on its own.
 *  False when there is no record. */
export function rebindTrust(dir: string, which: readonly TrustedFile[]): boolean {
  const record = readTrustRecord(dir);
  if (!record) return false;
  const files = { ...record.files };
  let changed = false;
  for (const rel of which) {
    if (!(rel in files)) continue;
    const now = fileHash(dir, rel);
    if (now !== files[rel]) { files[rel] = now; changed = true; }
  }
  // Unchanged files leave the record (and so the cached result) as it is.
  if (changed) writeRecord(dir, { ...record, files, binding: bindingOf(record.answer, files) });
  return true;
}

/** `rebindTrust` for the pack index and flags. */
export const rebindPackFiles = (dir: string): boolean => rebindTrust(dir, PACK_FILES);

/** Whether the verified answer in force names the rule packs (the pack index is then the workspace's, not a person's). */
export function packsSetByWorkspace(dir: string): boolean {
  return readTrustRecord(dir)?.answer.packs !== undefined;
}

/** Forget the record (the workspace's rules no longer apply here). */
export function forgetTrustRecord(dir: string): void {
  for (const name of [TRUSTED_ANSWER_FILE, TRUST_CHECK_FILE]) { try { rmSync(join(dir, name), { force: true }); } catch { /* checked again on the next change */ } }
  memo.delete(dir);
}

function writeRecord(dir: string, record: TrustRecord): void {
  writeAtomic(join(dir, TRUSTED_ANSWER_FILE), `${JSON.stringify(record, null, 2)}\n`);
}

let verifications = 0;
/** How many full checks this process has run (tests: the cache makes it one per change). */
export const trustVerifications = (): number => verifications;

const memo = new Map<string, { stamp: string; result: TrustCheck }>();

const installationOf = (connection: Partial<HookConnection> | null): string | null =>
  connection?.installation_id ?? connection?.gateway_id ?? null;

/** Whether the check applies: a record is kept, or the computer is latched while a workspace's rules are in force. */
function applies(dir: string, meta: ManagedMeta): boolean {
  return hasTrustRecord(dir) || (!!meta.policy_latch && (isManaged(dir) || meta.revision !== null));
}

/** What the cache is keyed by: the size, modification and change time of every file the check reads, and the ids it checks
 *  them against. */
function stampOf(dir: string, connection: Partial<HookConnection> | null, meta: ManagedMeta): string {
  const files = stamped().map((rel) => {
    try { const s = statSync(join(dir, rel)); return `${s.size}:${s.mtimeMs}:${s.ctimeMs}`; } catch { return "-"; }
  });
  return JSON.stringify([files, workspaceIdOf(connection), installationOf(connection), meta.policy_latch?.workspace ?? null]);
}

/** The full check, uncached. */
function verify(dir: string, connection: Partial<HookConnection> | null): TrustCheck {
  verifications += 1;
  const fail = (reason: string): TrustCheck => ({ applies: true, ok: false, reason });
  const record = readTrustRecord(dir);
  if (!record) return fail(hasTrustRecord(dir) ? "the stored workspace answer cannot be read" : "the signed workspace answer behind these rules is missing");
  if (bindingOf(record.answer, record.files) !== record.binding) return fail("the stored workspace answer does not match its own digest");
  const { answer } = record;
  const computer = installationOf(connection);
  if (!computer) return fail("this computer's workspace connection cannot be read");
  const issued = typeof answer.issued_at === "string" ? Date.parse(answer.issued_at) : NaN;
  const signature = checkAnswerSignature(answer, {
    workspace: workspaceIdOf(connection), computer, managed: true, lastIssuedAt: null, now: Number.isFinite(issued) ? new Date(issued) : new Date(),
  }, "enforce");
  if (signature.result !== "verified") return fail(signature.result === "refused" ? `the stored workspace answer does not verify (${signature.message})` : "the stored workspace answer is not signed");
  let doc: unknown;
  try { doc = JSON.parse(readFileSync(join(dir, MANAGED_DOC_FILE), "utf8")); } catch { doc = undefined; }
  if (!isObject(doc) || canonical(doc) !== canonical(answer)) return fail(`${MANAGED_DOC_FILE} is not the signed answer it came from`);
  for (const rel of coveredBy(answer)) {
    if (!(rel in record.files)) return fail(`the stored workspace answer does not cover ${rel}`);
    if (fileHash(dir, rel) !== record.files[rel]) return fail(`${rel} changed since the workspace's signed answer was installed`);
  }
  return {
    applies: true, ok: true,
    revision: Number.isInteger(answer.revision) ? answer.revision as number : null,
    rulesDigest: typeof answer.rules_digest === "string" ? answer.rules_digest : null,
  };
}

/** Check the workspace's rules on this computer against the signed answer they came from: once per change of the files (the
 *  result is cached by their size and times), else a few file stats. Never throws: a check that cannot run is a mismatch. */
export function checkTrust(dir: string, options: { connection?: Partial<HookConnection> | null } = {}): TrustCheck {
  try {
    const meta = readMeta(dir);
    if (!applies(dir, meta)) return { applies: false };
    const connection = options.connection !== undefined ? options.connection : loadConnection(dir);
    const stamp = stampOf(dir, connection, meta);
    const held = memo.get(dir);
    if (held?.stamp === stamp) return held.result;
    const cached = readCache(dir, stamp);
    if (cached) { memo.set(dir, { stamp, result: cached }); return cached; }
    const result = verify(dir, connection);
    memo.set(dir, { stamp, result });
    try { writeAtomic(join(dir, TRUST_CHECK_FILE), `${JSON.stringify({ v: 1, stamp, result })}\n`); } catch { /* checked again next time */ }
    // The cache file's own write changes nothing it is keyed by.
    return result;
  } catch (error) {
    return { applies: true, ok: false, reason: `the workspace rules could not be checked (${(error as Error).name})` };
  }
}

function readCache(dir: string, stamp: string): TrustCheck | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, TRUST_CHECK_FILE), "utf8")) as { v?: unknown; stamp?: unknown; result?: TrustCheck };
    if (raw.v !== 1 || raw.stamp !== stamp || !isObject(raw.result) || raw.result.applies !== true) return null;
    const r = raw.result;
    if (r.ok === true || (r.ok === false && typeof r.reason === "string")) return r;
    return null;
  } catch { return null; }
}

/** A hook call refused because the workspace's rules on this computer no longer match their signed answer. The CLI denies the
 *  call, and runs the rules check at once to install the workspace's rules again. */
export class PolicyTrustError extends Error {
  readonly kind = "policy";
  readonly managed = true;
  readonly trust = true;
  constructor(readonly reason: string, readonly file: string) {
    super(`the workspace rules on this computer do not match the signed answer they came from: ${reason}; this call is refused and the rules are being fetched again`);
    this.name = "PolicyTrustError";
  }
}

/** Throw a `PolicyTrustError` when the check applies and fails, recording the reason in the rules state (`policy_trust`), which
 *  makes the next rules check due at once. */
export function assertTrusted(dir: string): void {
  const check = checkTrust(dir);
  if (!check.applies || check.ok) return;
  noteTrustMismatch(dir, check.reason);
  throw new PolicyTrustError(check.reason, join(dir, POLICY_FILE));
}

/** Record a mismatch in the rules state, once per reason (a cached result does not move the time again). Never throws. */
export function noteTrustMismatch(dir: string, reason: string, now: Date = new Date()): void {
  try {
    const meta = readMeta(dir);
    if (meta.policy_trust?.reason === reason) return;
    writeMeta(dir, { ...meta, policy_trust: { at: now.toISOString(), reason: reason.slice(0, 300) }, last_error: `the workspace rules on this computer did not match their signed answer (${reason.slice(0, 200)}); they are fetched again` });
  } catch { /* the call is refused either way */ }
}
