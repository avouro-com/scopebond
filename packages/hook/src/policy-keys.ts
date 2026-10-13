// The public keys a workspace signs its rules documents with, pinned in this release.
//
// A rules document (and the workspace's "no rules for this computer" answer) may carry an Ed25519 `signature` and the
// `key_id` of the key that made it (policy-signature.ts). The hook trusts only the keys listed here: a key a document names
// that is not listed, or that is outside its validity window, is refused like a bad signature.
//
// The list ships empty: the workspace's signing key does not exist yet, so this release verifies nothing it could pin and
// runs in `dual` mode by default (signed documents are verified against the keys it has, unsigned ones are accepted and
// recorded). A future release pins the workspace's key here. Rotation is a release too: the next key is added ahead of time,
// with a `not_before` in the future, so computers already have it when the workspace starts signing with it; the old key is
// removed once its `not_after` has passed.
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

/** The keys pinned in this release. Empty until the workspace's key exists; see the note above. */
export const PINNED_POLICY_KEYS: readonly PolicyKey[] = [];

export const POLICY_KEYS_ENV = "SCOPEBOND_POLICY_KEYS_JSON";

const KEY_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function validKey(value: unknown): value is PolicyKey {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const k = value as Record<string, unknown>;
  return typeof k.key_id === "string" && KEY_ID.test(k.key_id)
    && typeof k.public_key === "string" && k.public_key.length > 0 && k.public_key.length <= 4096
    && typeof k.not_before === "string" && Number.isFinite(Date.parse(k.not_before))
    && typeof k.not_after === "string" && Number.isFinite(Date.parse(k.not_after));
}

/** The keys this computer trusts: the pinned ones, then any valid entry from `SCOPEBOND_POLICY_KEYS_JSON` (malformed
 *  entries, or an unreadable value, are ignored). */
export function policyKeys(env: NodeJS.ProcessEnv = process.env): PolicyKey[] {
  const keys: PolicyKey[] = [...PINNED_POLICY_KEYS];
  const raw = env[POLICY_KEYS_ENV];
  if (raw && raw.length <= 65_536) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) for (const entry of parsed) if (validKey(entry)) keys.push(entry);
    } catch { /* an unreadable value adds no key */ }
  }
  return keys;
}
