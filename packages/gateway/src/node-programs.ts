// Node-only: the full path of a program to start. Started by a bare name ("git"), a Windows spawn looks in the current
// folder before PATH unless NoDefaultCurrentDirectoryInExePath is set, which Windows does not set by default. The current
// folder of a hook, an MCP proxy or a pull request check is a project anyone can put a `git.exe` in, so the programs
// Scopebond starts are named by full path: Windows' own tools from the system folder, and anything else from PATH's
// absolute folders only. The current folder, and a relative PATH entry (which means the same), are never searched; a
// program not found there is not started.

import { accessSync, constants, lstatSync, statSync } from "node:fs";
import { posix, win32 } from "node:path";

/** Windows tools that ship in the system folder. */
export type WindowsSystemProgram = "cmd" | "conhost" | "explorer" | "icacls" | "msiexec" | "powershell" | "reg";

const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/;

/** An environment value by name; on Windows names are case-insensitive, as they are to Windows itself. */
function envValue(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== "win32") return env[name];
  if (env[name] !== undefined) return env[name];
  const upper = name.toUpperCase();
  for (const [key, value] of Object.entries(env)) if (key.toUpperCase() === upper && value !== undefined) return value;
  return undefined;
}

/** A Windows tool by its full path under the system folder: never a name looked up on PATH or in the current folder. */
export function windowsSystemProgram(name: WindowsSystemProgram, env: NodeJS.ProcessEnv = process.env): string {
  const named = envValue(env, "SystemRoot", "win32") || envValue(env, "windir", "win32") || "";
  // A relative system folder would put the current folder back in play.
  const root = /^[A-Za-z]:[\\/]/.test(named) ? named : "C:\\Windows";
  if (name === "explorer") return win32.join(root, "explorer.exe");
  if (name === "powershell") return win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return win32.join(root, "System32", `${name}.exe`);
}

/** Whether `name` names a program without any folder, so a spawn would search for it. */
export function isBareProgramName(name: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\0")) return false;
  return platform !== "win32" || !(name.includes("\\") || name.includes(":"));
}

export interface FindProgramOptions {
  /** The environment whose PATH is searched (default: this process's). Pass the child's when it has its own. */
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

/** Errors Node gives when it cannot follow a Windows reparse point it does not know how to open. */
const UNFOLLOWABLE = new Set(["EACCES", "EPERM", "EINVAL", "UNKNOWN"]);

function runnable(file: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    if (platform !== "win32") accessSync(file, constants.X_OK);
    return true;
  } catch (error) {
    // An App Execution Alias (Store Python, winget, wt in the per-user WindowsApps folder) is a reparse point Node cannot
    // follow, so it cannot be stat'ed; the shell starts it all the same, and so does a spawn of its full path. It counts when
    // the entry itself is there and is not a folder: a link that points nowhere (ENOENT) still does not.
    if (platform !== "win32" || !UNFOLLOWABLE.has((error as NodeJS.ErrnoException).code ?? "")) return false;
    try {
      const entry = lstatSync(file);
      return entry.isSymbolicLink() && !entry.isDirectory();
    } catch { return false; }
  }
}

const found = new Map<string, string>();

/** The full path of the bare program `name` in PATH's absolute folders, in PATH order, or null when there is none. On
 *  Windows the names tried in each folder are the ones a spawn tries (the name if it has an extension, then `.com`,
 *  then `.exe`). The current folder is never searched, nor is a relative PATH entry. */
export function findProgram(name: string, options: FindProgramOptions = {}): string | null {
  const platform = options.platform ?? process.platform;
  if (!isBareProgramName(name, platform)) throw new TypeError(`not a bare program name: ${JSON.stringify(name)}`);
  const pathValue = envValue(options.env ?? process.env, "PATH", platform) ?? "";
  const key = `${platform}\0${name}\0${pathValue}`;
  const known = found.get(key);
  if (known && runnable(known, platform)) return known;
  const win = platform === "win32";
  const names = win ? [...(win32.extname(name) ? [name] : []), `${name}.com`, `${name}.exe`] : [name];
  for (const entry of pathValue.split(win ? ";" : ":")) {
    const dir = win ? entry.trim().replace(/^"(.*)"$/, "$1") : entry;
    if (!(win ? WINDOWS_ABSOLUTE.test(dir) : dir.startsWith("/"))) continue;
    for (const candidate of names) {
      const file = win ? win32.join(dir, candidate) : posix.join(dir, candidate);
      if (runnable(file, platform)) { found.set(key, file); return file; }
    }
  }
  return null;
}

/** `findProgram`, or an error that names the program: for a spawn that must not start anything else. */
export function programPath(name: string, options: FindProgramOptions = {}): string {
  const file = findProgram(name, options);
  if (file === null) throw new Error(`${name} was not found in a folder on PATH (the current folder is never searched)`);
  return file;
}
