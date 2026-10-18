// Delivering rule packs from the workspace: on a rules check, bring this computer's pack cache (pack-store.ts) in step with the
// packs the workspace's signed answer names.
//
// The answer to `GET /v1/policy` may carry `packs` (a list of `{ id, version, sha256 }`) with `packs_digest` and
// `packs_signature` (policy-signature.ts `checkPacksSignature`). When it does, and the list's signature verifies:
//   - each pack the cache does not hold byte for byte is fetched from `GET /v1/packs/<id>@<version>` with this computer's
//     credential; it is used only when its sha256 is the one the list names, it is a valid pack, its own signature verifies
//     with a key this release trusts, and every one of its vectors passes on this version (pack-store.ts `checkPackText`,
//     `runPackVectors`);
//   - the index is rewritten to exactly the listed packs, and any other pack file is removed: a list without packs (a computer
//     that is not licensed) leaves none, so only the open detection and the starter protections apply;
//   - `checked_at` is set to now only when every listed pack is in the cache; when one could not be fetched or checked, the
//     version already held stays and the cache keeps the time of the last complete check-in, so it still expires 30 days later.
// An answer without `packs` (an older workspace, an unsigned answer) changes nothing, and an answer whose list does not verify
// changes nothing either. A `304 Not Modified` rules check is a check-in that confirms the list in force (`restampPacks`).
// Nothing here throws to the caller: a failure leaves the cache as it was.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { packRef } from "@scopebond/policy-schema/pack";
import { writeAtomic } from "./managed.js";
import { checkPackText, packsDir, readPackIndex, PACK_INDEX_FILE, type PackIndexEntry } from "./pack-store.js";
import { runPackVectors } from "./packs.js";
import { checkPacksSignature } from "./policy-signature.js";
import type { PolicyKey } from "./policy-keys.js";

/** The most packs one answer may name. */
export const MAX_PACK_REFS = 50;
// eslint-disable-next-line security/detect-unsafe-regex -- linear: anchored, a bounded run of one class with an optional repeat of separators
const ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const VERSION = /^(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})$/;
const HEX64 = /^[0-9a-f]{64}$/;

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
}

export type PackSyncResult =
  | { state: "not_named" }
  | { state: "refused"; message: string }
  | { state: "synced"; packs: string[]; fetched: string[]; removed: string[] }
  | { state: "partial"; packs: string[]; fetched: string[]; removed: string[]; failed: Array<{ ref: string; message: string }> };

/** The pack list an answer names, or null when it is not exactly the documented shape. */
export function packRefsOf(answer: Record<string, unknown>): PackIndexEntry[] | null {
  const list = answer.packs;
  if (!Array.isArray(list) || list.length > MAX_PACK_REFS) return null;
  const out: PackIndexEntry[] = [];
  const seen = new Set<string>();
  for (const item of list as unknown[]) {
    const e = item as Record<string, unknown>;
    if (!e || typeof e !== "object" || Array.isArray(e) || Object.keys(e).some((k) => !["id", "version", "sha256"].includes(k))) return null;
    if (typeof e.id !== "string" || !ID.test(e.id) || typeof e.version !== "string" || !VERSION.test(e.version) || typeof e.sha256 !== "string" || !HEX64.test(e.sha256)) return null;
    if (seen.has(e.id)) return null;
    seen.add(e.id);
    out.push({ id: e.id, version: e.version, sha256: e.sha256 });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const fileOf = (dir: string, ref: string): string => join(packsDir(dir), `${ref}.json`);

/** Bring the pack cache in step with a workspace answer that has passed its rules signature check. Never throws. */
export async function syncPacks(dir: string, answer: Record<string, unknown>, options: PackSyncOptions): Promise<PackSyncResult> {
  try {
    if (answer.packs === undefined) return { state: "not_named" };
    const signature = checkPacksSignature(answer, {
      workspace: options.workspace, computer: options.computer, lastIssuedAt: options.lastIssuedAt, now: options.now, keys: options.keys, managed: answer.managed !== false,
    });
    if (signature.result !== "verified") return { state: "refused", message: signature.result === "refused" ? signature.message : "the answer's pack list is not signed" };
    const wanted = packRefsOf(answer);
    if (!wanted) return { state: "refused", message: "the answer's pack list is malformed" };
    const now = options.now ?? new Date();
    const held = readPackIndex(dir);
    const kept: PackIndexEntry[] = [];
    const fetched: string[] = [];
    const failed: Array<{ ref: string; message: string }> = [];
    for (const ref of wanted) {
      const name = packRef(ref);
      const have = held?.packs.find((p) => p.id === ref.id);
      if (have && have.version === ref.version && have.sha256 === ref.sha256 && existsSync(fileOf(dir, name))) { kept.push(have); continue; }
      const got = await fetchPack(dir, ref, options);
      if (got.ok) { kept.push(ref); fetched.push(name); continue; }
      failed.push({ ref: name, message: got.message });
      // The version already held (a genuine, earlier pack) stays until it expires.
      if (have && existsSync(fileOf(dir, packRef(have)))) kept.push(have);
    }
    const checkedAt = failed.length === 0 || !held ? now.toISOString() : held.checked_at;
    mkdirSync(packsDir(dir), { recursive: true });
    writeAtomic(join(packsDir(dir), PACK_INDEX_FILE), `${JSON.stringify({ v: 1, checked_at: checkedAt, packs: kept }, null, 2)}\n`);
    const removed = removeUnlisted(dir, kept);
    const packs = kept.map(packRef);
    return failed.length ? { state: "partial", packs, fetched, removed, failed } : { state: "synced", packs, fetched, removed };
  } catch (error) {
    return { state: "refused", message: `the packs could not be updated (${(error as Error).message})` };
  }
}

/** Fetch one pack, check it, and write its file. The index is the caller's to write. */
async function fetchPack(dir: string, ref: PackIndexEntry, options: PackSyncOptions): Promise<{ ok: true } | { ok: false; message: string }> {
  const name = packRef(ref);
  let res: Response;
  try {
    res = await options.fetchImpl(`${options.base}/v1/packs/${encodeURIComponent(ref.id)}@${encodeURIComponent(ref.version)}`, {
      headers: { ...options.headers, accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
    });
  } catch (error) { return { ok: false, message: `could not reach the workspace (${(error as Error).name})` }; }
  if (res.status !== 200) return { ok: false, message: `the workspace answered ${res.status}` };
  let text: string;
  try { text = await res.text(); } catch { return { ok: false, message: "the pack could not be read" }; }
  if (sha256(text) !== ref.sha256) return { ok: false, message: "the pack does not match the digest the workspace's signed list names" };
  const checked = checkPackText(text, { keys: options.keys, now: options.now });
  if (!checked.ok) return { ok: false, message: checked.message };
  if (packRef(checked.pack) !== name) return { ok: false, message: `the file holds ${packRef(checked.pack)}` };
  const run = runPackVectors(checked.pack);
  if (run.failures.length) return { ok: false, message: `${run.failures.length} of the pack's ${checked.pack.vectors.length} vectors do not pass on this version (first: ${run.failures[0].id})` };
  mkdirSync(packsDir(dir), { recursive: true });
  writeAtomic(fileOf(dir, name), text);
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

/** A rules check the workspace answered `304 Not Modified` confirms the pack list in force: the cache's `checked_at` moves to
 *  now when every pack it lists is there. Never throws. */
export function restampPacks(dir: string, now: Date = new Date()): boolean {
  try {
    const held = readPackIndex(dir);
    if (!held || !held.packs.every((p) => existsSync(fileOf(dir, packRef(p))))) return false;
    writeAtomic(join(packsDir(dir), PACK_INDEX_FILE), `${JSON.stringify({ ...held, checked_at: now.toISOString() }, null, 2)}\n`);
    return true;
  } catch { return false; }
}
