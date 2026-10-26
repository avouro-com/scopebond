// The signature latch, freshness proofs and signed revocations of a workspace's rules answers.
//
// Latch. Once any answer from a workspace verifies (policy-signature.ts), this computer records it (`policy_latch` in
// managed-meta.json, beside the compiled policy) and treats that workspace as in enforce mode from then on, whatever the
// signature mode says: an unsigned 200 is refused, a 204 is ignored, unsigned grants beside a signed document are refused, and a
// 401 keeps the rules in force unless it carries a verified revocation (below). A hook that trusts no key, or a workspace that
// never sent a signed answer, never latches, and behaves as before.
//
// Freshness. Every signed 200 answer carries `freshness`, and a 304 carries the same object in the
// `x-scopebond-policy-freshness` header (base64url, no padding, of its UTF-8 JSON):
//
//   { v: 1, issued_at, valid_until, etag_digest, key_id, signature }
//
// `etag_digest` is the sha256 (lowercase hex) of the exact ETag header of the rules document it covers (quotes included), or of
// the string "unmanaged" for the "no rules for this computer" answer. The signature is Ed25519, by the same pinned keys, over the
// canonical JSON of the policy payload with `kind: "freshness"` and the `valid_until`:
//
//   { v: 1, workspace, computer, revision, rules_digest: etag_digest, local_changes: false, managed, issued_at,
//     kind: "freshness", valid_until }
//
// with this computer's own workspace and installation ids, the document's revision (0 for no rules) and `managed` true for a
// rules document, false for no rules. `valid_until` is after `issued_at` and at most 72 hours after it. The newest verified proof
// is kept (`policy_freshness`). While latched, only a 304 whose proof verifies for the ETag in force renews anything (the
// proof's validity, and the rule packs' 30-day clock); a 304 without one keeps the rules and renews nothing.
//
// Expiry. Past the kept proof's `valid_until`, the workspace's grants stop allowing anything: the allowances the workspace sent
// (and copies of them kept here) no longer let a blocked action through. Revoked allowances, session budgets and quiet blocks
// only restrict, so they stay. The rules themselves stay in force. The next answer with a verified proof restores the grants.
// Before the first verified proof (a workspace that does not send them yet) nothing expires.
//
// Revocation. A 401 may carry `revocation`: `{ v: 1, issued_at, key_id, signature }`, signed over the policy payload with
// revision 0, `rules_digest` the sha256 of "revoked", `managed` false and `kind: "revocation"`. A verified one, not older than
// the newest signed answer accepted here, drops the workspace's rules (this computer's own rules apply, starting with the starter
// protections), latched or not.

import { createHash } from "node:crypto";
import type { HookConnection } from "./cloud.js";
import { readMeta, type ManagedMeta } from "./managed.js";
import type { PolicyKey } from "./policy-keys.js";
import { checkPolicySignature, isSignedTime, workspaceIdOf, type SignatureCheck, type SignatureReason } from "./policy-signature.js";

/** The 304 header that carries a freshness proof. */
export const FRESHNESS_HEADER = "x-scopebond-policy-freshness";
/** The longest a freshness proof may cover. */
export const FRESHNESS_MAX_MS = 72 * 60 * 60 * 1000;

/** sha256 (lowercase hex) of a string's UTF-8 bytes. */
export const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
/** What a freshness proof's `etag_digest` must be: the sha256 of the ETag for a rules document, of "unmanaged" for none. */
export const freshnessDigestFor = (etag: string | null, managed: boolean): string | null =>
  managed ? (etag ? sha256Hex(etag) : null) : sha256Hex("unmanaged");
/** What a revocation is signed over as its `rules_digest`. */
export const REVOCATION_DIGEST = sha256Hex("revoked");

export type StoredFreshness = NonNullable<ManagedMeta["policy_freshness"]>;
export type StoredLatch = NonNullable<ManagedMeta["policy_latch"]>;

export interface FreshnessContext {
  /** The workspace id in cloud.json; null when the connection names none (nothing then verifies). */
  workspace: string | null;
  /** This installation's id. */
  computer: string;
  /** The revision of the document the proof is for (0 for no rules). */
  revision: number;
  /** True for a rules document, false for the "no rules" answer. */
  managed: boolean;
  /** The ETag of the rules document the proof is for (the one served with it, or the one in force for a 304). */
  etag: string | null;
  /** `issued_at` of the newest proof kept: an older one is a replay. */
  lastIssuedAt: string | null;
  keys?: PolicyKey[];
  now?: Date;
}

export type FreshnessCheck =
  | { result: "verified"; freshness: StoredFreshness }
  | { result: "absent" }
  | { result: "refused"; reason: SignatureReason; message: string };

const refused = (reason: SignatureReason, message: string): FreshnessCheck => ({ result: "refused", reason, message: `freshness: ${message}` });
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Check a freshness proof (the `freshness` member of a 200 answer, or a decoded 304 header). `absent` when there is none.
 *  Pure apart from reading the trusted keys (`keys` overrides them). */
export function checkFreshness(value: unknown, context: FreshnessContext): FreshnessCheck {
  if (value === undefined || value === null) return { result: "absent" };
  if (!isObject(value) || value.v !== 1 || !isSignedTime(value.valid_until) || !isSignedTime(value.issued_at) || typeof value.etag_digest !== "string") {
    return refused("malformed_signature", "the freshness proof is incomplete or malformed");
  }
  const expected = freshnessDigestFor(context.etag, context.managed);
  if (expected === null || value.etag_digest !== expected) return refused("freshness_mismatch", "the freshness proof is for another version of the rules");
  const issued = Date.parse(value.issued_at);
  const until = Date.parse(value.valid_until);
  if (!(until > issued && until - issued <= FRESHNESS_MAX_MS)) return refused("freshness_window", `the freshness proof's window (${value.issued_at} to ${value.valid_until}) is not within 72 hours`);
  const check = checkPolicySignature({
    revision: context.revision, rules_digest: value.etag_digest, local_changes: false, installation_id: context.computer,
    issued_at: value.issued_at, key_id: value.key_id, signature: value.signature,
  }, { workspace: context.workspace, computer: context.computer, managed: context.managed, lastIssuedAt: context.lastIssuedAt, keys: context.keys, now: context.now, domain: "freshness", validUntil: value.valid_until });
  if (check.result === "refused") return refused(check.reason, check.message);
  if (check.result !== "verified" || !context.workspace) return refused("malformed_signature", "the freshness proof is not signed");
  return { result: "verified", freshness: { workspace: context.workspace, etag_digest: value.etag_digest, issued_at: value.issued_at, valid_until: value.valid_until, key_id: check.keyId } };
}

/** The freshness proof a 304's header carries: undefined without the header, else the decoded JSON (anything that does not
 *  decode is returned as a value `checkFreshness` refuses, never as "absent"). */
export function decodeFreshnessHeader(value: string | null | undefined): unknown {
  if (value === null || value === undefined) return undefined;
  const text = value.trim();
  if (!/^[A-Za-z0-9_-]{1,4000}$/.test(text)) return { malformed: true };
  try { return JSON.parse(Buffer.from(text, "base64url").toString("utf8")) as unknown; } catch { return { malformed: true }; }
}

/** Encode a freshness proof as the 304 header carries it (base64url, no padding, of its JSON). */
export const encodeFreshnessHeader = (freshness: unknown): string => Buffer.from(JSON.stringify(freshness), "utf8").toString("base64url");

export interface RevocationContext {
  workspace: string | null;
  computer: string;
  /** `issued_at` of the newest signed answer accepted here: an older revocation is a replay. */
  lastIssuedAt: string | null;
  keys?: PolicyKey[];
  now?: Date;
}

/** Check a 401's `revocation`. `unsigned` when the body carries none. */
export function checkRevocation(value: unknown, context: RevocationContext): SignatureCheck {
  if (value === undefined || value === null) return { result: "unsigned" };
  if (!isObject(value) || value.v !== 1) return { result: "refused", reason: "malformed_signature", message: "revocation: the revocation is incomplete or malformed" };
  const check = checkPolicySignature({
    revision: 0, rules_digest: REVOCATION_DIGEST, local_changes: false, installation_id: context.computer,
    issued_at: value.issued_at, key_id: value.key_id, signature: value.signature,
  }, { workspace: context.workspace, computer: context.computer, managed: false, lastIssuedAt: context.lastIssuedAt, keys: context.keys, now: context.now, domain: "revocation" });
  if (check.result === "unsigned") return { result: "refused", reason: "malformed_signature", message: "revocation: the revocation is not signed" };
  return check.result === "refused" ? { ...check, message: `revocation: ${check.message}` } : check;
}

/** Whether this computer is latched to signed answers from the workspace `connection` names. */
export function latchedTo(meta: Pick<ManagedMeta, "policy_latch">, workspace: string | null): boolean {
  return !!workspace && meta.policy_latch?.workspace === workspace;
}

/** Whether the rules state in `dir` is latched for the workspace `connection` names. Never throws. */
export function policyLatched(dir: string, connection: Partial<HookConnection> | null): boolean {
  try { return latchedTo(readMeta(dir), workspaceIdOf(connection)); } catch { return false; }
}

/** The later of two RFC 3339 times (either may be null). */
export function laterOf(a: string | null | undefined, b: string | null | undefined): string | null {
  const ta = a ? Date.parse(a) : NaN;
  const tb = b ? Date.parse(b) : NaN;
  if (!Number.isFinite(ta)) return Number.isFinite(tb) ? b! : null;
  return Number.isFinite(tb) && tb > ta ? b! : a!;
}

/** Until when the workspace's grants may be relied on, or null when no freshness proof was ever kept (nothing expires). */
export function grantsValidUntil(dir: string): string | null {
  try { return readMeta(dir).policy_freshness?.valid_until ?? null; } catch { return null; }
}

/** Whether the workspace's grants have expired: a proof was kept and `now` is past its `valid_until` (an unreadable time counts
 *  as expired). Never throws. */
export function grantsExpired(dir: string, now: number = Date.now()): boolean {
  const until = grantsValidUntil(dir);
  if (until === null) return false;
  const t = Date.parse(until);
  return !(Number.isFinite(t) && now <= t);
}
