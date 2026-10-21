// The rule packs cached on this computer, and the check that makes one usable.
//
// Where packs live: the `packs` folder of the hook's state directory (the folder that holds policy.json):
//
//   packs/index.json             { "v": 1, "checked_at": "<RFC 3339>", "packs": [{ "id", "version", "sha256", "checked_at"? }] }
//   packs/<id>@<version>.json    one signed pack (scopebond:pack/v1), byte for byte as Scopebond Cloud serves it
//
// Whoever delivers packs (the client that checks in with the workspace) writes each pack file first and the index last, with
// `checked_at` set to the time of the successful check-in and `sha256` the hex SHA-256 of the pack file's bytes. Only packs
// the index lists are read, and only one version of each id.
//
// Each pack keeps its own clock: a pack's `checked_at` is the time its listed version was last confirmed, and an entry
// without one was confirmed at the index's `checked_at`. An entry carries its own only when a check-in could not confirm it
// (a newer version that could not be fetched or checked), so the version held stays in force until its own 30 days run out
// while every other pack is renewed as usual.
//
// A pack is used only when all of these hold; otherwise it is skipped, and the open detection and the starter protections
// are all that apply (the pack fails closed, never open):
//   - the index is readable, its `checked_at` is not more than an hour ahead of this clock, and the pack's own `checked_at`
//     is no more than 30 days ago (and not more than an hour ahead of this clock);
//   - the file is there, at most 4 MiB, and its SHA-256 matches the index;
//   - it is a valid pack (closed format; @scopebond/policy-schema `validatePack`) with the id and version the index names;
//   - its signature verifies with a policy-signing key this release trusts (policy-keys.ts), the key's validity window holds
//     both the pack's `issued_at` and now, and `issued_at` is not more than an hour ahead of this clock;
//   - this engine can run it: its `requires.engine` is not above this engine's level (`packEngineLevel`), and every action
//     type its `requires.action_types` names is known (built in, or added by the signed taxonomy extension in force,
//     pack-taxonomy.ts); otherwise it is skipped as `engine_too_old` or `unknown_action_type`;
//   - the workspace's signed pack list has not killed that version (`packs/sidecar/flags.json`, written by pack-sync.ts).
//
// The sidecar folder (`packs/sidecar`) holds what an engine that reads level 2 adds beside the index, so the index keeps the
// shape every engine reads: `flags.json` (`{ "v": 1, "shadow": [ids], "killed": ["id@version"], "fallback": [entries] }`) and
// `fallback/<id>@<version>.json`, the version of a pack held before the one in force, kept to fall back to when the one in
// force is killed.
//
// Nothing here uses the network. `packs add` (cli-main.ts) puts a local pack file into this cache for a person at a terminal.

import { createHash, verify } from "node:crypto";
import { closeSync, constants as fsConstants, existsSync, fstatSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PACK_ENGINE_LEVEL, PACK_LIMITS, packEngineProblem, packRef, packRequiredEngine, packSigningInput, validatePack, type Pack } from "@scopebond/policy-schema/pack";
import { getActionType } from "@scopebond/policy-schema/registry";
import { policyKeys, publicKeyFrom, type PolicyKey } from "./policy-keys.js";
import { writeAtomic } from "./managed.js";
import { runPackVectors, setActivePacks } from "./packs.js";
import { activateTaxonomyExtension } from "./pack-taxonomy.js";
import { useNextKey } from "./policy-next-key.js";

export const PACKS_DIR = "packs";
export const PACK_INDEX_FILE = "index.json";
/** How long cached packs stay usable after the last successful check-in. */
export const PACK_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const FUTURE_SKEW_MS = 60 * 60 * 1000;
const MAX_INDEX_BYTES = 64 * 1024;

/** One cached pack. `checked_at`, when present, is when this version was last confirmed; otherwise the index's `checked_at`. */
export interface PackIndexEntry { id: string; version: string; sha256: string; checked_at?: string }
export interface PackIndex { v: 1; checked_at: string; packs: PackIndexEntry[] }

export type PackRefusal = "invalid" | "unknown_key" | "key_not_valid" | "bad_signature" | "issued_in_future" | "missing" | "too_large" | "digest_mismatch" | "wrong_ref" | "expired"
  | "engine_too_old" | "unknown_action_type" | "killed";

/** The environment variable that lowers the pack engine level this hook reads at (tests, and trying what an older engine
 *  sees): an integer from 1 to `PACK_ENGINE_LEVEL`. It can never raise it. */
export const PACK_ENGINE_ENV = "SCOPEBOND_PACK_ENGINE_LEVEL";

/** The pack engine level this hook reads packs at: `PACK_ENGINE_LEVEL`, or lower when `SCOPEBOND_PACK_ENGINE_LEVEL` says so. */
export function packEngineLevel(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[PACK_ENGINE_ENV];
  const n = raw !== undefined && /^\d{1,4}$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= PACK_ENGINE_LEVEL ? n : PACK_ENGINE_LEVEL;
}

/** What a pack check takes: the trusted keys (tests), the clock, and the engine level (default `packEngineLevel()`). */
export interface PackCheckOptions { keys?: PolicyKey[]; now?: Date; engine?: number }

export interface LoadedPacks {
  packs: Pack[];
  /** Why a pack (or the whole cache) was not used, one line each. */
  problems: Array<{ ref: string; reason: PackRefusal; message: string }>;
  /** When the first pack in force stops being usable (30 days after its last confirmed check-in); without a pack in force,
   *  30 days after the index's last check-in; null without a readable index. */
  expiresAt: string | null;
  /** When each pack in force stops being usable, by `<id>@<version>`. */
  expires: Record<string, string>;
  /** The ids of the packs in force that the workspace's signed list put in shadow (they record, never block). */
  shadow?: string[];
}

/** When an index entry's version was last confirmed. */
export const packCheckedAt = (index: PackIndex, entry: PackIndexEntry): string => entry.checked_at ?? index.checked_at;

/** Write the index. An entry keeps its own `checked_at` only when it differs from the index's. */
export function writePackIndex(dir: string, index: PackIndex): void {
  const packs = index.packs.map((p) => {
    const { checked_at: own, ...rest } = p;
    return own !== undefined && own !== index.checked_at ? { ...rest, checked_at: own } : rest;
  });
  mkdirSync(packsDir(dir), { recursive: true });
  writeAtomic(join(packsDir(dir), PACK_INDEX_FILE), `${JSON.stringify({ v: 1, checked_at: index.checked_at, packs }, null, 2)}\n`);
}

const HEX64 = /^[0-9a-f]{64}$/;
// eslint-disable-next-line security/detect-unsafe-regex -- linear: anchored, fixed-width fields, one optional bounded fraction
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export const packsDir = (dir: string): string => join(dir, PACKS_DIR);

/** A regular file's text when it is at most `max` bytes: "too_large" past that, null when it cannot be read. The file is
 *  opened once and its type and size are checked on that descriptor, so what passed the check is what is read. */
function readBounded(file: string, max: number): { text: string } | "too_large" | null {
  let fd: number;
  try { fd = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0)); } catch { return null; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    if (st.size > max) return "too_large";
    return { text: readFileSync(fd, "utf8") };
  } catch { return null; } finally { closeSync(fd); }
}
const fileOf = (dir: string, ref: string): string => join(packsDir(dir), `${ref}.json`);

/** Read the index; null when it is missing or not exactly the documented shape. */
export function readPackIndex(dir: string): PackIndex | null {
  try {
    const file = join(packsDir(dir), PACK_INDEX_FILE);
    const read = readBounded(file, MAX_INDEX_BYTES);
    if (read === null || read === "too_large") return null;
    const doc = JSON.parse(read.text) as Record<string, unknown>;
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
    if (Object.keys(doc).some((k) => !["v", "checked_at", "packs"].includes(k))) return null;
    if (doc.v !== 1 || typeof doc.checked_at !== "string" || !RFC3339.test(doc.checked_at) || !Number.isFinite(Date.parse(doc.checked_at))) return null;
    if (!Array.isArray(doc.packs) || doc.packs.length > 200) return null;
    const packs: PackIndexEntry[] = [];
    for (const entry of doc.packs as unknown[]) {
      const e = entry as Record<string, unknown>;
      if (!e || typeof e !== "object" || Array.isArray(e) || Object.keys(e).some((k) => !["id", "version", "sha256", "checked_at"].includes(k))) return null;
      if (typeof e.id !== "string" || typeof e.version !== "string" || typeof e.sha256 !== "string" || !HEX64.test(e.sha256)) return null;
      if (!/^[a-z0-9-]{1,64}$/.test(e.id) || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(e.version)) return null;
      if (e.checked_at !== undefined && (typeof e.checked_at !== "string" || !RFC3339.test(e.checked_at) || !Number.isFinite(Date.parse(e.checked_at)))) return null;
      packs.push({ id: e.id, version: e.version, sha256: e.sha256, ...(typeof e.checked_at === "string" ? { checked_at: e.checked_at } : {}) });
    }
    return { v: 1, checked_at: doc.checked_at, packs };
  } catch { return null; }
}

export type SignatureResult = { ok: true; keyId: string } | { ok: false; reason: PackRefusal; message: string };

/** Verify signed data (a pack, a taxonomy extension) against the trusted policy-signing keys: `input` is what the signature
 *  covers, `what` names the document in messages. Pure apart from reading those keys (`keys` overrides). */
export function verifySignedData(input: string, issuedAt: string, signature: { key_id: string; value: string }, what: string, options: { keys?: PolicyKey[]; now?: Date } = {}): SignatureResult {
  const now = (options.now ?? new Date()).getTime();
  const issued = Date.parse(issuedAt);
  if (!Number.isFinite(issued)) return { ok: false, reason: "invalid", message: "issued_at is not a time" };
  if (issued > now + FUTURE_SKEW_MS) return { ok: false, reason: "issued_in_future", message: `the ${what} says it was issued at ${issuedAt}, more than an hour ahead of this computer's clock` };
  const key = (options.keys ?? policyKeys()).find((k) => k.key_id === signature.key_id);
  if (!key) return { ok: false, reason: "unknown_key", message: `the ${what} names a signing key this version does not trust (${signature.key_id}); update Scopebond` };
  const notBefore = Date.parse(key.not_before);
  const notAfter = Date.parse(key.not_after);
  if (!(issued >= notBefore && issued <= notAfter && now >= notBefore && now <= notAfter)) {
    return { ok: false, reason: "key_not_valid", message: `signing key ${key.key_id} is not valid for this ${what} (valid ${key.not_before} to ${key.not_after})` };
  }
  const publicKey = publicKeyFrom(key.public_key);
  if (!publicKey) return { ok: false, reason: "unknown_key", message: `signing key ${key.key_id} could not be read` };
  let ok: boolean;
  try { ok = verify(null, Buffer.from(input, "utf8"), publicKey, Buffer.from(signature.value, "base64")); } catch { ok = false; }
  return ok ? { ok: true, keyId: key.key_id } : { ok: false, reason: "bad_signature", message: `the ${what}'s signature does not verify; it was changed, damaged or not issued by Scopebond` };
}

/** Verify a pack's signature against the trusted policy-signing keys. Pure apart from reading those keys (`keys` overrides). */
export function verifyPackSignature(pack: Pack, options: { keys?: PolicyKey[]; now?: Date } = {}): SignatureResult {
  return verifySignedData(packSigningInput(pack as unknown as Record<string, unknown>), pack.issued_at, pack.signature, "pack", options);
}

/** Check a pack document from text: whether this engine's level can read it, the closed format at that level, whether it knows
 *  every action type the pack requires, then its signature. */
export function checkPackText(text: string, options: PackCheckOptions = {}): { ok: true; pack: Pack } | { ok: false; reason: PackRefusal; message: string } {
  if (Buffer.byteLength(text, "utf8") > PACK_LIMITS.maxBytes) return { ok: false, reason: "too_large", message: `the pack is larger than ${PACK_LIMITS.maxBytes} bytes` };
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { return { ok: false, reason: "invalid", message: "the pack is not JSON" }; }
  const level = options.engine ?? packEngineLevel();
  // A pack for a newer engine is told apart from a broken one before its shape is read at this level.
  const needs = packRequiredEngine(doc);
  if (needs !== null && needs > level) return { ok: false, reason: "engine_too_old", message: `the pack needs pack engine level ${needs}; this version reads level ${level}; update Scopebond` };
  const shape = validatePack(doc, { engine: level });
  if (!shape.valid) return { ok: false, reason: "invalid", message: `the pack is not a valid scopebond:pack/v1 document (${shape.errors.slice(0, 3).join("; ")})` };
  const pack = doc as Pack;
  const problem = packEngineProblem(pack, level, (type) => getActionType(type) !== undefined);
  if (problem?.reason === "unknown_action_type") return { ok: false, reason: "unknown_action_type", message: `the pack emits action type ${problem.needs}, which this computer does not know (no signed taxonomy extension in force names it)` };
  const signature = verifyPackSignature(pack, options);
  return signature.ok ? { ok: true, pack } : signature;
}

// ---- the sidecar: what level 2 adds beside the index -------------------------------------------------------------------

export const PACK_SIDECAR_DIR = "sidecar";
export const PACK_FLAGS_FILE = "flags.json";
/** The flags the last signed pack list set: the packs in shadow, the versions it killed, and the versions to fall back to. */
export interface PackFlags { v: 1; shadow: string[]; killed: string[]; fallback: PackIndexEntry[] }
const EMPTY_FLAGS: PackFlags = { v: 1, shadow: [], killed: [], fallback: [] };
export const packSidecarDir = (dir: string): string => join(packsDir(dir), PACK_SIDECAR_DIR);
export const packFallbackFile = (dir: string, ref: string): string => join(packSidecarDir(dir), "fallback", `${ref}.json`);
const REF = /^[a-z0-9-]{1,64}@\d{1,6}\.\d{1,6}\.\d{1,6}$/;

/** The flags, or none set when the file is missing or not exactly the documented shape. */
export function readPackFlags(dir: string): PackFlags {
  try {
    const read = readBounded(join(packSidecarDir(dir), PACK_FLAGS_FILE), MAX_INDEX_BYTES);
    if (read === null || read === "too_large") return { ...EMPTY_FLAGS };
    const doc = JSON.parse(read.text) as Record<string, unknown>;
    const strings = (v: unknown, pattern: RegExp): string[] | null => (Array.isArray(v) && v.length <= 200 && v.every((x) => typeof x === "string" && pattern.test(x)) ? v as string[] : null);
    const shadow = strings(doc?.shadow, /^[a-z0-9-]{1,64}$/);
    const killed = strings(doc?.killed, REF);
    const fallback = Array.isArray(doc?.fallback) && doc.fallback.length <= 200 ? (doc.fallback as unknown[]).filter((e): e is PackIndexEntry => {
      const x = e as Record<string, unknown>;
      return !!x && typeof x.id === "string" && typeof x.version === "string" && REF.test(`${x.id}@${x.version}`) && typeof x.sha256 === "string" && HEX64.test(x.sha256)
        && typeof x.checked_at === "string" && RFC3339.test(x.checked_at);
    }).map((x) => ({ id: x.id, version: x.version, sha256: x.sha256, checked_at: x.checked_at })) : null;
    if (doc?.v !== 1 || !shadow || !killed || !fallback) return { ...EMPTY_FLAGS };
    return { v: 1, shadow, killed, fallback };
  } catch { return { ...EMPTY_FLAGS }; }
}

/** Write the flags. */
export function writePackFlags(dir: string, flags: PackFlags): void {
  mkdirSync(packSidecarDir(dir), { recursive: true });
  writeAtomic(join(packSidecarDir(dir), PACK_FLAGS_FILE), `${JSON.stringify(flags, null, 2)}\n`);
}

/** The packs this computer may use now, and why any other was not used. The signed taxonomy extension held here is put in
 *  force first (pack-taxonomy.ts), so a pack that requires one of its action types can be read. Never throws. */
export function loadPacks(dir: string, options: PackCheckOptions = {}): LoadedPacks {
  const problems: LoadedPacks["problems"] = [];
  // The next policy-signing key pinned here may have signed the packs (policy-next-key.ts).
  useNextKey(dir);
  activateTaxonomyExtension(dir, options);
  const flags = readPackFlags(dir);
  const killed = new Set(flags.killed);
  const index = readPackIndex(dir);
  if (!index) {
    if (existsSync(join(packsDir(dir), PACK_INDEX_FILE))) problems.push({ ref: PACK_INDEX_FILE, reason: "invalid", message: "the pack index cannot be read; no pack is used" });
    return { packs: [], problems, expiresAt: null, expires: {} };
  }
  const now = (options.now ?? new Date()).getTime();
  const checked = Date.parse(index.checked_at);
  const indexExpiresAt = new Date(checked + PACK_TTL_MS).toISOString();
  if (checked > now + FUTURE_SKEW_MS) {
    problems.push({ ref: PACK_INDEX_FILE, reason: "issued_in_future", message: "the pack index says it was checked in the future; no pack is used" });
    return { packs: [], problems, expiresAt: indexExpiresAt, expires: {} };
  }
  const packs: Pack[] = [];
  const expires: Record<string, string> = {};
  const seen = new Set<string>();
  for (const entry of index.packs) {
    const ref = `${entry.id}@${entry.version}`;
    if (seen.has(entry.id)) { problems.push({ ref, reason: "invalid", message: `the index lists ${entry.id} twice; only the first is used` }); continue; }
    seen.add(entry.id);
    // A version the workspace's signed list killed is never used, even one held here while offline.
    if (killed.has(ref)) { problems.push({ ref, reason: "killed", message: "the workspace withdrew this version of the pack; it is not used" }); continue; }
    // Each pack on its own clock: one that could not be renewed expires alone.
    const own = Date.parse(packCheckedAt(index, entry));
    const ownExpiresAt = new Date(own + PACK_TTL_MS).toISOString();
    if (own > now + FUTURE_SKEW_MS) { problems.push({ ref, reason: "issued_in_future", message: "the pack index says this pack was checked in the future" }); continue; }
    if (now > own + PACK_TTL_MS) {
      problems.push({ ref, reason: "expired", message: `the pack expired on ${ownExpiresAt}, 30 days after this computer last confirmed it; it is not used until a check-in confirms it again` });
      continue;
    }
    const read = readBounded(fileOf(dir, ref), PACK_LIMITS.maxBytes);
    if (read === "too_large") { problems.push({ ref, reason: "too_large", message: "the pack file is too large" }); continue; }
    if (read === null) { problems.push({ ref, reason: "missing", message: "the pack file is missing" }); continue; }
    const text = read.text;
    if (createHash("sha256").update(text, "utf8").digest("hex") !== entry.sha256) { problems.push({ ref, reason: "digest_mismatch", message: "the pack file does not match the index" }); continue; }
    const checkedPack = checkPackText(text, options);
    if (!checkedPack.ok) { problems.push({ ref, reason: checkedPack.reason, message: checkedPack.message }); continue; }
    if (packRef(checkedPack.pack) !== ref) { problems.push({ ref, reason: "wrong_ref", message: `the file holds ${packRef(checkedPack.pack)}` }); continue; }
    packs.push(checkedPack.pack);
    expires[ref] = ownExpiresAt;
  }
  const first = Object.values(expires).sort()[0];
  const shadow = packs.map((p) => p.id).filter((id) => flags.shadow.includes(id));
  return { packs, problems, expiresAt: first ?? indexExpiresAt, expires, ...(shadow.length ? { shadow } : {}) };
}

/** Load the packs in this state directory and put them in force for the mapper (those in shadow record only). Never throws;
 *  on any failure no pack is in force. Returns what was loaded. */
export function activatePacks(dir: string, options: PackCheckOptions = {}): LoadedPacks {
  try {
    const loaded = loadPacks(dir, options);
    setActivePacks(loaded.packs, loaded.shadow ?? []);
    return loaded;
  } catch {
    setActivePacks([]);
    return { packs: [], problems: [{ ref: PACK_INDEX_FILE, reason: "invalid", message: "the packs could not be read" }], expiresAt: null, expires: {} };
  }
}

/** Put a checked pack into the cache, replacing any other version of its id, and stamp its `checked_at` (`packs add`, after a
 *  person loads a file). Every other pack keeps its own clock. The pack's own vectors must all pass first. */
export function installPack(dir: string, text: string, options: PackCheckOptions = {}): { ok: true; pack: Pack } | { ok: false; reason: PackRefusal | "vectors_failed"; message: string } {
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
  const others = index.packs.filter((p) => p.id !== checked.pack.id).map((p) => ({ ...p, checked_at: packCheckedAt(index, p) }));
  const packs = [...others, { id: checked.pack.id, version: checked.pack.version, sha256: createHash("sha256").update(text, "utf8").digest("hex") }]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  writePackIndex(dir, { v: 1, checked_at: now.toISOString(), packs });
  for (const old of stale) { try { rmSync(fileOf(dir, `${old.id}@${old.version}`), { force: true }); } catch { /* left behind, never read */ } }
  return { ok: true, pack: checked.pack };
}

/** Remove a pack from the cache. True when it was listed. */
export function removePack(dir: string, id: string): boolean {
  const index = readPackIndex(dir);
  if (!index) return false;
  const gone = index.packs.filter((p) => p.id === id);
  if (gone.length === 0) return false;
  writePackIndex(dir, { ...index, packs: index.packs.filter((p) => p.id !== id) });
  for (const p of gone) { try { rmSync(fileOf(dir, `${p.id}@${p.version}`), { force: true }); } catch { /* never read again */ } }
  return true;
}
