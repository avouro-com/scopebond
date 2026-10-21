// The next policy-signing key, signed by the current one, so a key rotation needs no release.
//
// The policy-signing key this release pins (policy-keys.ts) stops being trusted at its `not_after`. Before then the workspace
// hands each computer a next-key document (`scopebond:policy-next-key/v1`) on its rules answer (`policy_next_key`):
//
//   { format: "scopebond:policy-next-key/v1", issued_at,
//     key: { key_id, public_key, not_before, not_after },          // the next key, in the shape policy-keys.ts reads
//     managed_signature_mode?: "enforce",                          // computers a workspace manages default to enforce
//     signature: { alg: "Ed25519", key_id, value } }              // by a key this release pins
//
// It is signed (Ed25519) over the domain below followed by the RFC 8785 canonical document without its `signature` member, by
// a key this release trusts on its own (pinned, or `SCOPEBOND_POLICY_KEYS_JSON`), never by a key a document pinned: the chain is
// one step from a key the release carries. It is accepted only when the signer's window holds both its `issued_at` and now,
// the next key is a valid Ed25519 key with its own id, its window opens no later than the signer's closes (no gap), and it
// closes after the signer's (it extends trust, never shortens it). The document is kept in `policy-next-key.json` beside
// policy.json and checked again each time it is read, so a changed file adds no key. A newer valid document replaces an
// older one.
//
// `managed_signature_mode: "enforce"` makes a computer whose rules a workspace manages refuse unsigned answers (policy-signature.ts
// `enforce`), whatever else says `dual`; nothing here can make a computer less strict.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonical } from "@scopebond/policy-schema/canonical";
import type { HookConnection } from "./cloud.js";
import { isManaged, writeAtomic } from "./managed.js";
import { baseKeyProblem, basePolicyKeys, setPinnedNextKeys, type PolicyKey } from "./policy-keys.js";
import { verifySignedData } from "./pack-store.js";
import { signatureMode, type SignatureMode } from "./policy-signature.js";

export const NEXT_KEY_FORMAT = "scopebond:policy-next-key/v1";
/** What a next-key signature covers: these bytes, then the canonical document without `signature`. */
export const NEXT_KEY_SIGNATURE_DOMAIN = "scopebond:policy-next-key/v1\n";
export const NEXT_KEY_FILE = "policy-next-key.json";
const MAX_BYTES = 16 * 1024;
// eslint-disable-next-line security/detect-unsafe-regex -- linear: anchored, fixed-width fields, one optional bounded fraction
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const KEY_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const SIG = /^[A-Za-z0-9+/]{86}(?:==)?$/;

export interface NextKeyDocument {
  format: typeof NEXT_KEY_FORMAT;
  issued_at: string;
  key: PolicyKey;
  managed_signature_mode?: "enforce";
  signature: { alg: "Ed25519"; key_id: string; value: string };
}

/** The exact string whose UTF-8 bytes a next-key signature covers. */
export function nextKeySigningInput(doc: Record<string, unknown>): string {
  const unsigned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(doc)) if (key !== "signature") unsigned[key] = value;
  return NEXT_KEY_SIGNATURE_DOMAIN + canonical(unsigned);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Check a next-key document: its shape, its signature by a key this release trusts on its own, and the next key's window.
 *  Pure apart from reading those keys (`keys` overrides them). */
export function checkNextKey(raw: unknown, options: { keys?: PolicyKey[]; now?: Date } = {}): { ok: true; doc: NextKeyDocument } | { ok: false; message: string } {
  const bad = (message: string) => ({ ok: false as const, message });
  if (!isObject(raw) || Object.keys(raw).some((k) => !["format", "issued_at", "key", "managed_signature_mode", "signature"].includes(k))) return bad("the next-key document is not one");
  if (raw.format !== NEXT_KEY_FORMAT) return bad(`the next-key document's format is not ${NEXT_KEY_FORMAT}`);
  if (typeof raw.issued_at !== "string" || !RFC3339.test(raw.issued_at) || !Number.isFinite(Date.parse(raw.issued_at))) return bad("the next-key document's issued_at is not a time");
  if (raw.managed_signature_mode !== undefined && raw.managed_signature_mode !== "enforce") return bad("managed_signature_mode may only be enforce");
  const sig = raw.signature;
  if (!isObject(sig) || Object.keys(sig).some((k) => !["alg", "key_id", "value"].includes(k)) || sig.alg !== "Ed25519"
    || typeof sig.key_id !== "string" || !KEY_ID.test(sig.key_id) || typeof sig.value !== "string" || !SIG.test(sig.value)) return bad("the next-key document's signature is malformed");
  const key = raw.key;
  if (!isObject(key) || Object.keys(key).some((k) => !["key_id", "public_key", "not_before", "not_after"].includes(k))) return bad("the next key is not a key entry");
  const problem = baseKeyProblem(key);
  if (problem) return bad(`the next key cannot be trusted: ${problem}`);
  const next = key as unknown as PolicyKey;
  // Signed by a key this release carries, never by one a document pinned.
  const trusted = options.keys ?? basePolicyKeys();
  const signer = trusted.find((k) => k.key_id === sig.key_id);
  if (!signer) return bad(`the next-key document is signed by a key this version does not trust (${sig.key_id})`);
  if (next.key_id === signer.key_id || trusted.some((k) => k.key_id === next.key_id && k.public_key !== next.public_key)) return bad("the next key reuses a trusted key's id");
  const verified = verifySignedData(nextKeySigningInput(raw), raw.issued_at, sig as { key_id: string; value: string }, "next-key document", { keys: trusted, now: options.now });
  if (!verified.ok) return bad(verified.message);
  if (Date.parse(next.not_before) > Date.parse(signer.not_after)) return bad("the next key's window opens after the current key's closes");
  if (Date.parse(next.not_after) <= Date.parse(signer.not_after)) return bad("the next key's window must close after the current key's");
  return { ok: true, doc: raw as unknown as NextKeyDocument };
}

/** The next-key document pinned here, checked again, or null (none, or one that no longer checks out). */
export function readNextKey(dir: string, options: { keys?: PolicyKey[]; now?: Date } = {}): NextKeyDocument | null {
  try {
    const text = readFileSync(join(dir, NEXT_KEY_FILE), "utf8");
    if (Buffer.byteLength(text, "utf8") > MAX_BYTES) return null;
    const checked = checkNextKey(JSON.parse(text), options);
    return checked.ok ? checked.doc : null;
  } catch { return null; }
}

/** Pin a next-key document from a workspace answer: kept when it checks out and is not older than the one pinned. Puts the
 *  pinned key in force. Never throws. */
export function pinNextKey(dir: string, raw: unknown, options: { keys?: PolicyKey[]; now?: Date } = {}): { state: "pinned" | "unchanged" } | { state: "refused"; message: string } {
  try {
    const checked = checkNextKey(raw, options);
    if (!checked.ok) return { state: "refused", message: checked.message };
    const held = readNextKey(dir, options);
    if (held && Date.parse(held.issued_at) >= Date.parse(checked.doc.issued_at)) { useNextKey(dir, options); return { state: "unchanged" }; }
    const text = JSON.stringify(checked.doc);
    if (Buffer.byteLength(text, "utf8") > MAX_BYTES) return { state: "refused", message: "the next-key document is too large" };
    writeAtomic(join(dir, NEXT_KEY_FILE), `${text}\n`);
    useNextKey(dir, options);
    return { state: "pinned" };
  } catch (error) { return { state: "refused", message: `the next key could not be pinned (${(error as Error).name})` }; }
}

/** Put the next key pinned here in force (policy-keys.ts `policyKeys` then trusts it), or none. Returns the document. */
export function useNextKey(dir: string, options: { keys?: PolicyKey[]; now?: Date } = {}): NextKeyDocument | null {
  const doc = readNextKey(dir, options);
  setPinnedNextKeys(doc ? [doc.key] : []);
  return doc;
}

/** The signature mode in force on this computer: `signatureMode` (the environment and cloud.json), or `enforce` when the next-key
 *  document pinned here says computers a workspace manages default to it and a workspace manages this one. */
export function signatureModeAt(dir: string, connection: Partial<HookConnection> | null, env: NodeJS.ProcessEnv = process.env): SignatureMode {
  const mode = signatureMode(connection, env);
  if (mode === "enforce") return mode;
  return readNextKey(dir)?.managed_signature_mode === "enforce" && isManaged(dir) ? "enforce" : mode;
}
