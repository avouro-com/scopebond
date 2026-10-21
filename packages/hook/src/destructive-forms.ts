// Destructive commands a program name alone does not tell apart from everyday ones. safe-shell judges a command by its
// `program_scope` (delete-scope.ts); for these it carries the destructive form instead of the program:
//
//   mkfs.<type> …                              mkfs (a file-system maker is judged by its family name, which the list holds)
//   crontab -r (also -ir, -u <user> -r)         crontab/remove-all (removes every scheduled job)
//   chmod|chown|chgrp -R … <system folder>      chmod/system, chown/system, chgrp/system
//
// A system folder is the whole disk (`/`, a drive), the home folder itself, a folder the system keeps its programs and
// settings in (`/etc`, `/usr`, `/bin`, `/boot`, `C:/Windows`, `C:/Program Files` … and everything in them), or one that
// holds every account or every service (`/var`, `/home`, `/opt`, `C:/Users`: the folder itself, not what is in it).
// The forms are always on the safe-shell list (`DESTRUCTIVE_FORMS`), whatever programs a rule set lists. Pure: it reads the
// command, the folder it runs in and the working folder, never the disk.

import { canonProgram, type SimpleCommand } from "./shell.js";

/** The `program_scope` values of the destructive forms, denied by safe-shell with the programs on its list. */
export const DESTRUCTIVE_FORMS: readonly string[] = ["crontab/remove-all", "chmod/system", "chown/system", "chgrp/system"];
/** What the forms deny, in the words a block message quotes. */
export const DESTRUCTIVE_FORMS_SENTENCE = "A file-system maker is judged by its family name (mkfs.<type> as mkfs), and removing every scheduled job (crontab -r) or a recursive chmod, chown or chgrp of the whole disk, the home folder or a system folder is denied whatever the list says.";

const MKFS = /^mkfs\.[a-z0-9_-]{1,32}$/;
const PERMISSIONS = new Set(["chmod", "chown", "chgrp"]);
// Folders whose whole content is the system's (POSIX top folders, Windows folders under a drive), in lower case.
const SYSTEM_TREES = new Set(["etc", "usr", "bin", "sbin", "lib", "lib32", "lib64", "libx32", "boot", "dev", "proc", "sys", "root", "system",
  "windows", "program files", "program files (x86)", "programdata"]);
// Folders that hold every account or service: the folder itself only.
const SYSTEM_HOLDERS = new Set(["var", "home", "users", "opt", "library", "applications", "private", "srv", "snap"]);

/** Whether a short-option cluster (`-ir`) sets `letter`, skipping the value an option before it takes (`-u bob`). */
function setsOption(argv: string[], letter: string, valued: string): boolean {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") return false;
    if (!/^-[A-Za-z]+$/.test(a)) continue;
    if (a.includes(letter)) return true;
    if (valued.includes(a[a.length - 1])) i++;
  }
  return false;
}

/** The folder a target names, as lower-case segments after its root, with `.` and `..` resolved: `{ home, segs }` for
 *  `~/…`, `{ home: false, segs }` for an absolute path (a drive letter is dropped), null for anything else. */
function absoluteSegments(target: string): { home: boolean; segs: string[] } | null {
  const t = target.replace(/\\/g, "/");
  const home = t === "~" || t.startsWith("~/");
  const rest = home ? t.slice(1) : /^[A-Za-z]:\//.test(t) || /^[A-Za-z]:$/.test(t) ? t.slice(2) : t.startsWith("/") ? t : null;
  if (rest === null || /[$`%*?{}]/.test(rest)) return null;
  const segs: string[] = [];
  for (const s of rest.split("/")) {
    if (s === "" || s === ".") continue;
    if (s === "..") segs.pop(); else segs.push(s.toLowerCase());
  }
  return { home, segs };
}

/** Whether a recursive permission change of `target` reaches the whole disk, the home folder or a system folder. */
function systemTarget(target: string): boolean {
  const at = absoluteSegments(target);
  if (!at) return false;
  if (at.segs.length === 0) return true;
  if (at.home) return false;
  return SYSTEM_TREES.has(at.segs[0]) || (at.segs.length === 1 && SYSTEM_HOLDERS.has(at.segs[0]));
}

/** `word` where the command runs: as written when it starts at a root or home, else under `runDir` (after the call's `cd`s)
 *  inside `cwd`. */
const placed = (word: string, runDir: string, cwd: string | undefined): string => {
  if (/^(?:[\\/]|~|[A-Za-z]:)/.test(word)) return word;
  const base = /^(?:[\\/]|~|[A-Za-z]:)/.test(runDir) ? runDir : [cwd ?? "", runDir].filter(Boolean).join("/");
  return base ? `${base}/${word}` : word;
};

/** The destructive form one simple command takes, as safe-shell judges it, or null when it is none of them. */
export function destructiveForm(sc: SimpleCommand, runDir: string, cwd?: string): string | null {
  if (sc.opaque) return null;
  const program = canonProgram(sc.program);
  if (MKFS.test(program)) return "mkfs";
  if (program === "crontab") return setsOption(sc.argv, "r", "u") ? "crontab/remove-all" : null;
  if (!PERMISSIONS.has(program)) return null;
  const recursive = sc.argv.includes("--recursive") || setsOption(sc.argv, "R", "");
  if (!recursive) return null;
  // The operands after the mode or owner (or after `--reference=…`, which takes its place).
  const operands = sc.argv.filter((a) => !a.startsWith("-"));
  const targets = sc.argv.some((a) => a.startsWith("--reference")) ? operands : operands.slice(1);
  return targets.some((t) => systemTarget(placed(t, runDir, cwd))) ? `${program}/system` : null;
}
