// What `doctor` checks on macOS for the signed program: Gatekeeper's quarantine on it, and for the installer package's
// program, that it and every folder above it can be changed by root alone (every person's hook entries run it), that its
// LaunchAgent runs the agent for this person and its root updater is in place. Each check names the
// command that fixes it. The commands it runs are injected, so the checks are tested on every platform.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { dirname } from "node:path";

/** Where the macOS installer package puts the program (in a folder only root can change; `link` is on PATH only, and was
 *  the program itself in releases before), its LaunchAgent and its root updater. */
export const MAC_PACKAGE = {
  exe: "/Library/Application Support/Scopebond/bin/scopebond-agent",
  link: "/usr/local/bin/scopebond-agent",
  label: "com.scopebond.agent",
  launchAgent: "/Library/LaunchAgents/com.scopebond.agent.plist",
  updaterPlist: "/Library/LaunchDaemons/com.scopebond.updater.plist",
  updaterExe: "/Library/PrivilegedHelperTools/com.scopebond.updater",
  uninstall: "/Library/Application Support/Scopebond/uninstall.sh",
} as const;

export interface MacCheck { name: string; ok: boolean; detail: string; fix?: string }

export interface MacCheckDeps {
  /** Run a program; its exit status (null when it could not run or did not finish) and its output. */
  run(program: string, args: string[]): { status: number | null; stdout: string };
  exists(path: string): boolean;
  /** The owner, permission bits and whether it is a link, without following one; null when it is not there. */
  owner(path: string): { uid: number; mode: number; link: boolean } | null;
  uid: number;
}

export function defaultMacCheckDeps(): MacCheckDeps {
  return {
    run(program, args) {
      try { return { status: 0, stdout: execFileSync(program, args, { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }) }; }
      catch (error) { const e = error as { status?: number | null; stdout?: string }; return { status: typeof e.status === "number" ? e.status : null, stdout: e.stdout ?? "" }; }
    },
    exists: existsSync,
    owner(path) {
      try { const st = lstatSync(path); return { uid: st.uid, mode: st.mode & 0o7777, link: st.isSymbolicLink() }; } catch { return null; }
    },
    uid: process.getuid?.() ?? -1,
  };
}

/** The checks for the signed program at `exe` on macOS. */
export function macInstallChecks(exe: string, deps: MacCheckDeps = defaultMacCheckDeps()): MacCheck[] {
  const checks: MacCheck[] = [];
  // A program downloaded by a browser carries the quarantine attribute; Gatekeeper then stops it on its first start, which
  // for a hook command means a coding agent's tool calls fail until someone opens it by hand.
  const quarantined = deps.run("/usr/bin/xattr", ["-p", "com.apple.quarantine", exe]).status === 0;
  checks.push(quarantined
    ? { name: "quarantine", ok: false, detail: `${exe} is quarantined`, fix: `macOS may stop ${exe} the first time a hook starts it: remove the quarantine with \`xattr -d com.apple.quarantine "${exe}"\`, or install the Scopebond package instead` }
    : { name: "quarantine", ok: true, detail: `${exe} is not quarantined` });
  if (exe !== MAC_PACKAGE.exe) return checks;

  // Every person's hook entries and LaunchAgent run this program: nobody but root may be able to replace it, or a folder
  // above it (a person who could would run their own program in everyone's place).
  const chain: string[] = [];
  for (let p: string = exe; ; p = dirname(p)) { chain.push(p); if (dirname(p) === p) break; }
  const loose = chain.find((p) => { const o = deps.owner(p); return !o || o.uid !== 0 || o.link || (o.mode & 0o022) !== 0; });
  checks.push(loose
    ? { name: "root-owned", ok: false, detail: `${loose} can be changed by someone other than root`, fix: `install the Scopebond package again: it puts ${exe} in a folder only root can change` }
    : { name: "root-owned", ok: true, detail: `${exe} and every folder above it can be changed by root alone` });

  // The package's LaunchAgent runs the agent for each person signed in. Off on purpose (`autostart off`) is fine; without
  // a graphical session (a remote shell) launchd has nothing to say about it.
  const domain = `gui/${deps.uid}`;
  if (!deps.exists(MAC_PACKAGE.launchAgent)) {
    checks.push({ name: "launch agent", ok: false, detail: `${MAC_PACKAGE.launchAgent} is missing`, fix: `the package's LaunchAgent is missing: install the Scopebond package again` });
  } else if (deps.run("/bin/launchctl", ["print", domain]).status !== 0) {
    checks.push({ name: "launch agent", ok: true, detail: "no graphical session for this person: the agent starts at the next sign-in" });
  } else if (deps.run("/bin/launchctl", ["print", `${domain}/${MAC_PACKAGE.label}`]).status === 0) {
    checks.push({ name: "launch agent", ok: true, detail: `${MAC_PACKAGE.label} is loaded for this person` });
  } else if (/"com\.scopebond\.agent" => (?:disabled|true)/.test(deps.run("/bin/launchctl", ["print-disabled", domain]).stdout)) {
    checks.push({ name: "launch agent", ok: true, detail: "autostart is off for this person (`scopebond-agent autostart on` starts it at sign-in)" });
  } else {
    checks.push({ name: "launch agent", ok: false, detail: `${MAC_PACKAGE.label} is not loaded for this person`, fix: `the agent is not running for you: start it with \`launchctl bootstrap ${domain} ${MAC_PACKAGE.launchAgent}\`, or \`scopebond-agent autostart on\`` });
  }

  // The root updater installs newer signed packages; without it the agent stays on this version.
  const updater = deps.exists(MAC_PACKAGE.updaterPlist) && deps.exists(MAC_PACKAGE.updaterExe);
  checks.push(updater
    ? { name: "updater", ok: true, detail: `${MAC_PACKAGE.updaterPlist} and its program are in place` }
    : { name: "updater", ok: false, detail: "the package's updater is missing", fix: "updates cannot install without the package's updater: install the Scopebond package again" });
  return checks;
}
