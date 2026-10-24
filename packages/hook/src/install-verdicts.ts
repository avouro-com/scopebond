// Safe Install: before a detected install runs, ask the connected workspace for a verdict on it, inside the hook's deadline.
//
// What is asked about: each `software.install` intent the mapper derived (typed-install.ts) that names a registry package
// (npm, pypi, cargo, go, rubygems) or a script or program fetched from a named site. A clone, a container, an install from a
// manifest with no name, or a Homebrew formula is not asked about.
//
// When: only while this folder is connected to a workspace AND holds a valid signed block list from it (below). The workspace
// offers the check on its rules answers (`x-scopebond-safe-install: 1`) and gives the list only to a computer it licenses for
// it, so the list is also the switch: no list, no check, and every install is decided exactly as it was before.
//
// The answer (POST /v1/install/verdict) gives each install a verdict, `block`, `ask` or `allow`, with reason codes and the same
// reasons in plain words:
//   block  the call is denied, saying what was blocked and why.
//   ask    the coding agent's own prompt asks the person (Claude Code in a mode that prompts, Cursor, GitHub Copilot); an agent
//          that cannot ask (Codex, or Claude Code in a mode that never prompts) is denied with the reason and how to go ahead.
//   allow  the install goes on to the ordinary rules.
// The verdict, its reason codes and where it came from are added to the install's intent (`verdict`, `verdict_reasons`,
// `verdict_source`), so they are signed into its receipt. Names, versions and hosts only: never file contents or secrets.
//
// Offline, or when the workspace does not answer in time (or refuses the computer):
//   - the block list (`install-blocklist.json`, `scopebond:install-blocklist/v1`, signed with a policy-signing key this release
//     pins, kept for 30 days after the last successful check) blocks what it names;
//   - answers kept from earlier (`install-verdicts.json`) apply: a block stays a block, and the age gate holds a package
//     published less than 7 days ago to "ask";
//   - anything else is asked about.
// This module carries no list of packages or sites of its own: what is malicious or risky comes from the workspace.

import { createHash, verify } from "node:crypto";
import { closeSync, constants as fsConstants, fstatSync, openSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { canonical } from "@scopebond/gateway";
import type { Mapped } from "./map.js";
import { writeAtomic } from "./managed.js";
import { trimEndChars } from "./text.js";
import { policyKeys, publicKeyFrom, type PolicyKey } from "./policy-keys.js";

export const INSTALL_BLOCKLIST_FILE = "install-blocklist.json";
export const INSTALL_STATE_FILE = "install-state.json";
export const INSTALL_VERDICTS_FILE = "install-verdicts.json";
export const BLOCKLIST_FORMAT = "scopebond:install-blocklist/v1";
/** The header a workspace's rules answer carries ("1") when it offers this computer Safe Install. */
export const SAFE_INSTALL_HEADER = "x-scopebond-safe-install";
/** The block list stays usable this long after the last successful check with the workspace. */
export const BLOCKLIST_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** How often a rules check also checks the block list. */
export const BLOCKLIST_CHECK_MS = 6 * 60 * 60 * 1000;
/** The longest a hook call waits for verdicts (`SCOPEBOND_INSTALL_VERDICT_MS` can only shorten it). */
export const VERDICT_TIMEOUT_MS = 2_000;
/** A package published less than this long ago is asked about when the workspace cannot be reached. */
export const AGE_GATE_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_BLOCKLIST_BYTES = 8 * 1024 * 1024;
const MAX_BLOCKLIST_ENTRIES = 50_000;
const MAX_CACHED = 2_000;
const FUTURE_SKEW_MS = 60 * 60 * 1000;
const PACKAGE_ECOSYSTEMS = new Set(["npm", "pypi", "cargo", "go", "rubygems"]);
const SITE_ECOSYSTEMS = new Set(["script", "binary"]);
const NOT_ASKED_ROUTES = new Set(["git_clone", "git_clone_run", "docker_pull", "docker_run"]);
const VERDICT_FIELD = /^(?:block|ask|allow)$/;
const CODE = /^[a-z][a-z0-9_]{0,39}$/;

export type InstallVerdict = "block" | "ask" | "allow";
export type VerdictSource = "cloud" | "cache" | "blocklist" | "offline";
export interface VerdictReason { code: string; text: string }
/** What one install was given, as the runtime decides it (not part of the signed intent; the intent carries the codes). */
export interface InstallCheck { verdict: InstallVerdict; reasons: VerdictReason[]; source: VerdictSource; message: string }

type BlockEntry = [string, string, "*" | string[]];
interface Blocklist { issued_at: string; entries: Map<string, "*" | Set<string>> }

// ---- names ----------------------------------------------------------------------------------------------------------------

/** A name as its registry compares names: PyPI's normalised (lower case, runs of `-`, `_` and `.` as one `-`), npm's and
 *  crates.io's lower case, others as written. */
export function comparableName(ecosystem: string, name: string): string {
  const n = name.trim();
  if (ecosystem === "pypi") return n.toLowerCase().replace(/[-_.]+/g, "-");
  if (ecosystem === "npm" || ecosystem === "cargo") return n.toLowerCase();
  return n;
}
const keyOf = (ecosystem: string, name: string): string => `${ecosystem}:${comparableName(ecosystem, name)}`;
const exactVersion = (v: unknown): string | null =>
  typeof v === "string" && /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/.test(v) && !/^(?:latest|next)$/i.test(v) ? v : null;
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const cacheKeyOf = (p: Record<string, unknown>): string => `${keyOf(str(p.ecosystem), str(p.name) || str(p.source_domain))}@${exactVersion(p.version) ?? ""}`;

/** Whether an install intent is one Safe Install asks about. */
export function checkable(m: Mapped): boolean {
  if (m.intent.action_type !== "software.install") return false;
  const p = m.intent.params;
  if (NOT_ASKED_ROUTES.has(String(p.route))) return false;
  const eco = String(p.ecosystem);
  if (PACKAGE_ECOSYSTEMS.has(eco)) return typeof p.name === "string" && p.name !== "";
  return SITE_ECOSYSTEMS.has(eco) && typeof p.source_domain === "string" && p.source_domain !== "";
}

// ---- files ----------------------------------------------------------------------------------------------------------------

function readBounded(file: string, max: number): string | null {
  let fd: number;
  try { fd = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0)); } catch { return null; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > max) return null;
    return readFileSync(fd, "utf8");
  } catch { return null; } finally { closeSync(fd); }
}
interface InstallState { v: 1; checked_at: string; sha256: string | null }
function readState(dir: string): InstallState | null {
  try {
    const s = JSON.parse(readBounded(join(dir, INSTALL_STATE_FILE), 4096) ?? "null") as InstallState | null;
    return s && s.v === 1 && typeof s.checked_at === "string" && Number.isFinite(Date.parse(s.checked_at)) ? s : null;
  } catch { return null; }
}

// ---- the block list -------------------------------------------------------------------------------------------------------

export type BlocklistCheck = { ok: true; list: Blocklist } | { ok: false; message: string };

/** Check a block list document from text: its exact shape, then its signature with a key this release trusts (whose window holds
 *  both its issue time and now). Pure apart from reading the pinned keys (`keys` overrides). */
export function checkBlocklistText(text: string, options: { keys?: readonly PolicyKey[]; now?: number } = {}): BlocklistCheck {
  const now = options.now ?? Date.now();
  if (Buffer.byteLength(text, "utf8") > MAX_BLOCKLIST_BYTES) return { ok: false, message: "the block list is too large" };
  let doc: Record<string, unknown>;
  try { doc = JSON.parse(text) as Record<string, unknown>; } catch { return { ok: false, message: "the block list is not JSON" }; }
  if (!doc || typeof doc !== "object" || Array.isArray(doc) || Object.keys(doc).some((k) => !["format", "issued_at", "entries", "signature"].includes(k))) return { ok: false, message: "the block list is not the documented shape" };
  if (doc.format !== BLOCKLIST_FORMAT || typeof doc.issued_at !== "string" || !Array.isArray(doc.entries) || doc.entries.length > MAX_BLOCKLIST_ENTRIES) return { ok: false, message: "the block list is not the documented shape" };
  const sig = doc.signature as Record<string, unknown> | null;
  if (!sig || typeof sig !== "object" || sig.alg !== "Ed25519" || typeof sig.key_id !== "string" || typeof sig.value !== "string") return { ok: false, message: "the block list is not signed" };
  const issued = Date.parse(doc.issued_at);
  if (!Number.isFinite(issued) || issued > now + FUTURE_SKEW_MS) return { ok: false, message: "the block list's issue time is not valid" };
  const key = (options.keys ?? policyKeys()).find((k) => k.key_id === sig.key_id);
  if (!key) return { ok: false, message: `the block list names a signing key this version does not trust (${String(sig.key_id).slice(0, 64)})` };
  const from = Date.parse(key.not_before);
  const to = Date.parse(key.not_after);
  if (!(issued >= from && issued <= to && now >= from && now <= to)) return { ok: false, message: `signing key ${key.key_id} is not valid for the block list` };
  const publicKey = publicKeyFrom(key.public_key);
  if (!publicKey) return { ok: false, message: `signing key ${key.key_id} could not be read` };
  const unsigned = { format: doc.format, issued_at: doc.issued_at, entries: doc.entries };
  let good: boolean;
  try { good = verify(null, Buffer.from(`${BLOCKLIST_FORMAT}\n${canonical(unsigned as never)}`, "utf8"), publicKey, Buffer.from(sig.value, "base64")); } catch { good = false; }
  if (!good) return { ok: false, message: "the block list's signature does not verify; it was changed, damaged or not issued by your workspace" };
  const entries = new Map<string, "*" | Set<string>>();
  for (const raw of doc.entries as unknown[]) {
    const e = raw as BlockEntry;
    if (!Array.isArray(e) || e.length !== 3 || typeof e[0] !== "string" || typeof e[1] !== "string" || !(e[2] === "*" || (Array.isArray(e[2]) && e[2].every((v) => typeof v === "string")))) {
      return { ok: false, message: "the block list has a malformed entry" };
    }
    const key2 = keyOf(e[0], e[1]);
    const had = entries.get(key2);
    if (e[2] === "*" || had === "*") entries.set(key2, "*");
    else entries.set(key2, new Set([...(had ?? []), ...e[2]]));
  }
  return { ok: true, list: { issued_at: doc.issued_at, entries } };
}

/** The block list this folder may use now, or null: none held, not valid, or not checked with the workspace for 30 days. */
export function loadBlocklist(dir: string, options: { keys?: readonly PolicyKey[]; now?: number } = {}): Blocklist | null {
  const now = options.now ?? Date.now();
  const state = readState(dir);
  if (!state || now - Date.parse(state.checked_at) > BLOCKLIST_TTL_MS || Date.parse(state.checked_at) > now + FUTURE_SKEW_MS) return null;
  const text = readBounded(join(dir, INSTALL_BLOCKLIST_FILE), MAX_BLOCKLIST_BYTES);
  if (text === null) return null;
  const checked = checkBlocklistText(text, options);
  return checked.ok ? checked.list : null;
}

/** Whether Safe Install is on in this folder: it holds a usable block list from its workspace. */
export const safeInstallOn = (dir: string, options: { keys?: readonly PolicyKey[]; now?: number } = {}): boolean => loadBlocklist(dir, options) !== null;

export interface BlocklistSyncOptions {
  base: string;
  headers: Record<string, string>;
  fetchImpl: typeof fetch;
  now?: number;
  timeoutMs?: number;
  keys?: readonly PolicyKey[];
  /** Check even when the last check was less than six hours ago. */
  force?: boolean;
}
export type BlocklistSyncResult = "not_due" | "updated" | "unchanged" | "removed" | "kept";

/** Bring the block list in step with the workspace (GET /v1/install/blocklist), at most every six hours: 200 with a list that
 *  verifies replaces it; 304 renews it; 402 (not licensed) or 404 (the workspace offers none) removes it, which turns the check
 *  off; anything else keeps what is held until it expires. Never throws. */
export async function syncInstallBlocklist(dir: string, options: BlocklistSyncOptions): Promise<BlocklistSyncResult> {
  const now = options.now ?? Date.now();
  try {
    const state = readState(dir);
    if (!options.force && state && now - Date.parse(state.checked_at) < BLOCKLIST_CHECK_MS) return "not_due";
    const held = readBounded(join(dir, INSTALL_BLOCKLIST_FILE), MAX_BLOCKLIST_BYTES) !== null;
    const res = await options.fetchImpl(`${options.base}/v1/install/blocklist`, {
      headers: { ...options.headers, accept: "application/json", ...(held && state?.sha256 ? { "if-none-match": `"${state.sha256}"` } : {}) },
      redirect: "error", signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
    });
    if (res.status === 304 && held && state) { await res.body?.cancel(); writeState(dir, { v: 1, checked_at: new Date(now).toISOString(), sha256: state.sha256 }); return "unchanged"; }
    if (res.status === 402 || res.status === 404) { await res.body?.cancel(); removeBlocklist(dir); return "removed"; }
    if (res.status !== 200) { await res.body?.cancel(); return "kept"; }
    const text = await res.text();
    const checked = checkBlocklistText(text, { keys: options.keys, now });
    if (!checked.ok) return "kept";
    writeAtomic(join(dir, INSTALL_BLOCKLIST_FILE), text);
    const digest = createHash("sha256").update(text, "utf8").digest("hex");
    writeState(dir, { v: 1, checked_at: new Date(now).toISOString(), sha256: digest });
    return "updated";
  } catch { return "kept"; }
}
function writeState(dir: string, state: InstallState): void { writeAtomic(join(dir, INSTALL_STATE_FILE), `${JSON.stringify(state)}\n`); }
/** Remove the block list (the computer is not licensed for the check, or left the workspace): Safe Install is off here. */
export function removeBlocklist(dir: string): void {
  for (const f of [INSTALL_BLOCKLIST_FILE, INSTALL_STATE_FILE]) { try { rmSync(join(dir, f), { force: true }); } catch { /* never read without its state */ } }
}

// ---- answers kept from earlier ------------------------------------------------------------------------------------------------

interface Kept { verdict: InstallVerdict; codes: string[]; texts: string[]; published_at: string | null; at: string }
function readKept(dir: string): Record<string, Kept> {
  try {
    const doc = JSON.parse(readBounded(join(dir, INSTALL_VERDICTS_FILE), 2 * 1024 * 1024) ?? "null") as { v?: number; items?: Record<string, Kept> } | null;
    return doc?.v === 1 && doc.items && typeof doc.items === "object" ? doc.items : {};
  } catch { return {}; }
}
function keep(dir: string, add: Record<string, Kept>): void {
  try {
    const items = { ...readKept(dir), ...add };
    const newest = Object.entries(items).sort((a, b) => (a[1].at < b[1].at ? 1 : -1)).slice(0, MAX_CACHED);
    writeAtomic(join(dir, INSTALL_VERDICTS_FILE), `${JSON.stringify({ v: 1, items: Object.fromEntries(newest) })}\n`);
  } catch { /* the receipt is the record; this is a convenience for offline calls */ }
}

// ---- deciding ---------------------------------------------------------------------------------------------------------------

const ECOSYSTEM_LABEL: Readonly<Record<string, string>> = { npm: "npm", pypi: "PyPI", cargo: "crates.io", go: "Go", rubygems: "RubyGems", script: "script", binary: "download" };
const what = (p: Record<string, unknown>): string => {
  const eco = String(p.ecosystem);
  if (SITE_ECOSYSTEMS.has(eco)) return `a ${eco === "script" ? "script" : "program"} from ${String(p.source_domain)}`;
  return `${String(p.name)}${typeof p.version === "string" ? ` ${p.version}` : ""} (${ECOSYSTEM_LABEL[eco] ?? eco})`;
};
const clean = (text: string, max = 300): string => [...text].filter((ch) => ch.charCodeAt(0) >= 0x20).join("").replace(/\s+/g, " ").trim().slice(0, max);

/** The plain message for one install's verdict. */
function messageFor(p: Record<string, unknown>, verdict: InstallVerdict, reasons: readonly VerdictReason[], ask: "ask" | "deny"): string {
  const why = reasons.map((r) => r.text).filter(Boolean).slice(0, 3).join(" ");
  if (verdict === "block") return `Scopebond Safe Install blocked installing ${what(p)}. ${why}`.trim();
  if (ask === "ask") return `Scopebond Safe Install: check before installing ${what(p)}. ${why} Allow it only if you meant to install it.`.replace(/\s+/g, " ").trim();
  return `Scopebond Safe Install stopped installing ${what(p)} to check with you first. ${why} If you meant to install it, run the install yourself in your own terminal, then go on.`.replace(/\s+/g, " ").trim();
}

function offline(p: Record<string, unknown>, list: Blocklist | null, kept: Record<string, Kept>, now: number, why: string): { verdict: InstallVerdict; reasons: VerdictReason[]; source: VerdictSource } {
  const eco = String(p.ecosystem);
  const name = typeof p.name === "string" ? p.name : null;
  const version = exactVersion(p.version);
  if (name && list) {
    const hit = list.entries.get(keyOf(eco, name));
    if (hit === "*" || (hit && version && hit.has(version))) {
      return { verdict: "block", source: "blocklist", reasons: [{ code: "malicious", text: `${name} is on your workspace's list of known malware (the copy on this computer).` }] };
    }
  }
  const before = kept[cacheKeyOf(p)];
  if (before) {
    if (before.verdict === "block") return { verdict: "block", source: "cache", reasons: before.codes.map((code, i) => ({ code, text: before.texts[i] ?? "" })) };
    const published = before.published_at ? Date.parse(before.published_at) : NaN;
    if (Number.isFinite(published) && now - published < AGE_GATE_MS) {
      return { verdict: "ask", source: "cache", reasons: [{ code: "new_package", text: `It was published less than 7 days ago, and ${why}.` }] };
    }
    if (before.verdict === "allow" && (Number.isFinite(published) || now - Date.parse(before.at) < 7 * DAY_MS)) {
      return { verdict: "allow", source: "cache", reasons: before.codes.map((code, i) => ({ code, text: before.texts[i] ?? "" })) };
    }
    return { verdict: "ask", source: "cache", reasons: before.codes.map((code, i) => ({ code, text: before.texts[i] ?? "" })) };
  }
  return { verdict: "ask", source: "offline", reasons: [{ code: "offline_unknown", text: `Scopebond could not check it: ${why}.` }] };
}

export interface CheckOptions {
  /** The workspace connection (cloud.json): `url` and `credential`. */
  connection: { url: string; credential: string } | null;
  fetchImpl?: typeof fetch;
  /** How the host handles "ask": its own prompt, or none (then "ask" is a deny with how to go ahead). */
  ask: "ask" | "deny";
  timeoutMs?: number;
  now?: number;
  keys?: readonly PolicyKey[];
  /** Extra headers on the request (the hook version). */
  headers?: Record<string, string>;
}

/** Ask for verdicts on the installs a call would run, and return the call's intents with each verdict added to its install
 *  intent (`verdict`, `verdict_reasons`, `verdict_source`) and `install` set for the runtime. Unchanged when the call installs
 *  nothing Safe Install asks about, or Safe Install is off here. Never throws. */
export async function checkInstalls(dir: string, mapped: Mapped[], options: CheckOptions): Promise<Mapped[]> {
  const at = mapped.map((m, i) => (checkable(m) ? i : -1)).filter((i) => i >= 0);
  if (!at.length || !options.connection) return mapped;
  const now = options.now ?? Date.now();
  let list: Blocklist | null;
  try { list = loadBlocklist(dir, { keys: options.keys, now }); } catch { list = null; }
  if (!list) return mapped;
  const installs = at.map((i) => mapped[i].intent.params);
  const answers = await askWorkspace(options, installs).catch((): { ok: false; why: string } => ({ ok: false, why: "the workspace could not be reached" }));
  const kept = readKept(dir);
  const add: Record<string, Kept> = {};
  const out = mapped.slice();
  at.forEach((index, n) => {
    const p = mapped[index].intent.params;
    const got = answers.ok ? answers.verdicts[n] : null;
    const result = got ? { verdict: got.verdict, reasons: got.reasons, source: "cloud" as const } : offline(p, list, kept, now, answers.ok ? "the workspace gave no answer for it" : answers.why);
    if (got) add[cacheKeyOf(p)] = { verdict: got.verdict, codes: got.reasons.map((r) => r.code), texts: got.reasons.map((r) => r.text), published_at: got.published_at, at: new Date(now).toISOString() };
    const check: InstallCheck = { ...result, message: messageFor(p, result.verdict, result.reasons, options.ask) };
    out[index] = {
      ...mapped[index],
      intent: { ...mapped[index].intent, params: { ...p, verdict: result.verdict, verdict_reasons: result.reasons.map((r) => r.code), verdict_source: result.source } },
      install: check,
    };
  });
  if (Object.keys(add).length) keep(dir, add);
  return out;
}

type Answered = { ok: true; verdicts: Array<{ verdict: InstallVerdict; reasons: VerdictReason[]; published_at: string | null } | null> } | { ok: false; why: string };

async function askWorkspace(options: CheckOptions, installs: Array<Record<string, unknown>>): Promise<Answered> {
  const env = Number(process.env.SCOPEBOND_INSTALL_VERDICT_MS);
  const timeout = Math.max(100, Math.min(options.timeoutMs ?? VERDICT_TIMEOUT_MS, Number.isFinite(env) && env > 0 ? env : Infinity));
  const fetchImpl = options.fetchImpl ?? fetch;
  const body = { installs: installs.slice(0, 20).map((p) => {
    const pick: Record<string, unknown> = {};
    for (const k of ["route", "ecosystem", "verb", "name", "version", "source_domain", "source_url"]) if (typeof p[k] === "string") pick[k] = p[k];
    return pick;
  }) };
  let res: Response;
  // A timer that holds the process open (AbortSignal.timeout's does not), so a call whose workspace never answers still ends
  // with an answer at the timeout, never with nothing.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(Object.assign(new Error("the verdict request timed out"), { name: "TimeoutError" })), timeout);
  try {
    res = await fetchImpl(`${trimEndChars(options.connection!.url, "/")}/v1/install/verdict`, {
      method: "POST", redirect: "error", signal: controller.signal, body: JSON.stringify(body),
      headers: { ...(options.headers ?? {}), authorization: `Bearer ${options.connection!.credential}`, "content-type": "application/json", accept: "application/json", "x-scopebond-deadline-ms": String(timeout) },
    });
  } catch (error) {
    clearTimeout(timer);
    return { ok: false, why: controller.signal.aborted || (error as Error)?.name === "TimeoutError" || (error as Error)?.name === "AbortError" ? "the workspace did not answer in time" : "the workspace could not be reached" };
  }
  try {
    if (res.status === 402) { await res.body?.cancel(); return { ok: false, why: "this computer is not licensed for Safe Install in its workspace" }; }
    if (res.status !== 200) { await res.body?.cancel(); return { ok: false, why: `the workspace answered ${res.status}` }; }
    let doc: unknown;
    try { doc = await res.json(); } catch { return { ok: false, why: "the workspace's answer could not be read" }; }
    const verdicts = (doc as { verdicts?: unknown } | null)?.verdicts;
    if (!Array.isArray(verdicts)) return { ok: false, why: "the workspace's answer could not be read" };
    const byIndex = new Map<number, { verdict: InstallVerdict; reasons: VerdictReason[]; published_at: string | null }>();
    for (const v of verdicts as Array<Record<string, unknown>>) {
      if (!v || typeof v !== "object" || !Number.isInteger(v.index) || typeof v.verdict !== "string" || !VERDICT_FIELD.test(v.verdict) || !Array.isArray(v.reasons)) continue;
      const reasons = (v.reasons as Array<Record<string, unknown>>).filter((r) => r && typeof r.code === "string" && CODE.test(r.code) && typeof r.text === "string")
        .slice(0, 10).map((r) => ({ code: r.code as string, text: clean(r.text as string) }));
      const published = typeof v.published_at === "string" && Number.isFinite(Date.parse(v.published_at)) ? v.published_at : null;
      byIndex.set(v.index as number, { verdict: v.verdict as InstallVerdict, reasons, published_at: published });
    }
    return { ok: true, verdicts: installs.map((_p, i) => byIndex.get(i) ?? null) };
  } catch {
    return { ok: false, why: "the workspace did not answer in time" };
  } finally {
    clearTimeout(timer);
  }
}
