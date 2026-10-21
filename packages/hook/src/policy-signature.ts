// Signed workspace rules: check that a rules document (or the workspace's "no rules for this computer" answer) was signed
// by a workspace key this release pins, for this computer and this workspace, and is not older than the one in force.
//
// What is signed is the RFC 8785 canonical JSON of
//
//   { v: 1, workspace, computer, revision, rules_digest, local_changes, managed, issued_at }
//
// built here from this installation's own values: `workspace` is the workspace id in cloud.json (`organization_id`),
// `computer` is this installation's id (`installation_id`, else `gateway_id`), `revision`, `rules_digest` and `issued_at`
// are the document's, `local_changes` is the document's switch (absent means false), and `managed` is true for a rules
// document and false for the "no rules" answer. A document signed for another computer or workspace therefore never
// verifies here, whatever it says about itself. The signature is Ed25519 over those bytes, in base64, next to the `key_id`
// that names the key (policy-keys.ts). A rules document's allowances, revocations, session budgets and request answers are
// signed beside it (`grants_digest` and `grants_signature`; see "signed grants" below).
//
// Modes (`SCOPEBOND_POLICY_SIGNATURE_MODE`, or `policy_signature_mode` in cloud.json; the stricter of the two applies):
//   dual     the default. A signed document must verify; an unsigned one is accepted and recorded (`unsigned_policy`).
//   enforce  an unsigned document is refused too. A refused document never changes the rules in force: the computer keeps
//            the policy it has, and never falls back to no rules.

import { createHash, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonical } from "@scopebond/gateway";
import type { HookConnection } from "./cloud.js";
import { policyKeys, publicKeyFrom, type PolicyKey } from "./policy-keys.js";

export { publicKeyFrom };

export type SignatureMode = "dual" | "enforce";
export const SIGNATURE_MODE_ENV = "SCOPEBOND_POLICY_SIGNATURE_MODE";

/** Why a document's signature was not accepted. `unsigned_policy` is also the code recorded when dual mode accepts one. */
export type SignatureReason =
  | "unsigned_policy" | "malformed_signature" | "no_workspace_id" | "wrong_workspace" | "wrong_computer"
  | "unknown_key" | "key_not_valid" | "bad_signature" | "replayed" | "issued_in_future";

export interface SignedPolicyPayload {
  v: 1;
  workspace: string;
  computer: string;
  revision: number;
  rules_digest: string;
  local_changes: boolean;
  managed: boolean;
  issued_at: string;
  /** Only on a tool settings section's payload ("tool_settings") or a document's grants payload ("grants"); a rules payload
   *  never carries it. */
  kind?: "tool_settings" | "grants" | "packs";
}

export type SignatureCheck =
  | { result: "verified"; keyId: string; issuedAt: string }
  | { result: "unsigned" }
  | { result: "refused"; reason: SignatureReason; message: string };

/** What `status --json` and the rules check report about the last document's signature. */
export interface SignatureState {
  mode: SignatureMode;
  last: "verified" | "unsigned" | "refused";
  reason: SignatureReason | null;
  at: string;
}

const parseMode = (value: unknown): SignatureMode | null => {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  return v === "enforce" ? "enforce" : v === "dual" ? "dual" : null;
};

/** The mode in force: `enforce` when either the environment or cloud.json says so, else `dual`. Neither can weaken the other. */
export function signatureMode(connection: Partial<HookConnection> | null, env: NodeJS.ProcessEnv = process.env): SignatureMode {
  const fromEnv = parseMode(env[SIGNATURE_MODE_ENV]);
  const fromFile = parseMode((connection as { policy_signature_mode?: unknown } | null)?.policy_signature_mode);
  return fromEnv === "enforce" || fromFile === "enforce" ? "enforce" : "dual";
}

/** The workspace id this computer is connected to, as signed documents name it. */
export const workspaceIdOf = (connection: Partial<HookConnection> | null): string | null =>
  typeof connection?.organization_id === "string" && connection.organization_id !== "" ? connection.organization_id : null;

/** The bytes a workspace signs for a document. */
export function signedPolicyBytes(payload: SignedPolicyPayload): Buffer {
  return Buffer.from(canonical(payload), "utf8");
}

/** How far ahead of this computer's clock an answer's `issued_at` may be (clock skew). */
const FUTURE_SKEW_MS = 60 * 60 * 1000;

// eslint-disable-next-line security/detect-unsafe-regex -- linear: anchored, fixed-width fields, one optional bounded fraction
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const BASE64 = /^[A-Za-z0-9+/]{43,200}={0,2}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const KEY_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export interface SignatureContext {
  /** The workspace id in cloud.json; null when the connection does not name one. */
  workspace: string | null;
  /** This installation's id. */
  computer: string;
  /** True for a rules document, false for the "no rules for this computer" answer. */
  managed: boolean;
  /** `issued_at` of the signed document in force, if any: an older one is a replay. */
  lastIssuedAt: string | null;
  keys?: PolicyKey[];
  now?: Date;
  /** Set only by `checkToolSettingsSignature` / `checkGrantsSignature`: the payload then carries that `kind`. */
  domain?: "tool_settings" | "grants" | "packs";
}

/** Check a document's signature. Pure apart from reading the trusted keys (`keys` overrides them). */
export function checkPolicySignature(doc: Record<string, unknown>, context: SignatureContext): SignatureCheck {
  const refuse = (reason: SignatureReason, message: string): SignatureCheck => ({ result: "refused", reason, message });
  const { signature, key_id: keyId, issued_at: issuedAt } = doc;
  if (signature === undefined && keyId === undefined) return { result: "unsigned" };
  if (typeof signature !== "string" || !BASE64.test(signature) || typeof keyId !== "string" || !KEY_ID.test(keyId)
    || typeof issuedAt !== "string" || !RFC3339.test(issuedAt) || !Number.isFinite(Date.parse(issuedAt))
    || !Number.isInteger(doc.revision) || (doc.revision as number) < 0 || typeof doc.rules_digest !== "string" || !HEX64.test(doc.rules_digest)
    || (doc.local_changes !== undefined && typeof doc.local_changes !== "boolean")) {
    return refuse("malformed_signature", "the rules document's signature fields are incomplete or malformed");
  }
  if (!context.workspace) return refuse("no_workspace_id", "this computer's connection names no workspace id, so a signed document cannot be bound to it; sign in again");
  if (doc.workspace_id !== undefined && doc.workspace_id !== context.workspace) return refuse("wrong_workspace", "the rules document was signed for a different workspace");
  if (doc.installation_id !== context.computer) return refuse("wrong_computer", "the rules document was signed for a different computer");
  const now = (context.now ?? new Date()).getTime();
  const issued = Date.parse(issuedAt);
  // An answer from the future would become the replay mark, and every later answer would be refused as older than it.
  if (issued > now + FUTURE_SKEW_MS) return refuse("issued_in_future", `the rules document says it was issued at ${issuedAt}, more than an hour ahead of this computer's clock`);
  const key = (context.keys ?? policyKeys()).find((k) => k.key_id === keyId);
  if (!key) return refuse("unknown_key", `the rules document names a signing key this version does not trust (${keyId}); update Scopebond`);
  const notBefore = Date.parse(key.not_before);
  const notAfter = Date.parse(key.not_after);
  // Both the document and this moment must fall in the key's window: a key shipped ahead of a rotation signs nothing early.
  if (!(issued >= notBefore && issued <= notAfter && now >= notBefore && now <= notAfter)) {
    return refuse("key_not_valid", `signing key ${keyId} is not valid for this document (valid ${key.not_before} to ${key.not_after})`);
  }
  const publicKey = publicKeyFrom(key.public_key);
  if (!publicKey) return refuse("unknown_key", `signing key ${keyId} could not be read`);
  const payload: SignedPolicyPayload = {
    v: 1, workspace: context.workspace, computer: context.computer, revision: doc.revision as number,
    rules_digest: doc.rules_digest, local_changes: doc.local_changes === true, managed: context.managed, issued_at: issuedAt,
    ...(context.domain ? { kind: context.domain } : {}),
  };
  let ok: boolean;
  try { ok = verify(null, signedPolicyBytes(payload), publicKey, Buffer.from(signature, "base64")); } catch { ok = false; }
  if (!ok) return refuse("bad_signature", "the rules document's signature does not verify; it was changed, damaged or not issued by the workspace");
  const last = context.lastIssuedAt ? Date.parse(context.lastIssuedAt) : NaN;
  if (Number.isFinite(last) && issued < last) {
    return refuse("replayed", `the rules document was issued at ${issuedAt}, before the one in force (${context.lastIssuedAt})`);
  }
  return { result: "verified", keyId, issuedAt };
}

/** The last signature check recorded in the rules state (managed-meta.json), or null. Reads the file only. */
export function readSignatureState(dir: string): SignatureState | null {
  try {
    const state = (JSON.parse(readFileSync(join(dir, "managed-meta.json"), "utf8")) as { policy_signature?: SignatureState | null }).policy_signature;
    return state && typeof state === "object" && typeof state.last === "string" ? state : null;
  } catch { return null; }
}

/** Whether a checked document may be used under `mode`, and the state to record for it. */
export function admitSigned(check: SignatureCheck, mode: SignatureMode, at: string):
  { ok: true; state: SignatureState } | { ok: false; state: SignatureState; reason: SignatureReason; message: string } {
  if (check.result === "verified") return { ok: true, state: { mode, last: "verified", reason: null, at } };
  if (check.result === "unsigned") {
    return mode === "dual"
      ? { ok: true, state: { mode, last: "unsigned", reason: "unsigned_policy", at } }
      : { ok: false, state: { mode, last: "refused", reason: "unsigned_policy", at }, reason: "unsigned_policy", message: "the workspace's answer is not signed, and this computer accepts only signed rules (enforce mode); the rules in force stay" };
  }
  return { ok: false, state: { mode, last: "refused", reason: check.reason, at }, reason: check.reason, message: `${check.message}; the rules in force stay` };
}

/** What `checkToolSettingsSignature` needs: this computer's workspace and installation ids, and the `issued_at` of the tool
 *  settings last applied (an older section is a replay). */
export interface ToolSettingsSignatureContext {
  workspace: string | null;
  computer: string;
  lastIssuedAt: string | null;
  keys?: PolicyKey[];
  now?: Date;
}

/** Check the signature of a rules document's `tool_settings` section with the rules check itself: the same payload
 *  (`{ v: 1, workspace, computer, revision, rules_digest, local_changes, managed, issued_at }`), with the section's revision,
 *  its `settings_digest` as the digest, `local_changes` false and `managed` true, plus `kind: "tool_settings"`, which no
 *  rules payload carries: a rules signature never verifies as tool settings, nor the reverse. (The section's digest also covers
 *  its own `type`, so it never equals a rules digest.)
 *  There is no dual mode here: anything but `verified` means the section is not applied. */
export function checkToolSettingsSignature(section: Record<string, unknown>, context: ToolSettingsSignatureContext): SignatureCheck {
  return checkPolicySignature({
    revision: section.revision, rules_digest: section.settings_digest, local_changes: false, installation_id: context.computer,
    workspace_id: section.workspace_id, issued_at: section.issued_at, key_id: section.key_id, signature: section.signature,
  }, { workspace: context.workspace, computer: context.computer, managed: true, lastIssuedAt: context.lastIssuedAt, keys: context.keys, now: context.now, domain: "tool_settings" });
}

// --- signed grants ---------------------------------------------------------------------------------------------------------
//
// A rules document also carries what lets a blocked action through, or stops doing so: the allowances the workspace holds for
// this computer, the ones it revoked, the session budgets, the answers to requests and the blocks it keeps quiet. The workspace
// signs them with the rules, by the same key and at the same `issued_at`: `grants_digest` is the sha256 of the canonical JSON of
// `{ allowances, revoked_allowances, session_budgets, request_answers }` (each absent member as []; with `quiet_patterns` too
// when the document carries it), and `grants_signature` is over the rules payload with that digest as `rules_digest`,
// `local_changes` false, `managed` true and `kind: "grants"`, which no rules payload carries: a rules signature never verifies
// as grants, nor the reverse.

/** The members of a rules document the grants signature covers. */
export const GRANT_FIELDS = ["allowances", "revoked_allowances", "session_budgets", "request_answers", "quiet_patterns"] as const;

/** A document's grants digest (lowercase hex), computed from its own members. The quiet list (`quiet_patterns`, tune-digest.ts)
 *  joins the digested object only when the document carries it, so every document without one keeps the digest it had. */
export function digestGrants(doc: Record<string, unknown>): string {
  return createHash("sha256").update(canonical({
    allowances: doc.allowances ?? [], revoked_allowances: doc.revoked_allowances ?? [],
    session_budgets: doc.session_budgets ?? [], request_answers: doc.request_answers ?? [],
    ...(doc.quiet_patterns !== undefined ? { quiet_patterns: doc.quiet_patterns } : {}),
  })).digest("hex");
}

/** Whether a document carries any member the grants signature covers. */
export const carriesGrants = (doc: Record<string, unknown>): boolean => GRANT_FIELDS.some((field) => doc[field] !== undefined);

/** Check a rules document's grants signature. `unsigned` when it has neither `grants_digest` nor `grants_signature`; refused
 *  when only one is there, when the digest does not match the document's own members, or when the signature does not verify. */
export function checkGrantsSignature(doc: Record<string, unknown>, context: ToolSettingsSignatureContext): SignatureCheck {
  const hasDigest = doc.grants_digest !== undefined;
  const hasSignature = doc.grants_signature !== undefined;
  if (!hasDigest && !hasSignature) return { result: "unsigned" };
  if (!hasDigest || !hasSignature || typeof doc.grants_digest !== "string" || !HEX64.test(doc.grants_digest)) {
    return { result: "refused", reason: "malformed_signature", message: "the rules document's grants signature fields are incomplete or malformed" };
  }
  if (digestGrants(doc) !== doc.grants_digest) {
    return { result: "refused", reason: "bad_signature", message: "the rules document's allowances, revoked allowances, session budgets or request answers do not match their signed digest; they were changed or damaged" };
  }
  const check = checkPolicySignature({
    revision: doc.revision, rules_digest: doc.grants_digest, local_changes: false, installation_id: doc.installation_id,
    workspace_id: doc.workspace_id, issued_at: doc.issued_at, key_id: doc.key_id, signature: doc.grants_signature,
  }, { workspace: context.workspace, computer: context.computer, managed: true, lastIssuedAt: context.lastIssuedAt, keys: context.keys, now: context.now, domain: "grants" });
  return check.result === "refused" ? { ...check, message: `grants signature: ${check.message}` } : check;
}

// --- signed pack references --------------------------------------------------------------------------------------------------
//
// A workspace answer (a rules document, or the "no rules for this computer" answer) may name the rule packs this computer should
// hold: `packs`, a list of `{ id, version, sha256 }`, the sha256 being that of the pack file the workspace serves at
// `/v1/packs/<id>@<version>`. The list is signed beside the rules, by the same key and at the same `issued_at`: `packs_digest` is
// the sha256 of the canonical JSON of the list, and `packs_signature` is over the rules payload with that digest as
// `rules_digest`, `local_changes` false, the answer's own `managed` and `kind: "packs"`. Each pack is signed data in its own
// right (pack-store.ts); the signed list says which of them the workspace wants here, so it cannot be cut down or rolled back on
// the way.

/** The digest the packs signature covers: the sha256 (lowercase hex) of the canonical JSON of the answer's `packs`, or, when
 *  the answer kills pack versions (`killed`, sent only to a hook that reports `pack_engine_2`), of `{ packs, killed }`. */
export const digestPacks = (doc: Record<string, unknown>): string =>
  createHash("sha256").update(canonical(doc.killed === undefined ? doc.packs ?? [] : { packs: doc.packs ?? [], killed: doc.killed })).digest("hex");

/** Check the signature of an answer's pack list. `unsigned` when the answer names no packs; refused when the list, its digest
 *  or its signature is missing, does not match, or does not verify. */
export function checkPacksSignature(doc: Record<string, unknown>, context: ToolSettingsSignatureContext & { managed: boolean }): SignatureCheck {
  if (doc.packs === undefined && doc.packs_digest === undefined && doc.packs_signature === undefined) return { result: "unsigned" };
  if (!Array.isArray(doc.packs) || typeof doc.packs_digest !== "string" || !HEX64.test(doc.packs_digest) || typeof doc.packs_signature !== "string") {
    return { result: "refused", reason: "malformed_signature", message: "the answer's pack list or its signature is incomplete or malformed" };
  }
  if (digestPacks(doc) !== doc.packs_digest) return { result: "refused", reason: "bad_signature", message: "the answer's pack list does not match its signed digest; it was changed or damaged" };
  const check = checkPolicySignature({
    revision: doc.revision, rules_digest: doc.packs_digest, local_changes: false, installation_id: doc.installation_id,
    workspace_id: doc.workspace_id, issued_at: doc.issued_at, key_id: doc.key_id, signature: doc.packs_signature,
  }, { workspace: context.workspace, computer: context.computer, managed: context.managed, lastIssuedAt: context.lastIssuedAt, keys: context.keys, now: context.now, domain: "packs" });
  return check.result === "refused" ? { ...check, message: `packs signature: ${check.message}` } : check;
}

/** The whole signature check of a workspace answer: its rules signature and, for a rules document, its grants signature.
 *  A refused grants signature refuses the answer exactly as a refused rules signature does. In enforce mode, a signed rules
 *  document that carries grants without signing them is refused as unsigned. */
export function checkAnswerSignature(doc: Record<string, unknown>, context: SignatureContext, mode: SignatureMode): SignatureCheck {
  const rules = checkPolicySignature(doc, context);
  if (rules.result === "refused" || !context.managed) return rules;
  const grants = checkGrantsSignature(doc, { workspace: context.workspace, computer: context.computer, lastIssuedAt: context.lastIssuedAt, keys: context.keys, now: context.now });
  if (grants.result === "refused") return grants;
  if (grants.result === "unsigned" && rules.result === "verified" && mode === "enforce" && carriesGrants(doc)) {
    return { result: "refused", reason: "unsigned_policy", message: "the workspace's answer carries allowances, revocations, session budgets or request answers that are not signed, and this computer accepts only signed rules (enforce mode)" };
  }
  return rules;
}
