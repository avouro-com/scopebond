// Updates of the macOS package. The package installs for every user (/Library/PrivilegedHelperTools, which a person's
// agent cannot write), so it carries a small updater that runs as root: the LaunchDaemon com.scopebond.updater starts
// `scopebond-agent update-daemon` whenever a request appears in its requests folder.
//
//   - A person's agent, told by its workspace that a newer signed build is recommended, asks for it: a file in the
//     requests folder (writable by everyone, readable by root alone) that names a version and nothing else.
//   - The updater counts one request per person (the file's owner, which the system sets), and tries the versions asked
//     for newest first. It considers only versions newer than the one installed, when updates are not turned off for the
//     machine (the AutoUpdate preference of com.scopebond.agent, from a configuration profile or /Library/Preferences)
//     and not above the machine's MaxVersion preference there. A version with no signed release (a request for
//     99.0.0) is passed over for the next one asked for, so it cannot keep a real release from installing. It downloads
//     that release's signed manifest and package from the fixed release address itself, into a folder only root can
//     write, and checks them as the Windows agent checks its installer: the manifest signed with an updater key built
//     into this executable, the package's SHA-256 and size the manifest's, and the package signed with Avouro LLC's
//     Developer ID Installer identity and notarized (pkgutil, spctl). Only then does it run `installer`; the package's
//     postinstall starts the new agent for everyone signed in.
//   - It then checks the new agent starts: the installed program answers with the new version, and launchd keeps the
//     agent running for each person it is loaded for. If not, it installs the release that ran before again (fetched and
//     checked the same way), as the Windows update helper does.
//   - It writes what happened where every agent reads it. An agent that asked compares it with its own request: a
//     package that was not installed, or that did not start and was rolled back, counts as a failed update and is tried
//     again later, as on Windows.
//
// A request can only ask for a release that is newer and signed: whoever writes one cannot name a file, an address or an
// older version.

import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchVerifiedInstaller, INSTALL_RESULT, MAC_PACKAGE_EXE, readUpdatePending, updatesDir, type InstallResult, type VerifiedInstaller } from "./native-update.js";
import { MAC_SETTINGS_DOMAINS, readInstallerSetting, type RegistryReader } from "./signin.js";
import { agentVersion, compareVersions } from "./update.js";

export const MAC_UPDATER_LABEL = "com.scopebond.updater";
/** The command the LaunchDaemon runs. */
export const MAC_UPDATER_COMMAND = "update-daemon";
export const MAC_UPDATER_PLIST = `/Library/LaunchDaemons/${MAC_UPDATER_LABEL}.plist`;
/** The program the LaunchDaemon runs: the package's own copy of the executable in a folder only root can write. */
export const MAC_UPDATER_EXE = `/Library/PrivilegedHelperTools/${MAC_UPDATER_LABEL}`;
const SUPPORT = "/Library/Application Support/Scopebond";
/** The agent's LaunchAgent label, as the package installs it (autostart.ts's LABEL). */
const AGENT_LABEL = "com.scopebond.agent";
const VERSION = /^\d+\.\d+\.\d+$/;

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

/** At most this many different versions are tried in one run (each one asked for by a different person). */
const MAC_UPDATE_CANDIDATES = 4;
/** How long the new agent has to start and keep running after the package is installed (as on Windows). */
export const MAC_UPDATE_START_DEADLINE_MS = 3 * 60_000;

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

/** The newest version the package may update itself to, or null for no limit: the MaxVersion preference from a
 *  configuration profile or /Library/Preferences (an organization's pin, which the root updater enforces whatever a
 *  request asks for). A value that is not a version allows no update at all ("0.0.0"); a person's own preference
 *  changes nothing. */
export function macMaxVersion(read: RegistryReader = readInstallerSetting): string | null {
  for (const domain of MAC_SETTINGS_DOMAINS.slice(0, 2)) {
    const value = read(domain, "MaxVersion")?.trim();
    if (value) return VERSION.test(value) ? value : "0.0.0";
  }
  return null;
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
  if (!VERSION.test(version)) return "not a version";
  // A new name each time (the folder cannot be listed, so nobody can take a person's name in it before them).
  try { writeFileSync(join(paths.requests, `${uid}-${randomBytes(8).toString("hex")}.json`), `${JSON.stringify({ version })}\n`); return null; }
  catch (error) { return `the Scopebond updater could not be asked (${(error as Error).message})`; }
}

/** The updater's last result, when it is for `version`. */
export function readMacUpdateResult(paths: MacUpdaterPaths = MAC_UPDATER_PATHS): InstallResult | null {
  try {
    const r = JSON.parse(readFileSync(paths.result, "utf8")) as Partial<InstallResult>;
    if (typeof r.version !== "string" || typeof r.at !== "string") return null;
    return {
      at: r.at, version: r.version, installed: r.installed === true, reason: typeof r.reason === "string" ? r.reason : null, exit_code: typeof r.exit_code === "number" ? r.exit_code : null, log: null,
      ...(typeof r.rolled_back_to === "string" && VERSION.test(r.rolled_back_to) ? { rolled_back_to: r.rolled_back_to } : {}),
    };
  } catch { return null; }
}

/** The last updater result this person's agent took (its time), so a result is taken once. */
const MAC_RESULT_SEEN_FILE = "mac-update-result-seen";

/** Hand the updater's result to this person's update record (the file the Windows helper writes), once: when it is for
 *  the version this agent asked for and came after the request, or when it went back to this agent's version (the new
 *  agent may have started, cleared the request, then not kept running). noteUpdateOutcome then reads it as on Windows. */
export function takeMacUpdateResult(dir: string, paths: MacUpdaterPaths = MAC_UPDATER_PATHS, running: string = agentVersion()): boolean {
  const pending = readUpdatePending(dir);
  const result = readMacUpdateResult(paths);
  if (!result) return false;
  let seen: string | null = null;
  try { seen = readFileSync(join(updatesDir(dir), MAC_RESULT_SEEN_FILE), "utf8").trim(); } catch { /* none taken yet */ }
  if (seen === result.at) return false;
  const asked = pending !== null && result.version === pending.version && Date.parse(result.at) >= pending.at;
  const rolledBackHere = pending === null && result.rolled_back_to === running;
  if (!asked && !rolledBackHere) return false;
  try {
    mkdirSync(updatesDir(dir), { recursive: true });
    writeFileSync(join(updatesDir(dir), INSTALL_RESULT), `${JSON.stringify(result)}\n`, { mode: 0o600 });
    writeFileSync(join(updatesDir(dir), MAC_RESULT_SEEN_FILE), `${result.at}\n`, { mode: 0o600 });
    return true;
  } catch { return false; }
}

/** What the start check runs. Tests pass their own. */
export interface StartCheckDeps {
  run(program: string, args: string[]): { status: number | null; stdout: string };
  sleep(ms: number): Promise<void>;
  now(): number;
}
const systemStartDeps: StartCheckDeps = {
  run(program, args) {
    const r = spawnSync(program, args, { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "ignore"] });
    return { status: r.status, stdout: r.stdout ?? "" };
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

/** launchd's view of a job, from `launchctl print`: whether it is running, and its process id. */
export function launchdJob(text: string): { running: boolean; pid: number | null } {
  const state = /^\s*state = (\S+)/m.exec(text)?.[1];
  const pid = Number(/^\s*pid = (\d+)/m.exec(text)?.[1]);
  return { running: state === "running", pid: Number.isInteger(pid) && pid > 0 ? pid : null };
}

/** The people signed in to this Mac at the screen (a loginwindow of theirs), as the package's scripts find them. */
function signedInUsers(deps: StartCheckDeps): number[] {
  const out = deps.run("/bin/ps", ["-axo", "uid=,comm="]).stdout;
  const uids = new Set<number>();
  for (const line of out.split("\n")) {
    const [uid, comm] = line.trim().split(/\s+/, 2);
    if (Number(uid) > 0 && /\/loginwindow$/.test(comm ?? "")) uids.add(Number(uid));
  }
  return [...uids];
}

/** Whether the agent `version` started after the package was installed: null when it did, else why not. The installed
 *  program must answer `--version` with that version, and for each person signed in whose launchd has the agent's
 *  LaunchAgent loaded (postinstall started it; a person with autostart off has none), launchd must keep the same agent
 *  process running across `settleMs` (one that crashes and is restarted every 30 s does not count) within the deadline. */
export async function macAgentStarted(version: string, o: { exe?: string; label?: string; deadlineMs?: number; settleMs?: number; deps?: StartCheckDeps } = {}): Promise<string | null> {
  const deps = o.deps ?? systemStartDeps;
  const exe = o.exe ?? MAC_PACKAGE_EXE, label = o.label ?? AGENT_LABEL;
  const deadlineMs = o.deadlineMs ?? MAC_UPDATE_START_DEADLINE_MS, settleMs = o.settleMs ?? 10_000;
  const answered = deps.run(exe, ["--version"]);
  if (answered.status !== 0 || !answered.stdout.startsWith(`agent/${version} `)) {
    return `${exe} did not answer as ${version} (${answered.stdout.trim().slice(0, 200) || `exit code ${answered.status}`})`;
  }
  const until = deps.now() + deadlineMs;
  for (const uid of signedInUsers(deps)) {
    const job = `gui/${uid}/${label}`;
    if (deps.run("/bin/launchctl", ["print", job]).status !== 0) continue;
    for (;;) {
      const first = launchdJob(deps.run("/bin/launchctl", ["print", job]).stdout);
      if (first.running && first.pid !== null) {
        await deps.sleep(settleMs);
        const second = launchdJob(deps.run("/bin/launchctl", ["print", job]).stdout);
        if (second.running && second.pid === first.pid) break;
      }
      if (deps.now() >= until) return `the agent did not keep running for user ${uid} within ${Math.round(deadlineMs / 60_000)} minutes`;
      await deps.sleep(2_000);
    }
  }
  return null;
}

export interface MacUpdaterOptions {
  paths?: MacUpdaterPaths;
  running?: string;
  autoUpdate?: () => boolean;
  /** The machine's cap on the version installed (default: the MaxVersion preference). */
  maxVersion?: () => string | null;
  fetchImpl?: typeof fetch;
  /** The signature check (default: pkgutil and spctl). */
  check?: (file: string) => { valid: boolean; subject: string };
  /** Installs the package; its exit code (default: `/usr/sbin/installer -pkg <file> -target /`). */
  install?: (file: string) => number | null;
  /** Whether the agent of that version started once installed: null when it did, else why not (default: macAgentStarted). */
  started?: (version: string) => Promise<string | null>;
  /** Whom a request counts for (default: the file's owner). Tests, which cannot make files as other people, stand in for
   *  several people with it. */
  ownerOf?: (file: string, owner: number) => number;
  base?: string;
  publicKey?: Parameters<typeof fetchVerifiedInstaller>[1]["publicKey"];
  now?: () => number;
  log?: (line: string) => void;
}

/** A request file's text, owner and time, or null: opened without following a link and without waiting on a pipe or
 *  device, and read only when what was opened is a regular file of at most 1 KiB (a link to a pipe used to hang the root
 *  updater). */
function openRequest(file: string): { text: string; owner: number; at: number } | null {
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024) return null;
    const buffer = Buffer.alloc(stat.size);
    const read = readSync(fd, buffer, 0, stat.size, 0);
    return { text: buffer.subarray(0, read).toString("utf8"), owner: stat.uid, at: stat.mtimeMs };
  } finally {
    closeSync(fd);
  }
}

/** A request file's text, or null (see openRequest). */
export function readRequest(file: string): string | null {
  return openRequest(file)?.text ?? null;
}

/** The versions people's agents asked for: one per person, their latest. A person is the file's owner, which the system
 *  sets when the file is made (the number in its name is the writer's own choice), so one person cannot ask many times
 *  over. Request files are removed as they are read. Anything that is not a regular file is never read: a folder is left
 *  where it is, and one that cannot be removed does not stop the others (a folder named like a request used to make
 *  every later run fail). Anything without a request's name is left. */
function takeRequests(folder: string, ownerOf: (file: string, owner: number) => number = (_file, owner) => owner): string[] {
  const latest = new Map<number, { version: string; at: number }>();
  let names: string[];
  try { names = readdirSync(folder); } catch { return []; }
  for (const name of names.filter((n) => /^-?\d+-[0-9a-f]{16}\.json$/.test(n))) {
    const file = join(folder, name);
    let isFile: boolean;
    try {
      const stat = lstatSync(file);
      if (stat.isDirectory()) continue;
      isFile = stat.isFile();
    } catch { continue; }
    if (isFile) {
      try {
        const request = openRequest(file);
        const v = request === null ? undefined : (JSON.parse(request.text) as { version?: unknown } | null)?.version;
        if (request && typeof v === "string" && VERSION.test(v)) {
          const person = ownerOf(file, request.owner);
          const seen = latest.get(person);
          if (!seen || request.at >= seen.at) latest.set(person, { version: v, at: request.at });
        }
      } catch { /* not a request (swapped for a link or a pipe since, unreadable, not JSON) */ }
    }
    // unlink, never a recursive removal: a link goes, not what it points to; a folder swapped in since stays.
    try { unlinkSync(file); } catch { /* left; the next run passes over it the same way */ }
  }
  return [...latest.values()].map((r) => r.version);
}

/** One run of the updater (as root): take the requests, install the newest signed release asked for, check it starts
 *  (going back to the version that ran before when it does not), record the result. Returns the result it recorded, or
 *  null when there was nothing to do. */
export async function runMacUpdater(o: MacUpdaterOptions = {}): Promise<InstallResult | null> {
  const paths = o.paths ?? MAC_UPDATER_PATHS;
  const log = o.log ?? ((line: string) => console.log(`${new Date().toISOString()} ${line}`));
  const now = o.now ?? Date.now;
  const running = o.running ?? agentVersion();
  const newer = [...new Set(takeRequests(paths.requests, o.ownerOf))].filter((v) => compareVersions(v, running) > 0).sort(compareVersions).reverse();
  if (!newer.length) return null;
  const record = (version: string, installed: boolean, reason: string | null, exitCode: number | null, rolledBackTo?: string | null): InstallResult => {
    const result: InstallResult = { at: new Date(now()).toISOString(), version, installed, reason, exit_code: exitCode, log: null, ...(rolledBackTo !== undefined ? { rolled_back_to: rolledBackTo } : {}) };
    try { writeFileSync(paths.result, `${JSON.stringify(result)}\n`, { mode: 0o644 }); chmodSync(paths.result, 0o644); } catch { /* the asking agent times out and tries again */ }
    log(installed ? `installed the Scopebond Agent ${version}` : `did not install the Scopebond Agent ${version}: ${reason}`);
    return result;
  };
  if (!(o.autoUpdate ?? macAutoUpdate)()) return record(newer[0], false, "updates are turned off for this Mac (AutoUpdate)", null);
  const cap = (o.maxVersion ?? macMaxVersion)();
  const allowed = cap === null ? newer : newer.filter((v) => compareVersions(v, cap) <= 0);
  if (!allowed.length) return record(newer[0], false, `this Mac allows no version newer than ${cap} (MaxVersion)`, null);
  mkdirSync(paths.work, { recursive: true, mode: 0o700 });
  chmodSync(paths.work, 0o700);
  const fetchRelease = (version: string) => fetchVerifiedInstaller(version, {
    dir: paths.work, name: macPackageName(version), publisher: MAC_INSTALLER_PUBLISHER, check: o.check ?? macPackageSignature,
    fetchImpl: o.fetchImpl, base: o.base, publicKey: o.publicKey, now: now(),
  });
  /** Install a checked package; its exit code, or why it was not run. */
  const installChecked = (verified: VerifiedInstaller): { code: number | null } | { refused: string } => {
    try {
      // The file installed is the file checked: it sits in root's own folder, and its digest is checked once more.
      const bytes = readFileSync(verified.path);
      if (bytes.length !== verified.size || createHash("sha256").update(bytes).digest("hex") !== verified.sha256) return { refused: "the package changed after it was checked" };
      return { code: (o.install ?? ((file: string) => spawnSync("/usr/sbin/installer", ["-pkg", file, "-target", "/"], { stdio: "inherit", timeout: 15 * 60_000 }).status))(verified.path) };
    } finally {
      try { unlinkSync(verified.path); } catch { /* already gone */ }
    }
  };
  const started = o.started ?? ((version: string) => macAgentStarted(version));
  const candidates = allowed.slice(0, MAC_UPDATE_CANDIDATES);
  for (const [i, version] of candidates.entries()) {
    const verified = await fetchRelease(version);
    if (!verified.ok) {
      // Asked for, but not a release (someone asked for 99.0.0): the next version asked for is tried.
      if (verified.notARelease && i < candidates.length - 1) { log(`passed over the Scopebond Agent ${version}, asked for on this Mac: ${verified.reason}`); continue; }
      return record(version, false, verified.reason, null);
    }
    const ran = installChecked(verified);
    if ("refused" in ran) return record(version, false, ran.refused, null);
    if (ran.code !== 0) return record(version, false, `installer exited with ${ran.code}`, ran.code);
    const problem = await started(version);
    if (problem === null) return record(version, true, null, 0);
    // Installed but not running: back to the version that ran before, fetched and checked like any update.
    const why = `the Scopebond Agent ${version} was installed but did not start: ${problem}`;
    log(why);
    if (!VERSION.test(running) || running === version) return record(version, false, why, 0, null);
    const failed = (step: string) => record(version, false, `${why}; going back to ${running} did not work: ${step}`, 0, null);
    const previous = await fetchRelease(running);
    if (!previous.ok) return failed(previous.reason);
    const back = installChecked(previous);
    if ("refused" in back) return failed(back.refused);
    if (back.code !== 0) return failed(`installer exited with ${back.code}`);
    const again = await started(running);
    if (again !== null) return failed(`${running} was installed again but did not start: ${again}`);
    return record(version, false, `${why}; Scopebond went back to ${running}`, 0, running);
  }
  return null;
}

/** Whether this computer has the package's updater. */
export function hasMacUpdater(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin" && existsSync(MAC_UPDATER_PLIST);
}
