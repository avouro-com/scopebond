// Updates under the workspace's control. The agent asks the workspace which versions this computer should run; with
// "recommended" it installs the named agent from npm (which brings the matching hook, pinned exactly) and restarts; with
// "hold" it changes nothing. The hook entries in the agent settings are pinned to the hook version the agent carries.
//
// The npm path is hardened: the workspace's answer is bounded (size, strict x.y.z, no more than one major version ahead),
// the exact version must carry npm provenance from this repository's main branch, npm runs with package scripts off and
// the public registry pinned, the new program must start and report the version before the old one hands over, and a
// version that did not start is rolled back and not retried for a day.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  absoluteHookCommand, automaticHarnesses, configuredHookCommands, ensureDurableRuntime, hookCliPath, hookCommandResolves, hookVersion, isQuotedWindowsHookCommand, isScopebondHookCommand, isSingleExecutable,
  nativeHookCommand, userHarnessFile, writeHarnessConfig, type Harness, type HookConnection,
} from "@scopebond/hook";
import { findProgram, windowsSystemProgram } from "@scopebond/gateway/node";
import { agentCliPath } from "./self.js";
import { useNativeHookEntries } from "./hook-entries.js";
import type { InstallKind } from "./native-update.js";
import { readHookBundleTarget, type HookBundleTarget } from "./engine-update.js";
import { readIntelTarget, type IntelTarget } from "./intel-install.js";

/** x.y.z with no leading zeros, no tags, and each part of a sane size. */
const VERSION = /^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,5})$/;
/** The largest answer to /v1/client-version the agent reads. */
export const CLIENT_VERSION_MAX_BYTES = 4096;
/** The only registry the agent installs from. */
export const NPM_REGISTRY = "https://registry.npmjs.org/";
/** The repository and branch an installed agent's npm provenance must name. */
export const PROVENANCE_REPOSITORY = "https://github.com/avouro-com/scopebond";
export const PROVENANCE_REF = "refs/heads/main";

/** Set by the single executable's build (esbuild `define`); absent from the npm package. */
declare const __SCOPEBOND_AGENT_VERSION__: string | undefined;

export function agentVersion(): string {
  if (typeof __SCOPEBOND_AGENT_VERSION__ === "string") return __SCOPEBOND_AGENT_VERSION__;
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch { return "0.0.0"; }
}

export const isVersion = (v: unknown): v is string => typeof v === "string" && VERSION.test(v);

/** The workspace's answer to `GET /v1/client-version`. `agent` is the npm release to run; `native_agent` is the newest
 *  published signed Windows build (the version of its release manifest and installer), or null when there is none or the
 *  workspace holds it back. An install from the signed installer updates only to `native_agent`, never to `agent`: an
 *  npm release can be out before its signed build, or never get one. A workspace that does not send the field (an older
 *  one) offers the signed install no update.
 *
 *  `hook_bundle` names a newer engine for the signed install (engine-update.ts) and `intel` the plugin component
 *  (intel-install.ts); each is left out when absent or not usable, which never refuses the rest of the answer.
 *
 *  The request names this computer's platform (`?platform=darwin-arm64`, Node's `${process.platform}-${process.arch}`), so
 *  a workspace that keeps a signed build per platform names the one for this computer and says so in `native_platform`.
 *  An answer whose `native_platform` names another platform offers the signed install no update. */
export interface ClientVersion {
  policy: "recommended" | "hold"; hook: string | null; agent: string | null; native_agent: string | null;
  hook_bundle?: HookBundleTarget | null; intel?: IntelTarget | null;
}

/** A response body as text, or null when it is larger than `max` bytes. */
async function boundedText(res: Response, max: number): Promise<string | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { void reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Whether `named` is a version this computer may be moved to from `running`: well formed and at most one major ahead. */
function inRange(named: string, running: string): boolean {
  const major = Number(named.split(".")[0]);
  const current = Number((isVersion(running) ? running : "0.0.0").split(".")[0]);
  return major <= current + 1;
}

/** The versions the workspace names for this computer, or null when there is no usable answer. Anything unexpected — an
 *  answer over the size limit, not an object, a policy other than "recommended" or "hold", a version that is not a strict
 *  x.y.z or is more than one major version ahead — refuses the whole answer, so nothing changes. */
export async function fetchClientVersion(
  connection: Pick<HookConnection, "url" | "credential">, fetchImpl: typeof fetch = fetch, timeoutMs = 10_000,
  running: { agent: string; hook: string } = { agent: agentVersion(), hook: hookVersion() },
  platform = `${process.platform}-${process.arch}`,
): Promise<ClientVersion | null> {
  try {
    const url = new URL("/v1/client-version", connection.url);
    url.searchParams.set("platform", platform);
    const res = await fetchImpl(url.toString(), {
      headers: { authorization: `Bearer ${connection.credential}` }, redirect: "error", signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const text = await boundedText(res, CLIENT_VERSION_MAX_BYTES);
    if (text === null) return null;
    const body = JSON.parse(text) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const { policy, hook, agent, native_agent: nativeAgent, native_platform: nativePlatform, hook_bundle: hookBundle, intel } = body as Record<string, unknown>;
    if (policy !== "recommended" && policy !== "hold") return null;
    const version = (v: unknown, current: string): string | null | undefined => {
      if (v === null || v === undefined) return null;
      return isVersion(v) && inRange(v, current) ? v : undefined;
    };
    const h = version(hook, running.hook), a = version(agent, running.agent), n = version(nativeAgent, running.agent);
    if (h === undefined || a === undefined || n === undefined) return null;
    // A signed build named for another platform is not one this computer can install.
    const forThisPlatform = nativePlatform === undefined || nativePlatform === null || nativePlatform === platform;
    const bundleTarget = readHookBundleTarget(hookBundle), intelTarget = readIntelTarget(intel);
    return { policy, hook: h, agent: a, native_agent: forThisPlatform ? n : null, ...(bundleTarget ? { hook_bundle: bundleTarget } : {}), ...(intelTarget ? { intel: intelTarget } : {}) };
  } catch { return null; }
}

/** The version this install should move to, or null: under "recommended" only, newer than the one running, and from the
 *  field for this kind of install: an npm install follows `agent`; the signed installer follows `native_agent` alone (no
 *  field, or null, means no update for it). */
export function updateTarget(target: ClientVersion | null, kind: InstallKind, current: string): string | null {
  if (!target || target.policy !== "recommended") return null;
  const want = kind === "npm" ? target.agent : target.native_agent;
  return want && compareVersions(want, current) > 0 ? want : null;
}

/** Compare x.y.z versions: negative when a < b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** The hook version a settings command runs, when it names one (an `npx` pin or a pinned copy). */
export function commandHookVersion(command: string): string | null {
  return /@scopebond\/hook@([0-9]+\.[0-9]+\.[0-9]+)/.exec(command)?.[1]
    ?? /[\\/]runtime[\\/]([0-9]+\.[0-9]+\.[0-9]+)[\\/]/.exec(command)?.[1]
    ?? null;
}

const isNpxCommand = (command: string) => /(^|\s)npx(\.cmd)?\s/.test(command);
/** A file's text, or null when it cannot be read. */
const fileText = (file: string): string | null => { try { return readFileSync(file, "utf8"); } catch { return null; } };

/** The hook command upkeep writes: always the hook this agent carries, by its absolute path (a durable pinned copy when the
 *  carried one lives somewhere npm may clear). Never an `npx` form, which would resolve a package from the registry each
 *  time the coding tool runs it. */
export function maintainedHookCommand(harness: Harness): string {
  // The single executable carries its own hook, at the path the installer keeps.
  if (isSingleExecutable()) return nativeHookCommand(harness);
  const cli = hookCliPath();
  try {
    const pin = ensureDurableRuntime(cli, hookVersion());
    if (pin.cli) return absoluteHookCommand(pin.cli, harness);
  } catch { /* the carried hook's own path below */ }
  return absoluteHookCommand(cli, harness);
}

/** This Node's own npm, run directly (no shell, and never another Node's npm first on PATH), or null. */
export function ownNpm(): [string, string[]] | null {
  const cli = join(dirname(process.execPath), process.platform === "win32" ? "" : "../lib", "node_modules", "npm", "bin", "npm-cli.js");
  return existsSync(cli) ? [process.execPath, [cli]] : null;
}

/** npm on PATH, for a Node without its own: by its full path from PATH's absolute folders, never the current folder (which
 *  a spawn by bare name searches first on Windows). On Windows it is a .cmd, which starts only through a shell: the
 *  system folder's cmd.exe, with the path and each argument quoted. Null when there is none. */
export function npmOnPath(args: string[], env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): { program: string; args: string[]; shell: string | false } | null {
  const win = platform === "win32";
  const npm = findProgram(win ? "npm.cmd" : "npm", { env, platform });
  if (!npm) return null;
  return win ? { program: `"${npm}"`, args: args.map((a) => `"${a}"`), shell: windowsSystemProgram("cmd") } : { program: npm, args, shell: false };
}

/** Bring the user-level Scopebond hook entries to the hook this agent carries, and repair any that cannot start. Under
 *  "recommended" (`moveVersions`) an entry naming an older hook, or any `npx` entry, is pinned to the carried hook; under
 *  "hold" only broken entries and `npx` entries that name no version or the carried one are (their version does not
 *  change). Entries of other tools are never touched. Returns the files changed. */
export function maintainHookEntries(harnesses: Harness[], moveVersions = true, platform: NodeJS.Platform = process.platform, dir?: string): Array<{ harness: Harness; file: string; reason: string }> {
  harnesses = automaticHarnesses(harnesses, dir);
  // The signed install: every Scopebond entry runs this executable, whatever wrote it (an npm install before it, an npx
  // form), under either policy: the hook is the one inside this program, so no version moves.
  if (isSingleExecutable()) return useNativeHookEntries(harnesses, process.execPath, dir);
  const carried = hookVersion();
  const changed: Array<{ harness: Harness; file: string; reason: string }> = [];
  for (const harness of harnesses) {
    const file = userHarnessFile(harness);
    const ours = configuredHookCommands(file).filter((c) => isScopebondHookCommand(c));
    if (!ours.length) continue;
    // One coding agent's entry that cannot be written (a refused path) is recorded and the rest go on: upkeep, updates
    // and the self-check must not stop over it.
    try {
      const broken = ours.some((c) => !isNpxCommand(c) && !hookCommandResolves(c));
      const npx = ours.some((c) => { if (!isNpxCommand(c)) return false; const v = commandHookVersion(c); return moveVersions || v === null || v === carried; });
      const behind = moveVersions && ours.some((c) => { const v = commandHookVersion(c); return v !== null && compareVersions(v, carried) < 0; });
      // A quoted Windows entry (an earlier release's form, or a fallback from when a folder had no short name) that now has
      // the shell-plain spelling is rewritten for Codex and Cursor, which may run it under PowerShell (it cannot start the
      // quoted one). Claude Code runs hooks under Git Bash, which starts it; Copilot entries carry a PowerShell form.
      const target = !broken && !npx && !behind && platform === "win32" && (harness === "codex" || harness === "cursor") && ours.some(isQuotedWindowsHookCommand)
        ? maintainedHookCommand(harness) : null;
      const quoted = target !== null && !isQuotedWindowsHookCommand(target);
      if (!broken && !npx && !behind && !quoted) continue;
      const before = fileText(file);
      writeHarnessConfig(file, harness, target ?? maintainedHookCommand(harness));
      // Reported only when the file did change: a pass with nothing to do says nothing.
      if (fileText(file) === before) continue;
      changed.push({ harness, file, reason: broken ? "the hook command could not start" : npx ? `pinned to the hook this agent carries (${carried})` : behind ? `moved to hook ${carried}` : "rewritten in the form every Windows hook shell starts (PowerShell could not start the quoted one)" });
    } catch (error) {
      changed.push({ harness, file, reason: `could not be updated: ${(error as Error).message}` });
    }
  }
  return changed;
}

/** npm's arguments for a global install of `spec`: package scripts off, the public registry pinned (also for the
 *  @scopebond scope, which a scope registry setting would otherwise take over). */
export function npmInstallArgs(spec: string): string[] {
  return ["install", "-g", spec, "--ignore-scripts", `--registry=${NPM_REGISTRY}`, `--@scopebond:registry=${NPM_REGISTRY}`, "--no-fund", "--no-audit"];
}

/** The environment npm runs with: this process's, without settings that would change the registry or turn scripts back on. */
export function npmEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    const k = key.toLowerCase();
    if (k.startsWith("npm_config_") && (k.endsWith("registry") || k.includes("ignore_scripts") || k.includes("ignore-scripts") || k.includes("script_shell") || k.includes("script-shell"))) continue;
    out[key] = value;
  }
  return out;
}

export type ProvenanceResult = { ok: true } | { ok: false; reason: string };

/** Check, before installing, that npm's provenance for exactly `@scopebond/agent@version` says it was built by this
 *  repository's main branch, for the tarball the registry serves. The statement is the one the registry verified when the
 *  package was published; it is read here, not re-verified against Sigstore. */
export async function checkProvenance(version: string, fetchImpl: typeof fetch = fetch, timeoutMs = 30_000): Promise<ProvenanceResult> {
  const get = async (url: string, max: number): Promise<unknown> => {
    const res = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`${res.status}`);
    const text = await boundedText(res, max);
    if (text === null) throw new Error("too large");
    return JSON.parse(text);
  };
  try {
    const meta = await get(`${NPM_REGISTRY}@scopebond%2fagent/${version}`, 512 * 1024) as { version?: string; dist?: { integrity?: string; attestations?: { url?: string; provenance?: { predicateType?: string } } } };
    if (meta?.version !== version) return { ok: false, reason: "the registry did not describe this version" };
    const integrity = meta.dist?.integrity ?? "";
    const att = meta.dist?.attestations;
    if (!att?.url || !att.provenance?.predicateType?.startsWith("https://slsa.dev/provenance/")) return { ok: false, reason: "this version has no npm provenance" };
    if (!integrity.startsWith("sha512-")) return { ok: false, reason: "this version has no sha512 integrity" };
    const want = Buffer.from(integrity.slice("sha512-".length), "base64").toString("hex");
    if (!att.url.startsWith(`${NPM_REGISTRY}-/npm/v1/attestations/`)) return { ok: false, reason: "the provenance is not on the registry" };
    const bundle = await get(att.url, 1024 * 1024) as { attestations?: Array<{ predicateType?: string; bundle?: { dsseEnvelope?: { payload?: string } } }> };
    const slsa = bundle?.attestations?.find((a) => a.predicateType?.startsWith("https://slsa.dev/provenance/"));
    if (!slsa?.bundle?.dsseEnvelope?.payload) return { ok: false, reason: "this version has no npm provenance" };
    const statement = JSON.parse(Buffer.from(slsa.bundle.dsseEnvelope.payload, "base64").toString("utf8")) as {
      subject?: Array<{ name?: string; digest?: { sha512?: string } }>;
      predicate?: { buildDefinition?: { externalParameters?: { workflow?: { repository?: string; ref?: string } } } };
    };
    const subject = statement.subject?.find((s) => s.name === `pkg:npm/%40scopebond/agent@${version}`);
    if (!subject || subject.digest?.sha512 !== want) return { ok: false, reason: "the provenance is for another tarball" };
    const workflow = statement.predicate?.buildDefinition?.externalParameters?.workflow;
    if (workflow?.repository !== PROVENANCE_REPOSITORY) return { ok: false, reason: `the provenance names ${workflow?.repository ?? "no repository"}, not ${PROVENANCE_REPOSITORY}` };
    if (workflow.ref !== PROVENANCE_REF) return { ok: false, reason: `the provenance names ${workflow.ref ?? "no branch"}, not ${PROVENANCE_REF}` };
    return { ok: true };
  } catch (error) { return { ok: false, reason: `the registry could not be asked (${(error as Error).message.slice(0, 80)})` }; }
}

/** Install `@scopebond/agent@version` globally with this computer's npm: provenance checked first (unless `provenance` is
 *  false, for going back to the version already running), package scripts off, the public registry pinned. */
export async function installAgent(version: string, o: { timeoutMs?: number; fetchImpl?: typeof fetch; provenance?: boolean } = {}): Promise<{ ok: boolean; output: string }> {
  if (!isVersion(version)) return { ok: false, output: "not a version" };
  if (o.provenance !== false) {
    const checked = await checkProvenance(version, o.fetchImpl);
    if (!checked.ok) return { ok: false, output: `npm provenance check failed: ${checked.reason}; nothing was installed` };
  }
  const timeoutMs = o.timeoutMs ?? 5 * 60_000;
  return new Promise((resolve) => {
    const args = npmInstallArgs(`@scopebond/agent@${version}`);
    const env = npmEnvironment();
    // This Node's own npm when it can be found; otherwise npm on PATH (a .cmd on Windows, which Node only
    // starts through a shell; the arguments are fixed and the version is validated).
    const own = ownNpm();
    const run = own ? { program: own[0], args: [...own[1], ...args], shell: false as const } : npmOnPath(args, env);
    if (!run) { resolve({ ok: false, output: "npm was not found in a folder on PATH" }); return; }
    const child = spawn(run.program, run.args, { shell: run.shell, windowsHide: true, env });
    let output = "";
    child.stdout?.on("data", (d) => { output += d; });
    child.stderr?.on("data", (d) => { output += d; });
    const timer = setTimeout(() => { child.kill(); resolve({ ok: false, output: output + "\ntimed out" }); }, timeoutMs);
    child.on("error", (error) => { clearTimeout(timer); resolve({ ok: false, output: String(error) }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ ok: code === 0, output: output.slice(-2000) }); });
  });
}

/** Run the agent program now on disk (`version`) and confirm it starts and reports `version`. */
export function startCheck(version: string, cli = agentCliPath(), timeoutMs = 60_000): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", cli, "version"], {
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, SCOPEBOND_AGENT_TRAY: "off" },
    });
    let output = "";
    child.stdout?.on("data", (d) => { if (output.length < 4096) output += d; });
    child.stderr?.on("data", (d) => { if (output.length < 4096) output += d; });
    const timer = setTimeout(() => { child.kill(); resolve({ ok: false, output: `${output}\ntimed out` }); }, timeoutMs);
    child.on("error", (error) => { clearTimeout(timer); resolve({ ok: false, output: String(error) }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const first = output.trim().split(/\r?\n/)[0] ?? "";
      resolve({ ok: code === 0 && first.split(/\s+/)[0] === `agent/${version}`, output: output.trim().slice(-500) });
    });
  });
}

/** A version that did not install or start, kept so it is not tried again for a while: after 1 hour, then 6 hours, then
 *  every 24 hours (`failures` counts the tries of that version). The running version keeps protecting meanwhile. */
export const FAILED_UPDATE_FILE = "update-failed.json";
export const FAILED_UPDATE_RETRY_MS = 24 * 60 * 60 * 1000;
export const UPDATE_RETRY_MS: readonly number[] = [60 * 60 * 1000, 6 * 60 * 60 * 1000, FAILED_UPDATE_RETRY_MS];

/** How long after its `failures`-th failed try a version is tried again. */
export function updateRetryMs(failures: number): number {
  return UPDATE_RETRY_MS[Math.min(Math.max(failures, 1), UPDATE_RETRY_MS.length) - 1];
}

interface FailedRecord { version: string; at: number; reason: string | null; failures: number }

function readFailed(dir: string): FailedRecord | null {
  try {
    const r = JSON.parse(readFileSync(join(dir, FAILED_UPDATE_FILE), "utf8")) as { version?: unknown; at?: unknown; reason?: unknown; failures?: unknown };
    if (typeof r.version !== "string" || typeof r.at !== "number") return null;
    // A record from before tries were counted stood for a day, as the third try's does.
    const failures = typeof r.failures === "number" && Number.isInteger(r.failures) && r.failures > 0 ? r.failures : UPDATE_RETRY_MS.length;
    return { version: r.version, at: r.at, reason: typeof r.reason === "string" ? r.reason : null, failures };
  } catch { return null; }
}

/** Record a failed try of `version`: one more than the last when it was the same version, else the first. */
export function recordFailedUpdate(dir: string, version: string, now = Date.now(), reason: string | null = null): void {
  const before = readFailed(dir);
  const failures = before?.version === version ? before.failures + 1 : 1;
  try { writeFileSync(join(dir, FAILED_UPDATE_FILE), `${JSON.stringify({ version, at: now, failures, ...(reason ? { reason: reason.slice(0, 300) } : {}) })}\n`, { mode: 0o600 }); } catch { /* best effort */ }
}

/** The update installed and running: its failed tries are forgotten. */
export function clearFailedUpdate(dir: string): void {
  try { rmSync(join(dir, FAILED_UPDATE_FILE), { force: true }); } catch { /* read as none once it is retried */ }
}

/** The update that did not install or start here, with why and how many tries failed, until it is tried again (`retry_at`);
 *  null when there is none or its retry is due. */
export function failedUpdate(dir: string, now = Date.now()): { version: string; at: number; reason: string | null; failures: number; retry_at: number } | null {
  const r = readFailed(dir);
  if (!r) return null;
  const retryAt = r.at + updateRetryMs(r.failures);
  return now - r.at >= 0 && now < retryAt ? { ...r, retry_at: retryAt } : null;
}

export function recentlyFailedUpdate(dir: string, version: string, now = Date.now()): boolean {
  return failedUpdate(dir, now)?.version === version;
}
