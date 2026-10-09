// Updates for the signed Windows install (the single executable from the installer). npm installs keep updating with npm.
//
// A per-user install updates itself, but only with an installer it has checked three ways: the release manifest is signed
// with an updater key (a separate Ed25519 key; the public halves it trusts are built into this program, each with a key id
// and an optional last day of use, so the key can be rotated), the installer's SHA-256 and size are the manifest's, and
// the installer's Authenticode signature is valid and names Avouro LLC. The helper that runs msiexec after this agent has
// exited checks the digest, size and signature again from a handle that keeps the file from being changed, and only then
// starts msiexec. Anything else and nothing is installed: the agent says the update could not be verified. An install for
// every user (Program Files) never updates itself; the organisation that deployed it updates it.

import { createHash, createPublicKey, verify } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, win32 } from "node:path";
import { isSingleExecutable } from "@scopebond/hook";

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

/** A Windows tool by its full path under the system folder, never by a name looked up on PATH. */
export function windowsTool(name: "powershell" | "msiexec" | "cmd"): string {
  const root = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  if (name === "powershell") return win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return win32.join(root, "System32", `${name}.exe`);
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
  const folder = join(o.dir, "updates");
  mkdirSync(folder, { recursive: true });
  const path = join(folder, entry.name);
  writeFileSync(path, bytes);
  const signed = (o.check ?? authenticode)(path);
  if (!signed.valid) return { ok: false, reason: "the installer's signature is not valid" };
  if (!PUBLISHER.test(signed.subject)) return { ok: false, reason: `the installer is signed by ${signed.subject || "someone else"}, not Avouro LLC` };
  return { ok: true, path, version, sha256: entry.sha256, size: entry.size };
}

/** What the helper that installs after this agent exits records, beside the installer. */
export const INSTALL_RESULT = "install-result.json";

export interface InstallResult { at: string; version: string; installed: boolean; reason: string | null; exit_code: number | null }

/** The helper's script. It is constant text: every value (the installer, its digest and size, the publisher rule, where to
 *  record the outcome) reaches it through environment variables, never through the script itself.
 *
 *  Between the download and the install the agent exits and up to a minute passes, so the helper checks the installer again
 *  right before it runs msiexec, the same way the agent did: its size and SHA-256 are the signed manifest's, its Authenticode
 *  signature is valid and its signer matches the same anchored publisher rule (PUBLISHER). It holds the file open, denying
 *  writes and deletes, from that check until msiexec has finished, so the file checked is the file installed. Any mismatch
 *  installs nothing and records why in INSTALL_RESULT; the agent is started again either way. */
export const INSTALL_HELPER_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "function Write-Result([bool] $installed, $reason, $code) {",
  "  try {",
  "    $json = [ordered]@{ at = [DateTime]::UtcNow.ToString('o'); version = $env:SB_VERSION; installed = $installed; reason = $reason; exit_code = $code } | ConvertTo-Json -Compress",
  "    [IO.File]::WriteAllText($env:SB_RESULT, $json, (New-Object Text.UTF8Encoding $false))",
  "  } catch { }",
  "}",
  // The native tray first: it would start the old agent again, and the installer replaces its file. Only this install's.
  "if ($env:SB_TRAY) { try { Get-Process -Name scopebond-tray -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $env:SB_TRAY } | Stop-Process -Force -ErrorAction SilentlyContinue } catch { } }",
  "try { Wait-Process -Id ([int]$env:SB_PID) -Timeout 60 -ErrorAction SilentlyContinue } catch { }",
  "$lock = $null",
  "$reason = $null",
  "try {",
  "  $lock = New-Object IO.FileStream($env:SB_MSI, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)",
  "  if ($lock.Length -ne [long]$env:SB_SIZE) { $reason = \"the installer is $($lock.Length) bytes, not the manifest's $($env:SB_SIZE)\" }",
  "  else {",
  "    $sha = [Security.Cryptography.SHA256]::Create()",
  "    $digest = ([BitConverter]::ToString($sha.ComputeHash($lock)) -replace '-', '').ToLowerInvariant()",
  "    if ($digest -cne $env:SB_SHA256.ToLowerInvariant()) { $reason = 'the installer changed after it was checked: its SHA-256 is not the manifest''s' }",
  "    else {",
  "      $sig = Get-AuthenticodeSignature -LiteralPath $env:SB_MSI",
  "      $subject = \"$($sig.SignerCertificate.Subject)\"",
  "      if (\"$($sig.Status)\" -ne 'Valid') { $reason = \"the installer's signature is not valid ($($sig.Status))\" }",
  "      elseif (-not ($subject -cmatch $env:SB_PUBLISHER)) { $reason = \"the installer is signed by $subject, not the expected publisher\" }",
  "    }",
  "  }",
  "} catch { $reason = \"the installer could not be checked: $($_.Exception.Message)\" }",
  "try {",
  "  if ($reason) { Write-Result $false $reason $null }",
  "  else {",
  "    try {",
  // Windows' own msiexec by its full path (SB_MSIEXEC only replaces it in tests).
  "      $msiexec = if ($env:SB_MSIEXEC) { $env:SB_MSIEXEC } else { Join-Path $env:SystemRoot 'System32\\msiexec.exe' }",
  "      $p = Start-Process -FilePath $msiexec -ArgumentList @('/i', ('\"' + $env:SB_MSI + '\"'), '/qn', '/norestart') -Wait -PassThru",
  "      $code = [int]$p.ExitCode",
  "      if ($code -eq 0 -or $code -eq 3010) { Write-Result $true $null $code } else { Write-Result $false \"msiexec ended with exit code $code\" $code }",
  "    } catch { Write-Result $false \"msiexec could not start: $($_.Exception.Message)\" $null }",
  "  }",
  "} finally { if ($lock) { $lock.Dispose() } }",
  // Installed or not, the tray starts again (it starts the agent), or else the agent through autostart's launcher.
  "if ($env:SB_TRAY) { Start-Process -FilePath $env:SB_TRAY } elseif ($env:SB_LAUNCHER) { Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\\cmd.exe') -ArgumentList @('/d', '/s', '/c', ('\"\"' + $env:SB_LAUNCHER + '\"\"')) -WindowStyle Hidden }",
].join("\n");

/** The helper's script (INSTALL_HELPER_SCRIPT): stop the native tray, wait for this agent to exit, check the installer
 *  again, install, then start the tray again (or the agent through autostart's launcher). */
export function installAfterExitScript(): string {
  return INSTALL_HELPER_SCRIPT;
}

/** The native Scopebond tray the installer puts beside the single executable (`scopebond-tray.exe`), when it is there. It
 *  starts the agent at sign-in and keeps it running, so the agent leaves the tray to it. */
export function nativeTrayPath(execPath = process.execPath, single = isSingleExecutable(), exists: (path: string) => boolean = existsSync): string | null {
  if (!single) return null;
  const tray = win32.join(win32.dirname(execPath), "scopebond-tray.exe");
  return exists(tray) ? tray : null;
}

/** The helper's program, arguments and environment values (pure, so it can be tested). */
export function installHelper(installer: { path: string; version: string; sha256: string; size: number }, pid: number, launcher: string | null, o: { msiexec?: string; publisher?: RegExp; tray?: string | null } = {}): { program: string; args: string[]; env: Record<string, string> } {
  return {
    program: windowsTool("powershell"),
    args: ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", INSTALL_HELPER_SCRIPT],
    env: {
      SB_PID: String(pid),
      SB_MSI: installer.path,
      SB_VERSION: installer.version,
      SB_SHA256: installer.sha256,
      SB_SIZE: String(installer.size),
      SB_PUBLISHER: (o.publisher ?? PUBLISHER).source,
      SB_RESULT: join(dirname(installer.path), INSTALL_RESULT),
      SB_MSIEXEC: o.msiexec ?? windowsTool("msiexec"),
      SB_LAUNCHER: launcher ?? "",
      SB_TRAY: o.tray ?? "",
    },
  };
}

/** Install it once this agent has exited, then start the tray again (or the agent through autostart's launcher). A detached
 *  helper does it, because the installer replaces this very file; it checks the installer again first (INSTALL_HELPER_SCRIPT). */
export function installAfterExit(installer: { path: string; version: string; sha256: string; size: number }, pid: number, launcher: string | null, tray: string | null = null): void {
  const helper = installHelper(installer, pid, launcher, { tray });
  const child = spawn(helper.program, helper.args, { detached: true, stdio: "ignore", windowsHide: true, env: powershellEnv(helper.env) });
  child.on("error", () => { /* the next sign-in starts the agent */ });
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

/** PowerShell that opens $env:SB_MSI so nobody can change it while the handle is open, checks its size ($env:SB_SIZE),
 *  SHA-256 ($env:SB_SHA256) and Authenticode signature (valid, Avouro LLC), and runs `whenGood` only if all hold. */
function recheck(whenGood: string[]): string[] {
  return [
    "$ok = $false",
    "$f = $null",
    "try {",
    "  $f = [System.IO.File]::Open($env:SB_MSI, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)",
    "  if ($f.Length -eq [int64]$env:SB_SIZE) {",
    "    $sha = [System.Security.Cryptography.SHA256]::Create()",
    "    $h = -join ($sha.ComputeHash($f) | ForEach-Object { $_.ToString('x2') })",
    "    if ($h -eq $env:SB_SHA256) {",
    "      $s = Get-AuthenticodeSignature -LiteralPath $env:SB_MSI",
    "      $ok = (\"$($s.Status)\" -eq 'Valid') -and (\"$($s.SignerCertificate.Subject)\" -match '(^|,\\s*)O=Avouro LLC(,|$)')",
    "    }",
    "  }",
    ...whenGood.map((line) => `  if ($ok) { ${line} }`),
    "} catch { $ok = $false } finally { if ($f) { $f.Dispose() } }",
  ];
}

/** The helper's check alone: exit 0 when $env:SB_MSI is still the verified installer, 3 when it is not. */
export function installerRecheckScript(): string {
  return [...recheck([]), "if ($ok) { exit 0 } else { exit 3 }"].join("\n");
}

/** The helper script that installs after this agent exits (INSTALL_HELPER_SCRIPT). */
export function installHelperScript(): string {
  return INSTALL_HELPER_SCRIPT;
}

/** What the last install helper recorded, once: the file is removed when read. Null when there is nothing. */
export function takeInstallResult(dir: string): InstallResult | null {
  const file = join(dir, "updates", INSTALL_RESULT);
  try {
    const raw = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    rmSync(file, { force: true });
    const r = JSON.parse(raw) as Partial<InstallResult>;
    return { at: String(r.at ?? ""), version: String(r.version ?? ""), installed: r.installed === true, reason: typeof r.reason === "string" ? r.reason : null, exit_code: typeof r.exit_code === "number" ? r.exit_code : null };
  } catch { return null; }
}
