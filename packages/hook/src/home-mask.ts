// Home-folder masking: a record never names the person's account.
//
// A coding agent reports absolute paths: its working folder (`cwd`), the file it reads or writes, the command it runs.
// On every system the home folder carries the account name (Windows and macOS keep it under a `Users` folder, Linux
// under `home`), and the signed records travel: to the workspace, into exports, into a support thread. So before an
// action is signed the hook rewrites the current account's home folder to `~` (`$HOME/repo/src/a.ts` is recorded as
// `~/repo/src/a.ts`), and the account name in any other home folder to `~other`. Nothing else in a path changes, so a
// record still says which file in which project.
//
// Rules must still match. A rule names a path in one of three ways: relative (`.env`, `.ssh/`), from the home folder
// (`~/secrets/`) or absolute (`$HOME/secrets/` written out in full). The first two match the masked paths as they
// are. An absolute one is rewritten the same way when the rules are loaded (`maskHomeInPolicy`) and when a rule is
// added (`pathRuleFor`), so both sides of every comparison are spelled alike.
//
// The home folder is the operating system account's (`os.userInfo().homedir`), what Node reports (`os.homedir()`) and the
// `HOME` and `USERPROFILE` values, so a shell
// with a different `HOME` (Git Bash, WSL interop, a sandbox) is covered too, along with the Git Bash and WSL
// spellings of a Windows home (`/c/…` and `/mnt/c/…` for drive C). A Windows-style home is matched in any case
// and with either separator. A home of `/` or a bare drive is never masked: every path would collapse to `~`.

import { homedir } from "node:os";
import { accountHome } from "./env-trust.js";

/** One home folder: its spelling with "/" separators and no trailing separator. */
type Home = { path: string; fold: boolean };

const WINDOWS_HOME = /^[A-Za-z]:\//;

/** Normalise a candidate home folder; null when it is not usable (empty, relative, or a root). */
function normalise(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  let s = value.trim().replace(/\\/g, "/");
  while (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  if (s === "" || s === "/" || /^[A-Za-z]:$/.test(s) || /^[A-Za-z]:\/$/.test(s)) return null;
  if (!(s.startsWith("/") || WINDOWS_HOME.test(s))) return null;
  return s;
}

function safeHomedir(): string | undefined {
  try { return homedir(); } catch { return undefined; }
}

function safeAccountHome(): string | undefined {
  try { return accountHome(); } catch { return undefined; }
}

/** The current account's home folder in every spelling the process knows: the operating system account's (for this process's
 *  own environment), `os.homedir()`, `HOME` and `USERPROFILE` (each with "/" separators, no trailing separator). Empty or root
 *  values are left out. */
export function homeFolders(env: NodeJS.ProcessEnv = process.env, home: string | undefined = safeHomedir(), account: string | undefined = env === process.env ? safeAccountHome() : undefined): string[] {
  const out: string[] = [];
  for (const candidate of [account, home, env.HOME, env.USERPROFILE]) {
    const s = normalise(candidate);
    if (s && !out.some((o) => o.toLowerCase() === s.toLowerCase())) out.push(s);
  }
  return out;
}

/** Every spelling to look for: each home, plus the Git Bash and WSL spellings of a Windows one. Longest first, so a
 *  longer home is replaced before a shorter one it contains. */
function spellings(homes: readonly string[]): Home[] {
  const caseless = process.platform === "win32" || process.platform === "darwin";
  const out: Home[] = [];
  for (const raw of homes) {
    const h = normalise(raw);
    if (!h) continue;
    if (WINDOWS_HOME.test(h)) {
      const drive = h[0].toLowerCase();
      const rest = h.slice(2);
      out.push({ path: h, fold: true }, { path: `/${drive}${rest}`, fold: true }, { path: `/mnt/${drive}${rest}`, fold: true });
    } else {
      out.push({ path: h, fold: caseless });
    }
  }
  return out.sort((a, b) => b.path.length - a.path.length);
}

const escapeRe = (s: string): string => s.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");

// A name character on either side means the match is part of a longer name (the home followed by more letters, or the
// same folder names deeper in another path).
const BEFORE = "(?<![\\p{L}\\p{N}._~$/\\\\-])";
const AFTER = "(?![\\p{L}\\p{N}._~$-])";

/** A matcher for one home folder in free text: either separator, any run of separators, whole names only. */
function homeMatcher(home: Home): RegExp {
  const body = home.path.split("/").map(escapeRe).join("[\\\\/]+");
  // eslint-disable-next-line security/detect-non-literal-regexp -- built from the home folder's own segments, each escaped; no quantified group repeats
  return new RegExp(BEFORE + body + AFTER, home.fold ? "giu" : "gu");
}

// The matchers for the last set of homes: the hook masks a handful of strings per action against the same homes.
let cached: { key: string; matchers: RegExp[] } | null = null;
function matchersFor(homes: readonly string[]): RegExp[] {
  const key = homes.join("\0");
  if (cached?.key !== key) cached = { key, matchers: spellings(homes).map(homeMatcher) };
  return cached.matchers;
}

// Another account's home folder: a name under a drive's `Users` folder (also as Git Bash writes it), under macOS's
// `Users` or under Linux's `home`. The name is
// read by `nameEnd` below, not by the expression, so a long run of characters cannot make it backtrack.
const OTHER_HOME = /(?<![\p{L}\p{N}._~$/\\-])(?:[A-Za-z]:[\\/]+Users|\/[A-Za-z]\/Users|\/Users|\/home)[\\/]+/giu;
// Folders under those that are not one person's: the shared and default profiles, and Homebrew's Linux prefix.
const NOT_A_PERSON = new Set(["shared", "public", "default", "default user", "all users", "linuxbrew", "guest"]);
// Characters that end a name in free text (a shell word, a quoted argument, a JSON value).
const HARD_END = new Set(["/", "\\", "\"", "'", "`", ";", ",", ":", "=", "\0", "|", "&", "<", ">", "(", ")", "[", "]", "{", "}", "*", "?", "\n", "\r", "\t"]);

/** Where the account name that starts at `start` ends. A Windows account name may hold spaces
 *  ("Jane Doe"): there the name runs to the next separator when no space comes right before it. Elsewhere (and when
 *  no separator follows) it stops at the first space, so two home folders in one command line read as two names. */
function nameEnd(text: string, start: number, spaces: boolean): number {
  let firstSpace = -1;
  let i = start;
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === "/" || c === "\\") return spaces && text[i - 1] !== " " ? i : firstSpace >= 0 ? firstSpace : i;
    if (HARD_END.has(c) || (c === " " && !spaces)) break;
    if (c === " " && firstSpace < 0) firstSpace = i;
  }
  return firstSpace >= 0 ? firstSpace : i;
}

function maskOtherHomes(text: string): string {
  let out = "";
  let last = 0;
  OTHER_HOME.lastIndex = 0;
  for (let m = OTHER_HOME.exec(text); m; m = OTHER_HOME.exec(text)) {
    const start = m.index + m[0].length;
    const end = nameEnd(text, start, /^(?:[A-Za-z]:|\/[A-Za-z][\\/])/.test(m[0]));
    const name = text.slice(start, end);
    OTHER_HOME.lastIndex = Math.max(end, start + 1);
    if (name === "" || /^[~$%]/.test(name) || NOT_A_PERSON.has(name.toLowerCase())) continue;
    out += text.slice(last, start) + "~other";
    last = end;
  }
  return last === 0 ? text : out + text.slice(last);
}

/** Replace the current account's home folder with `~` and the account name in any other home folder with `~other`.
 *  Works on a path or on free text (a command line). Idempotent. */
export function maskHomeFolder(text: string, homes: readonly string[] = homeFolders()): string {
  if (text === "" || !/[\\/]/.test(text)) return text;
  let out = text;
  for (const matcher of matchersFor(homes)) out = out.replace(matcher, "~");
  return maskOtherHomes(out);
}

/** Every string in a value (an intent's params), masked; other values unchanged. Returns a new value only when
 *  something changed, so an untouched intent keeps its identity. */
export function maskHomeInValue<T>(value: T, homes: readonly string[] = homeFolders()): T {
  if (typeof value === "string") return maskHomeFolder(value, homes) as T;
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((v: unknown) => { const m = maskHomeInValue(v, homes); if (m !== v) changed = true; return m; });
    return (changed ? next : value) as T;
  }
  if (value && typeof value === "object") {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const m = maskHomeInValue(v, homes);
      if (m !== v) changed = true;
      next[k] = m;
    }
    return (changed ? next : value) as T;
  }
  return value;
}

/** The reverse of masking the current home, for looking up what an older version recorded: a `~` that starts a path
 *  becomes `home`. Not exact (a `~` the agent typed itself is expanded too), so it is used only to find older keys. */
export function unmaskHomeFolder(text: string, home: string): string {
  return text.replace(/(?<![\p{L}\p{N}._~$/\\-])~(?=[\\/\s"'`;|&<>)]|$)/gu, () => home);
}

/** `unmaskHomeFolder` on every string in a value. */
export function unmaskHomeInValue<T>(value: T, home: string): T {
  if (typeof value === "string") return unmaskHomeFolder(value, home) as T;
  if (Array.isArray(value)) return value.map((v: unknown) => unmaskHomeInValue(v, home)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, unmaskHomeInValue(v, home)])) as T;
  }
  return value;
}

// --- Rules -----------------------------------------------------------------------------------------------------------

// The two ways a rule spells a typed path: escaped as `pathRuleFor` escapes it, and case-folded as `ci()` folds it.
const escapeRule = (text: string): string => text.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
const fold = (s: string): string => s.replace(/[A-Za-z]/g, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`);
// After a home folder in a pattern: not another name character, plain, escaped or case-folded.
const PATTERN_AFTER = "(?!\\[[A-Za-z]{2}\\]|[\\p{L}\\p{N}_~-]|\\\\[.~-])";

/** A policy pattern with the current account's home folder, in any spelling a rule writes it, replaced by `~`, so the
 *  pattern matches the masked paths the hook signs. A pattern that does not name the home folder is returned as is. */
export function maskHomeInPattern(pattern: string, homes: readonly string[] = homeFolders()): string {
  let out = pattern;
  for (const home of spellings(homes)) {
    const forms = [...new Set([fold(escapeRule(home.path)), escapeRule(home.path), home.path])];
    for (const form of forms) {
      // eslint-disable-next-line security/detect-non-literal-regexp -- the home folder's own spelling, escaped; matched literally
      out = out.replace(new RegExp(escapeRe(form) + PATTERN_AFTER, home.fold ? "giu" : "gu"), "~");
    }
  }
  return out;
}

type Bound = { pattern?: unknown; enum?: unknown; items?: Bound };

/** Rewrite every `param_bounds` pattern and enumerated string in a policy so it compares against masked values the
 *  way it compared against absolute ones. Changes the policy in place (like `upgradeStarterPolicy`) and returns it. */
export function maskHomeInPolicy<T>(policy: T, homes: readonly string[] = homeFolders()): T {
  if (homes.length === 0) return policy;
  const p = policy as { clauses?: Array<{ param_bounds?: Record<string, Bound> }> };
  const rewrite = (bound: Bound | undefined): void => {
    if (!bound || typeof bound !== "object") return;
    if (typeof bound.pattern === "string") bound.pattern = maskHomeInPattern(bound.pattern, homes);
    if (Array.isArray(bound.enum)) bound.enum = bound.enum.map((v: unknown) => (typeof v === "string" ? maskHomeFolder(v, homes) : v));
    rewrite(bound.items);
  };
  for (const clause of Array.isArray(p?.clauses) ? p.clauses : []) {
    for (const bound of Object.values(clause?.param_bounds ?? {})) rewrite(bound);
  }
  return policy;
}
