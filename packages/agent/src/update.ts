// Updates under the workspace's control (D130). The agent asks the workspace which versions this
// computer should run; with "recommended" it installs the named agent from npm (which brings the
// matching hook, pinned exactly) and restarts; with "hold" it changes nothing. The hook entries in
// the agent settings are moved to the hook version the agent carries.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  absoluteHookCommand, configuredHookCommands, ensureDurableRuntime, hookCliPath, hookCommandResolves, hookVersion, isScopebondHookCommand, isSingleExecutable,
  nativeHookCommand, userHarnessFile, writeHarnessConfig, type Harness, type HookConnection,
} from "@scopebond/hook";

const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;

/** Set by the single executable's build (esbuild `define`); absent from the npm package. */
declare const __SCOPEBOND_AGENT_VERSION__: string | undefined;

export function agentVersion(): string {
  if (typeof __SCOPEBOND_AGENT_VERSION__ === "string") return __SCOPEBOND_AGENT_VERSION__;
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch { return "0.0.0"; }
}

export interface ClientVersion { policy: "recommended" | "hold"; hook: string | null; agent: string | null }

export async function fetchClientVersion(connection: Pick<HookConnection, "url" | "credential">, fetchImpl: typeof fetch = fetch, timeoutMs = 10_000): Promise<ClientVersion | null> {
  try {
    const res = await fetchImpl(new URL("/v1/client-version", connection.url).toString(), {
      headers: { authorization: `Bearer ${connection.credential}` }, redirect: "error", signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = await res.json() as Partial<ClientVersion>;
    const ok = (v: unknown) => typeof v === "string" && VERSION.test(v) ? v : null;
    return { policy: body.policy === "hold" ? "hold" : "recommended", hook: ok(body.hook), agent: ok(body.agent) };
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

/** The command an agent-maintained settings entry runs: the hook version this agent carries,
 *  through npx, so it resolves Node at run time and an agent update never swaps files under it. */
/** The hook command upkeep writes. The hook this agent carries is pinned by its absolute path (fast,
 *  and it needs neither the registry nor npx on the coding tool's PATH); another version, or a pin that
 *  cannot be made, falls back to the portable npx form. */
export function maintainedHookCommand(harness: Harness, version = hookVersion()): string {
  // The single executable carries its own hook, at the path the installer keeps.
  if (isSingleExecutable()) return nativeHookCommand(harness);
  if (version === hookVersion()) {
    try {
      const pin = ensureDurableRuntime(hookCliPath(), version);
      if (pin.cli) return absoluteHookCommand(pin.cli, harness);
    } catch { /* fall back below */ }
  }
  return `npx -y @scopebond/hook@${version} ${harness}`;
}

/** This Node's own npm, run directly (no shell, and never another Node's npm first on PATH), or null. */
export function ownNpm(): [string, string[]] | null {
  const cli = join(dirname(process.execPath), process.platform === "win32" ? "" : "../lib", "node_modules", "npm", "bin", "npm-cli.js");
  return existsSync(cli) ? [process.execPath, [cli]] : null;
}

/** Bring the user-level Scopebond hook entries to `version`, and repair any that cannot start.
 *  Entries of other tools are never touched. Returns the files changed. */
export function maintainHookEntries(harnesses: Harness[], version = hookVersion(), moveVersions = true): Array<{ harness: Harness; file: string; reason: string }> {
  const changed: Array<{ harness: Harness; file: string; reason: string }> = [];
  for (const harness of harnesses) {
    const file = userHarnessFile(harness);
    const ours = configuredHookCommands(file).filter((c) => isScopebondHookCommand(c));
    if (!ours.length) continue;
    const broken = ours.some((c) => !hookCommandResolves(c));
    const behind = moveVersions && ours.some((c) => { const v = commandHookVersion(c); return v !== null && compareVersions(v, version) < 0; });
    if (!broken && !behind) continue;
    writeHarnessConfig(file, harness, maintainedHookCommand(harness, version));
    changed.push({ harness, file, reason: broken ? "the hook command could not start" : `moved to hook ${version}` });
  }
  return changed;
}

/** Install `@scopebond/agent@version` globally with this computer's npm. */
export function installAgent(version: string, timeoutMs = 5 * 60_000): Promise<{ ok: boolean; output: string }> {
  if (!VERSION.test(version)) return Promise.resolve({ ok: false, output: "not a version" });
  return new Promise((resolve) => {
    const win = process.platform === "win32";
    const args = ["install", "-g", `@scopebond/agent@${version}`, "--no-fund", "--no-audit"];
    // This Node's own npm when it can be found; otherwise npm on PATH (a .cmd on Windows, which Node only
    // starts through a shell; the arguments are fixed and the version is validated).
    const own = ownNpm();
    const child = own ? spawn(own[0], [...own[1], ...args], { windowsHide: true }) : spawn(win ? "npm.cmd" : "npm", args, { shell: win, windowsHide: true });
    let output = "";
    child.stdout?.on("data", (d) => { output += d; });
    child.stderr?.on("data", (d) => { output += d; });
    const timer = setTimeout(() => { child.kill(); resolve({ ok: false, output: output + "\ntimed out" }); }, timeoutMs);
    child.on("error", (error) => { clearTimeout(timer); resolve({ ok: false, output: String(error) }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ ok: code === 0, output: output.slice(-2000) }); });
  });
}
