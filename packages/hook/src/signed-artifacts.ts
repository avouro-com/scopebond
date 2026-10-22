// Signed artifacts: data a workspace signs for the plugin slot (intel-plugin.ts), delivered beside the rule packs. The hook
// checks where an artifact comes from and that nobody changed it; it never reads what one says.
//
// A hook that reports `signed_artifacts_1` (SIGNED_ARTIFACTS_CAPABILITY) on its rules check may find, in the signed pack list of
// the answer (pack-sync.ts), an `artifacts` member: a list of `{ id, version, sha256, shadow? }`, covered by the list's digest and
// signature (policy-signature.ts `digestPacks`). When the list verifies:
//   - each artifact this computer does not hold byte for byte is fetched from `GET /v1/packs/<id>@<version>` (the pack route, with
//     the same headers as a pack fetch and this hook's capabilities); it is kept only when its sha256 is the one the list names, it
//     is a `scopebond:artifact/v1` document whose `kind` is the listed id and whose `version` is the listed version, and its
//     Ed25519 signature over ARTIFACT_SIGNATURE_DOMAIN + the RFC 8785 canonical document without `signature` verifies with a
//     policy-signing key this release pins (pack-store.ts `verifySignedData`, as packs are checked);
//   - the store is rewritten to exactly the listed artifacts: one that could not be fetched or checked keeps the copy already held
//     of that id (if any), and a 402 `not_licensed` drops it; an answer whose verified list has no `artifacts` leaves none.
// An answer without a pack list, or whose list does not verify, changes nothing, and nothing is fetched.
//
// The bytes go to the plugin unread: a plugin that exports `artifactKinds` (the kinds it reads) and `acceptArtifact` is handed,
// when it loads, each held artifact of one of those kinds as `{ kind, id, version, shadow, bytes }` (heldArtifacts, then
// intel-plugin.ts). An artifact of a kind no plugin reads is kept and ignored. Nothing here throws to the caller.
//
// Store: `<dir>/artifacts/<id>@<version>.json` (the exact bytes served) and `<dir>/artifacts/index.json`.

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { canonical } from "@scopebond/gateway";
import { writeAtomic } from "./managed.js";
import { verifySignedData } from "./pack-store.js";
import { checkPacksSignature } from "./policy-signature.js";
import type { PolicyKey } from "./policy-keys.js";

/** The capability a hook reports on its rules check (and repeats on each artifact fetch) when it holds signed artifacts. */
export const SIGNED_ARTIFACTS_CAPABILITY = "signed_artifacts_1";
export const ARTIFACT_FORMAT = "scopebond:artifact/v1";
/** What an artifact signature covers: these bytes, then the canonical document without `signature`. */
export const ARTIFACT_SIGNATURE_DOMAIN = "scopebond:artifact/v1\n";
/** The most artifacts one list may name. */
export const MAX_ARTIFACT_REFS = 20;
/** The largest artifact the hook keeps. */
export const ARTIFACT_MAX_BYTES = 16 * 1024 * 1024;
export const ARTIFACTS_DIR = "artifacts";
export const ARTIFACT_INDEX_FILE = "index.json";

// eslint-disable-next-line security/detect-unsafe-regex -- linear: anchored, a bounded run of one class with an optional repeat of separators
const ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const VERSION = /^(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})$/;
const HEX64 = /^[0-9a-f]{64}$/;
// eslint-disable-next-line security/detect-unsafe-regex -- linear: anchored, fixed-width fields, one optional bounded fraction
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const KEY_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const SIG = /^[A-Za-z0-9+/]{86}(?:==)?$/;

/** One entry of a signed artifact list. */
export interface ArtifactRef { id: string; version: string; sha256: string; shadow?: true }
/** One artifact this computer holds: its ref and the kind its document names (the plugin slot reads by kind). */
export interface HeldArtifactEntry extends ArtifactRef { kind: string }
/** A held artifact as a plugin is handed it: the exact bytes served, unread. */
export interface HeldArtifact { kind: string; id: string; version: string; shadow: boolean; bytes: Uint8Array }

export interface ArtifactSyncOptions {
  /** The workspace's base URL (cloud.json `url`, without a trailing slash). */
  base: string;
  /** Headers every call to the workspace carries (the credential, the machine id, the pack engine level). */
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

/** An artifact the list names that could not be fetched or checked: its ref, why (a code and words), and whether a copy stays. */
export interface ArtifactSyncFailure { ref: string; code: string; message: string; held: string | null }

export type ArtifactSyncResult =
  | { state: "not_named" }
  | { state: "refused"; message: string }
  | { state: "synced"; artifacts: string[]; fetched: string[]; removed: string[]; failed: ArtifactSyncFailure[] };

const refName = (ref: { id: string; version: string }): string => `${ref.id}@${ref.version}`;
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Where artifacts are kept: `<dir>/artifacts`. */
export const artifactsDir = (dir: string): string => join(dir, ARTIFACTS_DIR);
const fileOf = (dir: string, name: string): string => join(artifactsDir(dir), `${name}.json`);

/** One list entry, or null when it is not exactly the documented shape. */
function refOf(item: unknown): ArtifactRef | null {
  if (!isObject(item) || Object.keys(item).some((k) => !["id", "version", "sha256", "shadow"].includes(k))) return null;
  if (typeof item.id !== "string" || !ID.test(item.id) || typeof item.version !== "string" || !VERSION.test(item.version)) return null;
  if (typeof item.sha256 !== "string" || !HEX64.test(item.sha256) || (item.shadow !== undefined && item.shadow !== true)) return null;
  return { id: item.id, version: item.version, sha256: item.sha256, ...(item.shadow ? { shadow: true as const } : {}) };
}

/** The artifacts an answer's list names (none when the member is absent), or null when it is not exactly the documented shape. */
export function artifactRefsOf(answer: Record<string, unknown>): ArtifactRef[] | null {
  if (answer.artifacts === undefined) return [];
  const list = answer.artifacts;
  if (!Array.isArray(list) || list.length > MAX_ARTIFACT_REFS) return null;
  const out: ArtifactRef[] = [];
  for (const item of list as unknown[]) {
    const ref = refOf(item);
    if (!ref || out.some((r) => r.id === ref.id)) return null;
    out.push(ref);
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export type ArtifactCheck = { ok: true; kind: string; version: string } | { ok: false; reason: string; message: string };

/** Check an artifact document from text: its envelope (format, kind, version, issue time, signature) and its signature. What
 *  else it holds is never read. */
export function checkArtifactText(text: string, options: { keys?: PolicyKey[]; now?: Date } = {}): ArtifactCheck {
  if (Buffer.byteLength(text, "utf8") > ARTIFACT_MAX_BYTES) return { ok: false, reason: "too_large", message: `the artifact is larger than ${ARTIFACT_MAX_BYTES} bytes` };
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { return { ok: false, reason: "invalid", message: "the artifact is not JSON" }; }
  if (!isObject(doc) || doc.format !== ARTIFACT_FORMAT) return { ok: false, reason: "invalid", message: `the artifact is not a ${ARTIFACT_FORMAT} document` };
  const signature = doc.signature;
  if (typeof doc.kind !== "string" || !ID.test(doc.kind) || typeof doc.version !== "string" || !VERSION.test(doc.version)
    || typeof doc.issued_at !== "string" || !RFC3339.test(doc.issued_at) || !isObject(signature) || signature.alg !== "Ed25519"
    || typeof signature.key_id !== "string" || !KEY_ID.test(signature.key_id) || typeof signature.value !== "string" || !SIG.test(signature.value)) {
    return { ok: false, reason: "invalid", message: "the artifact's kind, version, issue time or signature is missing or malformed" };
  }
  const unsigned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(doc)) if (key !== "signature") unsigned[key] = value;
  const verified = verifySignedData(ARTIFACT_SIGNATURE_DOMAIN + canonical(unsigned), doc.issued_at, { key_id: signature.key_id, value: signature.value }, "artifact", options);
  return verified.ok ? { ok: true, kind: doc.kind, version: doc.version } : { ok: false, reason: verified.reason, message: verified.message };
}

/** The artifacts this computer holds, as the index lists them; empty when there is none or it cannot be read. */
export function readArtifactIndex(dir: string): HeldArtifactEntry[] {
  try {
    const doc: unknown = JSON.parse(readFileSync(join(artifactsDir(dir), ARTIFACT_INDEX_FILE), "utf8"));
    if (!isObject(doc) || doc.v !== 1 || !Array.isArray(doc.artifacts)) return [];
    const out: HeldArtifactEntry[] = [];
    for (const item of doc.artifacts as unknown[]) {
      if (!isObject(item) || typeof item.kind !== "string" || !ID.test(item.kind)) continue;
      const { kind, ...rest } = item;
      const ref = refOf(rest);
      if (ref) out.push({ ...ref, kind });
    }
    return out;
  } catch { return []; }
}

function writeArtifactIndex(dir: string, entries: readonly HeldArtifactEntry[], now: Date): void {
  mkdirSync(artifactsDir(dir), { recursive: true });
  writeAtomic(join(artifactsDir(dir), ARTIFACT_INDEX_FILE), `${JSON.stringify({ v: 1, checked_at: now.toISOString(), artifacts: entries })}\n`);
}

/** Fetch one artifact and check it against its ref. */
async function fetchArtifact(ref: ArtifactRef, options: ArtifactSyncOptions): Promise<{ ok: true; text: string; kind: string } | { ok: false; code: string; message: string }> {
  let res: Response;
  try {
    res = await options.fetchImpl(`${options.base}/v1/packs/${encodeURIComponent(ref.id)}@${encodeURIComponent(ref.version)}`, {
      headers: { ...options.headers, accept: "application/json", "x-scopebond-hook-capabilities": SIGNED_ARTIFACTS_CAPABILITY },
      redirect: "error", signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
    });
  } catch (error) { return { ok: false, code: "unreachable", message: `could not reach the workspace (${(error as Error).name})` }; }
  if (res.status === 402) return { ok: false, code: "not_licensed", message: "this computer is not licensed for it" };
  if (res.status !== 200) return { ok: false, code: "not_served", message: `the workspace answered ${res.status}` };
  let text: string;
  try { text = await res.text(); } catch { return { ok: false, code: "unreachable", message: "the artifact could not be read" }; }
  if (sha256(text) !== ref.sha256) return { ok: false, code: "digest_mismatch", message: "the artifact does not match the digest the workspace's signed list names" };
  const checked = checkArtifactText(text, { keys: options.keys, now: options.now });
  if (!checked.ok) return { ok: false, code: checked.reason, message: checked.message };
  if (checked.kind !== ref.id || checked.version !== ref.version) return { ok: false, code: "wrong_ref", message: `the file holds ${checked.kind}@${checked.version}` };
  return { ok: true, text, kind: checked.kind };
}

/** Bring the artifact store in step with a workspace answer (see the header). Never throws. */
export async function syncArtifacts(dir: string, answer: Record<string, unknown>, options: ArtifactSyncOptions): Promise<ArtifactSyncResult> {
  try {
    if (answer.packs === undefined) return { state: "not_named" };
    const signature = checkPacksSignature(answer, {
      workspace: options.workspace, computer: options.computer, lastIssuedAt: options.lastIssuedAt, now: options.now, keys: options.keys, managed: answer.managed !== false,
    });
    if (signature.result !== "verified") return { state: "refused", message: signature.result === "refused" ? signature.message : "the answer's pack list is not signed" };
    const wanted = artifactRefsOf(answer);
    if (!wanted) return { state: "refused", message: "the answer's artifact list is malformed" };
    const now = options.now ?? new Date();
    const held = readArtifactIndex(dir);
    const kept: HeldArtifactEntry[] = [];
    const fetched: string[] = [];
    const failed: ArtifactSyncFailure[] = [];
    for (const ref of wanted) {
      const name = refName(ref);
      const have = held.find((h) => h.id === ref.id);
      if (have && have.version === ref.version && have.sha256 === ref.sha256 && heldBytes(dir, have)) {
        kept.push({ ...ref, kind: have.kind });
        continue;
      }
      const got = await fetchArtifact(ref, options);
      if (got.ok) {
        mkdirSync(artifactsDir(dir), { recursive: true });
        writeAtomic(fileOf(dir, name), got.text);
        kept.push({ ...ref, kind: got.kind });
        fetched.push(name);
        continue;
      }
      // The copy already held of this id stays (an artifact is replaced only by one that checks out), unless the workspace says
      // this computer is not licensed for it.
      const stays = got.code !== "not_licensed" && have && heldBytes(dir, have) ? have : null;
      if (stays) kept.push(stays);
      failed.push({ ref: name, code: got.code, message: got.message, held: stays ? refName(stays) : null });
    }
    writeArtifactIndex(dir, kept, now);
    const removed = removeUnlisted(dir, kept);
    return { state: "synced", artifacts: kept.map(refName), fetched, removed, failed };
  } catch (error) {
    return { state: "refused", message: `the artifacts could not be updated (${(error as Error).message})` };
  }
}

/** A held artifact's bytes when they are still the ones its index entry names; null otherwise. */
function heldBytes(dir: string, entry: ArtifactRef): Buffer | null {
  try {
    const bytes = readFileSync(fileOf(dir, refName(entry)));
    return createHash("sha256").update(bytes).digest("hex") === entry.sha256 ? bytes : null;
  } catch { return null; }
}

/** Remove every artifact file the index does not list. */
function removeUnlisted(dir: string, listed: readonly ArtifactRef[]): string[] {
  const keep = new Set(listed.map((a) => `${refName(a)}.json`));
  const removed: string[] = [];
  let names: string[];
  try { names = readdirSync(artifactsDir(dir)); } catch { return removed; }
  for (const name of names) {
    if (name === ARTIFACT_INDEX_FILE || !name.endsWith(".json") || keep.has(name)) continue;
    try { rmSync(join(artifactsDir(dir), name), { force: true }); removed.push(name.slice(0, -5)); } catch { /* left behind, never handed over */ }
  }
  return removed;
}

/** The artifacts held for a plugin that reads `kinds`: each one's exact bytes (checked against the digest its signed list named),
 *  unread. Empty when there are none, on any error, and for a kind no plugin reads. */
export function heldArtifacts(dir: string, kinds: readonly string[]): HeldArtifact[] {
  const wanted = new Set(kinds);
  const out: HeldArtifact[] = [];
  for (const entry of readArtifactIndex(dir)) {
    if (!wanted.has(entry.kind)) continue;
    const bytes = heldBytes(dir, entry);
    if (bytes) out.push({ kind: entry.kind, id: entry.id, version: entry.version, shadow: entry.shadow === true, bytes: new Uint8Array(bytes) });
  }
  return out;
}
