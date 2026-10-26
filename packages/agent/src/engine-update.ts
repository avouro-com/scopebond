// Engine updates without an installer, for the signed install (per user and for every user). The workspace's answer to
// /v1/client-version may name `hook_bundle: { version, url, sha256, signature }`: a newer engine (the hook as one file,
// built and published with each signed release). The agent takes it only when every check passes:
//
//   - the manifest beside the archive (`<archive>.manifest.json`, `.sig`) is signed by an updater key this executable trusts
//     (the same keys and domain rules as the release manifest), names this version, and the archive's SHA-256 is the
//     manifest's (and the workspace's, when it names one);
//   - the version is newer than the engine in use: newer than the one inside the executable (the baseline), and never older
//     than a bundle already in use (going back happens only by rolling back);
//   - the archive unpacks into exactly the files the manifest names, each of its size and SHA-256;
//   - the new engine, run from its folder, passes the vectors of every rule pack in force (`packs test --all`), and runs at
//     least as many of those packs as the engine in use.
//
// Then it is staged under `<home>/engine/<version>/` and named in `<home>/engine/current.json`, which the executable reads
// on each hook call (engine-shim.ts in the hook, which checks the signature and digest again before every load). A bundle
// that fails its vectors is removed and remembered as bad; one that failed to start twice since it became current is rolled
// back (to the bundle before it, else to the baseline) and remembered as bad. A bad bundle is never taken again.
//
// For every user (Program Files), the bundle goes to the Scopebond folder of the user the agent runs for, like the rest
// of that user's data; the signed executable verifies it on every load, so a file put there by anyone else is not run.
// npm installs take none: npm brings their hook.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkStagedEngine, compareEngineVersions, engineDir, engineStartFailures, engineVersionDir, hookVersion, isEngineVersion, isSingleExecutable, loadPacks,
  readCurrentEngine, verifyEngineManifest, writeCurrentEngine, ENGINE_CANDIDATE_ENV, ENGINE_FILE, ENGINE_MANIFEST, ENGINE_SIGNATURE, MAX_ENGINE_START_FAILURES,
  settingsEnv, SETTING_FLAG, type CurrentEngine, type EngineKey,
} from "@scopebond/hook";
import { unpackTgz } from "./tgz.js";
import { updaterKeys, type InstallKind, type UpdaterKey } from "./native-update.js";

/** The bundle a workspace names. `signature`, when given, must be the manifest's own signature. */
export interface HookBundleTarget { version: string; url: string; sha256: string | null; signature: string | null }

/** The largest archive and manifest the agent downloads. */
export const ENGINE_ARCHIVE_MAX_BYTES = 32 * 1024 * 1024;
const MANIFEST_MAX_BYTES = 64 * 1024;
/** Where bundles that must not be used again are listed. */
export const BAD_ENGINES_FILE = "bad.json";
const HEX64 = /^[0-9a-f]{64}$/;

/** The `hook_bundle` of an answer, or null when it is absent or not usable (an answer's other fields still count). */
export function readHookBundleTarget(value: unknown): HookBundleTarget | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!isEngineVersion(v.version) || typeof v.url !== "string" || v.url.length > 2048) return null;
  try { new URL(v.url); } catch { return null; }
  const sha256 = v.sha256 === undefined || v.sha256 === null ? null : typeof v.sha256 === "string" && HEX64.test(v.sha256) ? v.sha256 : undefined;
  const signature = v.signature === undefined || v.signature === null ? null : typeof v.signature === "string" && v.signature.length <= 200 ? v.signature : undefined;
  if (sha256 === undefined || signature === undefined) return null;
  return { version: v.version, url: v.url, sha256, signature };
}

/** Whether the agent fetches from this address: https, or a test server on this computer. */
function fetchableUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || (u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]"));
  } catch { return false; }
}

/** The bundles never to use again here, by version: when and why. */
export function badEngines(dir: string): Record<string, { at: number; reason: string }> {
  try {
    const r = JSON.parse(readFileSync(join(engineDir(dir), BAD_ENGINES_FILE), "utf8")) as Record<string, { at?: unknown; reason?: unknown }>;
    const out: Record<string, { at: number; reason: string }> = {};
    for (const [version, entry] of Object.entries(r)) if (isEngineVersion(version) && typeof entry?.at === "number") out[version] = { at: entry.at, reason: typeof entry.reason === "string" ? entry.reason : "" };
    return out;
  } catch { return {}; }
}

function rememberBad(dir: string, version: string, reason: string, now: number): void {
  const bad = badEngines(dir);
  bad[version] = { at: now, reason: reason.slice(0, 300) };
  try { mkdirSync(engineDir(dir), { recursive: true }); writeFileSync(join(engineDir(dir), BAD_ENGINES_FILE), `${JSON.stringify(bad)}\n`, { mode: 0o600 }); } catch { /* best effort */ }
}

const engineKeys = (keys: readonly UpdaterKey[]): EngineKey[] => keys.map((k) => ({ kid: k.kid, key: k.key, not_after: k.not_after }));

/** Run the vectors of the packs in force with the staged `version`: the executable with the candidate named (it loads that
 *  bundle or fails), or, outside the single executable, Node running the bundle file. `{ ok, output }`: the command's JSON
 *  report, or why there is none. */
export function runEngineCandidate(dir: string, version: string, timeoutMs = 120_000): Promise<{ ok: boolean; output: string }> {
  // The settings this agent itself trusts, and the home, on the command line too: the bundle is a signed build, which reads
  // them only from there (the hook's env-trust.ts).
  const settings = Object.entries({ ...settingsEnv(), SCOPEBOND_HOME: dir }).flatMap(([name, value]) => [SETTING_FLAG, `${name}=${value}`]);
  const args = ["packs", "test", "--all", "--json", ...settings];
  const [program, argv] = isSingleExecutable() ? [process.execPath, ["hook", ...args]] : [process.execPath, [join(engineVersionDir(dir, version), ENGINE_FILE), ...args]];
  return new Promise((resolve) => {
    const child = spawn(program, argv, {
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, SCOPEBOND_HOME: dir, SCOPEBOND_HOOK_DIR: dir, [ENGINE_CANDIDATE_ENV]: version, SCOPEBOND_AGENT_TRAY: "off" },
    });
    let stdout = ""; let stderr = "";
    child.stdout?.on("data", (d) => { if (stdout.length < 1_000_000) stdout += d; });
    child.stderr?.on("data", (d) => { if (stderr.length < 4096) stderr += d; });
    const timer = setTimeout(() => { child.kill(); resolve({ ok: false, output: "timed out" }); }, timeoutMs);
    child.on("error", (error) => { clearTimeout(timer); resolve({ ok: false, output: String(error) }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ ok: code === 0, output: code === 0 ? stdout : `${stdout}\n${stderr}`.trim().slice(-1000) }); });
  });
}

export interface EngineOutcome { action: "none" | "installed" | "refused" | "rolled_back" | "baseline"; version?: string; reason?: string }

export interface EngineUpdateOptions {
  dir: string;
  kind: InstallKind;
  /** The workspace's answer (fetchClientVersion), or null when there is none. */
  target: { policy: "recommended" | "hold"; hook_bundle?: HookBundleTarget | null } | null;
  /** The engine inside this executable (default: this hook's version). */
  baseline?: string;
  /** The updater keys trusted (default: the ones this build carries). */
  keys?: readonly UpdaterKey[];
  fetchImpl?: typeof fetch;
  /** Runs the pack vectors with a staged version (default: runEngineCandidate). */
  runCandidate?: (dir: string, version: string) => Promise<{ ok: boolean; output: string }>;
  log?: (line: string) => void;
  now?: () => number;
}

/** Roll back from the bundle in use: to the one before it when that is still staged, verifies, is not bad and is newer than
 *  the baseline; else to the baseline. The bundle is remembered as bad. */
function rollBack(dir: string, current: CurrentEngine, reason: string, keys: EngineKey[], baseline: string, now: number): EngineOutcome {
  rememberBad(dir, current.version, reason, now);
  const previous = current.previous;
  const usable = previous !== null && !badEngines(dir)[previous] && compareEngineVersions(previous, baseline) > 0 && checkStagedEngine(dir, previous, keys, now).ok;
  if (usable) writeCurrentEngine(dir, { version: previous, at: now, previous: null });
  else rmSync(join(engineDir(dir), "current.json"), { force: true });
  return { action: "rolled_back", version: current.version, reason: `${reason}; ${usable ? `back to ${previous}` : "back to the engine this install carries"}` };
}

/** Remove version folders other than `keep` (and leftovers of an interrupted staging). Never throws. */
function prune(dir: string, keep: Array<string | null>): void {
  try {
    for (const name of readdirSync(engineDir(dir))) {
      const folder = join(engineDir(dir), name);
      if ((isEngineVersion(name) && !keep.includes(name)) || /\.incoming-\d+$/.test(name)) rmSync(folder, { recursive: true, force: true });
    }
  } catch { /* the next pass */ }
}

async function download(fetchImpl: typeof fetch, url: string, max: number): Promise<Buffer | null> {
  try {
    const res = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(5 * 60_000) });
    if (!res.ok) return null;
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > max) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    return bytes.length > max ? null : bytes;
  } catch { return null; }
}

/** Download, check and stage `target`, run its vectors, and make it current. */
async function install(o: Required<Pick<EngineUpdateOptions, "dir" | "fetchImpl" | "runCandidate" | "log">> & { target: HookBundleTarget; keys: EngineKey[]; current: CurrentEngine | null; now: number }): Promise<EngineOutcome> {
  const { dir, target, keys, now } = o;
  const refuse = (reason: string): EngineOutcome => ({ action: "refused", version: target.version, reason });
  if (!keys.length) return refuse("this build has no updater key");
  if (!fetchableUrl(target.url) || !target.url.endsWith(".tgz")) return refuse("the bundle's address is not an https address of a .tgz");
  const manifestUrl = `${target.url.slice(0, -".tgz".length)}.manifest.json`;
  const [manifestBytes, signatureBytes] = await Promise.all([download(o.fetchImpl, manifestUrl, MANIFEST_MAX_BYTES), download(o.fetchImpl, `${manifestUrl}.sig`, 4096)]);
  if (!manifestBytes || !signatureBytes) return refuse("the bundle has no signed manifest");
  const text = manifestBytes.toString("utf8");
  const signature = signatureBytes.toString("utf8").trim();
  if (target.signature !== null && target.signature.trim() !== signature) return refuse("the manifest's signature is not the one the workspace names");
  const manifest = verifyEngineManifest(text, signature, keys, now);
  if (!manifest) return refuse("the bundle's manifest is not signed by a trusted updater key");
  if (manifest.version !== target.version) return refuse(`the manifest is for ${manifest.version}, not ${target.version}`);
  if (target.sha256 !== null && target.sha256 !== manifest.sha256) return refuse("the bundle is not the one the workspace names");
  const archive = await download(o.fetchImpl, target.url, ENGINE_ARCHIVE_MAX_BYTES);
  if (!archive) return refuse("the bundle could not be downloaded");
  if (createHash("sha256").update(archive).digest("hex") !== manifest.sha256) return refuse("the archive is not the one the manifest names");
  const files = unpackTgz(archive, { maxFiles: 16, maxBytes: ENGINE_ARCHIVE_MAX_BYTES * 4 });
  if (files instanceof Error) return refuse(`the archive cannot be read: ${files.message}`);
  if (files.length !== manifest.files.length) return refuse("the archive does not hold exactly the files its manifest names");
  for (const file of files) {
    const named = manifest.files.find((f) => f.name === file.name);
    if (!named || named.size !== file.bytes.length || named.sha256 !== createHash("sha256").update(file.bytes).digest("hex")) return refuse(`${file.name} is not the file the manifest names`);
  }
  // Staged whole: written to a folder of its own, then renamed into place.
  const folder = engineVersionDir(dir, target.version);
  const incoming = `${folder}.incoming-${process.pid}`;
  try {
    rmSync(incoming, { recursive: true, force: true });
    mkdirSync(incoming, { recursive: true });
    for (const file of files) writeFileSync(join(incoming, file.name), file.bytes, { mode: 0o600 });
    writeFileSync(join(incoming, ENGINE_MANIFEST), text, { mode: 0o600 });
    writeFileSync(join(incoming, ENGINE_SIGNATURE), `${signature}\n`, { mode: 0o600 });
    rmSync(folder, { recursive: true, force: true });
    renameSync(incoming, folder);
  } catch (error) {
    rmSync(incoming, { recursive: true, force: true });
    return refuse(`the bundle could not be staged: ${(error as Error).message}`);
  }
  const staged = checkStagedEngine(dir, target.version, keys, now);
  if (!staged.ok) { rmSync(folder, { recursive: true, force: true }); return refuse(staged.reason); }
  // The new engine runs the vectors of every pack in force, and at least as many packs as the engine in use runs.
  const inForce = (() => { try { return loadPacks(dir).packs.length; } catch { return 0; } })();
  const ran = await o.runCandidate(dir, target.version);
  let failure: string | null = null;
  if (!ran.ok) failure = `it failed the pack vectors (${ran.output.slice(-200)})`;
  else {
    try {
      const report = JSON.parse(ran.output) as { engine?: unknown; packs?: unknown; failures?: unknown };
      if (report.engine !== target.version) failure = `it reported engine ${String(report.engine)}, not ${target.version}`;
      else if (!Array.isArray(report.failures) || report.failures.length) failure = "it failed the pack vectors";
      else if (!Array.isArray(report.packs) || report.packs.length < inForce) failure = `it ran ${Array.isArray(report.packs) ? report.packs.length : 0} of the ${inForce} pack(s) in force`;
    } catch { failure = "its pack vector report could not be read"; }
  }
  if (failure) {
    rmSync(folder, { recursive: true, force: true });
    rememberBad(dir, target.version, failure, now);
    return refuse(failure);
  }
  writeCurrentEngine(dir, { version: target.version, at: now, previous: o.current?.version ?? null });
  prune(dir, [target.version, o.current?.version ?? null]);
  return { action: "installed", version: target.version };
}

/** One pass: roll back a bundle that does not start, then take the workspace's bundle when it is newer and checks out. */
export async function maintainEngine(o: EngineUpdateOptions): Promise<EngineOutcome> {
  const log = o.log ?? (() => {});
  if (o.kind === "npm") return { action: "none" };
  const now = (o.now ?? Date.now)();
  const keys = engineKeys(o.keys ?? updaterKeys());
  const baseline = o.baseline ?? hookVersion();
  let current = readCurrentEngine(o.dir);
  // A bundle no newer than the engine this install now carries (an installer brought a newer one) is never loaded: forgotten.
  if (current && compareEngineVersions(current.version, baseline) <= 0) {
    rmSync(join(engineDir(o.dir), "current.json"), { force: true });
    prune(o.dir, []);
    current = null;
  }
  // A bundle in use that failed to start twice, or that no longer checks out on disk, is rolled back first, whatever the
  // workspace says.
  if (current && compareEngineVersions(current.version, baseline) > 0) {
    const failures = engineStartFailures(o.dir, current.version, current.at);
    const staged = checkStagedEngine(o.dir, current.version, keys, now);
    if (failures >= MAX_ENGINE_START_FAILURES || !staged.ok) {
      const outcome = rollBack(o.dir, current, failures >= MAX_ENGINE_START_FAILURES ? `engine ${current.version} failed to start ${failures} times` : `engine ${current.version} no longer checks out (${staged.ok ? "" : staged.reason})`, keys, baseline, now);
      log(`engine rolled back: ${outcome.reason}`);
      return outcome;
    }
  }
  if (!o.target || o.target.policy !== "recommended") return { action: "none" };
  const want = o.target.hook_bundle ?? null;
  if (!want) return { action: "none" };
  if (compareEngineVersions(want.version, baseline) <= 0) {
    if (!current) return { action: "none" };
    rmSync(join(engineDir(o.dir), "current.json"), { force: true });
    log(`the workspace recommends the engine this install carries (${baseline}); engine ${current.version} is no longer used`);
    return { action: "baseline", version: baseline };
  }
  if (current?.version === want.version) return { action: "none" };
  if (current && compareEngineVersions(want.version, current.version) < 0) {
    const reason = `the workspace names engine ${want.version}, older than ${current.version} in use; the agent never moves to an older bundle (only back to the engine this install carries, or by rolling back)`;
    log(reason);
    return { action: "refused", version: want.version, reason };
  }
  if (badEngines(o.dir)[want.version]) return { action: "none" };
  current = readCurrentEngine(o.dir);
  const outcome = await install({ dir: o.dir, target: want, keys, now, current, fetchImpl: o.fetchImpl ?? fetch, runCandidate: o.runCandidate ?? runEngineCandidate, log });
  log(outcome.action === "installed" ? `engine ${want.version} is in use (it passed the pack vectors)` : `engine ${want.version} was not used: ${outcome.reason}`);
  return outcome;
}

/** Whether there is a newer engine in use than the baseline (for status). */
export function engineInUse(dir: string, baseline = hookVersion()): string | null {
  const current = readCurrentEngine(dir);
  return current && compareEngineVersions(current.version, baseline) > 0 && existsSync(join(engineVersionDir(dir, current.version), ENGINE_FILE)) ? current.version : null;
}
