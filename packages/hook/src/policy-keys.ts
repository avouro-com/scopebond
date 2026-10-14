// The public keys a workspace signs its rules documents with, pinned in this release.
//
// A rules document (and the workspace's "no rules for this computer" answer) may carry an Ed25519 `signature` and the
// `key_id` of the key that made it (policy-signature.ts). The hook trusts only the keys listed here: a key a document names
// that is not listed, or that is outside its validity window, is refused like a bad signature.
//
// This release pins Scopebond Cloud's policy signing key. It still runs in `dual` mode by default (signed documents are
// verified against the pinned keys, unsigned ones are accepted and recorded); `enforce` stays opt-in. Rotation is a release
// too: the next key is added ahead of time, with a `not_before` in the future, so computers already have it when the
// workspace starts signing with it; the old key is removed once its `not_after` has passed.
//
// Scopebond Cloud names its key `pol_` followed by the first 16 hex digits of the SHA-256 of the key's SPKI DER in base64
// (the PEM body on one line), and publishes the same entries at https://cloud.scopebond.com/.well-known/scopebond-policy-keys.json.
//
// An entry looks like this (an illustration, not a key):
//
//   {
//     key_id: "policy-2027-01",
//     public_key: "-----BEGIN PUBLIC KEY-----\n…\n-----END PUBLIC KEY-----\n",  // SPKI PEM, or the raw 32-byte key in base64
//     not_before: "2027-01-01T00:00:00Z",
//     not_after: "2028-01-01T00:00:00Z",
//   }
//
// `SCOPEBOND_POLICY_KEYS_JSON` adds keys in the same shape (a JSON array) for tests and for trying a key before a release
// pins it. Whoever can set this process's environment can already change what it runs, so it widens nothing.

import { createPublicKey, type KeyObject } from "node:crypto";

export interface PolicyKey {
  /** The id a signed document names in `key_id`. */
  key_id: string;
  /** The Ed25519 public key: SPKI PEM, or the raw 32-byte key (or its SPKI DER) in base64. */
  public_key: string;
  /** RFC 3339: the key signs nothing issued before this time. */
  not_before: string;
  /** RFC 3339: the key signs nothing issued after this time, and is not trusted at all once it has passed. */
  not_after: string;
}

/** The keys pinned in this release; see the note above. */
export const PINNED_POLICY_KEYS: readonly PolicyKey[] = [
  {
    key_id: "pol_088707688c36e0f6",
    public_key: "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA/eUv90rHLFgh6UWx/6cV67mSiedwjmHnqCXI8kxIlyk=\n-----END PUBLIC KEY-----\n",
    not_before: "2026-10-13T21:00:18Z",
    not_after: "2027-10-13T21:00:18Z",
  },
];

export const POLICY_KEYS_ENV = "SCOPEBOND_POLICY_KEYS_JSON";

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


/** Why an entry cannot be a trusted key, or null when it can: every field present, a window that opens before it closes,
 *  and a public key that reads as Ed25519. Checked when the list is read, not when a document first names the key. */
function keyProblem(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "an entry is not an object";
  const k = value as Record<string, unknown>;
  const id = typeof k.key_id === "string" && KEY_ID.test(k.key_id) ? k.key_id : null;
  if (!id) return "an entry has no valid key_id";
  if (typeof k.not_before !== "string" || typeof k.not_after !== "string" || !Number.isFinite(Date.parse(k.not_before)) || !Number.isFinite(Date.parse(k.not_after))) {
    return `key ${id}: not_before and not_after must be RFC 3339 times`;
  }
  if (Date.parse(k.not_before) >= Date.parse(k.not_after)) return `key ${id}: its window closes (${k.not_after}) before it opens (${k.not_before})`;
  if (typeof k.public_key !== "string" || k.public_key.length === 0 || k.public_key.length > 4096 || !publicKeyFrom(k.public_key)) {
    return `key ${id}: public_key is not an Ed25519 public key (SPKI PEM, or base64 of the raw key or SPKI DER)`;
  }
  return null;
}

function readKeys(env: NodeJS.ProcessEnv): { keys: PolicyKey[]; problems: string[] } {
  const keys: PolicyKey[] = [];
  const problems: string[] = [];
  const take = (entry: unknown, from: string): void => {
    const problem = keyProblem(entry);
    if (problem) problems.push(`${from}: ${problem}; it is not trusted`); else keys.push(entry as PolicyKey);
  };
  for (const entry of PINNED_POLICY_KEYS) take(entry, "pinned key");
  const raw = env[POLICY_KEYS_ENV];
  if (raw) {
    try {
      if (raw.length > 65_536) throw new Error("longer than 64 KiB");
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) throw new Error("not a JSON array");
      for (const entry of parsed) take(entry, POLICY_KEYS_ENV);
    } catch (error) { problems.push(`${POLICY_KEYS_ENV} cannot be read (${(error as Error).message}); it adds no key`); }
  }
  return { keys, problems };
}

/** The keys this computer trusts: the pinned ones, then the valid entries of `SCOPEBOND_POLICY_KEYS_JSON`. An entry that
 *  cannot be a key (see `policyKeyProblems`) is left out. */
export function policyKeys(env: NodeJS.ProcessEnv = process.env): PolicyKey[] {
  return readKeys(env).keys;
}

/** What is wrong with the configured keys, for `doctor`: the entries left out, and why. */
export function policyKeyProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  return readKeys(env).problems;
}
