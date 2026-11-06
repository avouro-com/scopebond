// Updates of the macOS package. The package installs for every user (/Library/Application Support/Scopebond/bin, which a
// person's agent cannot write), so it carries a small updater that runs as root: the LaunchDaemon com.scopebond.updater starts
// `scopebond-agent update-daemon` whenever its requests folder is not empty (launchd's QueueDirectories, which also starts
// it again after a run while anything is left there: a request that lands while it runs is never lost, as it could be
// with WatchPaths, which drops a change made while the job runs and fires once when the job is loaded).
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
//   - After `installer` it waits for the new agent to run (health below), as the Windows helper waits for the new agent to
//     answer. When it does not, the update is recorded as failed and the release that ran before is installed again: the
//     package kept from its own install (root's folder), else that release downloaded and checked as above. Whatever
//     happens, every signed-in person's agent is started again afterwards, so a package that failed half way (the
//     preinstall stopped the agents, the postinstall never ran) does not leave anyone without one.
//   - It writes what happened where every agent reads it. An agent that asked compares it with its own request: a
//     package that was not installed counts as a failed update and is tried again later, as on Windows.
//
// A request can only ask for a release that is newer and signed: whoever writes one cannot name a file, an address or an
// older version. Anything else in the folder (another name, a directory, a link, a pipe) is never read or followed and
// never a reason to stop: it is removed, and logged, so the folder is empty after every run and launchd does not start
// the updater again for it. The folder is writable by everyone, and root alone can remove such things.

import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LABEL, MAC_PACKAGE_PLIST } from "./autostart.js";
import { fetchVerifiedInstaller, INSTALL_RESULT, MAC_PACKAGE_EXE, readUpdatePending, updatesDir, type InstallResult } from "./native-update.js";
import { MAC_SETTINGS_DOMAINS, readInstallerSetting, type RegistryReader } from "./signin.js";
import { agentVersion, compareVersions } from "./update.js";

export const MAC_UPDATER_LABEL = "com.scopebond.updater";
/** The command the LaunchDaemon runs. */
export const MAC_UPDATER_COMMAND = "update-daemon";
export const MAC_UPDATER_PLIST = `/Library/LaunchDaemons/${MAC_UPDATER_LABEL}.plist`;
/** The program the LaunchDaemon runs: the package's own copy of the executable in a folder only root can write. */
export const MAC_UPDATER_EXE = `/Library/PrivilegedHelperTools/${MAC_UPDATER_LABEL}`;
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
  /** After `installer`: null when `version` is installed and every signed-in person's agent runs it, else why not
   *  (default: macAgentHealth). */
  health?: (version: string) => Promise<string | null>;
  /** Start every signed-in person's agent (and menu-bar app) again (default: launchctl, as the postinstall does). */
  startAgain?: () => void;
}

/** A request file's text, or null: opened without following a link and without waiting on a pipe or device, and read only
 *  when what was opened is a regular file of at most 1 KiB (a link to a pipe used to hang the root updater). */
export function readRequest(file: string): string | null {
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024) return null;
    const buffer = Buffer.alloc(stat.size);
    const read = readSync(fd, buffer, 0, stat.size, 0);
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

const REQUEST_NAME = /^-?\d+-[0-9a-f]{16}\.json$/;

/** The versions people's agents asked for. The folder is left empty, since launchd starts the updater again while anything
 *  is in it: a request (a regular file under a request's name) is read and removed; anything else is removed without
 *  being read or followed (a link goes itself, never what it names) and logged. A directory that is not empty is moved
 *  whole into `strays` (root's own folder; renamed, so nothing in it is read, followed or removed), or, without `strays`,
 *  left and logged. Nothing in the folder can make this throw. */
export function takeRequests(folder: string, log: (line: string) => void = () => {}, strays?: string): string[] {
  const versions: string[] = [];
  let names: string[];
  try { names = readdirSync(folder); } catch { return versions; }
  for (const name of names) {
    const file = join(folder, name);
    try {
      const stat = lstatSync(file);
      if (REQUEST_NAME.test(name) && stat.isFile()) {
        try {
          const text = readRequest(file);
          const v = text === null ? undefined : (JSON.parse(text) as { version?: unknown }).version;
          if (typeof v === "string" && /^\d+\.\d+\.\d+$/.test(v)) versions.push(v);
        } catch { /* not a request (swapped for a link or a pipe since, unreadable, not JSON) */ }
      } else log(`removed ${name} from the requests folder: ${stat.isFile() ? "not a request" : "not a regular file"}`);
      removeEntry(file, stat.isDirectory(), name, strays);
    } catch (error) {
      log(`left ${name} in the requests folder: ${(error as Error).message}`);
    }
  }
  return versions;
}

/** Remove one entry of the requests folder, never following it: a directory with rmdir, or moved into `strays` when it
 *  is not empty; anything else with unlink (a directory swapped in since is then treated as one). */
function removeEntry(file: string, directory: boolean, name: string, strays: string | undefined): void {
  if (!directory) {
    try { unlinkSync(file); return; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; }
  }
  try { rmdirSync(file); return; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; }
  if (!strays) throw new Error("a folder that is not empty");
  mkdirSync(strays, { recursive: true, mode: 0o700 });
  renameSync(file, join(strays, `${name}-${randomBytes(8).toString("hex")}`));
}

/** The people signed in to this Mac (each one's loginwindow), as the package's scripts find them. */
export function signedInUids(): number[] {
  const ps = spawnSync("/bin/ps", ["-axo", "uid=,comm="], { encoding: "utf8", timeout: 10_000 });
  const uids = new Set<number>();
  for (const line of (ps.stdout ?? "").split("\n")) {
    const m = /^\s*(\d+)\s+(.*\/loginwindow)\s*$/.exec(line);
    if (m && m[1] !== "0") uids.add(Number(m[1]));
  }
  return [...uids];
}

const launchctl = (args: string[]) => spawnSync("/bin/launchctl", args, { encoding: "utf8", timeout: 10_000 });
const agentDisabled = (uid: number) => /"com\.scopebond\.agent"\s*=>\s*(?:disabled|true)/.test(launchctl(["print-disabled", `gui/${uid}`]).stdout ?? ""); // LABEL

/** Start the agent (and the menu-bar app, when installed) for every person signed in, as the postinstall does: a person
 *  for whom launchd has it turned off stays without it. Already running is left running. */
export function startAgentsAgain(uids: number[] = signedInUids()): void {
  const tray = "/Library/LaunchAgents/com.scopebond.tray.plist";
  for (const uid of uids) {
    if (!agentDisabled(uid)) {
      launchctl(["bootstrap", `gui/${uid}`, MAC_PACKAGE_PLIST]);
      launchctl(["kickstart", `gui/${uid}/${LABEL}`]);
    }
    if (existsSync(tray)) launchctl(["bootstrap", `gui/${uid}`, tray]);
  }
}

/** The pid launchd runs the agent as for `uid`, or null when it is not running. */
function agentPid(uid: number): number | null {
  const out = launchctl(["print", `gui/${uid}/${LABEL}`]).stdout ?? "";
  const pid = /^\s*pid = (\d+)\s*$/m.exec(out)?.[1];
  return /^\s*state = running\s*$/m.test(out) && pid ? Number(pid) : null;
}

/** Whether `version` is installed and running: the installed executable says it is that version, and every signed-in
 *  person whose agent is not turned off has it running under the same process for at least `steadyMs` (a crash restarts
 *  it after 30 seconds under a new process, so a new agent that keeps failing never counts). Root cannot ask a person's
 *  agent over its own channel (it is that person's), so launchd's view of it is what is checked. Null when healthy, else
 *  why not, once `deadlineMs` has passed. */
export async function macAgentHealth(version: string, o: { exe?: string; deadlineMs?: number; steadyMs?: number; uids?: () => number[]; pid?: (uid: number) => number | null; reports?: (exe: string) => string; sleep?: (ms: number) => Promise<void> } = {}): Promise<string | null> {
  const exe = o.exe ?? MAC_PACKAGE_EXE;
  const deadline = Date.now() + (o.deadlineMs ?? 3 * 60_000);
  const steadyMs = o.steadyMs ?? 15_000;
  const reports = o.reports ?? ((file: string) => spawnSync(file, ["--version"], { encoding: "utf8", timeout: 30_000 }).stdout ?? "");
  const pidOf = o.pid ?? agentPid;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const seen = new Map<number, { pid: number; since: number }>();
  let why: string;
  for (;;) {
    const said = reports(exe).trim();
    if (!said.startsWith(`agent/${version} `)) why = `${exe} reports ${JSON.stringify(said.slice(0, 80) || "nothing")}, not agent/${version}`;
    else {
      const waiting: number[] = [];
      for (const uid of (o.uids ?? (() => signedInUids().filter((u) => !agentDisabled(u))))()) {
        const pid = pidOf(uid);
        const before = seen.get(uid);
        if (pid === null) { seen.delete(uid); waiting.push(uid); continue; }
        if (!before || before.pid !== pid) { seen.set(uid, { pid, since: Date.now() }); waiting.push(uid); continue; }
        if (Date.now() - before.since < steadyMs) waiting.push(uid);
      }
      if (!waiting.length) return null;
      why = `the agent did not keep running for ${waiting.map((u) => `uid ${u}`).join(", ")}`;
    }
    if (Date.now() >= deadline) return why;
    await sleep(5_000);
  }
}

/** How many requested versions one run tries, newest first, before giving up (each is a download and a check). */
const MAX_CANDIDATES = 5;

/** One run of the updater (as root): take the requests, install the newest signed release asked for, check that the new
 *  agent runs (else install the one before again), record the result. Returns the result it recorded, or null when there
 *  was nothing to do. */
export async function runMacUpdater(o: MacUpdaterOptions = {}): Promise<InstallResult | null> {
  const paths = o.paths ?? MAC_UPDATER_PATHS;
  const log = o.log ?? ((line: string) => console.log(`${new Date().toISOString()} ${line}`));
  const now = o.now ?? Date.now;
  const running = o.running ?? agentVersion();
  // Every version asked for that is newer than the one running, newest first, at most MAX_CANDIDATES of them. Anyone on the
  // Mac can write a request, so the newest one may name a release that does not exist ("99.0.0"): the updater goes down the
  // list until one is published and checks out, so a made-up version never stands in the way of a real one.
  mkdirSync(paths.work, { recursive: true, mode: 0o700 });
  chmodSync(paths.work, 0o700);
  const candidates = [...new Set(takeRequests(paths.requests, log, join(paths.work, "strays")))].filter((v) => compareVersions(v, running) > 0)
    .sort(compareVersions).reverse().slice(0, MAX_CANDIDATES);
  let asked = candidates[0];
  if (!asked) return null;
  const record = (installed: boolean, reason: string | null, exitCode: number | null): InstallResult => {
    const result: InstallResult = { at: new Date(now()).toISOString(), version: asked, installed, reason, exit_code: exitCode, log: null };
    try { writeFileSync(paths.result, `${JSON.stringify(result)}\n`, { mode: 0o644 }); chmodSync(paths.result, 0o644); } catch { /* the asking agent times out and tries again */ }
    log(installed ? `installed the Scopebond Agent ${asked}` : `did not install the Scopebond Agent ${asked}: ${reason}`);
    return result;
  };
  if (!(o.autoUpdate ?? macAutoUpdate)()) return record(false, "updates are turned off for this Mac (AutoUpdate)", null);
  const check = o.check ?? macPackageSignature;
  const install = o.install ?? ((file: string) => spawnSync("/usr/sbin/installer", ["-pkg", file, "-target", "/"], { stdio: "inherit", timeout: 15 * 60_000 }).status);
  const health = o.health ?? ((version: string) => macAgentHealth(version));
  const startAgain = o.startAgain ?? (() => startAgentsAgain());
  let verified: Awaited<ReturnType<typeof fetchVerifiedInstaller>> | undefined;
  const refused: string[] = [];
  for (const version of candidates) {
    const got = await fetchVerifiedInstaller(version, {
      dir: paths.work, name: macPackageName(version), publisher: MAC_INSTALLER_PUBLISHER, check,
      fetchImpl: o.fetchImpl, base: o.base, publicKey: o.publicKey, now: now(),
    });
    if (got.ok) { asked = version; verified = got; break; }
    refused.push(`${version}: ${got.reason}`);
    log(`skipped the Scopebond Agent ${version}: ${got.reason}`);
  }
  if (!verified || !verified.ok) return record(false, refused.join("; "), null);
  // The package of the release that installed fine last time, kept for going back (root's own folder).
  const kept = join(paths.work, "installed");
  let keep = false;
  try {
    // The file installed is the file checked: it sits in root's own folder, and its digest is checked once more.
    const bytes = readFileSync(verified.path);
    if (bytes.length !== verified.size || createHash("sha256").update(bytes).digest("hex") !== verified.sha256) return record(false, "the package changed after it was checked", null);
    const code = install(verified.path);
    if (code !== 0) {
      // A package that failed part way can have stopped every agent (preinstall) without starting them (postinstall).
      startAgain();
      return record(false, `installer exited with ${code}`, code);
    }
    const unhealthy = await health(asked);
    if (unhealthy === null) {
      keep = true;
      return record(true, null, 0);
    }
    const why = `the Scopebond Agent ${asked} was installed but did not start: ${unhealthy}`;
    const back = await reinstallPrevious(running, { kept, paths, check, install, health, startAgain, o, now: now() });
    return record(false, `${why}; ${back}`, 0);
  } finally {
    if (keep) {
      try {
        mkdirSync(kept, { recursive: true, mode: 0o700 });
        for (const old of readdirSync(kept)) rmSync(join(kept, old), { force: true, recursive: true });
        renameSync(verified.path, join(kept, macPackageName(asked)));
      } catch { rmSync(verified.path, { force: true }); }
    } else rmSync(verified.path, { force: true });
  }
}

/** Install `previous` again after a release that did not start: the package kept from its own install, checked again, or
 *  else that release downloaded and checked as any update is. What happened, for the recorded result. */
async function reinstallPrevious(previous: string, d: {
  kept: string; paths: MacUpdaterPaths; check: (file: string) => { valid: boolean; subject: string }; install: (file: string) => number | null;
  health: (version: string) => Promise<string | null>; startAgain: () => void; o: MacUpdaterOptions; now: number;
}): Promise<string> {
  if (!/^\d+\.\d+\.\d+$/.test(previous) || previous === "0.0.0") { d.startAgain(); return "there is no earlier release to go back to"; }
  let file: string | null = join(d.kept, macPackageName(previous));
  let fetched = false;
  if (!existsSync(file)) {
    const got = await fetchVerifiedInstaller(previous, {
      dir: d.paths.work, name: macPackageName(previous), publisher: MAC_INSTALLER_PUBLISHER, check: d.check,
      fetchImpl: d.o.fetchImpl, base: d.o.base, publicKey: d.o.publicKey, now: d.now,
    });
    if (!got.ok) { d.startAgain(); return `going back to ${previous} did not work: ${got.reason}`; }
    file = got.path;
    fetched = true;
  } else {
    const signed = d.check(file);
    if (!signed.valid || !MAC_INSTALLER_PUBLISHER.test(signed.subject)) { d.startAgain(); return `going back to ${previous} did not work: its kept package is no longer signed by Avouro LLC`; }
  }
  try {
    const code = d.install(file);
    if (code !== 0) { d.startAgain(); return `going back to ${previous} did not work: installer exited with ${code}`; }
    const unhealthy = await d.health(previous);
    return unhealthy === null ? `Scopebond went back to ${previous}` : `${previous} was installed again but did not start either: ${unhealthy}`;
  } finally {
    if (fetched) rmSync(file, { force: true });
  }
}

/** Whether this computer has the package's updater. */
export function hasMacUpdater(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin" && existsSync(MAC_UPDATER_PLIST);
}
