// Delivering rule packs from the workspace: on a rules check, bring this computer's pack cache (pack-store.ts) in step with the
// packs the workspace's signed answer names.
//
// The answer to `GET /v1/policy` may carry `packs` (a list of `{ id, version, sha256 }`) with `packs_digest` and
// `packs_signature` (policy-signature.ts `checkPacksSignature`). When it does, and the list's signature verifies:
//   - each pack the cache does not hold byte for byte is fetched from `GET /v1/packs/<id>@<version>` with this computer's
//     credential; it is used only when its sha256 is the one the list names, it is a valid pack, its own signature verifies
//     with a key this release trusts, this engine can run it, and every one of its vectors passes on this version
//     (pack-store.ts `checkPackText`, `runPackVectors`);
//   - the index is rewritten to exactly the listed packs, and any other pack file is removed: a list without packs (a computer
//     that is not licensed) leaves none, so only the open detection and the starter protections apply;
//   - each pack is checked and kept on its own: a pack confirmed by this answer (held byte for byte, or fetched and checked)
//     is renewed to now; a pack that could not be fetched or checked is skipped and named in the result (id, version, why),
//     and the version already held of it stays on its own clock (pack-store.ts), so it still expires 30 days after it was
//     last confirmed. One pack that cannot be read never holds back the others.
//
// Engine level 2 (sent only to a hook that reports `pack_engine_2`; this hook says its level in `x-scopebond-pack-engine` on
// the rules check and on each pack fetch):
//   - a list entry may say `requires_engine` (the level that version needs: one above this engine's is not fetched, and is
//     reported as `engine_too_old`) and `shadow: true` (the pack's rules record what they would block and never block);
//   - the answer may carry `killed: ["id@version", …]`, covered by the list's digest: a killed version is dropped at once,
//     even one held here, and never fetched; the version of that pack held before it (kept in `packs/sidecar/fallback`) is
//     used instead while it is not killed and not expired;
//   - the entry `{ id: "taxonomy-ext", version, sha256 }` names the signed taxonomy extension (pack-taxonomy.ts), fetched
//     from the same route and checked before the packs, so a pack that requires one of its action types can be read.
//
// An answer without `packs` (an older workspace, an unsigned answer) changes nothing, and an answer whose list does not verify
// changes nothing either. A `304 Not Modified` rules check is a check-in that confirms the list in force (`restampPacks`).
// Nothing here throws to the caller: a failure leaves the cache as it was.

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { packRef } from "@scopebond/policy-schema/pack";
import { TAXONOMY_EXT_ID } from "@scopebond/policy-schema/taxonomy-ext";
import { writeAtomic, type ManagedMeta } from "./managed.js";
import {
  checkPackText, packCheckedAt, packEngineLevel, packFallbackFile, packsDir, readPackFlags, readPackIndex, writePackFlags, writePackIndex,
  PACK_INDEX_FILE, PACK_TTL_MS, type PackIndexEntry,
} from "./pack-store.js";
import { checkTaxonomyExtText, heldTaxonomyDigest, installTaxonomyExtension, removeTaxonomyExtension } from "./pack-taxonomy.js";
import { runPackVectors } from "./packs.js";
import { checkPacksSignature } from "./policy-signature.js";
import type { PolicyKey } from "./policy-keys.js";

/** The most packs one answer may name. */
export const MAX_PACK_REFS = 50;
/** The header that says this hook's pack engine level, on the rules check and on each pack fetch. */
export const PACK_ENGINE_HEADER = "x-scopebond-pack-engine";
// eslint-disable-next-line security/detect-unsafe-regex -- linear: anchored, a bounded run of one class with an optional repeat of separators
const ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const VERSION = /^(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})$/;
const HEX64 = /^[0-9a-f]{64}$/;
// eslint-disable-next-line security/detect-unsafe-regex -- linear: anchored, two bounded fields
const KILLED = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?@(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})$/;

export interface PackSyncOptions {
  /** The workspace's base URL (cloud.json `url`, without a trailing slash). */
  base: string;
  /** Headers every call to the workspace carries (the credential, the machine id). */
  headers: Record<string, string>;
  fetchImpl: typeof fetch;
  /** The signature context of the answer: the workspace and computer ids and the replay mark. */
  workspace: string | null;
  computer: string;
  lastIssuedAt: string | null;
  now?: Date;
  timeoutMs?: number;
  /** Trusted keys (tests); the pinned keys otherwise. */
  keys?: PolicyKey[];
  /** The pack engine level to read at (default `packEngineLevel()`). */
  engine?: number;
}

/** Why a named pack (or the taxonomy extension) was not taken, as a code: a pack-store.ts refusal, or `unreachable`,
 *  `not_served`, `vectors_failed`. */
export type PackSyncCode = string;

/** A pack the answer names that could not be fetched or checked: its id and version, why (a code, and words), what it needs
 *  when this engine is too old or lacks an action type, and the version of it that stays in force (and until when), if any. */
export interface PackSyncFailure {
  ref: string; id: string; version: string; code: PackSyncCode; message: string; needs?: number | string;
  held: string | null; held_until: string | null;
}

export type PackSyncResult =
  | { state: "not_named" }
  | { state: "refused"; message: string }
  | { state: "synced"; packs: string[]; fetched: string[]; removed: string[] }
  | { state: "partial"; packs: string[]; fetched: string[]; removed: string[]; failed: PackSyncFailure[] };

/** One entry of a signed pack list: the pack, and (level 2) the engine level it needs and whether it is in shadow. */
export interface PackRef extends PackIndexEntry { requires_engine?: number; shadow?: true }

/** One entry, or null when it is not exactly the documented shape. */
function refOf(item: unknown): PackRef | null {
  const e = item as Record<string, unknown>;
  if (!e || typeof e !== "object" || Array.isArray(e) || Object.keys(e).some((k) => !["id", "version", "sha256", "requires_engine", "shadow"].includes(k))) return null;
  if (typeof e.id !== "string" || !ID.test(e.id) || typeof e.version !== "string" || !VERSION.test(e.version) || typeof e.sha256 !== "string" || !HEX64.test(e.sha256)) return null;
  if (e.requires_engine !== undefined && !(Number.isInteger(e.requires_engine) && (e.requires_engine as number) >= 1 && (e.requires_engine as number) <= 1000)) return null;
  if (e.shadow !== undefined && e.shadow !== true) return null;
  return { id: e.id, version: e.version, sha256: e.sha256, ...(e.requires_engine !== undefined ? { requires_engine: e.requires_engine as number } : {}), ...(e.shadow ? { shadow: true as const } : {}) };
}

/** The pack list an answer names (without the taxonomy extension's entry), or null when it is not exactly the documented
 *  shape. */
export function packRefsOf(answer: Record<string, unknown>): PackRef[] | null {
  const list = answer.packs;
  if (!Array.isArray(list) || list.length > MAX_PACK_REFS + 1) return null;
  const out: PackRef[] = [];
  const seen = new Set<string>();
  for (const item of list as unknown[]) {
    const ref = refOf(item);
    if (!ref || seen.has(ref.id)) return null;
    seen.add(ref.id);
    if (ref.id !== TAXONOMY_EXT_ID) out.push(ref);
  }
  if (out.length > MAX_PACK_REFS) return null;
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The taxonomy extension an answer's pack list names, or null when it names none (or the list is malformed). */
export function taxonomyRefOf(answer: Record<string, unknown>): PackIndexEntry | null {
  const list = Array.isArray(answer.packs) ? answer.packs as unknown[] : [];
  const ref = list.map(refOf).find((r) => r?.id === TAXONOMY_EXT_ID);
  return ref ? { id: ref.id, version: ref.version, sha256: ref.sha256 } : null;
}

/** The versions an answer kills (`killed`), or null when the member is there and is not a list of `id@version`. */
export function killedOf(answer: Record<string, unknown>): string[] | null {
  if (answer.killed === undefined) return [];
  const list = answer.killed;
  return Array.isArray(list) && list.length <= 200 && list.every((x) => typeof x === "string" && KILLED.test(x)) ? [...new Set(list as string[])] : null;
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const fileOf = (dir: string, ref: string): string => join(packsDir(dir), `${ref}.json`);
const fetchHeaders = (options: PackSyncOptions): Record<string, string> =>
  ({ ...options.headers, accept: "application/json", [PACK_ENGINE_HEADER]: String(options.engine ?? packEngineLevel()) });

/** Fetch one named document from the packs route and check its digest. */
async function fetchNamed(ref: PackIndexEntry, options: PackSyncOptions): Promise<{ ok: true; text: string } | { ok: false; code: PackSyncCode; message: string }> {
  let res: Response;
  try {
    res = await options.fetchImpl(`${options.base}/v1/packs/${encodeURIComponent(ref.id)}@${encodeURIComponent(ref.version)}`, {
      headers: fetchHeaders(options), redirect: "error", signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
    });
  } catch (error) { return { ok: false, code: "unreachable", message: `could not reach the workspace (${(error as Error).name})` }; }
  if (res.status !== 200) return { ok: false, code: "not_served", message: `the workspace answered ${res.status}` };
  let text: string;
  try { text = await res.text(); } catch { return { ok: false, code: "unreachable", message: "the pack could not be read" }; }
  if (sha256(text) !== ref.sha256) return { ok: false, code: "digest_mismatch", message: "the pack does not match the digest the workspace's signed list names" };
  return { ok: true, text };
}

/** Bring the taxonomy extension in step with a verified list: fetch and check the one it names unless it is held byte for
 *  byte; remove the one held when the list names none. A failure keeps what is held. */
async function syncTaxonomy(dir: string, ref: PackIndexEntry | null, options: PackSyncOptions): Promise<PackSyncFailure | null> {
  if (!ref) { removeTaxonomyExtension(dir); return null; }
  if (heldTaxonomyDigest(dir) === ref.sha256) return null;
  const name = packRef(ref);
  const fail = (code: PackSyncCode, message: string): PackSyncFailure => ({ ref: name, id: ref.id, version: ref.version, code, message, held: null, held_until: null });
  const got = await fetchNamed(ref, options);
  if (!got.ok) return fail(got.code, got.message);
  const checked = checkTaxonomyExtText(got.text, { keys: options.keys, now: options.now });
  if (!checked.ok) return fail(checked.reason, checked.message);
  installTaxonomyExtension(dir, got.text, checked.ext);
  return null;
}

/** Bring the pack cache in step with a workspace answer that has passed its rules signature check. Never throws. */
export async function syncPacks(dir: string, answer: Record<string, unknown>, options: PackSyncOptions): Promise<PackSyncResult> {
  try {
    if (answer.packs === undefined) return { state: "not_named" };
    const signature = checkPacksSignature(answer, {
      workspace: options.workspace, computer: options.computer, lastIssuedAt: options.lastIssuedAt, now: options.now, keys: options.keys, managed: answer.managed !== false,
    });
    if (signature.result !== "verified") return { state: "refused", message: signature.result === "refused" ? signature.message : "the answer's pack list is not signed" };
    const wanted = packRefsOf(answer);
    const killedList = killedOf(answer);
    if (!wanted || !killedList) return { state: "refused", message: "the answer's pack list is malformed" };
    const killed = new Set(killedList);
    const level = options.engine ?? packEngineLevel();
    const now = options.now ?? new Date();
    const held = readPackIndex(dir);
    const flags = readPackFlags(dir);
    const kept: PackIndexEntry[] = [];
    const fetched: string[] = [];
    const failed: PackSyncFailure[] = [];
    // The taxonomy extension first: a pack may require one of its action types. An engine below level 2 does not read one.
    const taxonomy = level >= 2 ? await syncTaxonomy(dir, taxonomyRefOf(answer), options) : null;
    if (taxonomy) failed.push(taxonomy);
    let fallback = flags.fallback.filter((f) => !killed.has(packRef(f)) && existsSync(packFallbackFile(dir, packRef(f))));
    for (const ref of wanted) {
      const name = packRef(ref);
      const entry: PackIndexEntry = { id: ref.id, version: ref.version, sha256: ref.sha256 };
      const haveRaw = held?.packs.find((p) => p.id === ref.id);
      // A killed version is dropped at once, even one held while offline.
      const have = haveRaw && !killed.has(packRef(haveRaw)) ? haveRaw : undefined;
      // Confirmed by this answer: renewed to now (an entry without its own clock takes the index's).
      if (have && have.version === ref.version && have.sha256 === ref.sha256 && existsSync(fileOf(dir, name))) { kept.push(entry); continue; }
      let got: { ok: true } | { ok: false; code: PackSyncCode; message: string; needs?: number | string };
      if (killed.has(name)) got = { ok: false, code: "killed", message: "the workspace withdrew this version of the pack" };
      // A version for a newer engine is not fetched: this engine keeps what it holds of that pack.
      else if ((ref.requires_engine ?? 1) > level) got = { ok: false, code: "engine_too_old", message: `the pack needs pack engine level ${ref.requires_engine}; this version reads level ${level}`, needs: ref.requires_engine };
      else got = await fetchPack(dir, entry, options);
      if (got.ok) {
        kept.push(entry);
        fetched.push(name);
        // The version it replaces is kept to fall back to, should this one be killed.
        if (have && held && have.version !== ref.version && existsSync(fileOf(dir, packRef(have)))) {
          fallback = keepFallback(dir, fallback, { ...have, checked_at: packCheckedAt(held, have) });
        }
        continue;
      }
      // The version already held (a genuine, earlier pack) stays on its own clock until it expires; else the version kept to fall
      // back to, while it is not killed. The others are not held back.
      let holding: PackIndexEntry | null = have && held && existsSync(fileOf(dir, packRef(have))) ? { ...have, checked_at: packCheckedAt(held, have) } : null;
      if (!holding) holding = restoreFallback(dir, fallback.find((f) => f.id === ref.id && f.version !== ref.version) ?? null, now);
      if (holding) kept.push(holding);
      failed.push({
        ref: name, id: ref.id, version: ref.version, code: got.code, message: got.message, ...(got.needs !== undefined ? { needs: got.needs } : {}),
        held: holding ? packRef(holding) : null, held_until: holding?.checked_at ? new Date(Date.parse(holding.checked_at) + PACK_TTL_MS).toISOString() : null,
      });
    }
    writePackIndex(dir, { v: 1, checked_at: now.toISOString(), packs: kept });
    // The flags this list sets: the packs in shadow, the versions killed, and the versions kept to fall back to (only for packs
    // still listed, and never one in force).
    const listed = new Set(wanted.map((r) => r.id));
    fallback = fallback.filter((f) => listed.has(f.id) && !kept.some((k) => k.id === f.id && k.version === f.version));
    writePackFlags(dir, { v: 1, shadow: wanted.filter((r) => r.shadow).map((r) => r.id), killed: [...killed], fallback });
    pruneFallback(dir, fallback);
    const removed = removeUnlisted(dir, kept);
    const packs = kept.map(packRef);
    return failed.length ? { state: "partial", packs, fetched, removed, failed } : { state: "synced", packs, fetched, removed };
  } catch (error) {
    return { state: "refused", message: `the packs could not be updated (${(error as Error).message})` };
  }
}

/** Keep a held version's file to fall back to (one per pack: the newest replaced). */
function keepFallback(dir: string, list: PackIndexEntry[], entry: PackIndexEntry): PackIndexEntry[] {
  try {
    const file = packFallbackFile(dir, packRef(entry));
    mkdirSync(dirname(file), { recursive: true });
    copyFileSync(fileOf(dir, packRef(entry)), file);
    return [...list.filter((f) => f.id !== entry.id), entry];
  } catch { return list; }
}

/** Put a version kept to fall back to back in the packs folder, while its own 30 days have not run out. */
function restoreFallback(dir: string, entry: PackIndexEntry | null, now: Date): PackIndexEntry | null {
  if (!entry?.checked_at || now.getTime() > Date.parse(entry.checked_at) + PACK_TTL_MS) return null;
  try {
    copyFileSync(packFallbackFile(dir, packRef(entry)), fileOf(dir, packRef(entry)));
    return entry;
  } catch { return null; }
}

/** Remove every fallback file the flags do not list. */
function pruneFallback(dir: string, list: readonly PackIndexEntry[]): void {
  const keep = new Set(list.map((f) => `${packRef(f)}.json`));
  let names: string[];
  try { names = readdirSync(dirname(packFallbackFile(dir, "x"))); } catch { return; }
  for (const name of names) if (!keep.has(name)) { try { rmSync(join(dirname(packFallbackFile(dir, "x")), name), { force: true }); } catch { /* never read */ } }
}

/** Fetch one pack, check it, and write its file. The index is the caller's to write. */
async function fetchPack(dir: string, ref: PackIndexEntry, options: PackSyncOptions): Promise<{ ok: true } | { ok: false; code: PackSyncCode; message: string }> {
  const name = packRef(ref);
  const got = await fetchNamed(ref, options);
  if (!got.ok) return got;
  const checked = checkPackText(got.text, { keys: options.keys, now: options.now, engine: options.engine });
  if (!checked.ok) return { ok: false, code: checked.reason, message: checked.message };
  if (packRef(checked.pack) !== name) return { ok: false, code: "wrong_ref", message: `the file holds ${packRef(checked.pack)}` };
  const run = runPackVectors(checked.pack);
  if (run.failures.length) return { ok: false, code: "vectors_failed", message: `${run.failures.length} of the pack's ${checked.pack.vectors.length} vectors do not pass on this version (first: ${run.failures[0].id})` };
  mkdirSync(packsDir(dir), { recursive: true });
  writeAtomic(fileOf(dir, name), got.text);
  return { ok: true };
}

/** Remove every pack file the index does not list. */
function removeUnlisted(dir: string, listed: readonly PackIndexEntry[]): string[] {
  const keep = new Set(listed.map((p) => `${packRef(p)}.json`));
  const removed: string[] = [];
  let names: string[];
  try { names = readdirSync(packsDir(dir)); } catch { return removed; }
  for (const name of names) {
    if (name === PACK_INDEX_FILE || !name.endsWith(".json") || keep.has(name)) continue;
    try { rmSync(join(packsDir(dir), name), { force: true }); removed.push(name.slice(0, -5)); } catch { /* left behind, never read */ }
  }
  return removed;
}

/** A rules check the workspace answered `304 Not Modified` confirms the pack list in force: every pack the cache lists moves
 *  to now, except the ids in `unconfirmed` (packs the last list named at a version this computer could not fetch or check)
 *  and any whose file is missing, which keep their own clock. False when there is no index to renew. Never throws. */
export function restampPacks(dir: string, now: Date = new Date(), unconfirmed: readonly string[] = []): boolean {
  try {
    const held = readPackIndex(dir);
    if (!held) return false;
    const packs = held.packs.map((p): PackIndexEntry => {
      const ref = { id: p.id, version: p.version, sha256: p.sha256 };
      return unconfirmed.includes(p.id) || !existsSync(fileOf(dir, packRef(p))) ? { ...ref, checked_at: packCheckedAt(held, p) } : ref;
    });
    writePackIndex(dir, { v: 1, checked_at: now.toISOString(), packs });
    return true;
  } catch { return false; }
}

/** What `status` and `packs list` say about the last pack list the workspace named: one line for each pack that could not be
 *  updated (its id, the version named, why, and what stays in force), or why the list was not used. Empty when it was taken in
 *  full. */
export function describePackSync(state: ManagedMeta["packs"] | undefined): string[] {
  if (!state || state.complete) return [];
  if (!state.failed?.length) return state.error ? [`the last pack list was not used: ${state.error}`] : [];
  return state.failed.map((f) => `${f.id} ${f.version} could not be updated (${f.reason}); ${f.held && f.held_until ? `${f.held} stays in force until ${f.held_until}` : "no version of it is in force"}`);
}
