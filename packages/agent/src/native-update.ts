// Updates for the signed Windows install (the single executable from the installer). npm installs keep updating with npm.
//
// A per-user install updates itself, but only with an installer it has checked three ways: the release manifest is signed
// with the updater key (a separate Ed25519 key; its public half is built into this program), the installer's SHA-256 and
// size are the manifest's, and the installer's Authenticode signature is valid and names Avouro LLC. Anything else and
// nothing is installed: the agent says the update could not be verified. An install for every user (Program Files) never
// updates itself; the organisation that deployed it updates it.

import { createHash, createPublicKey, verify } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, win32 } from "node:path";
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

export interface VerifiedInstaller { ok: true; path: string; version: string }
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
  return { ok: true, path, version };
}

/** The native Scopebond tray the installer puts beside the single executable (`scopebond-tray.exe`), when it is there. It
 *  starts the agent at sign-in and keeps it running, so the agent leaves the tray to it. */
export function nativeTrayPath(execPath = process.execPath, single = isSingleExecutable(), exists: (path: string) => boolean = existsSync): string | null {
  if (!single) return null;
  const tray = win32.join(win32.dirname(execPath), "scopebond-tray.exe");
  return exists(tray) ? tray : null;
}

/** The helper's script: stop the native tray (it would start the agent again, and the installer replaces its file), wait
 *  for this agent to exit, install, then start the tray again (it starts the agent), or else the agent through autostart's
 *  launcher. The paths reach it as environment variables, never as code. */
export function installAfterExitScript(): string {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "if ($env:SB_TRAY) { Get-Process -Name scopebond-tray | Where-Object { $_.Path -eq $env:SB_TRAY } | Stop-Process -Force }",
    "Wait-Process -Id ([int]$env:SB_PID) -Timeout 60",
    "Start-Process -FilePath msiexec.exe -ArgumentList @('/i', ('\"' + $env:SB_MSI + '\"'), '/qn', '/norestart') -Wait",
    "if ($env:SB_TRAY) { Start-Process -FilePath $env:SB_TRAY } elseif ($env:SB_LAUNCHER) { Start-Process -FilePath cmd.exe -ArgumentList @('/d', '/s', '/c', ('\"\"' + $env:SB_LAUNCHER + '\"\"')) -WindowStyle Hidden }",
  ].join("\n");
}

/** Install it once this agent has exited, then start the tray again (or the agent through autostart's launcher). A detached
 *  helper does it, because the installer replaces this very file. */
export function installAfterExit(installer: string, pid: number, launcher: string | null, tray: string | null = null): void {
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", installAfterExitScript()], {
    detached: true, stdio: "ignore", windowsHide: true,
    env: { ...process.env, SB_PID: String(pid), SB_MSI: installer, SB_LAUNCHER: launcher ?? "", SB_TRAY: tray ?? "" },
  });
  child.on("error", () => { /* the next sign-in starts the agent */ });
  child.unref();
}
