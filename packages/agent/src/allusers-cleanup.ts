// Removal for every user. An install for every user (`msiexec … ALLUSERS=1`) is removed by an administrator or the system
// account, and the agent's `uninstall` it runs reaches that account's settings only: the hook finds its home from the
// operating system account, never from HOME or USERPROFILE, so it cannot be pointed at other people's settings. Their coding
// agents would keep calling a program that is gone.
//
// So that removal leaves behind, for each person's next sign-in, a Windows Active Setup entry and a copy of the agent in a
// folder under Program Files (only administrators can change it, so no user can replace what the others run):
//
//   scopebond-agent allusers-cleanup register   "<Program Files>\Scopebond Cleanup"   the installer, as the system account
//   scopebond-agent allusers-cleanup unregister "<Program Files>\Scopebond Cleanup"   an install for every user takes it away
//   scopebond-agent uninstall --signed-in                                              Active Setup, once per person
//
// At each person's next sign-in, Windows runs the copy's `uninstall --signed-in` as that person, with no window: the hook's
// uninstall takes Scopebond out of their coding agents' settings and tells their workspace, as a removal by them would. It
// does nothing for a person who never used Scopebond (no Scopebond folder), or when Scopebond is installed again by then.
// A new install for every user removes the entry and the copy first, so a later sign-in never takes the new install away.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmdirSync, unlinkSync } from "node:fs";
import { win32 } from "node:path";
import { windowsTool } from "./native-update.js";
import { readRegistryValue, SETTINGS_KEYS, type RegistryReader } from "./signin.js";

export const CLEANUP_COMMAND = "allusers-cleanup";
/** `uninstall` as Active Setup runs it at a person's sign-in. */
export const SIGNED_IN_FLAG = "--signed-in";
/** The folder's own name: `register` and `unregister` refuse any other, so they never write or delete elsewhere. */
export const CLEANUP_FOLDER_NAME = "Scopebond Cleanup";
export const CLEANUP_EXE = "scopebond-agent.exe";
/** This product's Active Setup entry (its own GUID, never another product's). */
export const ACTIVE_SETUP_KEY = "HKLM\\SOFTWARE\\Microsoft\\Active Setup\\Installed Components\\{6C1E2B9A-4F3D-4E8B-9A57-3D2C1B0E8F64}";

/** The folder when it is an absolute Windows path named CLEANUP_FOLDER_NAME, without quotes or a trailing separator; else
 *  null. The installer passes `[ProgramFiles64Folder]Scopebond Cleanup`. */
export function cleanupFolder(value: string | undefined): string | null {
  if (!value || value.includes("\"") || !win32.isAbsolute(value) || value.startsWith("\\\\")) return null;
  if (value.endsWith("\\") || value.endsWith("/")) return null;
  return win32.basename(value) === CLEANUP_FOLDER_NAME ? win32.normalize(value) : null;
}

/** Active Setup compares Version as up to four comma-separated numbers and runs the entry again for a person whose recorded
 *  version is lower: one from the time of the removal, so each removal runs once more for everyone. */
export function activeSetupVersion(now: Date): string {
  const p = (n: number) => String(n);
  return [now.getUTCFullYear(), (now.getUTCMonth() + 1) * 100 + now.getUTCDate(), now.getUTCHours() * 100 + now.getUTCMinutes(), now.getUTCSeconds()].map(p).join(",");
}

/** What Active Setup runs at sign-in: the copy's `uninstall --signed-in`, under `conhost --headless` so no window opens. */
export function stubPath(folder: string, conhost = windowsTool("conhost")): string {
  return `"${conhost}" --headless "${win32.join(folder, CLEANUP_EXE)}" uninstall ${SIGNED_IN_FLAG}`;
}

/** reg.exe with these arguments, in the 64-bit view; false when it failed. */
export type RegRunner = (args: string[]) => boolean;
const runReg: RegRunner = (args) => {
  try { execFileSync(windowsTool("reg"), [...args, "/reg:64"], { stdio: "ignore", windowsHide: true, timeout: 10_000 }); return true; } catch { return false; }
};

export interface CleanupFiles {
  exists: (path: string) => boolean;
  mkdir: (dir: string) => void;
  copy: (from: string, to: string) => void;
  unlink: (path: string) => void;
  rmdir: (dir: string) => void;
}
const realFiles: CleanupFiles = {
  exists: existsSync,
  mkdir: (dir) => mkdirSync(dir, { recursive: true }),
  copy: copyFileSync,
  unlink: unlinkSync,
  rmdir: rmdirSync,
};

export interface CleanupOptions {
  folder: string;
  /** This program (the installed scopebond-agent.exe). */
  self?: string;
  now?: Date;
  reg?: RegRunner;
  files?: CleanupFiles;
  conhost?: string;
  /** Program Files (default: the 64-bit one this Windows names); `register` writes only directly inside it. */
  programFiles?: string;
}

const trimmed = (path: string) => { let p = win32.normalize(path).toLowerCase(); while (p.endsWith("\\")) p = p.slice(0, -1); return p; };

/** Copy this program into the folder and write the Active Setup entry. The lines to log; throws on a failure, so the
 *  installer's log has it (the installer never stops on it). */
export function registerCleanup(o: CleanupOptions): string[] {
  const files = o.files ?? realFiles;
  const reg = o.reg ?? runReg;
  const self = o.self ?? process.execPath;
  // Only administrators can change a folder directly in Program Files: what every person's sign-in runs must not be
  // replaceable by one of them.
  const programFiles = o.programFiles ?? process.env.ProgramW6432 ?? process.env.ProgramFiles ?? "C:\\Program Files";
  if (trimmed(win32.dirname(o.folder)) !== trimmed(programFiles)) throw new Error(`${o.folder} is not directly in ${programFiles}`);
  files.mkdir(o.folder);
  files.copy(self, win32.join(o.folder, CLEANUP_EXE));
  const values: string[][] = [
    ["/ve", "/d", "Scopebond Agent: removal for each user"],
    ["/v", "StubPath", "/t", "REG_SZ", "/d", stubPath(o.folder, o.conhost)],
    ["/v", "Version", "/t", "REG_SZ", "/d", activeSetupVersion(o.now ?? new Date())],
    ["/v", "IsInstalled", "/t", "REG_DWORD", "/d", "1"],
  ];
  for (const value of values) {
    if (!reg(["add", ACTIVE_SETUP_KEY, ...value, "/f"])) throw new Error(`could not write ${ACTIVE_SETUP_KEY} (${value[1]})`);
  }
  return [`Each person's next sign-in takes Scopebond out of their coding agents' settings (${ACTIVE_SETUP_KEY}, ${win32.join(o.folder, CLEANUP_EXE)}).`];
}

/** Remove the Active Setup entry and the copy (the file, then the folder when it is empty; never anything else in it). */
export function unregisterCleanup(o: CleanupOptions): string[] {
  const files = o.files ?? realFiles;
  const reg = o.reg ?? runReg;
  const lines: string[] = [];
  if (reg(["delete", ACTIVE_SETUP_KEY, "/f"])) lines.push(`Removed ${ACTIVE_SETUP_KEY}.`);
  const exe = win32.join(o.folder, CLEANUP_EXE);
  if (files.exists(exe)) { files.unlink(exe); lines.push(`Removed ${exe}.`); }
  if (files.exists(o.folder)) {
    try { files.rmdir(o.folder); lines.push(`Removed ${o.folder}.`); } catch { lines.push(`Kept ${o.folder}: it holds other files.`); }
  }
  return lines.length ? lines : ["No removal for each user was waiting."];
}

/** At a person's sign-in: whether to run the uninstall for them. "no-folder": they never used Scopebond here (the hook
 *  writes the coding agents' settings only after setting up its folder); "installed": Scopebond is installed again (for
 *  them or for everyone) and its own program is there, so nothing is taken away. */
export function signedInCleanup(o: { dir: string; exists?: (path: string) => boolean; readValue?: RegistryReader }): "run" | "no-folder" | "installed" {
  const exists = o.exists ?? existsSync;
  if (!exists(o.dir)) return "no-folder";
  const read = o.readValue ?? readRegistryValue;
  for (const key of SETTINGS_KEYS) {
    const path = read(key, "InstallPath");
    if (path && exists(win32.join(path, CLEANUP_EXE))) return "installed";
  }
  return "run";
}

/** `scopebond-agent allusers-cleanup register|unregister <folder>` (the installer's custom actions). The exit code. */
export function runCleanupCommand(args: string[], say: (line: string) => void = console.log, o: Partial<CleanupOptions> = {}): number {
  const [action, value] = args;
  const folder = cleanupFolder(value);
  if ((action !== "register" && action !== "unregister") || !folder) {
    say(`usage: scopebond-agent ${CLEANUP_COMMAND} register|unregister "<Program Files>\\${CLEANUP_FOLDER_NAME}"`);
    return 2;
  }
  try {
    for (const line of (action === "register" ? registerCleanup : unregisterCleanup)({ ...o, folder })) say(line);
    return 0;
  } catch (error) {
    say(`Could not ${action} the removal for each user: ${(error as Error).message}`);
    return 1;
  }
}
