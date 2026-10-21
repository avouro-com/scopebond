// The engine shim: how the signed install's hook entry (`"<exe>" hook <harness>`) runs a newer engine than the one it
// carries, without a new installer.
//
// The agent stages a signed engine bundle (a single-file build of this hook) under `<home>/engine/<version>/`, checks it,
// and names it in `<home>/engine/current.json`. On each hook call the executable asks `engineToRun`: when current.json
// names a version newer than the engine inside the executable (the baseline), whose manifest is signed by an updater key
// the executable trusts and whose bundle is the one the manifest names, the bundle is loaded from those verified bytes and
// runs the call. Otherwise, or when the bundle fails to start (it throws while loading, or has no `run`), the baseline
// runs the call and the failure is recorded in `<home>/engine/start-failures.log`. A bundle that failed to start twice
// since it became current is not tried again; the agent rolls it back and remembers it as bad.
//
// The executable is the stable shim: a computer with the signed install may have no Node.js, so its hook entry cannot run
// a script file, and entries written by any earlier agent keep working unchanged.
//
// This file is loaded before the engine on every hook call, so it imports only Node's built-ins.

import { createHash, createPublicKey, verify } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { compileFunction, constants as vmConstants } from "node:vm";

/** What the updater key signs for an engine bundle: this domain, then the manifest's exact bytes. */
export const ENGINE_MANIFEST_DOMAIN = "scopebond:hook-bundle/v1\n";
/** The bundle file inside a version folder. */
export const ENGINE_FILE = "scopebond-hook.cjs";
export const ENGINE_MANIFEST = "manifest.json";
export const ENGINE_SIGNATURE = "manifest.json.sig";
export const ENGINE_CURRENT = "current.json";
export const ENGINE_START_FAILURES = "start-failures.log";
/** Set by the agent when it checks a staged bundle before using it: that version runs, from its folder, or the call fails. */
export const ENGINE_CANDIDATE_ENV = "SCOPEBOND_ENGINE_CANDIDATE";
/** Start failures after which a bundle is no longer tried. */
export const MAX_ENGINE_START_FAILURES = 2;
/** The largest bundle file read. */
export const ENGINE_MAX_BYTES = 64 * 1024 * 1024;

/** One trusted updater key, as the signed install carries them: its id (first 16 hex digits of the SHA-256 of its SPKI
 *  bytes), its public half (base64 SPKI) and its last day of use (inclusive), or null. */
export interface EngineKey { kid: string; key: string; not_after: string | null }
export interface EngineManifest {
  type: "scopebond:hook-bundle"; version: string; kid?: string; sha256: string; built_from: string;
  files: Array<{ name: string; sha256: string; size: number }>;
}
/** What current.json says: the version in use, when it became current, and the one before it (null: the baseline). */
export interface CurrentEngine { version: string; at: number; previous: string | null }

const VERSION = /^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,5})$/;
export const isEngineVersion = (v: unknown): v is string => typeof v === "string" && VERSION.test(v);

/** Compare x.y.z versions: negative when a < b. */
export function compareEngineVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** The hook's home, as `userHome()` (install.ts) finds it; repeated here so the shim loads nothing else. */
export function engineHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.SCOPEBOND_HOME ?? join(homedir(), ".scopebond");
}

/** `<home>/engine`: the version folders, current.json and the start-failure log. */
export const engineDir = (home: string): string => join(home, "engine");
/** The folder of one staged version. */
export const engineVersionDir = (home: string, version: string): string => join(engineDir(home), version);

/** current.json, or null when there is none or it is not one this shim reads. */
export function readCurrentEngine(home: string): CurrentEngine | null {
  try {
    const r = JSON.parse(readFileSync(join(engineDir(home), ENGINE_CURRENT), "utf8")) as Record<string, unknown>;
    if (!isEngineVersion(r.version) || typeof r.at !== "number" || !Number.isFinite(r.at)) return null;
    return { version: r.version, at: r.at, previous: isEngineVersion(r.previous) ? r.previous : null };
  } catch { return null; }
}

/** Write current.json through a new file renamed into place, so a hook call never reads half of it. */
export function writeCurrentEngine(home: string, current: CurrentEngine): void {
  mkdirSync(engineDir(home), { recursive: true });
  const file = join(engineDir(home), ENGINE_CURRENT);
  const incoming = `${file}.incoming-${process.pid}`;
  writeFileSync(incoming, `${JSON.stringify(current)}\n`, { mode: 0o600 });
  renameSync(incoming, file);
}

/** Record that `version` failed to start (one line, appended: hook calls run side by side). Never throws. */
export function recordEngineStartFailure(home: string, version: string, error: unknown, now = Date.now()): void {
  try {
    mkdirSync(engineDir(home), { recursive: true });
    const message = String((error as Error | null)?.message ?? error).slice(0, 300);
    appendFileSync(join(engineDir(home), ENGINE_START_FAILURES), `${JSON.stringify({ version, at: now, error: message })}\n`, { mode: 0o600 });
  } catch { /* the baseline runs either way */ }
}

/** How many start failures of `version` were recorded at or after `since`. */
export function engineStartFailures(home: string, version: string, since: number): number {
  let text: string;
  try { text = readFileSync(join(engineDir(home), ENGINE_START_FAILURES), "utf8"); } catch { return 0; }
  let count = 0;
  for (const line of text.split("\n").slice(-1000)) {
    try {
      const r = JSON.parse(line) as { version?: unknown; at?: unknown };
      if (r.version === version && typeof r.at === "number" && r.at >= since) count += 1;
    } catch { /* a line cut short */ }
  }
  return count;
}

/** Whether a key may still sign at `now`: no last day, or `now` is on or before it. An unreadable date counts as past. */
function inDate(key: EngineKey, now: number): boolean {
  if (key.not_after === null) return true;
  const end = /^\d{4}-\d{2}-\d{2}$/.test(key.not_after) ? Date.parse(`${key.not_after}T23:59:59.999Z`) : Date.parse(key.not_after);
  return Number.isFinite(end) && now <= end;
}

/** The manifest when `signatureB64` is a trusted, in-date updater key's signature over the domain and exactly these bytes
 *  (with the key the manifest names, when it names one), and the manifest has the bundle's shape; else null. */
export function verifyEngineManifest(text: string, signatureB64: string, keys: readonly EngineKey[], now = Date.now()): EngineManifest | null {
  try {
    const parsed = JSON.parse(text) as EngineManifest;
    const named = typeof parsed?.kid === "string" ? parsed.kid : null;
    const candidates = keys.filter((k) => inDate(k, now) && (named === null || k.kid === named));
    if (!candidates.length) return null;
    const message = Buffer.from(ENGINE_MANIFEST_DOMAIN + text, "utf8");
    const signature = Buffer.from(signatureB64.trim(), "base64");
    const signed = candidates.some((k) => {
      try { return verify(null, message, createPublicKey({ key: Buffer.from(k.key, "base64"), format: "der", type: "spki" }), signature); } catch { return false; }
    });
    if (!signed) return null;
    if (parsed.type !== "scopebond:hook-bundle" || !isEngineVersion(parsed.version) || typeof parsed.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(parsed.sha256)) return null;
    if (!Array.isArray(parsed.files) || !parsed.files.some((f) => f?.name === ENGINE_FILE)) return null;
    for (const f of parsed.files) {
      if (typeof f?.name !== "string" || !/^[A-Za-z0-9._-]{1,100}$/.test(f.name) || f.name.startsWith(".") || typeof f.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(f.sha256) || !Number.isSafeInteger(f.size) || f.size < 0) return null;
    }
    return parsed;
  } catch { return null; }
}

export type StagedEngine = { ok: true; manifest: EngineManifest; bytes: Buffer; file: string } | { ok: false; reason: string };

/** Check a staged version folder: its manifest is signed by a trusted key and names this version, and the bundle file is
 *  the one the manifest names (size and SHA-256). Returns the bundle's bytes, read once, for loading. */
export function checkStagedEngine(home: string, version: string, keys: readonly EngineKey[], now = Date.now()): StagedEngine {
  if (!isEngineVersion(version)) return { ok: false, reason: "not a version" };
  const folder = engineVersionDir(home, version);
  let text: string, signature: string;
  try { text = readFileSync(join(folder, ENGINE_MANIFEST), "utf8"); signature = readFileSync(join(folder, ENGINE_SIGNATURE), "utf8"); }
  catch { return { ok: false, reason: "the bundle's manifest is missing" }; }
  const manifest = verifyEngineManifest(text, signature, keys, now);
  if (!manifest) return { ok: false, reason: "the bundle's manifest is not signed by a trusted updater key" };
  if (manifest.version !== version) return { ok: false, reason: `the manifest is for ${manifest.version}, not ${version}` };
  const entry = manifest.files.find((f) => f.name === ENGINE_FILE)!;
  const file = join(folder, ENGINE_FILE);
  let bytes: Buffer;
  try { bytes = readFileSync(file); } catch { return { ok: false, reason: "the bundle file is missing" }; }
  if (bytes.length > ENGINE_MAX_BYTES || bytes.length !== entry.size || createHash("sha256").update(bytes).digest("hex") !== entry.sha256) {
    return { ok: false, reason: "the bundle file is not the one its manifest names" };
  }
  return { ok: true, manifest, bytes, file };
}

/** A loaded engine: its version, and the call that runs one hook command line (the bundle installs its own deadline and
 *  fail-closed answer, as cli.js does). */
export interface LoadedEngine { version: string; run(args: string[]): Promise<void> }

/** Evaluate a bundle (CommonJS) from bytes already checked, never from the file again. `require` resolves Node's built-ins
 *  (the bundle carries everything else), and `import()` inside it uses Node's default loader. Throws when it fails to start. */
export function compileEngine(bytes: Buffer, file: string): { run(args: string[]): Promise<void> } {
  const wrapper = compileFunction(bytes.toString("utf8"), ["exports", "require", "module", "__filename", "__dirname"], {
    filename: file, importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
  }) as (exports: unknown, require: NodeJS.Require, module: { exports: Record<string, unknown> }, filename: string, dirname: string) => void;
  const module: { exports: Record<string, unknown> } = { exports: {} };
  wrapper.call(module.exports, module.exports, createRequire(file), module, file, dirname(file));
  const run = module.exports.run;
  if (typeof run !== "function") throw new Error("the engine bundle has no run()");
  return { run: (args) => Promise.resolve((run as (a: string[]) => unknown)(args)).then(() => undefined) };
}

/** The engine this hook call should run instead of the baseline, or null for the baseline. Never throws for the engine in
 *  current.json (a failure is recorded and the baseline runs); for a candidate (ENGINE_CANDIDATE_ENV) it throws instead, so
 *  the check that asked for it fails rather than passing on the baseline. */
export function engineToRun(o: { home?: string; keys: readonly EngineKey[]; baselineVersion: string; env?: NodeJS.ProcessEnv; now?: number }): LoadedEngine | null {
  const env = o.env ?? process.env;
  const home = o.home ?? engineHome(env);
  const now = o.now ?? Date.now();
  const candidate = env[ENGINE_CANDIDATE_ENV];
  if (candidate !== undefined && candidate !== "") {
    const staged = checkStagedEngine(home, candidate, o.keys, now);
    if (!staged.ok) throw new Error(`the candidate engine ${candidate} cannot be used: ${staged.reason}`);
    try { return { version: candidate, ...compileEngine(staged.bytes, staged.file) }; }
    catch (error) { throw new Error(`the candidate engine ${candidate} failed to start: ${(error as Error).message}`, { cause: error }); }
  }
  const current = readCurrentEngine(home);
  if (!current || !isEngineVersion(o.baselineVersion) || compareEngineVersions(current.version, o.baselineVersion) <= 0) return null;
  if (engineStartFailures(home, current.version, current.at) >= MAX_ENGINE_START_FAILURES) return null;
  const staged = checkStagedEngine(home, current.version, o.keys, now);
  if (!staged.ok) { recordEngineStartFailure(home, current.version, staged.reason, now); return null; }
  try { return { version: current.version, ...compileEngine(staged.bytes, staged.file) }; }
  catch (error) { recordEngineStartFailure(home, current.version, error, now); return null; }
}

/** The updater keys the single executable was built with (its `__SCOPEBOND_UPDATER_KEYS__` text), or none. */
export function engineKeysFrom(text: string | undefined): EngineKey[] {
  if (typeof text !== "string" || !text) return [];
  try {
    const list = JSON.parse(text) as unknown;
    if (!Array.isArray(list)) return [];
    return list.flatMap((k): EngineKey[] => {
      const e = k as Partial<EngineKey>;
      if (!e || typeof e.key !== "string" || !e.key) return [];
      const kid = typeof e.kid === "string" && e.kid ? e.kid : createHash("sha256").update(Buffer.from(e.key, "base64")).digest("hex").slice(0, 16);
      return [{ kid, key: e.key, not_after: typeof e.not_after === "string" ? e.not_after : null }];
    });
  } catch { return []; }
}

/** Whether `<home>/engine/<version>` exists (for the agent's housekeeping). */
export const engineStaged = (home: string, version: string): boolean => isEngineVersion(version) && existsSync(join(engineVersionDir(home, version), ENGINE_FILE));
