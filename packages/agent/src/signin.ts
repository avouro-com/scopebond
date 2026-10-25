// The first sign-in of a signed install, with no terminal. The installer may name the workspace: on Windows
// `msiexec … WORKSPACE=https://…`, kept as `Workspace` under HKCU, or HKLM for every user, `Software\Avouro\Scopebond`; on
// macOS the `Workspace` preference of `com.scopebond.agent`, from a configuration profile (managed preferences), the
// machine's preferences an administrator wrote, or this user's. Without one it is Scopebond Cloud. Only an https origin
// read from there is used: never a URL from a link, a notification or anything else that reaches the agent.
//
// The agent runs the device-code sign-in itself (the same requests the hook's `login` makes): it asks the workspace for a
// code, opens the approval page (on that workspace only), and keeps waiting for the approval in the background, while the
// tray shows the code. Once approved it completes the enrollment with the hook's own `connectCloud`, then does the rest of
// a first-time setup: the hook entries for the coding agents on this computer, and autostart. It runs inside the agent
// process, so no second program is left waiting when the agent stops or is updated.

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  approvedWorkspaceId, automaticHarnesses, clientNameField, configuredHookCommands, connectCloud, isHarnessConfigured, loadConnection, machineIdField, observationStatus, scaffold,
  userHarnessFile, wireLifecycleHooks, writeHarnessConfig,
  type Harness,
} from "@scopebond/hook";
import { expectedHarnesses } from "./agent.js";
import { windowsTool } from "./native-update.js";
import { openInBrowser, sameOrigin } from "./summary.js";
import { maintainedHookCommand } from "./update.js";
import type { ReconnectStart } from "./reconnect.js";

/** The workspace a signed install signs in to when its installer named none. */
export const DEFAULT_WORKSPACE = "https://cloud.scopebond.com";
/** Where the installer keeps its settings: the machine's first (an install for every user, set by an administrator), then this
 *  user's. A per-user value, which any program running as the person can write, never overrides the machine's. */
export const SETTINGS_KEYS = ["HKLM\\Software\\Avouro\\Scopebond", "HKCU\\Software\\Avouro\\Scopebond"] as const;
const WORKSPACE_VALUE = "Workspace";
/** An install key the installer was given (`msiexec … KEY=sbk_…`): a company-wide install connects with it, with no code. */
export const INSTALL_KEY_VALUE = "InstallKey";
const INSTALL_KEY = /^sbk_[A-Za-z0-9_-]{20,96}$/;

/** Where the macOS installer package's settings are read, as preference domains of `com.scopebond.agent`: a configuration
 *  profile a device management service installed first, then the machine's preferences an administrator wrote
 *  (`sudo defaults write /Library/Preferences/com.scopebond.agent Workspace https://…`), then this user's. Only an
 *  administrator can write the first two, so a user's value never overrides them. */
export const MAC_SETTINGS_DOMAINS = [
  "/Library/Managed Preferences/com.scopebond.agent",
  "/Library/Preferences/com.scopebond.agent",
  "~/Library/Preferences/com.scopebond.agent",
] as const;
/** Every place an installer's settings can be, the machine's before the person's (each platform reads its own; the
 *  others are never there). */
export const INSTALLER_SETTINGS = [SETTINGS_KEYS[0], MAC_SETTINGS_DOMAINS[0], MAC_SETTINGS_DOMAINS[1], SETTINGS_KEYS[1], MAC_SETTINGS_DOMAINS[2]] as const;

/** Reads one registry string value; null when it is not there. Tests pass their own. */
export type RegistryReader = (key: string, name: string) => string | null;

/** `reg query <key> /v <name>`, Windows' own reg.exe by its full path, in the 64-bit view the installer writes. */
export const readRegistryValue: RegistryReader = (key, name) => {
  let out: string;
  try { out = execFileSync(windowsTool("reg"), ["query", key, "/v", name, "/reg:64"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 10_000 }); }
  catch { return null; }
  const line = out.split(/\r?\n/).find((l) => l.trim().toLowerCase().startsWith(`${name.toLowerCase()} `));
  return /^\s*\S+\s+REG_(?:EXPAND_)?SZ\s+(.*?)\s*$/.exec(line ?? "")?.[1] ?? null;
};

/** One string value of a preference domain, read from its file (`<domain>.plist`) with macOS's own `plutil` by its full
 *  path: what a configuration profile, `defaults write` or the person put there ("true" or "false" for a boolean); null
 *  when the file or the value is not there, or the value is of another type. `~` is this user's home. The file is read itself, not through the preferences cache, so a value
 *  is never stale. */
export const readMacPreference: RegistryReader = (domain, name) => {
  const file = `${domain.startsWith("~/") ? join(homedir(), domain.slice(2)) : domain}.plist`;
  let out: string;
  try { out = execFileSync("/usr/bin/plutil", ["-extract", name, "xml1", "-o", "-", file], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }); }
  catch { return null; }
  // A boolean reads as "true" or "false" (a profile's AutoUpdate); any other type is no setting.
  const flag = /<plist[^>]*>\s*<(true|false)\/>\s*<\/plist>/.exec(out);
  if (flag) return flag[1];
  const m = /<plist[^>]*>\s*<string>([^<]*)<\/string>\s*<\/plist>/.exec(out);
  return m ? m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&") : null;
};

/** An installer setting where this platform keeps it: the registry on Windows, preferences on macOS; null for a place
 *  of another platform, without starting anything. */
export const readInstallerSetting: RegistryReader = (key, name, platform: NodeJS.Platform = process.platform) => {
  if (key.startsWith("HK")) return platform === "win32" ? readRegistryValue(key, name) : null;
  return platform === "darwin" ? readMacPreference(key, name) : null;
};

/** The https origin of `value`, or null for anything else (another scheme, a user name or password in it, not a URL). */
export function httpsOrigin(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password || !url.hostname) return null;
    return url.origin;
  } catch { return null; }
}

/** The workspace the installer named (the machine's setting, then this user's), else Scopebond Cloud. A setting that is
 *  there but is not an https address is refused, not skipped: signing in somewhere else would surprise whoever set it. */
export function installedWorkspace(read: RegistryReader = readInstallerSetting): { origin: string; from: string } | { error: string } {
  for (const key of INSTALLER_SETTINGS) {
    const value = read(key, WORKSPACE_VALUE);
    if (value === null || value.trim() === "") continue;
    const origin = httpsOrigin(value);
    if (!origin) return { error: `the ${WORKSPACE_VALUE} setting in ${key} is not an https address of a workspace (${value.slice(0, 100)})` };
    return { origin, from: key };
  }
  return { origin: DEFAULT_WORKSPACE, from: "default" };
}

/** The install key the installer was given (the machine's setting, then this user's), or null. Only a well-formed key is used. */
export function installedKey(read: RegistryReader = readInstallerSetting): { key: string; from: string } | null {
  for (const key of INSTALLER_SETTINGS) {
    const value = read(key, INSTALL_KEY_VALUE)?.trim() ?? "";
    if (INSTALL_KEY.test(value)) return { key: value, from: key };
  }
  return null;
}

/** Left in the Scopebond folder once the agent has started a first sign-in by itself, so it never does so twice. */
export const FIRST_SIGNIN_FILE = "first-signin.json";

export interface FirstSignInOptions {
  fetchImpl?: typeof fetch;
  open?: (url: string) => void;
  /** The coding agents to set the hook up for (default: Claude Code, and Cursor and Codex where they are installed). */
  harnesses?: Harness[];
  /** Turns autostart on (the agent's own enableAutostart); returns what it did. */
  autostart?: () => string;
  /** Called once, when the sign-in ends: connected, or why not. */
  onDone?: (outcome: { ok: true; lines: string[] } | { ok: false; error: string }) => void;
  /** The longest the agent waits for the approval, whatever the workspace says (default 15 minutes). */
  maxWaitMs?: number;
}

export interface FirstSignIn { started: ReconnectStart; cancel(): void; done: Promise<boolean> }

const textOf = (v: unknown, max = 2048): string => (typeof v === "string" ? v.slice(0, max) : "");

/** Start a first-time sign-in to `origin`. Resolves with the code and the approval page once the workspace gave them (the
 *  page is opened in the browser when it is on that workspace); the approval is waited for in the background. */
export async function startFirstSignIn(dir: string, origin: string, o: FirstSignInOptions = {}): Promise<FirstSignIn | { error: string }> {
  const fetchImpl = o.fetchImpl ?? fetch;
  const post = async (path: string, body: unknown, signal?: AbortSignal) => {
    const res = await fetchImpl(new URL(path, origin).toString(), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    });
    let json: Record<string, unknown> = {};
    try { json = await res.json() as Record<string, unknown>; } catch { /* no body */ }
    return { status: res.status, json, retryAfter: res.headers.get("retry-after") };
  };
  let start: Awaited<ReturnType<typeof post>>;
  // The machine id (a hash, never the OS id itself) lets the workspace see that a computer signing in again is the same one.
  try { start = await post("/v1/device/code", { ...clientNameField(), harness: "claude", ...machineIdField(dir, loadConnection(dir)?.organization_id) }); }
  catch (error) { return { error: `could not reach ${origin}: ${(error as Error).message}` }; }
  const deviceCode = textOf(start.json.device_code);
  const userCode = textOf(start.json.user_code, 40);
  if (start.status !== 200 || !deviceCode || !userCode) return { error: `${origin} did not start a sign-in (HTTP ${start.status})` };
  const page = textOf(start.json.verification_uri_complete) || textOf(start.json.verification_uri) || origin;
  // The approval page only when it is on the workspace signed in to; otherwise the tray shows the code alone.
  const started: ReconnectStart = { user_code: userCode, verification_url: sameOrigin(page, origin) ? page : origin };
  if (sameOrigin(page, origin)) (o.open ?? openInBrowser)(page);

  const stop = new AbortController();
  let intervalMs = Math.max(1, Math.min(60, Number(start.json.interval ?? 5) || 5)) * 1000;
  const lifetimeMs = Math.max(60, Math.min(3600, Number(start.json.expires_in ?? 600) || 600)) * 1000;
  const deadline = Date.now() + Math.min(lifetimeMs, o.maxWaitMs ?? 15 * 60_000);
  const sleep = (ms: number) => new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    stop.signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
  const finish = (outcome: Parameters<NonNullable<FirstSignInOptions["onDone"]>>[0]) => { try { o.onDone?.(outcome); } catch { /* reported by the caller */ } return outcome.ok; };

  const done = (async (): Promise<boolean> => {
    // Keys and the starter rules first, as the hook's sign-in does: the enrollment binds this computer's keys.
    try { scaffold(dir, {}); } catch (error) { return finish({ ok: false, error: `the Scopebond folder could not be set up: ${(error as Error).message}` }); }
    while (Date.now() < deadline && !stop.signal.aborted) {
      await sleep(intervalMs);
      if (stop.signal.aborted) break;
      let polled: Awaited<ReturnType<typeof post>>;
      try { polled = await post("/v1/device/token", { device_code: deviceCode }, stop.signal); }
      catch { continue; } // a passing network problem: keep waiting until the deadline
      if (polled.status === 429 || polled.status === 503) { intervalMs = Math.max(intervalMs, Math.min(300, Number(polled.retryAfter) || 10) * 1000); continue; }
      const enrollment = polled.json.enrollment;
      if (polled.status === 200 && enrollment && typeof enrollment === "object") {
        try { return finish({ ok: true, lines: await completeSetup(dir, origin, enrollment, o, approvedWorkspaceId(polled.json)) }); }
        catch (error) { return finish({ ok: false, error: `the sign-in was approved but could not be completed: ${(error as Error).message}` }); }
      }
      const error = polled.json.error;
      if (error === "authorization_pending") continue;
      if (error === "slow_down") { intervalMs += 5_000; continue; }
      if (error === "access_denied") return finish({ ok: false, error: "the sign-in was denied in the workspace; nothing was connected" });
      if (error === "expired_token") break;
      return finish({ ok: false, error: `the sign-in failed (${textOf(error, 80) || `HTTP ${polled.status}`})` });
    }
    return finish({ ok: false, error: stop.signal.aborted ? "the sign-in was stopped" : "the code expired before it was approved" });
  })();
  return { started, cancel: () => stop.abort(), done };
}

/** A first-time connection with the install key a company-wide install was given: no code and no approval. The workspace answers
 *  as a granted sign-in does, and the rest is the same first-time setup. The computer joins as unclaimed; the person on it claims
 *  it by opening their workspace from the tray. */
export async function connectWithInstallKey(dir: string, origin: string, key: string, o: FirstSignInOptions = {}): Promise<{ ok: true; lines: string[] } | { ok: false; error: string }> {
  const fetchImpl = o.fetchImpl ?? fetch;
  try { scaffold(dir, {}); } catch (error) { return { ok: false, error: `the Scopebond folder could not be set up: ${(error as Error).message}` }; }
  let res: Response;
  try {
    res = await fetchImpl(new URL("/v1/install/enroll", origin).toString(), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key, ...clientNameField() }), redirect: "error", signal: AbortSignal.timeout(15_000),
    });
  } catch (error) { return { ok: false, error: `could not reach ${origin}: ${(error as Error).message}` }; }
  let json: Record<string, unknown> = {};
  try { json = await res.json() as Record<string, unknown>; } catch { /* no body */ }
  if (res.status === 401) return { ok: false, error: "the install key was not accepted (it may have been revoked); ask whoever installed Scopebond for a new one" };
  if (res.status === 429) return { ok: false, error: "the install key has connected as many computers as it allows today; Scopebond tries again later" };
  const enrollment = json.enrollment;
  if (res.status !== 200 || !enrollment || typeof enrollment !== "object") return { ok: false, error: `${origin} did not connect this computer (HTTP ${res.status})` };
  try { return { ok: true, lines: await completeSetup(dir, origin, enrollment, o, approvedWorkspaceId(json)) }; }
  catch (error) { return { ok: false, error: `the install key was accepted but the connection could not be completed: ${(error as Error).message}` }; }
}

/** What a first-time setup does after the approval: enroll, then the hook entries and autostart. */
async function completeSetup(dir: string, origin: string, enrollment: object, o: FirstSignInOptions, workspaceId: string | null): Promise<string[]> {
  const lines: string[] = [];
  const connected = await connectCloud(dir, origin, enrollment as Parameters<typeof connectCloud>[2], o.fetchImpl, workspaceId);
  lines.push(`connected to ${connected.url}`);
  // The hook entries: the hook this agent carries, for each coding agent on this computer, where none is there yet (an
  // existing Scopebond entry is the agent's upkeep's to keep current).
  const harnesses = automaticHarnesses(o.harnesses ?? expectedHarnesses(), dir);
  for (const harness of harnesses) {
    const file = userHarnessFile(harness);
    if (isHarnessConfigured(file)) continue;
    try {
      writeHarnessConfig(file, harness, maintainedHookCommand(harness));
      lines.push(`put the Scopebond hook in ${file}`);
    } catch (error) {
      lines.push(`could not put the Scopebond hook in ${file}: ${(error as Error).message}`);
    }
  }
  // Only supported lifecycle events, still subject to each host's native review and restart requirements.
  if (observationStatus(loadConnection(dir)).state === "on") {
    for (const harness of harnesses) {
      if (harness !== "claude" && harness !== "codex") continue;
      const file = userHarnessFile(harness);
      const command = configuredHookCommands(file)[0];
      if (command) { wireLifecycleHooks(file, command, harness); lines.push(`turned on session and after-action observations in ${file}`); }
    }
  }
  if (o.autostart) {
    try { lines.push(o.autostart()); } catch (error) { lines.push(`autostart was not turned on: ${(error as Error).message}`); }
  }
  return lines;
}
