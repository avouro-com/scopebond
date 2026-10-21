// What a delete reaches. The safe-shell rule used to judge a delete by its program alone: `rm -rf node_modules` was refused
// like `rm -rf ~`. A delete is now judged by its targets too. When every target it names is inside the working folder (a
// relative path that stays inside it after any `cd` in the same command, and is neither the working folder itself, `.git`
// nor a protected place), is a build or cache folder (`node_modules`, `dist`, `*.log` …) anywhere inside it, or is under the
// temp folder, the command's `program_scope` carries `<program>/contained`, which the safe-shell pattern lets through. Any
// other delete keeps `program_scope` equal to its program and is refused as before: `~`, `/`, a drive root, an absolute
// path outside the working folder, a `..` that climbs out, a whole-folder wildcard at its top (`rm -rf *`), a target only
// known at run time (`$VAR`, `$(…)`, `{}` from find or xargs) and a delete with no target at all.
//
// Pure and deterministic, like the mapper: it reads the command text and the working folder it is given, never the disk.

import { trimChars } from "./text.js";
import type { Mapped } from "./map.js";
import { canonProgram, decomposeShell, type SimpleCommand } from "./shell.js";

/** The programs that remove the files and folders they are given, in their canonical spelling (canonProgram). POSIX
 *  (rm, rmdir, unlink), cmd (del, erase, rd, rmdir, deltree) and PowerShell (Remove-Item and its aliases). */
export const DELETE_PROGRAMS: ReadonlySet<string> = new Set(["rm", "rmdir", "unlink", "del", "erase", "rd", "deltree", "remove-item", "ri"]);

/** What follows the program in `program_scope` when every target of a delete is contained. */
export const CONTAINED_SUFFIX = "/contained";

/** Build and cache output a delete may remove anywhere inside the working folder (a log file by its `.log` ending). */
export const BUILD_OUTPUT: readonly string[] = ["node_modules", "dist", "build", "out", ".next", "coverage", "target", ".turbo", ".cache", "tmp"];

export type DeleteScope = "contained" | "outside" | "protected" | "unknown" | "none";

export interface DeleteVerdict {
  scope: DeleteScope;
  /** For a contained delete: each target as a path (relative to the working folder, or under the temp folder), so the
   *  file rules judge it as a write. */
  paths: string[];
  /** For a delete that reaches outside the working folder: each target that is not contained, as a full path (`/x/y`,
   *  `c:/x/y`, `~/x/y`) with `.` and `..` resolved, when every one of them could be read and none is a root, holds a
   *  wildcard or names a protected place. What a workspace's exception for the program compares with its folders; absent,
   *  no exception can apply. */
  targets?: string[];
}

// cmd's own deleters read `/s`, `/q`, `/a:h` as switches, not paths.
const CMD_DELETERS = new Set(["del", "erase", "rd", "rmdir", "deltree"]);
// eslint-disable-next-line security/detect-unsafe-regex -- linear: anchored, each repeat starts with a fixed `/`
const CMD_SWITCHES = /^(?:\/[a-z](?::[a-z-]*)?)+$/i;
// PowerShell parameters whose value is a path to remove, and those whose value is not a path (skipped with it).
const PS_PATH = /^-(?:path|literalpath|pspath|lp)$/i;
const PS_VALUED = /^-(?:include|exclude|filter|erroraction|ea|warningaction|wa|informationaction|infa|errorvariable|ev|warningvariable|wv|informationvariable|iv|outvariable|ov|outbuffer|ob|pipelinevariable|pv|credential|stream)$/i;
const CD = new Set(["cd", "pushd", "chdir", "set-location", "sl", "push-location"]);
const POP = new Set(["popd", "pop-location"]);
// A target only known at run time: a variable, a substitution (shell.ts leaves `${__sb_subst}`), a cmd `%VAR%`, a
// find/xargs `{}` or a brace sequence, a PowerShell array or expression (`@(…)`).
const RUNTIME_VALUE = /[$`%{}]|^@/;
// The temp folder, named by its variable: the rest of the path follows the separator.
const TEMP_VARIABLE = /^(?:\$(?:TMPDIR|TEMP|TMP)|\$\{(?:TMPDIR|TEMP|TMP)\}|\$env:(?:TEMP|TMP)|\$\{env:(?:TEMP|TMP)\}|%(?:TEMP|TMP)%)\//i;
const TEMP_FOLDER = /^\/tmp\//;
// A Windows 8.3 short name (`SCOPEB~1`) may stand for any longer name.
const SHORT_NAME = /~\d/;
/** A colon past a drive letter: a PowerShell provider path (`HKCU:/Software/x`, `Env:X`, `Cert:`) or a file stream, which is
 *  not a place inside the working folder. */
const providerPath = (p: string): boolean => p.replace(/^[A-Za-z]:/, "").includes(":");
// Places a delete never reaches through any of its segments (the repository's history, Scopebond's folder, credentials)…
const PROTECTED_ANYWHERE = new Set([".git", ".scopebond", ".ssh", ".aws", ".gnupg", ".azure", ".kube", ".docker"]);
// …and folders that hold a protected place, and protected files, when the delete names them.
const PROTECTED_NAMED = new Set([
  ".github", ".claude", ".cursor", ".codex", ".copilot", ".husky", ".githooks", ".circleci", ".buildkite", ".config", ".mcp.json",
  ".gitlab-ci.yml", ".gitlab-ci.yaml", "jenkinsfile", "azure-pipelines.yml", "azure-pipelines.yaml", "bitbucket-pipelines.yml",
  ".travis.yml", ".drone.yml", "cloudbuild.yml", "cloudbuild.yaml", ".envrc", ".npmrc", ".pypirc", ".netrc", "_netrc",
  ".git-credentials", ".credentials.json",
]);
// …and the protected places inside those folders: CI configuration, the coding agents' hook settings, credentials.
const PROTECTED_PLACES = [
  ".github/workflows", ".github/actions", ".github/hooks", ".github/copilot", ".claude/settings.json", ".claude/settings.local.json",
  ".claude/hooks", ".claude/agents", ".claude/.credentials.json", ".cursor/hooks", ".cursor/hooks.json", ".cursor/mcp.json",
  ".codex/hooks.json", ".codex/config.toml", ".copilot/hooks", ".copilot/settings.json", ".copilot/mcp-config.json",
  ".config/gh", ".config/gcloud",
];
/** Whether a relative path is, or is inside, one of the protected places, wherever it sits. */
const inProtectedPlace = (segs: string[]): boolean => {
  const path = `/${segs.join("/").toLowerCase()}/`;
  return PROTECTED_PLACES.some((place) => path.includes(`/${place}/`));
};
const SECRET_FILE = /\.(?:key|pem|p12|pfx|jks|keystore)$/i;
const ENV_TEMPLATE = /\.(?:example|sample|template|dist)$/i;
// Sample names a wildcard segment is tested against: if it could match one, it could reach a protected place.
const PROTECTED_SAMPLES = [...PROTECTED_ANYWHERE, ...PROTECTED_NAMED, ".env", ".env.local", "a.key", "a.pem", "a.p12", "a.pfx", "a.jks"];

const isProtectedName = (seg: string): boolean => {
  const s = seg.toLowerCase();
  if (PROTECTED_ANYWHERE.has(s) || PROTECTED_NAMED.has(s) || SECRET_FILE.test(s)) return true;
  return (s === ".env" || s.startsWith(".env.")) && !ENV_TEMPLATE.test(s);
};
/** Whether path segments name a protected place (the repository's history, Scopebond's folder, credentials, CI and the coding
 *  agents' settings): a delete never reaches one, and no workspace exception names one. */
export const namesProtectedPlace = (segs: string[]): boolean => segs.some(isProtectedName) || inProtectedPlace(segs);
const isWildcard = (seg: string): boolean => /[*?[]/.test(seg);
/** A segment of wildcards (and dots) alone: `*`, `*.*`, `.*`, `**`, `?`, `[a-z]*`. */
const wildcardOnly = (seg: string): boolean => isWildcard(seg) && seg.replace(/\[[^\]]*\]|[*?.]/g, "") === "";

/** A wildcard segment as an anchored, case-insensitive pattern. A leading `*` may match a leading dot (fail closed). */
function globPattern(seg: string): RegExp {
  let re = "";
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (c === "[") {
      const end = seg.indexOf("]", i + 1);
      if (end < 0) { re += "\\["; continue; }
      const body = seg.slice(i + 1, end).replace(/^!/, "^").replace(/\\/g, "\\\\");
      re += `[${body}]`;
      i = end;
    } else re += c.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
  }
  // eslint-disable-next-line security/detect-non-literal-regexp -- built from one path segment with every metacharacter escaped; `.*` runs only between literals of a short segment
  return new RegExp(`^${re}$`, "i");
}
const couldName = (seg: string, samples: readonly string[]): boolean => {
  const m = globPattern(seg);
  return samples.some((s) => m.test(s));
};

const isRooted = (p: string): boolean => p.startsWith("/") || /^[A-Za-z]:/.test(p);
/** The segments of a slash path with `.` and `..` resolved; a relative path keeps the `..` that climb above it. */
function resolve(path: string): string[] {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") { if (out.length && out[out.length - 1] !== "..") out.pop(); else out.push(".."); continue; }
    // Windows drops trailing dots and spaces from a name (`dist.` is `dist`).
    let end = seg.length;
    while (end > 0 && (seg[end - 1] === "." || seg[end - 1] === " ")) end--;
    out.push(end === 0 ? seg : seg.slice(0, end));
  }
  return out;
}
/** A working folder in slash form, with a Git Bash drive (`/c/x`) read as `c:/x`. */
const slashed = (p: string): string => {
  let s = p.replace(/\\/g, "/");
  // Trailing separators dropped in one linear pass (`/\/+$/` retries at every slash of a long run).
  let end = s.length;
  while (end > 0 && s[end - 1] === "/") end--;
  s = s.slice(0, end);
  return /^\/[A-Za-z]\//.test(s) ? `${s[1]}:${s.slice(2)}` : s;
};
/** The part of absolute `path` below the working folder, or null when it is not strictly inside it. */
function below(path: string, cwd: string | undefined): string[] | null {
  if (!cwd) return null;
  const root = resolve(slashed(cwd));
  const target = resolve(slashed(path));
  const drive = /^[A-Za-z]:$/.test(root[0] ?? "");
  const same = (a: string, b: string): boolean => (drive ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (slashed(cwd).startsWith("/") !== slashed(path).startsWith("/")) return null;
  if (target.length <= root.length || !root.every((s, i) => same(s, target[i]))) return null;
  return target.slice(root.length);
}

// No file name is longer than this, and no target this long is ordinary: either is judged unknown, which also keeps the
// wildcard checks below to short text.
const MAX_NAME = 255;
const MAX_TARGET = 4096;

/** One target, judged inside the working folder by its segments relative to it. */
function judgeInside(segs: string[]): DeleteScope {
  if (segs.some((s) => s.length > MAX_NAME)) return "unknown";
  if (segs.length === 0) return "outside";                       // the working folder itself
  if (segs[0] === "..") return "outside";                        // climbs out of it
  if (segs.some((s) => PROTECTED_ANYWHERE.has(s.toLowerCase())) || inProtectedPlace(segs)) return "protected";
  const last = segs[segs.length - 1];
  // Build output by name, anywhere: `node_modules`, `packages/*/dist`, `*.log`.
  const lastLower = last.toLowerCase();
  if (BUILD_OUTPUT.includes(lastLower) || lastLower.endsWith(".log")) return "contained";
  // A protected file, or a folder holding a protected place, by name. Deeper inside such a folder (`.claude/worktrees/x`),
  // the file rules judge the write the delete is recorded as.
  if (!isWildcard(last) && isProtectedName(last)) return "protected";
  // A wildcard at the top could take the whole folder (`*`, `.*`) or `.git`; one deeper is judged when it has literal text.
  if (wildcardOnly(segs[0]) && segs.length === 1) return "outside";
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (!isWildcard(s)) continue;
    if (i === 0 ? couldName(s, PROTECTED_SAMPLES) : !wildcardOnly(s) && couldName(s, PROTECTED_SAMPLES)) return "protected";
  }
  return "contained";
}

/** A path below the temp folder: anything but the folder itself or the whole of it. */
function judgeTemp(rest: string): DeleteScope {
  if (RUNTIME_VALUE.test(rest) || SHORT_NAME.test(rest) || rest.includes(":")) return "unknown";
  const segs = resolve(rest);
  if (segs.some((s) => s.length > MAX_NAME)) return "unknown";
  if (segs.length === 0 || segs[0] === ".." || wildcardOnly(segs[0])) return "outside";
  return "contained";
}

/** Where the commands so far left the shell: a folder relative to the working folder (`""` for the folder itself), or null
 *  once it may be anywhere (a `cd` to a variable, home, `-`, out of the folder, a popd). */
type Base = string | null;

function moved(base: Base, target: string | undefined, cwd: string | undefined): Base {
  if (base === null || target === undefined) return null;
  const t = target.replace(/\\/g, "/");
  // `pushd +1` turns the folder stack, which may hold any folder.
  if (t === "" || t === "-" || t.startsWith("~") || t.startsWith("+") || RUNTIME_VALUE.test(t) || SHORT_NAME.test(t) || providerPath(t)) return null;
  if (isRooted(t)) {
    const rest = below(t, cwd);
    if (rest) return rest.join("/");
    return cwd && resolve(slashed(t)).join("/").toLowerCase() === resolve(slashed(cwd)).join("/").toLowerCase() ? "" : null;
  }
  // A `..` after an earlier move could undo a move made in a subshell that never applied here: where it lands is unknown.
  if (base !== "" && t.split("/").includes("..")) return null;
  const segs = resolve(base ? `${base}/${t}` : t);
  return segs[0] === ".." ? null : segs.join("/");
}

/** A target outside the working folder as a full path, for a workspace's exception to compare: `prefix` (`/`, `c:/` or
 *  `~/`) and the resolved segments after it. Null when there is nothing after the root, a segment holds a wildcard, or one
 *  names a protected place: no exception reaches those. */
function fullTarget(prefix: string, segs: string[]): string | null {
  if (segs.length === 0 || segs[0] === ".." || segs.some((s) => s.length > MAX_NAME || isWildcard(s) || isProtectedName(s))) return null;
  if (inProtectedPlace(segs)) return null;
  return prefix + segs.join("/");
}
/** The full path of an absolute target (`/x`, `C:/x`), its drive letter in lower case. */
function absoluteTarget(w: string): string | null {
  const drive = /^([A-Za-z]):/.exec(w);
  if (drive) return fullTarget(`${drive[1].toLowerCase()}:/`, resolve(w.slice(2)));
  return fullTarget("/", resolve(w));
}

/** One target word (a brace alternative, a comma part) where the command runs. */
function judgeTarget(word: string, base: Base, cwd: string | undefined): { scope: DeleteScope; path?: string; target?: string | null } {
  const w = word.replace(/\\/g, "/");
  if (w === "" || w.length > MAX_TARGET) return { scope: "unknown" };
  const temp = TEMP_VARIABLE.exec(w) ?? TEMP_FOLDER.exec(w);
  if (temp) {
    const scope = judgeTemp(w.slice(temp[0].length));
    return scope === "contained" ? { scope, path: w } : { scope };
  }
  if (RUNTIME_VALUE.test(w) || SHORT_NAME.test(w) || providerPath(w)) return { scope: "unknown" };
  // `~user` is another account's home: never a target an exception names.
  if (w.startsWith("~")) return { scope: "outside", target: w === "~" || w.startsWith("~/") ? fullTarget("~/", resolve(w.slice(1))) : null };
  if (isRooted(w)) {
    const rest = below(w, cwd);
    if (!rest) return { scope: "outside", target: absoluteTarget(w) };
    const scope = judgeInside(rest);
    return scope === "contained" ? { scope, path: rest.join("/") } : { scope };
  }
  if (base === null) return { scope: "unknown" };
  // After a move, a `..` may climb from a folder a subshell's `cd` only seemed to reach (see moved).
  if (base !== "" && w.split("/").includes("..")) return { scope: "unknown" };
  const segs = resolve(base ? `${base}/${w}` : w);
  const scope = judgeInside(segs);
  if (scope === "contained") return { scope, path: segs.join("/") };
  // A path that climbs out of the working folder is named by where it lands.
  return { scope, target: scope === "outside" && segs[0] === ".." && cwd && isRooted(slashed(cwd)) ? absoluteTarget(`${slashed(cwd)}/${segs.join("/")}`) : null };
}

/** The words a delete names as targets: its operands, `-Path`/`-LiteralPath` values, with options, cmd switches and the
 *  values of other PowerShell parameters left out. */
function targetWords(prog: string, argv: string[]): string[] {
  const out: string[] = [];
  let options = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (options && a === "--") { options = false; continue; }
    if (options && CMD_DELETERS.has(prog) && CMD_SWITCHES.test(a)) continue;
    if (options && a.length > 1 && a.startsWith("-")) {
      const colon = a.indexOf(":");
      const name = colon > 0 ? a.slice(0, colon) : a;
      if (PS_PATH.test(name)) { if (colon > 0) out.push(a.slice(colon + 1)); else if (i + 1 < argv.length) out.push(argv[++i]); }
      else if (PS_VALUED.test(name) && colon < 0) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

/** Words before the program in the command's own text: a wrapper that moves where it runs (`env -C /`, `chroot`) or feeds
 *  it more arguments (`xargs`) makes its targets unknown. */
function wrappedElsewhere(sc: SimpleCommand): boolean {
  const words = sc.raw.trim().split(/\s+/);
  const at = words.findIndex((w) => canonProgram(trimChars(w, "'\"")) === canonProgram(sc.program));
  return words.slice(0, Math.max(at, 0)).some((w) => {
    const name = canonProgram(w);
    return name === "chroot" || name === "xargs" || /^--chdir/.test(w) || /^-[A-Za-z]*[CD]/.test(w);
  });
}

// Anywhere in the call: a program that feeds a command arguments it reads elsewhere, or an alias that can change what a
// name runs. Either makes every delete in the call unknown.
const FEEDS_OR_ALIASES = /(?:^|[\s;&|(`'"])(?:xargs|parallel|alias|set-alias|new-alias|sal|nal|doskey)(?:\.exe)?(?=[\s'";&|)]|$)/i;

/** Judge one delete command where `base` says it runs. Null when the command is not a delete. */
function judgeDelete(sc: SimpleCommand, base: Base, cwd: string | undefined, expand: (word: string) => string[], unknownAll: boolean): DeleteVerdict | null {
  const prog = canonProgram(sc.program);
  if (sc.opaque || !DELETE_PROGRAMS.has(prog)) return null;
  // A PowerShell expression in the command's own text (`Remove-Item (Get-Item x)`) names what it removes only at run time.
  if (unknownAll || wrappedElsewhere(sc) || /(?<!\$)\(|@\{/.test(sc.raw)) return { scope: "unknown", paths: [] };
  const words = targetWords(prog, sc.argv);
  if (!words.some((w) => w.replace(/,/g, "") !== "")) return { scope: "none", paths: [] };
  const paths: string[] = [];
  // The first target that is not contained decides the scope; every such target is read on, for an exception to compare.
  let scope: DeleteScope = "contained";
  let targets: string[] | null = [];
  for (const word of words) {
    // Brace lists first (`{dist,build}`), then a PowerShell list (`Remove-Item dist, build`) names each part.
    for (const alt of expand(word).flatMap((w) => w.split(",")).filter((w) => w !== "")) {
      const judged = judgeTarget(alt, base, cwd);
      if (judged.scope === "contained") {
        if (judged.path !== undefined && !paths.includes(judged.path)) paths.push(judged.path);
        continue;
      }
      if (scope === "contained") scope = judged.scope;
      if (targets !== null && judged.scope === "outside" && judged.target) { if (!targets.includes(judged.target)) targets.push(judged.target); }
      else targets = null;
    }
  }
  if (scope === "contained") return { scope, paths };
  return { scope, paths: [], ...(targets?.length ? { targets } : {}) };
}

/** Walk the simple commands of one call in order, following `cd`, and judge each delete. */
function walk(commands: SimpleCommand[], cwd: string | undefined, expand: (word: string) => string[], unknownAll: boolean): Map<SimpleCommand, DeleteVerdict> {
  const out = new Map<SimpleCommand, DeleteVerdict>();
  let base: Base = "";
  for (const sc of commands) {
    if (sc.opaque) continue;
    const verdict = judgeDelete(sc, base, cwd, expand, unknownAll);
    if (verdict) out.set(sc, verdict);
    const prog = canonProgram(sc.program);
    if (CD.has(prog)) base = moved(base, sc.argv.find((a) => !a.startsWith("-")), cwd);
    else if (POP.has(prog)) base = null;
  }
  return out;
}

/** Judge every delete in one shell call. `windowsText` is the call read with `\` as a path separator (a "Bash" command that
 *  may run under cmd or PowerShell): a delete is contained only when it is in both readings. `expand` is the shell's brace
 *  expansion of one word. */
export function deleteVerdicts(commands: SimpleCommand[], text: string, cwd: string | undefined, windowsText: string | null, expand: (word: string) => string[]): Map<SimpleCommand, DeleteVerdict> {
  const unknownAll = FEEDS_OR_ALIASES.test(text);
  const verdicts = walk(commands, cwd, expand, unknownAll);
  if (windowsText !== null && [...verdicts.values()].some((v) => v.scope === "contained")) {
    const other = walk(decomposeShell(windowsText), cwd, expand, unknownAll);
    if ([...other.values()].some((v) => v.scope !== "contained")) {
      for (const [sc, v] of verdicts) if (v.scope === "contained") verdicts.set(sc, { scope: "unknown", paths: [] });
    }
  }
  // A call read two ways names no target an exception could rely on.
  if (windowsText !== null) for (const [sc, v] of verdicts) if (v.targets) verdicts.set(sc, { scope: v.scope, paths: v.paths });
  return verdicts;
}

/** What safe-shell lets a delete do, in the words a block message quotes, for the deleting programs on its list (empty when
 *  none is). */
export function containedDeletesSentence(programs: readonly string[]): string {
  const deleters = programs.filter((p) => DELETE_PROGRAMS.has(p.toLowerCase()));
  if (deleters.length === 0) return "";
  return `A delete (${deleters.join(", ")}) is allowed when every target it names is inside the working folder (after any cd in the same command) and is not the folder itself, .git or a protected place; build and cache output (${BUILD_OUTPUT.join(", ")}, *.log) anywhere inside it and paths under the temp folder count as inside. A delete of ~, /, a drive root, a path outside the working folder, a whole-folder wildcard (rm -rf *), a target known only at run time ($VAR, $(…), {} from find or xargs) or no target is denied.`;
}

/** The value safe-shell judges: the program, with `/contained` after it when it is a delete whose every target is contained.
 *  A program name never holds a `/` (the mapper keeps its last path segment), so the two cannot be confused. */
export const programScope = (program: string, verdict: DeleteVerdict | undefined): string =>
  verdict?.scope === "contained" ? `${program}${CONTAINED_SUFFIX}` : program;

/** Whether a shell command's `program_scope` marks a delete whose every target is contained. */
export const isContainedDelete = (params: Record<string, unknown>): boolean =>
  typeof params.program === "string" && params.program !== "" && params.program_scope === `${params.program}${CONTAINED_SUFFIX}`;

/** A shell command intent with `program_scope` filled in when the mapper did not set it (an intent built by hand, or by an
 *  older mapper): the program alone, so it is judged by name as before. */
export function withProgramScope(m: Mapped): Mapped {
  const params = m.intent.params;
  if (m.intent.action_type !== "shell.exec" || params.program_scope !== undefined) return m;
  return { ...m, intent: { ...m.intent, params: { ...params, program_scope: typeof params.program === "string" ? params.program : "" } } };
}
