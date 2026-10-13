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
// that names the key (policy-keys.ts).
//
// Modes (`SCOPEBOND_POLICY_SIGNATURE_MODE`, or `policy_signature_mode` in cloud.json; the stricter of the two applies):
//   dual     the default. A signed document must verify; an unsigned one is accepted and recorded (`unsigned_policy`).
//   enforce  an unsigned document is refused too. A refused document never changes the rules in force: the computer keeps
//            the policy it has, and never falls back to no rules.

import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonical } from "@scopebond/gateway";
import type { HookConnection } from "./cloud.js";
import { policyKeys, type PolicyKey } from "./policy-keys.js";

export type SignatureMode = "dual" | "enforce";
export const SIGNATURE_MODE_ENV = "SCOPEBOND_POLICY_SIGNATURE_MODE";

/** Why a document's signature was not accepted. `unsigned_policy` is also the code recorded when dual mode accepts one. */
export type SignatureReason =
  | "unsigned_policy" | "malformed_signature" | "no_workspace_id" | "wrong_workspace" | "wrong_computer"
  | "unknown_key" | "key_not_valid" | "bad_signature" | "replayed";

export interface SignedPolicyPayload {
  v: 1;
  workspace: string;
  computer: string;
  revision: number;
  rules_digest: string;
  local_changes: boolean;
  managed: boolean;
  issued_at: string;
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

// eslint-disable-next-line security/detect-unsafe-regex -- linear: anchored, fixed-width fields, one optional bounded fraction
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const BASE64 = /^[A-Za-z0-9+/]{43,200}={0,2}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const KEY_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** An Ed25519 public key from SPKI PEM, base64 SPKI DER, or the raw 32-byte key in base64; null when it is none of these. */
export function publicKeyFrom(text: string): KeyObject | null {
  try {
    const trimmed = text.trim();
    const key = trimmed.startsWith("-----BEGIN") ? createPublicKey(trimmed)
      : (() => {
        const bytes = Buffer.from(trimmed, "base64");
        return bytes.length === 32
          ? createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: bytes.toString("base64url") }, format: "jwk" })
          : createPublicKey({ key: bytes, format: "der", type: "spki" });
      })();
    return key.asymmetricKeyType === "ed25519" ? key : null;
  } catch { return null; }
}

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
  const key = (context.keys ?? policyKeys()).find((k) => k.key_id === keyId);
  if (!key) return refuse("unknown_key", `the rules document names a signing key this version does not trust (${keyId}); update Scopebond`);
  const notBefore = Date.parse(key.not_before);
  const notAfter = Date.parse(key.not_after);
  if (!(issued >= notBefore && issued <= notAfter && now <= notAfter)) {
    return refuse("key_not_valid", `signing key ${keyId} is not valid for this document (valid ${key.not_before} to ${key.not_after})`);
  }
  const publicKey = publicKeyFrom(key.public_key);
  if (!publicKey) return refuse("unknown_key", `signing key ${keyId} could not be read`);
  const payload: SignedPolicyPayload = {
    v: 1, workspace: context.workspace, computer: context.computer, revision: doc.revision as number,
    rules_digest: doc.rules_digest, local_changes: doc.local_changes === true, managed: context.managed, issued_at: issuedAt,
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
