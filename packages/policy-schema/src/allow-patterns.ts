// Pattern allowances: "Similar commands in this project". A person who unblocks one action may instead allow the actions like
// it in the same project, for the same rule: a pattern built from what the rule matched, shown to them in words with an example
// of what it covers and one of what it does not.
//
// A rule says how it may be widened with a *recipe* (`AllowPattern`): which parameter of the action is widened and how (a
// folder prefix, a file pattern, a package name in any version, a host, an MCP server's tool). A pack rule carries its recipes
// as `allow_patterns`; the starter destructive-shell rule has one built in (`DELETE_RECIPE`: the deleting program and a folder
// its targets are inside). An allowance made from a recipe carries `match` (`AllowanceMatch`): the rule, the action type, the
// recipe and the bounds the person saw. The engine matches an action against `match` and never outside its bounds.
//
// Every bound is narrow by construction, and checked here on its own words (`validAllowanceMatch`), so a malformed or widened
// bound, wherever it comes from, is refused as a whole:
//   - never wider than one project folder or repository (`project`), never climbing out of it (no `.` or `..` segment), never
//     a wildcard where a folder is named;
//   - never across rules or action types (the matcher compares both);
//   - never for the always-on protections (the engine refuses those rule ids; none of them takes a person's answer).
//
// This module defines the shapes and checks them. It does not match actions: the engine does.

/** How a recipe widens the parameter it names. */
export const ALLOW_PATTERN_KINDS = ["path_prefix", "path_glob", "package_name", "host", "mcp_tool"] as const;
export type AllowPatternKind = (typeof ALLOW_PATTERN_KINDS)[number];

/** A rule's recipe for "Similar commands in this project": `param` is the action's parameter it widens, `kind` how, `title`
 *  the words a person reads (a `{value}` in it stands for the bound: "Reading files in {value}"). */
export interface AllowPattern { id: string; title: string; param: string; kind: AllowPatternKind }

export const ALLOW_PATTERN_LIMITS = { maxPatterns: 8, maxId: 64, maxTitle: 80, maxParam: 64, maxValue: 500, maxProject: 1000, maxWith: 4 } as const;

/** The built-in recipe of the starter destructive-shell rule: the same deleting program, every target inside one folder of a
 *  project or repository ("Deleting folders inside <folder> with rm"). */
export const DELETE_RECIPE = "delete-in-folder";

/** What a pattern allowance lets through: one rule, one action type, one recipe, inside these bounds. */
export interface AllowanceMatch { rule: string; action_type: string; recipe: string; bounds: AllowanceBounds }

/** The bounds of a pattern allowance.
 *  - `kind`, `param`, `value`: the parameter widened, how, and to what (a folder, a file pattern, a package name, a host, a
 *    tool name).
 *  - `project`: the project folder or repository the allowance stays inside, as the engine writes a path (forward slashes,
 *    the home folder as `~`). For `path_prefix` and `path_glob` on a relative path, the working folder the action must run in;
 *    for the built-in delete recipe, the folder `value` must be inside (or be).
 *  - `program`: the built-in delete recipe's program (canonical spelling).
 *  - `with`: other parameters that must be exactly equal (an MCP tool's `server`, a package's `ecosystem`). */
export interface AllowanceBounds {
  kind: AllowPatternKind;
  param: string;
  value: string;
  project: string;
  program?: string;
  with?: Record<string, string>;
}

const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PARAM = /^[a-z_][a-z0-9_]{0,63}$/;
const PROGRAM = /^[a-z0-9][a-z0-9._-]{0,63}$/;
// eslint-disable-next-line security/detect-unsafe-regex -- linear: each label ends at its own dot (not in the label classes), and the lookahead bounds the input to 253 characters
const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const NAME = /^[A-Za-z0-9_.:-]{1,128}$/;
// Characters a shell reads at run time, and wildcards: never in a folder a bound names.
const RUNTIME_OR_WILDCARD = /[*?[\]{}$`%]/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** Control characters (and line breaks), and the bidirectional and invisible formatting characters: never in a bound. */
const hasHiddenCharacter = (v: string): boolean => [...v].some((ch) => {
  const c = ch.codePointAt(0)!;
  return c < 0x20 || c === 0x7f || (c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2060 && c <= 0x2069) || c === 0xfeff || c === 0x2028 || c === 0x2029;
});
const plainText = (v: unknown, max: number): v is string => typeof v === "string" && v.length >= 1 && v.length <= max && v.trim() === v && !hasHiddenCharacter(v);

/** The root a full path starts with (`/`, `c:/`, `~/`), or null for a relative path. */
function rootOf(path: string): string | null {
  if (path.startsWith("~/")) return "~/";
  if (/^[a-z]:\//.test(path)) return path.slice(0, 3);
  if (path.startsWith("/")) return "/";
  return null;
}
/** The segments of a path after its root: none may be empty, `.` or `..` (a path a bound names is already resolved). */
function cleanSegments(rest: string): string[] | null {
  if (rest === "") return [];
  const segs = rest.split("/");
  return segs.every((s) => s !== "" && s !== "." && s !== "..") ? segs : null;
}
/** A full path a bound may name: `/x/y`, `c:/x/y` (drive in lower case) or `~/x/y`, at least one folder below its root, every
 *  segment plain. Its segments, or null. */
export function fullPathSegments(path: string): string[] | null {
  const root = rootOf(path);
  if (!root || path.includes("\\") || RUNTIME_OR_WILDCARD.test(path)) return null;
  const segs = cleanSegments(path.slice(root.length));
  return segs && segs.length >= 1 ? segs : null;
}
/** A path relative to the working folder a bound may name: plain segments, never climbing out (`.` alone is the folder
 *  itself). `glob`: the last segment (the file name) may hold `*` and `?`, never `**`; the folders before it are plain. */
export function relativeSegments(path: string, glob = false): string[] | null {
  if (path === ".") return [];
  if (rootOf(path) !== null || /^[A-Za-z]:/.test(path) || path.startsWith("~") || path.includes("\\")) return null;
  const segs = cleanSegments(path);
  if (!segs || segs.length === 0) return null;
  const last = segs[segs.length - 1];
  if (segs.slice(0, -1).some((s) => RUNTIME_OR_WILDCARD.test(s))) return null;
  if (!glob) return RUNTIME_OR_WILDCARD.test(last) ? null : segs;
  return /[[\]{}$`%]/.test(last) || last.includes("**") ? null : segs;
}

/** Whether a value is a list of recipes a rule may carry: at most `maxPatterns`, each well formed, ids unique. */
export function validAllowPatterns(v: unknown): v is AllowPattern[] {
  return allowPatternErrors(v, "allow_patterns").length === 0;
}

/** What is wrong with a rule's `allow_patterns`, one sentence each (none when it is well formed). For a pack's own check. */
export function allowPatternErrors(v: unknown, where: string): string[] {
  if (!Array.isArray(v)) return [`${where} must be a list`];
  if (v.length === 0 || v.length > ALLOW_PATTERN_LIMITS.maxPatterns) return [`${where} must hold 1 to ${ALLOW_PATTERN_LIMITS.maxPatterns} recipes`];
  const errors: string[] = [];
  const ids = new Set<string>();
  v.forEach((p, i) => {
    const at = `${where}[${i}]`;
    if (!isObject(p)) { errors.push(`${at} must be an object`); return; }
    const unknown = Object.keys(p).filter((k) => !["id", "title", "param", "kind"].includes(k));
    if (unknown.length) errors.push(`${at} has unknown field ${unknown[0]}`);
    if (typeof p.id !== "string" || !ID.test(p.id)) errors.push(`${at}.id must be a lower-case id`);
    else if (ids.has(p.id)) errors.push(`${at}.id repeats ${p.id}`);
    else ids.add(p.id);
    if (!plainText(p.title, ALLOW_PATTERN_LIMITS.maxTitle)) errors.push(`${at}.title must be 1 to ${ALLOW_PATTERN_LIMITS.maxTitle} characters of plain text`);
    if (typeof p.param !== "string" || !PARAM.test(p.param)) errors.push(`${at}.param must name a parameter`);
    if (typeof p.kind !== "string" || !(ALLOW_PATTERN_KINDS as readonly string[]).includes(p.kind)) errors.push(`${at}.kind must be one of ${ALLOW_PATTERN_KINDS.join(", ")}`);
  });
  return errors;
}

/** Whether `inner` (segments) is `outer` or inside it. `fold`: compare without case (a drive path, or a Windows computer). */
export function withinSegments(inner: readonly string[], outer: readonly string[], fold: boolean): boolean {
  if (inner.length < outer.length) return false;
  return outer.every((s, i) => (fold ? s.toLowerCase() === inner[i].toLowerCase() : s === inner[i]));
}

/** Whether bounds are well formed and narrow: the value fits its kind, a folder or path never climbs out of the project, the
 *  project is a folder below a root (never `/`, a drive or the home folder itself). */
export function validBounds(b: unknown): b is AllowanceBounds {
  if (!isObject(b)) return false;
  if (Object.keys(b).some((k) => !["kind", "param", "value", "project", "program", "with"].includes(k))) return false;
  if (typeof b.kind !== "string" || !(ALLOW_PATTERN_KINDS as readonly string[]).includes(b.kind)) return false;
  if (typeof b.param !== "string" || !PARAM.test(b.param)) return false;
  if (!plainText(b.value, ALLOW_PATTERN_LIMITS.maxValue) || !plainText(b.project, ALLOW_PATTERN_LIMITS.maxProject)) return false;
  const project = fullPathSegments(b.project);
  if (!project) return false;
  if (b.with !== undefined) {
    if (!isObject(b.with) || Object.keys(b.with).length > ALLOW_PATTERN_LIMITS.maxWith) return false;
    if (!Object.entries(b.with).every(([k, w]) => PARAM.test(k) && k !== b.param && plainText(w, 200))) return false;
  }
  if (b.program !== undefined) {
    // The built-in delete recipe: a full path inside (or equal to) the project, for one deleting program.
    if (b.kind !== "path_prefix" || typeof b.program !== "string" || !PROGRAM.test(b.program)) return false;
    const value = fullPathSegments(b.value);
    if (!value || rootOf(b.value)!.toLowerCase() !== rootOf(b.project)!.toLowerCase()) return false;
    return withinSegments(value, project, /^[a-z]:\//.test(b.project));
  }
  switch (b.kind) {
    case "path_prefix": return relativeSegments(b.value) !== null;
    case "path_glob": return relativeSegments(b.value, true) !== null && b.value !== ".";
    case "package_name": return b.value.length <= 214 && !/[\s*?]/.test(b.value);
    case "host": return HOST.test(b.value);
    case "mcp_tool": return NAME.test(b.value) && isObject(b.with) && typeof b.with.server === "string" && NAME.test(b.with.server);
  }
  return false;
}

/** An action type's shape: two to four dotted lower-case words (`shell.exec`, `mcp.tool.call`). */
const actionType = (t: string): boolean => {
  const words = t.split(".");
  return t.length <= 64 && words.length >= 2 && words.length <= 4 && words.every((w) => /^[a-z][a-z0-9_]*$/.test(w));
};

/** Whether a value is a well-formed `allowance.match` with narrow bounds (`validBounds`). */
export function validAllowanceMatch(v: unknown): v is AllowanceMatch {
  if (!isObject(v) || Object.keys(v).some((k) => !["rule", "action_type", "recipe", "bounds"].includes(k))) return false;
  return typeof v.rule === "string" && /^[a-z0-9-]{1,64}$/.test(v.rule)
    && typeof v.action_type === "string" && actionType(v.action_type)
    && typeof v.recipe === "string" && ID.test(v.recipe)
    && validBounds(v.bounds)
    // The built-in delete recipe is the only one with a program, and it widens a shell command's delete targets alone.
    && ((v.recipe === DELETE_RECIPE) === (v.bounds.program !== undefined))
    && (v.recipe !== DELETE_RECIPE || (v.action_type === "shell.exec" && v.bounds.param === "delete_targets"));
}
