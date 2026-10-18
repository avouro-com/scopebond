// The rule packs cached on this computer, and the check that makes one usable.
//
// Where packs live: the `packs` folder of the hook's state directory (the folder that holds policy.json):
//
//   packs/index.json             { "v": 1, "checked_at": "<RFC 3339>", "packs": [{ "id", "version", "sha256" }] }
//   packs/<id>@<version>.json    one signed pack (scopebond:pack/v1), byte for byte as Scopebond Cloud serves it
//
// Whoever delivers packs (the client that checks in with the workspace) writes each pack file first and the index last, with
// `checked_at` set to the time of the successful check-in and `sha256` the hex SHA-256 of the pack file's bytes. Only packs
// the index lists are read, and only one version of each id.
//
// A pack is used only when all of these hold; otherwise it is skipped, and the open detection and the starter protections
// are all that apply (the pack fails closed, never open):
//   - the index is readable and its `checked_at` is no more than 30 days ago (and not more than an hour ahead of this clock);
//   - the file is there, at most 4 MiB, and its SHA-256 matches the index;
//   - it is a valid pack (closed format; @scopebond/policy-schema `validatePack`) with the id and version the index names;
//   - its signature verifies with a policy-signing key this release trusts (policy-keys.ts), the key's validity window holds
//     both the pack's `issued_at` and now, and `issued_at` is not more than an hour ahead of this clock.
//
// Nothing here uses the network. `packs add` (cli-main.ts) puts a local pack file into this cache for a person at a terminal.

import { createHash, verify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { PACK_LIMITS, packRef, packSigningInput, validatePack, type Pack } from "@scopebond/policy-schema/pack";
import { policyKeys, publicKeyFrom, type PolicyKey } from "./policy-keys.js";
import { writeAtomic } from "./managed.js";
import { runPackVectors, setActivePacks } from "./packs.js";

export const PACKS_DIR = "packs";
export const PACK_INDEX_FILE = "index.json";
/** How long cached packs stay usable after the last successful check-in. */
export const PACK_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const FUTURE_SKEW_MS = 60 * 60 * 1000;
const MAX_INDEX_BYTES = 64 * 1024;

export interface PackIndexEntry { id: string; version: string; sha256: string }
export interface PackIndex { v: 1; checked_at: string; packs: PackIndexEntry[] }

export type PackRefusal = "invalid" | "unknown_key" | "key_not_valid" | "bad_signature" | "issued_in_future" | "missing" | "too_large" | "digest_mismatch" | "wrong_ref" | "expired";

export interface LoadedPacks {
  packs: Pack[];
  /** Why a pack (or the whole cache) was not used, one line each. */
  problems: Array<{ ref: string; reason: PackRefusal; message: string }>;
  /** When the cache stops being usable (30 days after the last check-in), or null without a readable index. */
  expiresAt: string | null;
}

const HEX64 = /^[0-9a-f]{64}$/;
// eslint-disable-next-line security/detect-unsafe-regex -- linear: anchored, fixed-width fields, one optional bounded fraction
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export const packsDir = (dir: string): string => join(dir, PACKS_DIR);
const fileOf = (dir: string, ref: string): string => join(packsDir(dir), `${ref}.json`);

/** Read the index; null when it is missing or not exactly the documented shape. */
export function readPackIndex(dir: string): PackIndex | null {
  try {
    const file = join(packsDir(dir), PACK_INDEX_FILE);
    if (statSync(file).size > MAX_INDEX_BYTES) return null;
    const doc = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
    if (Object.keys(doc).some((k) => !["v", "checked_at", "packs"].includes(k))) return null;
    if (doc.v !== 1 || typeof doc.checked_at !== "string" || !RFC3339.test(doc.checked_at) || !Number.isFinite(Date.parse(doc.checked_at))) return null;
    if (!Array.isArray(doc.packs) || doc.packs.length > 200) return null;
    const packs: PackIndexEntry[] = [];
    for (const entry of doc.packs as unknown[]) {
      const e = entry as Record<string, unknown>;
      if (!e || typeof e !== "object" || Array.isArray(e) || Object.keys(e).some((k) => !["id", "version", "sha256"].includes(k))) return null;
      if (typeof e.id !== "string" || typeof e.version !== "string" || typeof e.sha256 !== "string" || !HEX64.test(e.sha256)) return null;
      if (!/^[a-z0-9-]{1,64}$/.test(e.id) || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(e.version)) return null;
      packs.push({ id: e.id, version: e.version, sha256: e.sha256 });
    }
    return { v: 1, checked_at: doc.checked_at, packs };
  } catch { return null; }
}

export type SignatureResult = { ok: true; keyId: string } | { ok: false; reason: PackRefusal; message: string };

/** Verify a pack's signature against the trusted policy-signing keys. Pure apart from reading those keys (`keys` overrides). */
export function verifyPackSignature(pack: Pack, options: { keys?: PolicyKey[]; now?: Date } = {}): SignatureResult {
  const now = (options.now ?? new Date()).getTime();
  const issued = Date.parse(pack.issued_at);
  if (!Number.isFinite(issued)) return { ok: false, reason: "invalid", message: "issued_at is not a time" };
  if (issued > now + FUTURE_SKEW_MS) return { ok: false, reason: "issued_in_future", message: `the pack says it was issued at ${pack.issued_at}, more than an hour ahead of this computer's clock` };
  const key = (options.keys ?? policyKeys()).find((k) => k.key_id === pack.signature.key_id);
  if (!key) return { ok: false, reason: "unknown_key", message: `the pack names a signing key this version does not trust (${pack.signature.key_id}); update Scopebond` };
  const notBefore = Date.parse(key.not_before);
  const notAfter = Date.parse(key.not_after);
  if (!(issued >= notBefore && issued <= notAfter && now >= notBefore && now <= notAfter)) {
    return { ok: false, reason: "key_not_valid", message: `signing key ${key.key_id} is not valid for this pack (valid ${key.not_before} to ${key.not_after})` };
  }
  const publicKey = publicKeyFrom(key.public_key);
  if (!publicKey) return { ok: false, reason: "unknown_key", message: `signing key ${key.key_id} could not be read` };
  let ok: boolean;
  try { ok = verify(null, Buffer.from(packSigningInput(pack as unknown as Record<string, unknown>), "utf8"), publicKey, Buffer.from(pack.signature.value, "base64")); } catch { ok = false; }
  return ok ? { ok: true, keyId: key.key_id } : { ok: false, reason: "bad_signature", message: "the pack's signature does not verify; it was changed, damaged or not issued by Scopebond" };
}

/** Check a pack document from text: the closed format, then its signature. */
export function checkPackText(text: string, options: { keys?: PolicyKey[]; now?: Date } = {}): { ok: true; pack: Pack } | { ok: false; reason: PackRefusal; message: string } {
  if (Buffer.byteLength(text, "utf8") > PACK_LIMITS.maxBytes) return { ok: false, reason: "too_large", message: `the pack is larger than ${PACK_LIMITS.maxBytes} bytes` };
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { return { ok: false, reason: "invalid", message: "the pack is not JSON" }; }
  const shape = validatePack(doc);
  if (!shape.valid) return { ok: false, reason: "invalid", message: `the pack is not a valid scopebond:pack/v1 document (${shape.errors.slice(0, 3).join("; ")})` };
  const pack = doc as Pack;
  const signature = verifyPackSignature(pack, options);
  return signature.ok ? { ok: true, pack } : signature;
}

/** The packs this computer may use now, and why any other was not used. Never throws. */
export function loadPacks(dir: string, options: { keys?: PolicyKey[]; now?: Date } = {}): LoadedPacks {
  const problems: LoadedPacks["problems"] = [];
  const index = readPackIndex(dir);
  if (!index) {
    if (existsSync(join(packsDir(dir), PACK_INDEX_FILE))) problems.push({ ref: PACK_INDEX_FILE, reason: "invalid", message: "the pack index cannot be read; no pack is used" });
    return { packs: [], problems, expiresAt: null };
  }
  const now = (options.now ?? new Date()).getTime();
  const checked = Date.parse(index.checked_at);
  const expiresAt = new Date(checked + PACK_TTL_MS).toISOString();
  if (checked > now + FUTURE_SKEW_MS) {
    problems.push({ ref: PACK_INDEX_FILE, reason: "issued_in_future", message: "the pack index says it was checked in the future; no pack is used" });
    return { packs: [], problems, expiresAt };
  }
  if (now > checked + PACK_TTL_MS) {
    problems.push({ ref: PACK_INDEX_FILE, reason: "expired", message: `the rule packs expired on ${expiresAt}, 30 days after this computer last checked in; no pack is used until it checks in again` });
    return { packs: [], problems, expiresAt };
  }
  const packs: Pack[] = [];
  const seen = new Set<string>();
  for (const entry of index.packs) {
    const ref = `${entry.id}@${entry.version}`;
    if (seen.has(entry.id)) { problems.push({ ref, reason: "invalid", message: `the index lists ${entry.id} twice; only the first is used` }); continue; }
    seen.add(entry.id);
    let text: string;
    try {
      const file = fileOf(dir, ref);
      if (statSync(file).size > PACK_LIMITS.maxBytes) { problems.push({ ref, reason: "too_large", message: "the pack file is too large" }); continue; }
      text = readFileSync(file, "utf8");
    } catch { problems.push({ ref, reason: "missing", message: "the pack file is missing" }); continue; }
    if (createHash("sha256").update(text, "utf8").digest("hex") !== entry.sha256) { problems.push({ ref, reason: "digest_mismatch", message: "the pack file does not match the index" }); continue; }
    const checkedPack = checkPackText(text, options);
    if (!checkedPack.ok) { problems.push({ ref, reason: checkedPack.reason, message: checkedPack.message }); continue; }
    if (packRef(checkedPack.pack) !== ref) { problems.push({ ref, reason: "wrong_ref", message: `the file holds ${packRef(checkedPack.pack)}` }); continue; }
    packs.push(checkedPack.pack);
  }
  return { packs, problems, expiresAt };
}

/** Load the packs in this state directory and put them in force for the mapper. Never throws; on any failure no pack is in
 *  force. Returns what was loaded. */
export function activatePacks(dir: string, options: { keys?: PolicyKey[]; now?: Date } = {}): LoadedPacks {
  try {
    const loaded = loadPacks(dir, options);
    setActivePacks(loaded.packs);
    return loaded;
  } catch {
    setActivePacks([]);
    return { packs: [], problems: [{ ref: PACK_INDEX_FILE, reason: "invalid", message: "the packs could not be read" }], expiresAt: null };
  }
}

/** Put a checked pack into the cache, replacing any other version of its id, and stamp the index `checked_at` (the delivery
 *  client calls this after a successful check-in; `packs add` after a person loads a file). The pack's own vectors must all
 *  pass first. */
export function installPack(dir: string, text: string, options: { keys?: PolicyKey[]; now?: Date } = {}): { ok: true; pack: Pack } | { ok: false; reason: PackRefusal | "vectors_failed"; message: string } {
  const checked = checkPackText(text, options);
  if (!checked.ok) return checked;
  const run = runPackVectors(checked.pack);
  if (run.failures.length) return { ok: false, reason: "vectors_failed", message: `${run.failures.length} of the pack's ${checked.pack.vectors.length} vectors do not pass on this version (first: ${run.failures[0].id})` };
  const now = options.now ?? new Date();
  const ref = packRef(checked.pack);
  mkdirSync(packsDir(dir), { recursive: true });
  const index = readPackIndex(dir) ?? { v: 1 as const, checked_at: now.toISOString(), packs: [] };
  const stale = index.packs.filter((p) => p.id === checked.pack.id && p.version !== checked.pack.version);
  writeAtomic(fileOf(dir, ref), text);
  const packs = [...index.packs.filter((p) => p.id !== checked.pack.id), { id: checked.pack.id, version: checked.pack.version, sha256: createHash("sha256").update(text, "utf8").digest("hex") }]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  writeAtomic(join(packsDir(dir), PACK_INDEX_FILE), `${JSON.stringify({ v: 1, checked_at: now.toISOString(), packs }, null, 2)}\n`);
  for (const old of stale) { try { rmSync(fileOf(dir, `${old.id}@${old.version}`), { force: true }); } catch { /* left behind, never read */ } }
  return { ok: true, pack: checked.pack };
}

/** Remove a pack from the cache. True when it was listed. */
export function removePack(dir: string, id: string): boolean {
  const index = readPackIndex(dir);
  if (!index) return false;
  const gone = index.packs.filter((p) => p.id === id);
  if (gone.length === 0) return false;
  writeAtomic(join(packsDir(dir), PACK_INDEX_FILE), `${JSON.stringify({ ...index, packs: index.packs.filter((p) => p.id !== id) }, null, 2)}\n`);
  for (const p of gone) { try { rmSync(fileOf(dir, `${p.id}@${p.version}`), { force: true }); } catch { /* never read again */ } }
  return true;
}
