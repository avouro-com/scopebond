// Updates of the macOS package. The package installs for every user (/usr/local/bin, which a person's agent cannot
// write), so it carries a small updater that runs as root: the LaunchDaemon com.scopebond.updater starts
// `scopebond-agent update-daemon` whenever a request appears in its requests folder.
//
//   - A person's agent, told by its workspace that a newer signed build is recommended, asks for it: a file in the
//     requests folder (writable by everyone, readable by root alone) that names a version and nothing else.
//   - The updater takes the highest version asked for, only when it is newer than the one installed and updates are not
//     turned off for the machine (the AutoUpdate preference of com.scopebond.agent, from a configuration profile or
//     /Library/Preferences). It downloads that release's signed manifest and package from the fixed release address
//     itself, into a folder only root can write, and checks them as the Windows agent checks its installer: the manifest
//     signed with an updater key built into this executable, the package's SHA-256 and size the manifest's, and the
//     package signed with Avouro LLC's Developer ID Installer identity and notarized (pkgutil, spctl). Only then does it
//     run `installer`; the package's postinstall starts the new agent for everyone signed in.
//   - It writes what happened where every agent reads it. An agent that asked compares it with its own request: a
//     package that was not installed counts as a failed update and is tried again later, as on Windows.
//
// A request can only ask for a release that is newer and signed: whoever writes one cannot name a file, an address or an
// older version.

import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchVerifiedInstaller, INSTALL_RESULT, readUpdatePending, updatesDir, type InstallResult } from "./native-update.js";
import { MAC_SETTINGS_DOMAINS, readInstallerSetting, type RegistryReader } from "./signin.js";
import { agentVersion, compareVersions } from "./update.js";

export const MAC_UPDATER_LABEL = "com.scopebond.updater";
/** The command the LaunchDaemon runs. */
export const MAC_UPDATER_COMMAND = "update-daemon";
export const MAC_UPDATER_PLIST = `/Library/LaunchDaemons/${MAC_UPDATER_LABEL}.plist`;
const SUPPORT = "/Library/Application Support/Scopebond";

/** Where the updater's files are. Tests pass their own folders. */
export interface MacUpdaterPaths {
  /** Requests from people's agents: one file per person, writable by everyone (mode 1733), readable by root alone. */
  requests: string;
  /** The updater's own folder (root only, mode 0700): it downloads and checks a release there. */
  work: string;
  /** What the updater last did, readable by everyone. */
  result: string;
}
export const MAC_UPDATER_PATHS: MacUpdaterPaths = {
  requests: `${SUPPORT}/update-requests`,
  work: `${SUPPORT}/updater`,
  result: `${SUPPORT}/update-result.json`,
};

/** The release's package for this Mac's architecture (build-pkg.mjs names it so). */
export const macPackageName = (version: string, arch: string = process.arch) => `scopebond-agent-${version}-${arch === "arm64" ? "arm64" : "x86_64"}.pkg`;

/** The signer a release package must name: Avouro LLC's Developer ID Installer identity, with its team id. */
export const MAC_INSTALLER_PUBLISHER = /^Developer ID Installer: Avouro LLC \([A-Z0-9]{10}\)$/;

/** Whether the machine lets the package update itself: the AutoUpdate preference from a configuration profile or
 *  /Library/Preferences (on unless one says false). A person's own preference does not turn it on or off. */
export function macAutoUpdate(read: RegistryReader = readInstallerSetting): boolean {
  for (const domain of MAC_SETTINGS_DOMAINS.slice(0, 2)) {
    const value = read(domain, "AutoUpdate")?.trim().toLowerCase();
    if (value === "false" || value === "0" || value === "no") return false;
    if (value === "true" || value === "1" || value === "yes") return true;
  }
  return true;
}

/** The package's signature as macOS judges it: signed with a Developer ID issued by Apple, and accepted by Gatekeeper as
 *  notarized. `subject` is the signing identity's name. */
export function macPackageSignature(file: string): { valid: boolean; subject: string } {
  const sig = spawnSync("/usr/sbin/pkgutil", ["--check-signature", file], { encoding: "utf8", timeout: 60_000 });
  const subject = /^\s*1\.\s+(.+?)\s*$/m.exec(sig.stdout ?? "")?.[1] ?? "";
  const signed = sig.status === 0 && /Status: signed by a developer certificate issued by Apple for distribution/.test(sig.stdout ?? "");
  const assess = spawnSync("/usr/sbin/spctl", ["--assess", "--type", "install", "-vv", file], { encoding: "utf8", timeout: 60_000 });
  const notarized = assess.status === 0 && /source=Notarized Developer ID/.test(`${assess.stdout ?? ""}${assess.stderr ?? ""}`);
  return { valid: signed && notarized, subject };
}

/** Ask the updater for `version`, as person `uid`. Returns null when the request is in place, else why not. */
export function requestMacUpdate(version: string, uid: number = process.getuid?.() ?? -1, paths: MacUpdaterPaths = MAC_UPDATER_PATHS): string | null {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return "not a version";
  // A new name each time (the folder cannot be listed, so nobody can take a person's name in it before them).
  try { writeFileSync(join(paths.requests, `${uid}-${randomBytes(8).toString("hex")}.json`), `${JSON.stringify({ version })}\n`); return null; }
  catch (error) { return `the Scopebond updater could not be asked (${(error as Error).message})`; }
}

/** The updater's last result, when it is for `version`. */
export function readMacUpdateResult(paths: MacUpdaterPaths = MAC_UPDATER_PATHS): InstallResult | null {
  try {
    const r = JSON.parse(readFileSync(paths.result, "utf8")) as Partial<InstallResult>;
    if (typeof r.version !== "string" || typeof r.at !== "string") return null;
    return { at: r.at, version: r.version, installed: r.installed === true, reason: typeof r.reason === "string" ? r.reason : null, exit_code: typeof r.exit_code === "number" ? r.exit_code : null, log: null };
  } catch { return null; }
}

/** Hand the updater's result to this person's update record (the file the Windows helper writes), once: when it is for
 *  the version this agent asked for and came after the request. noteUpdateOutcome then reads it as on Windows. */
export function takeMacUpdateResult(dir: string, paths: MacUpdaterPaths = MAC_UPDATER_PATHS): boolean {
  const pending = readUpdatePending(dir);
  const result = readMacUpdateResult(paths);
  if (!pending || !result || result.version !== pending.version || !(Date.parse(result.at) >= pending.at)) return false;
  try {
    mkdirSync(updatesDir(dir), { recursive: true });
    writeFileSync(join(updatesDir(dir), INSTALL_RESULT), `${JSON.stringify(result)}\n`, { mode: 0o600 });
    return true;
  } catch { return false; }
}

export interface MacUpdaterOptions {
  paths?: MacUpdaterPaths;
  running?: string;
  autoUpdate?: () => boolean;
  fetchImpl?: typeof fetch;
  /** The signature check (default: pkgutil and spctl). */
  check?: (file: string) => { valid: boolean; subject: string };
  /** Installs the package; its exit code (default: `/usr/sbin/installer -pkg <file> -target /`). */
  install?: (file: string) => number | null;
  base?: string;
  publicKey?: Parameters<typeof fetchVerifiedInstaller>[1]["publicKey"];
  now?: () => number;
  log?: (line: string) => void;
}

/** The versions people's agents asked for (the files are removed as they are read; anything else in the folder is left). */
function takeRequests(folder: string): string[] {
  const versions: string[] = [];
  let names: string[];
  try { names = readdirSync(folder); } catch { return versions; }
  for (const name of names.filter((n) => /^-?\d+-[0-9a-f]{16}\.json$/.test(n))) {
    const file = join(folder, name);
    try {
      const stat = lstatSync(file);
      if (stat.isFile() && stat.size <= 1024) {
        const v = (JSON.parse(readFileSync(file, "utf8")) as { version?: unknown }).version;
        if (typeof v === "string" && /^\d+\.\d+\.\d+$/.test(v)) versions.push(v);
      }
    } catch { /* not a request */ }
    rmSync(file, { force: true });
  }
  return versions;
}

/** One run of the updater (as root): take the requests, install the newest signed release asked for, record the result.
 *  Returns the result it recorded, or null when there was nothing to do. */
export async function runMacUpdater(o: MacUpdaterOptions = {}): Promise<InstallResult | null> {
  const paths = o.paths ?? MAC_UPDATER_PATHS;
  const log = o.log ?? ((line: string) => console.log(`${new Date().toISOString()} ${line}`));
  const now = o.now ?? Date.now;
  const running = o.running ?? agentVersion();
  const asked = takeRequests(paths.requests).sort(compareVersions).at(-1);
  if (!asked || compareVersions(asked, running) <= 0) return null;
  const record = (installed: boolean, reason: string | null, exitCode: number | null): InstallResult => {
    const result: InstallResult = { at: new Date(now()).toISOString(), version: asked, installed, reason, exit_code: exitCode, log: null };
    try { writeFileSync(paths.result, `${JSON.stringify(result)}\n`, { mode: 0o644 }); chmodSync(paths.result, 0o644); } catch { /* the asking agent times out and tries again */ }
    log(installed ? `installed the Scopebond Agent ${asked}` : `did not install the Scopebond Agent ${asked}: ${reason}`);
    return result;
  };
  if (!(o.autoUpdate ?? macAutoUpdate)()) return record(false, "updates are turned off for this Mac (AutoUpdate)", null);
  mkdirSync(paths.work, { recursive: true, mode: 0o700 });
  chmodSync(paths.work, 0o700);
  const verified = await fetchVerifiedInstaller(asked, {
    dir: paths.work, name: macPackageName(asked), publisher: MAC_INSTALLER_PUBLISHER, check: o.check ?? macPackageSignature,
    fetchImpl: o.fetchImpl, base: o.base, publicKey: o.publicKey, now: now(),
  });
  if (!verified.ok) return record(false, verified.reason, null);
  try {
    // The file installed is the file checked: it sits in root's own folder, and its digest is checked once more.
    const bytes = readFileSync(verified.path);
    if (bytes.length !== verified.size || createHash("sha256").update(bytes).digest("hex") !== verified.sha256) return record(false, "the package changed after it was checked", null);
    const code = (o.install ?? ((file: string) => spawnSync("/usr/sbin/installer", ["-pkg", file, "-target", "/"], { stdio: "inherit", timeout: 15 * 60_000 }).status))(verified.path);
    return code === 0 ? record(true, null, 0) : record(false, `installer exited with ${code}`, code);
  } finally {
    rmSync(verified.path, { force: true });
  }
}

/** Whether this computer has the package's updater. */
export function hasMacUpdater(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin" && existsSync(MAC_UPDATER_PLIST);
}
