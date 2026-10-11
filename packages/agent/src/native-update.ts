// Updates for the signed Windows install (the single executable from the installer). npm installs keep updating with npm.
//
// A per-user install updates itself, but only with an installer it has checked three ways: the release manifest is signed
// with an updater key (a separate Ed25519 key; the public halves it trusts are built into this program, each with a key id
// and an optional last day of use, so the key can be rotated), the installer's SHA-256 and size are the manifest's, and
// the installer's Authenticode signature is valid and names Avouro LLC. The helper that runs msiexec after this agent has
// exited (a copy of this signed executable, `update-helper`) checks the digest, size and signature again from a handle that
// keeps the file from being changed, and only then starts msiexec, with a verbose log in the updates folder. Anything else
// and nothing is installed: the agent says the update could not be verified. The helper then checks that the new agent
// starts and reports its version; a version that did not install or start is recorded and not tried again for a day.
// The version comes from the workspace's `native_agent` (the newest published signed build), never its npm `agent`.
// An install for every user (Program Files) never updates itself; the organisation that deployed it updates it.

import { createHash, createPublicKey, verify } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, win32 } from "node:path";
import { isSingleExecutable } from "@scopebond/hook";
import { windowsSystemProgram, type WindowsSystemProgram } from "@scopebond/gateway/node";

/** Where the signed releases are published. */
export const RELEASE_BASE = "https://github.com/avouro-com/scopebond/releases/download";
/** The domain the updater key signs in: a manifest, never anything else. */
export const MANIFEST_DOMAIN = "scopebond:agent-release/v1\n";
/** The publisher an installer must be signed by. */
export const PUBLISHER = /(^|,\s*)O=Avouro LLC(,|$)/;

/** One trusted updater key: its id (the first 16 hex digits of the SHA-256 of its SPKI bytes), its public half (base64
 *  SPKI), and the last day it may sign (an ISO date, inclusive), or null for no end. */
export interface UpdaterKey { kid: string; key: string; not_after: string | null }

/** Set by the single executable's build from updater-keys.json (or updater-public-key.txt): a JSON list of UpdaterKey.
 *  Absent from npm builds. */
declare const __SCOPEBOND_UPDATER_KEYS__: string | undefined;

/** A public key's id: the first 16 hex digits of the SHA-256 of its SPKI bytes. */
export function keyId(publicKeyB64: string): string {
  return createHash("sha256").update(Buffer.from(publicKeyB64, "base64")).digest("hex").slice(0, 16);
}

/** The updater keys this build trusts (empty when it has none). */
export function updaterKeys(): UpdaterKey[] {
  if (typeof __SCOPEBOND_UPDATER_KEYS__ !== "string" || !__SCOPEBOND_UPDATER_KEYS__) return [];
  try { return normalizeKeys(JSON.parse(__SCOPEBOND_UPDATER_KEYS__) as unknown); } catch { return []; }
}

function normalizeKeys(value: unknown): UpdaterKey[] {
  if (typeof value === "string") return value ? [{ kid: keyId(value), key: value, not_after: null }] : [];
  if (!Array.isArray(value)) return [];
  return value.flatMap((k): UpdaterKey[] => {
    const e = k as Partial<UpdaterKey>;
    if (!e || typeof e.key !== "string" || !e.key) return [];
    return [{ kid: typeof e.kid === "string" && e.kid ? e.kid : keyId(e.key), key: e.key, not_after: typeof e.not_after === "string" ? e.not_after : null }];
  });
}

/** Whether a key may still sign at `now`: no end, or `now` is on or before its last day. An unreadable date counts as past. */
function inDate(key: UpdaterKey, now: number): boolean {
  if (key.not_after === null) return true;
  const end = /^\d{4}-\d{2}-\d{2}$/.test(key.not_after) ? Date.parse(`${key.not_after}T23:59:59.999Z`) : Date.parse(key.not_after);
  return Number.isFinite(end) && now <= end;
}

export type InstallKind = "npm" | "per-user" | "per-machine";

/** How this agent was installed: from npm, by the installer for this user, or for every user (Program Files). */
export function installKind(execPath = process.execPath, single = isSingleExecutable(), programFiles = process.env.ProgramFiles ?? "C:\\Program Files"): InstallKind {
  if (!single) return "npm";
  // The folder without trailing separators (a loop, not a regular expression, on a value from the environment).
  let folder = programFiles.toLowerCase();
  while (folder.endsWith("\\") || folder.endsWith("/")) folder = folder.slice(0, -1);
  return execPath.toLowerCase().startsWith(`${folder}\\`) ? "per-machine" : "per-user";
}

export interface ReleaseManifest { type: "scopebond:agent-release"; version: string; kid?: string; files: Array<{ name: string; sha256: string; size: number }> }

/** The manifest when its signature is one trusted, in-date updater key's over exactly these bytes, else null. A manifest
 *  that names its key id (`kid`) is checked with that key only. */
export function verifyManifest(text: string, signatureB64: string, keys: string | UpdaterKey[], now = Date.now()): ReleaseManifest | null {
  try {
    const ring = normalizeKeys(keys).filter((k) => inDate(k, now));
    if (!ring.length) return null;
    const parsed = JSON.parse(text) as ReleaseManifest;
    const named = typeof parsed?.kid === "string" ? parsed.kid : null;
    const candidates = named === null ? ring : ring.filter((k) => k.kid === named);
    const message = Buffer.from(MANIFEST_DOMAIN + text, "utf8");
    const signature = Buffer.from(signatureB64.trim(), "base64");
    const signed = candidates.some((k) => {
      try { return verify(null, message, createPublicKey({ key: Buffer.from(k.key, "base64"), format: "der", type: "spki" }), signature); }
      catch { return false; }
    });
    if (!signed) return null;
    if (parsed.type !== "scopebond:agent-release" || typeof parsed.version !== "string" || !Array.isArray(parsed.files)) return null;
    return parsed;
  } catch { return null; }
}

export const installerName = (version: string) => `scopebond-agent-${version}-x64.msi`;

/** The environment for Windows PowerShell (powershell.exe, 5.1): this one's, without `PSModulePath`, plus `extra`. An
 *  agent started from PowerShell 7 inherits its module path, and Windows PowerShell then cannot load its own security
 *  module (Get-AuthenticodeSignature), so every check would fail; without the variable it uses its own default. */
export function powershellEnv(extra: Record<string, string>, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) if (key.toLowerCase() !== "psmodulepath") env[key] = value;
  return { ...env, ...extra };
}

/** A Windows tool by its full path under the system folder, never by a name looked up on PATH or in the current folder
 *  (a spawn by bare name on Windows looks in the current folder first, and the agent is often run from a project). */
export function windowsTool(name: WindowsSystemProgram): string {
  return windowsSystemProgram(name);
}

/** The Authenticode check: Windows' own verdict on the file, and the signer's subject. */
export function authenticode(file: string): { valid: boolean; subject: string } {
  const script = `$s = Get-AuthenticodeSignature -LiteralPath $env:SB_FILE; [Console]::Out.Write((@{ status = "$($s.Status)"; subject = "$($s.SignerCertificate.Subject)" } | ConvertTo-Json -Compress))`;
  const run = spawnSync(windowsTool("powershell"), ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", env: powershellEnv({ SB_FILE: file }), windowsHide: true, timeout: 60_000 });
  try { const r = JSON.parse(run.stdout) as { status: string; subject: string }; return { valid: r.status === "Valid", subject: r.subject }; }
  catch { return { valid: false, subject: "" }; }
}

export interface VerifiedInstaller { ok: true; path: string; version: string; sha256: string; size: number }
export interface Refused { ok: false; reason: string }

/** Download the installer for `version` and check it three ways. Nothing is kept unless every check passes. */
export async function fetchVerifiedInstaller(version: string, o: {
  dir: string; fetchImpl?: typeof fetch; publicKey?: string | UpdaterKey[] | null; check?: (file: string) => { valid: boolean; subject: string }; base?: string; now?: number;
}): Promise<VerifiedInstaller | Refused> {
  const keys = o.publicKey === undefined ? updaterKeys() : o.publicKey === null ? [] : normalizeKeys(o.publicKey);
  if (!keys.length) return { ok: false, reason: "this build has no updater key" };
  if (!/^\d+\.\d+\.\d+$/.test(version)) return { ok: false, reason: "not a version" };
  const fetchImpl = o.fetchImpl ?? fetch;
  const base = `${o.base ?? RELEASE_BASE}/agent-native-v${version}`;
  const get = async (name: string): Promise<Buffer | null> => {
    try {
      const res = await fetchImpl(`${base}/${name}`, { redirect: "follow", signal: AbortSignal.timeout(5 * 60_000) });
      return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
    } catch { return null; }
  };
  const [text, signature] = await Promise.all([get(`scopebond-agent-${version}.manifest.json`), get(`scopebond-agent-${version}.manifest.json.sig`)]);
  if (!text || !signature) return { ok: false, reason: "the release has no signed manifest" };
  const manifest = verifyManifest(text.toString("utf8"), signature.toString("utf8"), keys, o.now);
  if (!manifest) return { ok: false, reason: "the release manifest is not signed by the updater key" };
  if (manifest.version !== version) return { ok: false, reason: `the manifest is for ${manifest.version}, not ${version}` };
  const entry = manifest.files.find((f) => f.name === installerName(version));
  if (!entry) return { ok: false, reason: "the manifest names no installer" };
  const bytes = await get(entry.name);
  if (!bytes) return { ok: false, reason: "the installer could not be downloaded" };
  if (bytes.length !== entry.size || createHash("sha256").update(bytes).digest("hex") !== entry.sha256) return { ok: false, reason: "the installer is not the one the manifest names" };
  const folder = updatesDir(o.dir);
  mkdirSync(folder, { recursive: true });
  const path = join(folder, entry.name);
  writeFileSync(path, bytes);
  const signed = (o.check ?? authenticode)(path);
  if (!signed.valid) return { ok: false, reason: "the installer's signature is not valid" };
  if (!PUBLISHER.test(signed.subject)) return { ok: false, reason: `the installer is signed by ${signed.subject || "someone else"}, not Avouro LLC` };
  return { ok: true, path, version, sha256: entry.sha256, size: entry.size };
}

/** Where updates are downloaded, checked and logged: `updates` in the Scopebond folder. */
export function updatesDir(dir: string): string {
  return join(dir, "updates");
}

/** msiexec's verbose log of installing `version`, beside the installer. */
export function msiLogPath(dir: string, version: string): string {
  return join(updatesDir(dir), `msi-${version}.log`);
}

/** What the helper that installs after this agent exits records, beside the installer. */
export const INSTALL_RESULT = "install-result.json";

export interface InstallResult { at: string; version: string; installed: boolean; reason: string | null; exit_code: number | null; log?: string | null }

/** The check right before installing, in Windows PowerShell (5.1) for Windows' own Authenticode verdict. It is constant
 *  text: the installer, its digest and size and the publisher rule reach it as environment variables (SB_MSI, SB_SHA256,
 *  SB_SIZE, SB_PUBLISHER), never through the script itself.
 *
 *  It opens the installer sharing it for reading only (nobody can change or delete it while the handle is open), checks
 *  its size and SHA-256 against the signed manifest's from that handle, then its Authenticode signature (valid, and the
 *  signer matches the same anchored publisher rule as the first check). It prints one JSON line, `{"ok":true}` or
 *  `{"ok":false,"reason":…}`. When the installer checks out it keeps the handle open until its standard input closes: the
 *  helper closes it once msiexec has finished, so the file checked is the file installed. Exit code 0 when it checks out,
 *  3 when it does not. */
export const INSTALLER_CHECK_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$lock = $null",
  "$reason = $null",
  "try {",
  "  $lock = New-Object IO.FileStream($env:SB_MSI, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)",
  "  if ($lock.Length -ne [long]$env:SB_SIZE) { $reason = \"the installer is $($lock.Length) bytes, not the manifest's $($env:SB_SIZE)\" }",
  "  else {",
  "    $sha = [Security.Cryptography.SHA256]::Create()",
  "    $digest = ([BitConverter]::ToString($sha.ComputeHash($lock)) -replace '-', '').ToLowerInvariant()",
  "    if ($digest -cne \"$($env:SB_SHA256)\".ToLowerInvariant()) { $reason = 'the installer changed after it was checked: its SHA-256 is not the manifest''s' }",
  "    else {",
  "      $sig = Get-AuthenticodeSignature -LiteralPath $env:SB_MSI",
  "      $subject = \"$($sig.SignerCertificate.Subject)\"",
  "      if (\"$($sig.Status)\" -ne 'Valid') { $reason = \"the installer's signature is not valid ($($sig.Status))\" }",
  "      elseif (-not ($subject -cmatch $env:SB_PUBLISHER)) { $reason = \"the installer is signed by $subject, not the expected publisher\" }",
  "    }",
  "  }",
  "} catch { $reason = \"the installer could not be checked: $($_.Exception.Message)\" }",
  "if ($reason) {",
  "  if ($lock) { $lock.Dispose() }",
  "  [Console]::Out.WriteLine((@{ ok = $false; reason = $reason } | ConvertTo-Json -Compress))",
  "  exit 3",
  "}",
  "[Console]::Out.WriteLine('{\"ok\":true}')",
  "[Console]::Out.Flush()",
  // Held until the helper says msiexec is done (it closes this standard input).
  "try { [void][Console]::In.ReadToEnd() } catch { }",
  "$lock.Dispose()",
  "exit 0",
].join("\n");

/** The check alone, as the helper runs it (INSTALLER_CHECK_SCRIPT): exit 0 when SB_MSI is still the verified installer,
 *  3 when it is not. */
export function installerRecheckScript(): string {
  return INSTALLER_CHECK_SCRIPT;
}

/** The native Scopebond tray the installer puts beside the single executable (`scopebond-tray.exe`), when it is there. It
 *  starts the agent at sign-in and keeps it running, so the agent leaves the tray to it. */
export function nativeTrayPath(execPath = process.execPath, single = isSingleExecutable(), exists: (path: string) => boolean = existsSync): string | null {
  if (!single) return null;
  const tray = win32.join(win32.dirname(execPath), "scopebond-tray.exe");
  return exists(tray) ? tray : null;
}

/** The agent's subcommand that installs an update after the agent has exited (internal; see update-helper.ts). */
export const UPDATE_HELPER_COMMAND = "update-helper";

/** The copy of this signed executable that runs as the helper: in the updates folder, named for the agent it replaces, so
 *  the installer can replace the installed file while the helper runs. */
export function helperCopyPath(dir: string, pid: number): string {
  return join(updatesDir(dir), `scopebond-update-helper-${pid}.exe`);
}

/** The helper copies an earlier update left behind (a running helper's own file cannot be removed; it is next time). */
export function removeOldHelpers(dir: string, keep: string | null = null): void {
  try {
    for (const name of readdirSync(updatesDir(dir))) {
      const file = join(updatesDir(dir), name);
      if (/^scopebond-update-helper-\d+\.exe$/.test(name) && file !== keep) rmSync(file, { force: true });
    }
  } catch { /* no updates folder, or a helper still running */ }
}

/** Everything the helper needs, as environment values for it: never on its command line, never inside a script. */
export interface HelperPlan { program: string; args: string[]; env: Record<string, string> }

/** The helper's program (the copy of this executable), its one argument and its environment (pure, so it can be tested). */
export function installHelper(installer: { path: string; version: string; sha256: string; size: number }, pid: number, launcher: string | null, o: { dir: string; publisher?: RegExp; tray?: string | null; previous?: string }): HelperPlan {
  const dir = o.dir;
  return {
    // Named from the Scopebond folder and this agent's process id only: nothing from the release reaches the command line.
    program: helperCopyPath(dir, pid),
    args: [UPDATE_HELPER_COMMAND],
    env: {
      SB_PID: String(pid),
      SB_HOME: dir,
      SB_MSI: installer.path,
      SB_VERSION: installer.version,
      SB_PREVIOUS: o.previous ?? "",
      SB_SHA256: installer.sha256,
      SB_SIZE: String(installer.size),
      SB_PUBLISHER: (o.publisher ?? PUBLISHER).source,
      SB_RESULT: join(dirname(installer.path), INSTALL_RESULT),
      SB_LOG: msiLogPath(dir, installer.version),
      SB_LAUNCHER: launcher ?? "",
      SB_TRAY: o.tray ?? "",
    },
  };
}

/** Install it once this agent has exited, then start the tray again (or the agent through autostart's launcher). The
 *  helper is this signed executable itself, from a copy in the updates folder (the installer replaces the installed file),
 *  run detached with `update-helper`; it checks the installer again first (INSTALLER_CHECK_SCRIPT), runs Windows' own
 *  msiexec by its full path with a verbose log, and checks that the new agent starts. Throws when the copy cannot be made. */
export function installAfterExit(installer: { path: string; version: string; sha256: string; size: number }, pid: number, launcher: string | null, tray: string | null, o: { dir: string; previous?: string }): void {
  const helper = installHelper(installer, pid, launcher, { tray, dir: o.dir, previous: o.previous });
  copyFileSync(process.execPath, helper.program);
  const child = spawn(helper.program, helper.args, { detached: true, stdio: "ignore", windowsHide: true, env: { ...process.env, ...helper.env } });
  child.on("error", () => { /* the next start records that the update did not finish */ });
  child.unref();
}

/** Whether the installer on disk is still the verified one: same size and SHA-256, and still validly signed by Avouro LLC. */
export function installerUnchanged(installer: Pick<VerifiedInstaller, "path" | "sha256" | "size">, check: (file: string) => { valid: boolean; subject: string } = authenticode): boolean {
  try {
    const bytes = readFileSync(installer.path);
    if (bytes.length !== installer.size || createHash("sha256").update(bytes).digest("hex") !== installer.sha256) return false;
    const signed = check(installer.path);
    return signed.valid && PUBLISHER.test(signed.subject);
  } catch { return false; }
}

/** What the last install helper recorded, once: the file is removed when read. Null when there is nothing. */
export function takeInstallResult(dir: string): InstallResult | null {
  const file = join(updatesDir(dir), INSTALL_RESULT);
  try {
    const raw = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    rmSync(file, { force: true });
    const r = JSON.parse(raw) as Partial<InstallResult>;
    return {
      at: String(r.at ?? ""), version: String(r.version ?? ""), installed: r.installed === true, reason: typeof r.reason === "string" ? r.reason : null,
      exit_code: typeof r.exit_code === "number" ? r.exit_code : null, log: typeof r.log === "string" ? r.log : null,
    };
  } catch { return null; }
}

/** Written by the agent right before it hands an update to the helper, and removed when an agent next starts and has heard
 *  how it went. One left behind for long means the helper never finished. */
export const UPDATE_PENDING_FILE = "update-pending.json";
/** How long a handed-over update may take before the agent counts it as not finished. */
export const UPDATE_PENDING_MS = 15 * 60_000;

export function writeUpdatePending(dir: string, version: string, now = Date.now()): void {
  try { writeFileSync(join(updatesDir(dir), UPDATE_PENDING_FILE), `${JSON.stringify({ version, at: now })}\n`, { mode: 0o600 }); } catch { /* best effort */ }
}

export function readUpdatePending(dir: string): { version: string; at: number } | null {
  try {
    const r = JSON.parse(readFileSync(join(updatesDir(dir), UPDATE_PENDING_FILE), "utf8")) as { version?: unknown; at?: unknown };
    return typeof r.version === "string" && typeof r.at === "number" ? { version: r.version, at: r.at } : null;
  } catch { return null; }
}

export function clearUpdatePending(dir: string): void {
  rmSync(join(updatesDir(dir), UPDATE_PENDING_FILE), { force: true });
}
