// Updates under the workspace's control. The agent asks the workspace which versions this computer should run; with
// "recommended" it installs the named agent from npm (which brings the matching hook, pinned exactly) and restarts; with
// "hold" it changes nothing. The hook entries in the agent settings are pinned to the hook version the agent carries.
//
// The npm path is hardened: the workspace's answer is bounded (size, strict x.y.z, no more than one major version ahead),
// the exact version must carry npm provenance from this repository's main branch, npm runs with package scripts off and
// the public registry pinned, the new program must start and report the version before the old one hands over, and a
// version that did not start is rolled back and not retried for a day.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  absoluteHookCommand, configuredHookCommands, ensureDurableRuntime, hookCliPath, hookCommandResolves, hookVersion, isScopebondHookCommand, isSingleExecutable,
  nativeHookCommand, userHarnessFile, writeHarnessConfig, type Harness, type HookConnection,
} from "@scopebond/hook";
import { findProgram, windowsSystemProgram } from "@scopebond/gateway/node";
import { agentCliPath } from "./self.js";

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

export interface ClientVersion { policy: "recommended" | "hold"; hook: string | null; agent: string | null }

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
): Promise<ClientVersion | null> {
  try {
    const res = await fetchImpl(new URL("/v1/client-version", connection.url).toString(), {
      headers: { authorization: `Bearer ${connection.credential}` }, redirect: "error", signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const text = await boundedText(res, CLIENT_VERSION_MAX_BYTES);
    if (text === null) return null;
    const body = JSON.parse(text) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const { policy, hook, agent } = body as Record<string, unknown>;
    if (policy !== "recommended" && policy !== "hold") return null;
    const version = (v: unknown, current: string): string | null | undefined => {
      if (v === null || v === undefined) return null;
      return isVersion(v) && inRange(v, current) ? v : undefined;
    };
    const h = version(hook, running.hook), a = version(agent, running.agent);
    if (h === undefined || a === undefined) return null;
    return { policy, hook: h, agent: a };
  } catch { return null; }
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
export function maintainHookEntries(harnesses: Harness[], moveVersions = true): Array<{ harness: Harness; file: string; reason: string }> {
  const carried = hookVersion();
  const changed: Array<{ harness: Harness; file: string; reason: string }> = [];
  for (const harness of harnesses) {
    const file = userHarnessFile(harness);
    const ours = configuredHookCommands(file).filter((c) => isScopebondHookCommand(c));
    if (!ours.length) continue;
    const broken = ours.some((c) => !isNpxCommand(c) && !hookCommandResolves(c));
    const npx = ours.some((c) => { if (!isNpxCommand(c)) return false; const v = commandHookVersion(c); return moveVersions || v === null || v === carried; });
    const behind = moveVersions && ours.some((c) => { const v = commandHookVersion(c); return v !== null && compareVersions(v, carried) < 0; });
    if (!broken && !npx && !behind) continue;
    writeHarnessConfig(file, harness, maintainedHookCommand(harness));
    changed.push({ harness, file, reason: broken ? "the hook command could not start" : npx ? `pinned to the hook this agent carries (${carried})` : `moved to hook ${carried}` });
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

/** A version that was installed but did not start, kept so it is not installed again for a while. */
export const FAILED_UPDATE_FILE = "update-failed.json";
export const FAILED_UPDATE_RETRY_MS = 24 * 60 * 60 * 1000;

export function recordFailedUpdate(dir: string, version: string, now = Date.now()): void {
  try { writeFileSync(join(dir, FAILED_UPDATE_FILE), `${JSON.stringify({ version, at: now })}\n`, { mode: 0o600 }); } catch { /* best effort */ }
}

export function recentlyFailedUpdate(dir: string, version: string, now = Date.now()): boolean {
  try {
    const r = JSON.parse(readFileSync(join(dir, FAILED_UPDATE_FILE), "utf8")) as { version?: unknown; at?: unknown };
    return r.version === version && typeof r.at === "number" && now - r.at >= 0 && now - r.at < FAILED_UPDATE_RETRY_MS;
  } catch { return false; }
}
