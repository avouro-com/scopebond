// Deletes git can restore. A delete that reaches outside the working folder is refused by safe-shell (delete-scope.ts), but
// when every target it names is tracked and committed in a git repository, with nothing modified, staged, untracked or ignored
// under it, `git checkout` brings it back: such a delete is recorded instead of blocked. Its `program_scope` becomes
// `<program>/git_restorable`, which the safe-shell pattern lets through like a contained delete.
//
// Anything git cannot vouch for keeps today's decision: a target that does not exist, is reached through a link, is the
// repository's own top folder (it holds the history) or above it, is a drive root or the home folder, sits in no repository;
// and any git failure or a git that does not answer in time. git is started by its full path from PATH (never from the
// project, which could hold a git of its own), with the repository's file monitor switched off, and is only ever asked to read.

import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { programPath } from "@scopebond/gateway/node";
import { maskHomeFolder } from "./home-mask.js";

/** How long the whole check may take, at most: it is on a tool call's path. */
export const GIT_RESTORE_TIMEOUT_MS = 1_500;
/** The most targets one delete may name and still be checked (each takes three short git calls); more keep the block. */
export const GIT_RESTORE_MAX_TARGETS = 8;

/** Runs git with these arguments in `cwd` and gives its output, or null on any failure (or throws, which counts the same). */
export type GitRun = (args: string[], cwd: string, timeoutMs: number) => string | null;

/** The real git, read-only: no file monitor, no optional locks (`git status` writes no index), no prompt, literal pathspecs. */
const runGit: GitRun = (args, cwd, timeoutMs) => {
  try {
    return execFileSync(programPath("git"), ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", ...args], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_LITERAL_PATHSPECS: "1" },
    });
  } catch { return null; }
};

const win = process.platform === "win32";
/** A path as compared here: forward slashes, no trailing slash, and on Windows in lower case. */
function norm(p: string): string {
  let s = p.replace(/\\/g, "/");
  let end = s.length;
  while (end > 1 && s[end - 1] === "/") end--;
  s = s.slice(0, end);
  return win ? s.toLowerCase() : s;
}
/** Whether normalized `inner` is strictly below normalized `outer`. */
const strictlyBelow = (inner: string, outer: string): boolean => inner.length > outer.length + 1 && inner.startsWith(outer.endsWith("/") ? outer : `${outer}/`);

/** A target as the mapper writes it (`/x/y`, `c:/x/y`, `~/x/y`) as a path on this computer; null when it cannot be one here
 *  (a POSIX path on Windows names a folder only Git Bash knows). */
function onDisk(target: string, home: string): string | null {
  if (target.startsWith("~/")) return `${home.replace(/\\/g, "/")}/${target.slice(2)}`;
  if (/^[A-Za-z]:\//.test(target)) return win ? target : null;
  if (target.startsWith("/")) return win ? null : target;
  return null;
}

/** A path in engine form (forward slashes, a drive letter in lower case, the home folder as `~`). */
function engineForm(native: string, homes?: readonly string[]): string {
  const s = native.replace(/\\/g, "/");
  return maskHomeFolder(/^[A-Za-z]:\//.test(s) ? s[0].toLowerCase() + s.slice(1) : s, homes);
}

/** The real path of a path in engine form (`~/x`, `c:/x`, `/x`), in engine form: links followed, the spelling on disk; null
 *  when it does not exist or cannot be read. */
export function realEnginePath(path: string, options: { home?: string; homes?: readonly string[] } = {}): string | null {
  const home = options.home ?? homedir();
  const native = path === "~" ? home : onDisk(path, home);
  if (!native) return null;
  try { return engineForm(realpathSync.native(native), options.homes); } catch { return null; }
}

/** The top folder of the git repository a path (engine form) is in, in engine form; null when it is in none, git cannot tell
 *  in time, or git fails. The path need not exist: the nearest folder above it that does is asked. */
export function repositoryTop(path: string, options: { run?: GitRun; timeoutMs?: number; home?: string; homes?: readonly string[] } = {}): string | null {
  const home = options.home ?? homedir();
  let folder = onDisk(path, home);
  if (!folder) return null;
  try {
    for (let i = 0; i < 64; i++) {
      const stat = lstatSync(folder, { throwIfNoEntry: false });
      if (stat?.isDirectory()) break;
      const up = dirname(folder);
      if (up === folder) return null;
      folder = up;
    }
    const top = (options.run ?? runGit)(["rev-parse", "--show-toplevel"], folder, options.timeoutMs ?? GIT_RESTORE_TIMEOUT_MS)?.trim();
    return top ? engineForm(realpathSync.native(top), options.homes) : null;
  } catch { return null; }
}

/** Whether git can restore every target a delete names. `targets` are full paths as delete-scope.ts writes them. False when
 *  there is none, too many, or any one fails a check; false on any git failure or once the time is up. */
export function gitRestorable(targets: readonly string[], options: { run?: GitRun; timeoutMs?: number; home?: string; now?: () => number } = {}): boolean {
  if (targets.length === 0 || targets.length > GIT_RESTORE_MAX_TARGETS) return false;
  const run = options.run ?? runGit;
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? GIT_RESTORE_TIMEOUT_MS);
  const home = options.home ?? homedir();
  const ask = (args: string[], cwd: string): string | null => {
    const left = deadline - now();
    if (left <= 0) return null;
    try { return run(args, cwd, left); } catch { return null; }
  };
  try {
    const homeNorm = norm(realpathSync.native(home));
    for (const target of targets) {
      const path = onDisk(target, home);
      if (!path) return false;
      // It must exist as it is written: not a link, and no link on the way to it (its real path is its own).
      const stat = lstatSync(path, { throwIfNoEntry: false });
      if (!stat || stat.isSymbolicLink()) return false;
      const realText = realpathSync.native(path).replace(/\\/g, "/");
      const real = norm(realText);
      if (real !== norm(path)) return false;
      // Never the home folder or a folder holding it, never a drive root.
      if (real === homeNorm || strictlyBelow(homeNorm, real) || /^(?:[a-z]:)?\/?$/i.test(real)) return false;
      const folder = stat.isDirectory() ? path : dirname(path);
      const top = ask(["rev-parse", "--show-toplevel"], folder)?.trim();
      if (!top) return false;
      // Strictly inside the repository: its top folder holds the history.
      const topNorm = norm(realpathSync.native(top));
      if (!strictlyBelow(real, topNorm)) return false;
      // In the spelling on disk (the comparison above ignores case on Windows; git's paths may not).
      const relative = realText.slice(topNorm.length + 1);
      // Tracked: git lists at least one file under it.
      const tracked = ask(["ls-files", "-z", "--", relative], top);
      if (!tracked) return false;
      // Committed: nothing modified, staged, untracked or ignored under it (an ignored file is not in git either).
      const status = ask(["status", "--porcelain=v1", "-z", "--ignored=matching", "--untracked-files=all", "--", relative], top);
      if (status === null || status !== "") return false;
    }
    return true;
  } catch { return false; }
}
