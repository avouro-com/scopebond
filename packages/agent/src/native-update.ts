// Updates for the signed Windows install (the single executable from the installer). npm installs keep updating with npm.
//
// A per-user install updates itself, but only with an installer it has checked three ways: the release manifest is signed
// with the updater key (a separate Ed25519 key; its public half is built into this program), the installer's SHA-256 and
// size are the manifest's, and the installer's Authenticode signature is valid and names Avouro LLC. Anything else and
// nothing is installed: the agent says the update could not be verified. An install for every user (Program Files) never
// updates itself; the organisation that deployed it updates it.

import { createHash, createPublicKey, verify } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isSingleExecutable } from "@scopebond/hook";

/** Where the signed releases are published. */
export const RELEASE_BASE = "https://github.com/avouro-com/scopebond/releases/download";
/** The domain the updater key signs in: a manifest, never anything else. */
export const MANIFEST_DOMAIN = "scopebond:agent-release/v1\n";
/** The publisher an installer must be signed by. */
export const PUBLISHER = /(^|,\s*)O=Avouro LLC(,|$)/;

/** Set by the single executable's build from the updater's public key (base64 SPKI); absent from npm builds. */
declare const __SCOPEBOND_UPDATER_KEY__: string | undefined;

export function updaterPublicKey(): string | null {
  return typeof __SCOPEBOND_UPDATER_KEY__ === "string" && __SCOPEBOND_UPDATER_KEY__ ? __SCOPEBOND_UPDATER_KEY__ : null;
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

export interface ReleaseManifest { type: "scopebond:agent-release"; version: string; files: Array<{ name: string; sha256: string; size: number }> }

/** The manifest when its signature is the updater key's over exactly these bytes, else null. */
export function verifyManifest(text: string, signatureB64: string, publicKeyB64: string): ReleaseManifest | null {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyB64, "base64"), format: "der", type: "spki" });
    if (!verify(null, Buffer.from(MANIFEST_DOMAIN + text, "utf8"), key, Buffer.from(signatureB64.trim(), "base64"))) return null;
    const manifest = JSON.parse(text) as ReleaseManifest;
    if (manifest.type !== "scopebond:agent-release" || typeof manifest.version !== "string" || !Array.isArray(manifest.files)) return null;
    return manifest;
  } catch { return null; }
}

export const installerName = (version: string) => `scopebond-agent-${version}-x64.msi`;

/** The Authenticode check: Windows' own verdict on the file, and the signer's subject. */
export function authenticode(file: string): { valid: boolean; subject: string } {
  const script = `$s = Get-AuthenticodeSignature -LiteralPath $env:SB_FILE; [Console]::Out.Write((@{ status = "$($s.Status)"; subject = "$($s.SignerCertificate.Subject)" } | ConvertTo-Json -Compress))`;
  const run = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", env: { ...process.env, SB_FILE: file }, windowsHide: true, timeout: 60_000 });
  try { const r = JSON.parse(run.stdout) as { status: string; subject: string }; return { valid: r.status === "Valid", subject: r.subject }; }
  catch { return { valid: false, subject: "" }; }
}

export interface VerifiedInstaller { ok: true; path: string; version: string; sha256: string; size: number }
export interface Refused { ok: false; reason: string }

/** Download the installer for `version` and check it three ways. Nothing is kept unless every check passes. */
export async function fetchVerifiedInstaller(version: string, o: {
  dir: string; fetchImpl?: typeof fetch; publicKey?: string | null; check?: (file: string) => { valid: boolean; subject: string }; base?: string;
}): Promise<VerifiedInstaller | Refused> {
  const publicKey = o.publicKey === undefined ? updaterPublicKey() : o.publicKey;
  if (!publicKey) return { ok: false, reason: "this build has no updater key" };
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
  const manifest = verifyManifest(text.toString("utf8"), signature.toString("utf8"), publicKey);
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
  "      $p = Start-Process -FilePath $env:SB_MSIEXEC -ArgumentList @('/i', ('\"' + $env:SB_MSI + '\"'), '/qn', '/norestart') -Wait -PassThru",
  "      $code = [int]$p.ExitCode",
  "      if ($code -eq 0 -or $code -eq 3010) { Write-Result $true $null $code } else { Write-Result $false \"msiexec ended with exit code $code\" $code }",
  "    } catch { Write-Result $false \"msiexec could not start: $($_.Exception.Message)\" $null }",
  "  }",
  "} finally { if ($lock) { $lock.Dispose() } }",
  "if ($env:SB_LAUNCHER) { Start-Process -FilePath cmd.exe -ArgumentList @('/d', '/s', '/c', ('\"\"' + $env:SB_LAUNCHER + '\"\"')) -WindowStyle Hidden }",
].join("\n");

/** The helper's program, arguments and environment values (pure, so it can be tested). */
export function installHelper(installer: { path: string; version: string; sha256: string; size: number }, pid: number, launcher: string | null, o: { msiexec?: string; publisher?: RegExp } = {}): { program: string; args: string[]; env: Record<string, string> } {
  return {
    program: "powershell.exe",
    args: ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", INSTALL_HELPER_SCRIPT],
    env: {
      SB_PID: String(pid),
      SB_MSI: installer.path,
      SB_VERSION: installer.version,
      SB_SHA256: installer.sha256,
      SB_SIZE: String(installer.size),
      SB_PUBLISHER: (o.publisher ?? PUBLISHER).source,
      SB_RESULT: join(dirname(installer.path), INSTALL_RESULT),
      SB_MSIEXEC: o.msiexec ?? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "msiexec.exe"),
      SB_LAUNCHER: launcher ?? "",
    },
  };
}

/** Install it once this agent has exited, then start the agent again through autostart's launcher. A detached helper does it,
 *  because the installer replaces this very file; it checks the installer again first (INSTALL_HELPER_SCRIPT). */
export function installAfterExit(installer: { path: string; version: string; sha256: string; size: number }, pid: number, launcher: string | null): void {
  const helper = installHelper(installer, pid, launcher);
  const child = spawn(helper.program, helper.args, { detached: true, stdio: "ignore", windowsHide: true, env: { ...process.env, ...helper.env } });
  child.on("error", () => { /* the next sign-in starts the agent */ });
  child.unref();
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
