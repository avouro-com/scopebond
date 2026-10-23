// The user-level installer. One install per developer machine (not per repo):
// keys and a starter policy live in a user-level home (~/.scopebond, override
// SCOPEBOND_HOME), and the hook is registered by absolute path in the user-level agent
// config (~/.claude/settings.json, ~/.cursor/hooks.json, ~/.codex/hooks.json,
// ~/.copilot/hooks/scopebond.json). When a
// user-level install exists, a project-local `.scopebond` is used only if the user
// trusted that exact policy (`scopebond trust`, or `init` in the project): a cloned
// repository, or an agent inside it, must not be able to swap in its own policy.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants, mkdirSync, writeFileSync, existsSync, readFileSync, realpathSync, rmSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { canonical } from "@scopebond/gateway";
import { findProgram, programPath, windowsSystemProgram } from "@scopebond/gateway/node";
import { readIfPresent, replaceFile } from "./safe-fs.js";
import { hookCliPath } from "./self.js";
import { editHarnessConfig, readConfigText as readBoundedConfigText } from "./config-edit.js";

import { adapterFile, adapterPresent, GROUPED_LIFECYCLE_EVENTS, type Harness } from "./adapters.js";
export { HARNESSES, type Harness } from "./adapters.js";

/** GitHub Copilot reads every `*.json` file in its hooks folders, so Scopebond's entries live in a file of their own. */
export const COPILOT_HOOK_FILE = "scopebond.json";

/** The `timeoutSec` Scopebond writes on each Copilot hook entry. Copilot lets the action run when a hook times out (a
 *  timeout fails open there), so the hook stops itself and denies well before this: see `COPILOT_DECISION_DEADLINE_MS`. */
export const COPILOT_TIMEOUT_SEC = 60;

/** How long a Copilot tool check may run before the hook gives up and denies. Shorter than `COPILOT_TIMEOUT_SEC` by a
 *  margin for Node's start and the write to stdout, so a slow policy load or a held lock ends as a deny, never as a
 *  timed-out hook that Copilot would wave through. */
export const COPILOT_DECISION_DEADLINE_MS = 45_000;

/** Copilot's user-level folder: `COPILOT_HOME` when set, else `~/.copilot` (`%USERPROFILE%\.copilot` on Windows). */
export function copilotHome(): string {
  return process.env.COPILOT_HOME || join(homedir(), ".copilot");
}

/** The user-level Scopebond home. `SCOPEBOND_HOME` overrides it (tests, CI). */
export function userHome(): string {
  return process.env.SCOPEBOND_HOME ?? join(homedir(), ".scopebond");
}

/** The user-level agent config file for a harness. `HOME`/`USERPROFILE` (via homedir)
 *  roots it; SCOPEBOND_HOME does not move the agent's own config. */
export function userHarnessFile(harness: Harness): string {
  return adapterFile(harness);
}

/** The project-level agent config file for a harness — what `init` writes, so the
 *  hook travels with the repository rather than the machine. */
export function projectHarnessFile(harness: Harness, cwd: string = process.cwd()): string {
  if (harness === "cursor") return join(cwd, ".cursor", "hooks.json");
  if (harness === "codex") return join(cwd, ".codex", "hooks.json");
  if (harness === "copilot") return join(cwd, ".github", "hooks", COPILOT_HOOK_FILE);
  return join(cwd, ".claude", "settings.json");
}

/** The personal, per-machine project config for a harness, or null when the harness
 *  has none. Claude Code reads `.claude/settings.local.json` beside `settings.json` and
 *  merges the hooks of both; it is the place for anything that names a path on this
 *  machine. Cursor, Codex and Copilot have no such file. */
export function localHarnessFile(harness: Harness, cwd: string = process.cwd()): string | null {
  return harness === "claude" ? join(cwd, ".claude", "settings.local.json") : null;
}

/** Which config files actually carry a Scopebond hook for this harness. There are three
 *  places it can live — the shared project config, the personal project config (Claude
 *  Code's `settings.local.json`, where `init` pins the fast command) and the user config
 *  `install` writes — and `status`/`doctor` must look at all of them: checking only the
 *  user one told everyone who ran `init` that their install had failed. */
export interface HarnessScopes { project: string | null; local: string | null; user: string | null }

export function harnessScopes(harness: Harness, cwd: string = process.cwd()): HarnessScopes {
  const project = projectHarnessFile(harness, cwd);
  const local = localHarnessFile(harness, cwd);
  const user = userHarnessFile(harness);
  return {
    project: isHarnessConfigured(project) ? project : null,
    local: local && isHarnessConfigured(local) ? local : null,
    user: isHarnessConfigured(user) ? user : null,
  };
}

/** One word for where a harness is wired, for a status line. */
export function harnessScopeLabel(scopes: HarnessScopes): string {
  const where = [
    scopes.project ? "project" : "",
    scopes.local ? "this machine" : "",
    scopes.user ? "user" : "",
  ].filter(Boolean);
  if (where.length === 0) return "";
  if (where.length === 1 && scopes.project) return "configured (this project)";
  if (where.length === 1 && scopes.local) return "configured (this project, this machine only)";
  if (where.length === 1 && scopes.user) return "configured (user-level)";
  return `configured (${where.join(" + ")})`;
}

/** Whether a hook command names a path that exists only on this machine — the pinned
 *  `"<node>" "<…/cli.js>" claude` form — rather than the portable `npx` form. */
export function isMachineSpecificCommand(command: string): boolean {
  if (/(^|\s)npx(\.cmd)?\s/.test(command)) return false;
  const first = (command.match(/"[^"]+"|\S+/) ?? [""])[0].replace(/^"|"$/g, "");
  return isAbsolute(first) || /^[A-Za-z]:[\\/]/.test(first);
}

/** How git treats a config file: committed (`tracked`), kept out (`ignored`), neither
 *  yet (`untracked`, so a `git add .` would commit it), or not in a repository / no git
 *  on this machine (`none`). A file git shares must never carry a machine-specific
 *  command: on a teammate's machine the path does not exist, the command cannot start,
 *  and Claude Code, Cursor and Codex all treat a hook that cannot start as a non-blocking
 *  error — the agent runs with no check at all. */
export type GitShare = "tracked" | "ignored" | "untracked" | "none";

export function gitShareState(file: string): GitShare {
  const cwd = dirname(file);
  const git = (args: string[]): number => {
    try {
      mkdirSync(cwd, { recursive: true });
      // By full path from PATH: by bare name Windows would look in `cwd`, a project folder, first.
      execFileSync(programPath("git"), args, { cwd, stdio: "ignore", timeout: 5000 });
      return 0;
    } catch (error) {
      const status = (error as { status?: number | null }).status;
      return typeof status === "number" ? status : -1;
    }
  };
  if (git(["rev-parse", "--is-inside-work-tree"]) !== 0) return "none";
  if (git(["ls-files", "--error-unmatch", "--", file]) === 0) return "tracked";
  return git(["check-ignore", "-q", "--", file]) === 0 ? "ignored" : "untracked";
}

/** Keep a file out of git for this clone only, through `.git/info/exclude` — never the
 *  repository's own `.gitignore`, which is the team's file. Returns true when the file is
 *  ignored afterwards. */
export function excludeFromGit(file: string): boolean {
  try {
    const cwd = dirname(file);
    mkdirSync(cwd, { recursive: true });
    // The entry is built from git's own view of where this directory sits in the work
    // tree (`--show-prefix`), not from comparing file-system paths: the same directory
    // can be spelled two ways (a Windows 8.3 short name, a symlinked temp dir), and a
    // path computed across the two spellings excludes the wrong file.
    const prefix = execFileSync(programPath("git"), ["rev-parse", "--show-prefix"], { cwd, encoding: "utf8", timeout: 5000 }).trim();
    const exclude = resolve(cwd, execFileSync(programPath("git"), ["rev-parse", "--git-path", "info/exclude"], { cwd, encoding: "utf8", timeout: 5000 }).trim());
    const entry = "/" + prefix + basename(file);
    const existing = readIfPresent(exclude) ?? "";
    if (!existing.split(/\r?\n/).includes(entry)) {
      mkdirSync(dirname(exclude), { recursive: true });
      writeFileSync(exclude, `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${entry}\n`);
    }
    return gitShareState(file) === "ignored";
  } catch { return false; }
}

/** Remove the Scopebond entries whose command `remove` selects, leaving every other
 *  setting alone. Returns the number of entries removed. */
export function pruneHarnessEntries(file: string, remove: (command: string) => boolean, events?: readonly string[]): number {
  if (readHarnessConfigIfPresent(file) === undefined) return 0;
  let removed = 0;
  const prune = (list: unknown[]): unknown[] => list.flatMap((e): unknown[] => {
    if (!isRecord(e)) return [e];
    const command = harnessEntryCommand(e);
    if (command !== undefined && isScopebond(command) && remove(command)) { removed++; return []; }
    if (!Array.isArray(e.hooks)) return [e];
    const hooks = prune(e.hooks);
    return hooks.length || e.hooks.length === 0 ? [{ ...e, hooks }] : [];
  });
  editHarnessConfig(file, (config) => {
    removed = 0;
    const hooks = isRecord(config.hooks) ? config.hooks : {};
    for (const [event, value] of Object.entries(hooks)) {
      if (!Array.isArray(value) || (events && !events.includes(event))) continue;
      const kept = prune(value);
      if (events && !kept.length) delete hooks[event];
      else (hooks as Record<string, unknown[]>)[event] = kept;
    }
  }, { mustExist: true });
  return removed;
}

/** The file in the user home that pins trusted project policies: absolute project
 *  config dir → its trust digest (`trustDigest`). It lives under the protected home, so the
 *  governed agent cannot write it. */
export function trustedProjectsFile(): string {
  return join(userHome(), "trusted-projects.json");
}

const sha256Hex = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

/** The SHA-256 of the project's policy.json: what a pin covered before `trustDigest`. */
function policyDigest(dir: string): string | null {
  try { return sha256Hex(readFileSync(join(dir, "policy.json"))); } catch { return null; }
}

/** The workspace a config folder's connection (cloud.json) names: its addresses, workspace, environment and installation,
 *  never the credential, which renews. Null when there is none; a file that cannot be read stands for itself. */
function connectionIdentity(dir: string): unknown {
  let text: string;
  try { text = readFileSync(join(dir, "cloud.json"), "utf8"); } catch { return null; }
  try {
    const c = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown;
    if (!isRecord(c)) return { unreadable: sha256Hex(text) };
    const field = (name: string): unknown => c[name] ?? null;
    return { url: field("url"), ingest_url: field("ingest_url"), organization_id: field("organization_id"), environment_id: field("environment_id"),
      installation_id: field("installation_id"), gateway_id: field("gateway_id") };
  } catch { return { unreadable: sha256Hex(text) }; }
}

/** What a trust pin covers in a project's config folder: everything there that decides what its policy enforces, apart from
 *  what may let a blocked action through (for a trusted project that comes from the user home: `decisionStateDir`). That is
 *  policy.json; rules.json, which the hook also reads on each call (the allowed roots, the remote-database guard); and the
 *  identity of the folder's workspace connection, whose rules checks rewrite the policy. Null when there is no policy. */
function trustDigest(dir: string): string | null {
  const policy = policyDigest(dir);
  if (!policy) return null;
  let rules: string | null;
  try { rules = sha256Hex(readFileSync(join(dir, "rules.json"))); } catch { rules = null; }
  return `v2:${sha256Hex(canonical({ policy, rules, connection: connectionIdentity(dir) }))}`;
}

function readTrusted(): Record<string, string> {
  try { const p = JSON.parse(readFileSync(trustedProjectsFile(), "utf8")); return isRecord(p) ? (p as Record<string, string>) : {}; } catch { return {}; }
}

/** A path as the file system names it: absolute, with every link, junction and alias of its nearest existing ancestor
 *  resolved (macOS's /var is /private/var; a temp folder may sit behind a junction), and the missing rest appended as
 *  written. The same folder reached two ways gives one answer; a path that cannot be read stays as resolve() gives it. */
export function canonicalPath(path: string): string {
  const absolute = resolve(path);
  const rest: string[] = [];
  for (let at = absolute; ;) {
    try { return rest.length ? join(realpathSync.native(at), ...rest) : realpathSync.native(at); } catch { /* not there (yet): try its parent */ }
    const parent = dirname(at);
    if (parent === at) return absolute;
    rest.unshift(basename(at));
    at = parent;
  }
}

/** Whether two paths name the same folder or file (case-insensitively on Windows and macOS, whose volumes usually are). */
export function samePath(a: string, b: string): boolean {
  const fold = (p: string): string => (process.platform === "win32" || process.platform === "darwin" ? canonicalPath(p).toLowerCase() : canonicalPath(p));
  return fold(a) === fold(b);
}

/** The key a project is trusted under: its canonical path, so a project reached through a link (or through macOS's /var
 *  and /private/var) is one project. Keys written before used resolve() only; they are still read. */
const trustKey = (dir: string): string => canonicalPath(dir).replace(/\\/g, "/").toLowerCase();
const legacyTrustKey = (dir: string): string => resolve(dir).replace(/\\/g, "/").toLowerCase();

/** Pin the project's current policy as trusted. Editing the policy afterwards un-trusts
 *  it until the user trusts it again, so a rewrite by the agent never takes effect. */
export function trustProjectPolicy(dir: string): string {
  const digest = trustDigest(dir);
  if (!digest) throw new Error(`no policy at ${join(dir, "policy.json")}`);
  pin(dir, digest);
  return policyDigest(dir)!;
}

function pin(dir: string, digest: string): void {
  const trusted = readTrusted();
  if (legacyTrustKey(dir) !== trustKey(dir)) delete trusted[legacyTrustKey(dir)];
  trusted[trustKey(dir)] = digest;
  mkdirSync(userHome(), { recursive: true });
  replaceFile(trustedProjectsFile(), JSON.stringify(trusted, null, 2) + "\n");
}

/** Whether the project's policy, rule list and connection are exactly the ones the user trusted. A pin made before the rule
 *  list and the connection were covered (the policy's own SHA-256) still holds while the policy is unchanged, and is renewed
 *  to cover them, so any later change to either lapses the trust. */
export function isTrustedProject(dir: string): boolean {
  const digest = trustDigest(dir);
  if (!digest) return false;
  const trusted = readTrusted();
  const pinned = trusted[trustKey(dir)] ?? trusted[legacyTrustKey(dir)];
  if (pinned === digest) return true;
  if (pinned === undefined || pinned !== policyDigest(dir)) return false;
  try { pin(dir, digest); } catch { /* renewed on a later check */ }
  return true;
}

/** Where a hook call reads, and writes, what may let a blocked action through: the workspace rules document (whether a person
 *  may allow or ask, and on what terms), allowances and the record of earlier overrides. The config folder itself, except a
 *  project folder that governs only because the person trusted it (a user-level install exists): the trust pins the
 *  project's rule files, never this state, so a repository could otherwise bring an allowance for an action its trusted
 *  policy blocks. For such a project it is the user-level home. */
export function decisionStateDir(dir: string): string {
  if (process.env.SCOPEBOND_HOOK_DIR) return dir;
  const home = userHome();
  if (samePath(dir, home) || !existsSync(join(home, "policy.json"))) return dir;
  return home;
}

/** Resolve the config dir for a hook event, most specific first:
 *  explicit override → the payload's project → $CLAUDE_PROJECT_DIR → the user home.
 *  A project dir counts only when it has been scaffolded (a policy.json), so a bare
 *  working directory never shadows the user-level install — and, once a user-level
 *  install exists, only when its policy is trusted (`isTrustedProject`). Otherwise the
 *  user's own policy governs: a repository cannot bring a weaker one with it. */
export function resolveConfigDir(payloadCwd: string | undefined): string {
  if (process.env.SCOPEBOND_HOOK_DIR) return process.env.SCOPEBOND_HOOK_DIR;
  const candidates: string[] = [];
  if (payloadCwd) candidates.push(join(payloadCwd, ".scopebond"));
  if (process.env.CLAUDE_PROJECT_DIR) candidates.push(join(process.env.CLAUDE_PROJECT_DIR, ".scopebond"));
  const home = userHome();
  const homeInstalled = existsSync(join(home, "policy.json"));
  for (const dir of candidates) {
    if (existsSync(join(dir, "policy.json")) && (!homeInstalled || isTrustedProject(dir))) return dir;
  }
  if (homeInstalled) return home;
  // Nothing scaffolded yet: prefer the payload project, else the user home.
  return candidates[0] ?? home;
}

/** A project policy present but ignored because it is not trusted (for status/doctor). */
export function untrustedProjectPolicy(payloadCwd: string | undefined): string | null {
  if (process.env.SCOPEBOND_HOOK_DIR || !existsSync(join(userHome(), "policy.json"))) return null;
  // Run from the user's home folder, `<cwd>/.scopebond` is the user-level home itself, not a project setup.
  const home = userHome();
  const dirs = [payloadCwd, process.env.CLAUDE_PROJECT_DIR].filter(Boolean).map((d) => join(d as string, ".scopebond"));
  return dirs.find((d) => !samePath(d, home) && existsSync(join(d, "policy.json")) && !isTrustedProject(d)) ?? null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Whether a harness command string is one of ours. This is the single matcher for
 *  every form the installer has ever written, and it is what makes re-running `init`
 *  or `install` replace the entry instead of appending a second one:
 *    - `npx -y @scopebond/hook@0.6.0 claude`          (portable)
 *    - `"<node>" "<…/@scopebond/hook/dist/cli.js>" claude`  (pinned, POSIX)
 *    - `"<node>" "<…\@scopebond\hook\dist\cli.js>" claude`  (pinned, Windows)
 *    - `scopebond-hook claude`                        (legacy global binary)
 *  The separator class matters: a Windows pinned path spells the scope
 *  `@scopebond\hook`, and matching only `@scopebond/hook` let a second `init`
 *  install a duplicate hook — which would double-check every tool call.
 *
 *  Written with substring and token tests rather than one regular expression: the
 *  previous `(^|["\s])scopebond(["'\s]).*\b(claude|cursor|codex)\b` backtracked
 *  polynomially on a long run of `\tscopebond\t` (CodeQL js/polynomial-redos). The
 *  input is a command out of a config file rather than a request, so this was not
 *  reachable by an attacker — but a linear check is also the clearer one. */
const HARNESS_SUBCOMMANDS = new Set(["claude", "cursor", "codex", "copilot"]);
/** Long enough for any real command; a bound keeps the work linear and small. */
const MAX_COMMAND = 4096;
const unquote = (token: string): string => token.replace(/^["']+|["']+$/g, "");

/** The tail Scopebond adds to a Copilot `powershell` command (see `powershellHookCommand`), removed before matching. */
const PASS_EXIT_CODE = "; exit $LASTEXITCODE";
const withoutPassExitCode = (cmd: string): string => {
  const trimmed = cmd.trimEnd();
  return trimmed.toLowerCase().endsWith(PASS_EXIT_CODE.toLowerCase()) ? trimmed.slice(0, -PASS_EXIT_CODE.length) : cmd;
};

export const isScopebondHookCommand = (input: unknown): boolean => {
  if (typeof input !== "string" || input.length === 0 || input.length > MAX_COMMAND) return false;
  const cmd = withoutPassExitCode(input);
  const lower = cmd.toLowerCase();
  // The package itself, in either path spelling (`@scopebond/hook`, `@scopebond\hook`).
  if (lower.includes("@scopebond/hook") || lower.includes("@scopebond\\hook")) return true;
  // The legacy global binary, as a whole token.
  if (/(^|[\s"'])scopebond-hook([\s"']|$)/.test(cmd)) return true;
  // An absolute or bare form whose last argument is one of our harness subcommands:
  // `<node> <…/cli.js> claude`, `scopebond cursor`.
  const tokens = cmd.split(/\s+/).filter(Boolean);
  const last = unquote(tokens[tokens.length - 1] ?? "");
  if (!HARNESS_SUBCOMMANDS.has(last)) return false;
  return tokens.some((token) => isScopebondProgram(unquote(token)));
};

/** Scopebond's own program names: the npm bins and the single executable. */
const SCOPEBOND_PROGRAMS = new Set(["scopebond", "scopebond-hook", "scopebond-agent"]);
const slashes = (p: string): string => p.replace(/\\/g, "/").toLowerCase();
let ownCli: Set<string> | null = null;
/** This hook's own cli.js, as written in an entry (its path, and on Windows its shell-plain spelling). */
function ownCliSpellings(): Set<string> {
  if (ownCli) return ownCli;
  const spellings = new Set<string>();
  try {
    const cli = hookCliPath();
    spellings.add(slashes(cli));
    if (process.platform === "win32") { const plain = shellPlainWindowsPath(cli); if (plain) spellings.add(slashes(plain)); }
  } catch { /* no path to compare with */ }
  return (ownCli = spellings);
}

/** Whether one token of a hook command is a Scopebond program: one of its program names (`scopebond`, `scopebond-hook`,
 *  `scopebond-agent`, with any folder and `.exe`/`.cmd`), a `cli.js` inside a `.scopebond` or `@scopebond` folder (npm's
 *  install, the pinned copy), or this hook's own `cli.js`. A `cli.js` anywhere else, or a path that merely has
 *  "scopebond" in a folder name, is someone else's. */
function isScopebondProgram(token: string): boolean {
  const t = slashes(token);
  const name = (t.split("/").pop() ?? "").replace(/\.(exe|cmd)$/, "");
  if (SCOPEBOND_PROGRAMS.has(name)) return true;
  if (!/(^|\/)cli\.(m|c)?js$/.test(t)) return false;
  return t.includes("/.scopebond/") || t.includes("/@scopebond/") || ownCliSpellings().has(t);
}
const isScopebond = isScopebondHookCommand;

/** The fields a hook entry names a command in: `command` (Claude Code, Cursor, Codex), Codex's Windows override
 *  `commandWindows`, and a GitHub Copilot entry's one per shell (`bash`, `powershell`). */
const ENTRY_COMMAND_KEYS = ["command", "commandWindows", "bash", "powershell"] as const;

/** The command one hook entry runs. Claude Code, Cursor and Codex name it `command`; a GitHub Copilot entry names one
 *  per shell (`bash`, `powershell`), and Scopebond writes the same command in both, so `bash` stands for the entry (the
 *  `powershell` form only adds PowerShell's call operator in front). */
export function harnessEntryCommand(e: unknown): string | undefined {
  if (!isRecord(e)) return undefined;
  for (const key of ENTRY_COMMAND_KEYS) { const value = e[key]; if (typeof value === "string") return value; }
  return undefined;
}

/** Whether any command field of one hook entry is Scopebond's (a Codex entry may name it only in `commandWindows`). */
export const harnessHookIsOurs = (e: unknown): boolean => isRecord(e) && ENTRY_COMMAND_KEYS.some((key) => isScopebond(e[key]));
const commandIsOurs = harnessHookIsOurs;

/** Whether a harness hook entry (either shape: a bare command, or a group with a
 *  nested `hooks` array) is a Scopebond entry. */
export const harnessEntryMatches = (e: unknown): boolean =>
  isRecord(e) && (commandIsOurs(e) || (Array.isArray(e.hooks) && e.hooks.some(commandIsOurs)));
const entryMatches = harnessEntryMatches;

/** Read an agent's JSON config for merging. A missing file is an empty config; a file
 *  that exists but does not parse as a JSON object is an error — rewriting it would
 *  silently delete the user's other settings, so the installer stops instead. */
/** A config file's text without a UTF-8 byte-order mark: Windows PowerShell 5.1 writes one
 *  (Set-Content -Encoding UTF8), and JSON.parse refuses the whole file because of it. */
function readConfigText(file: string): string {
  return readFileSync(file, "utf8").replace(/^\uFEFF/, "");
}

export function readHarnessConfig(file: string): Record<string, unknown> {
  return readHarnessConfigIfPresent(file) ?? {};
}

/** `readHarnessConfig`, but undefined when there is no file. The file is read directly (a missing file is the read's
 *  ENOENT), never checked first: a check followed by the read and a later write races a path swap between them. */
function readHarnessConfigIfPresent(file: string): Record<string, unknown> | undefined {
  const raw = readBoundedConfigText(file);
  if (raw === undefined) return undefined;
  const text = raw.replace(/^\uFEFF/, "");
  if (!text.trim()) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (error) {
    throw new Error(`${file} is not valid JSON (${(error as Error).message}); fix or move it, then run this again — it was left unchanged`, { cause: error });
  }
  if (!isRecord(parsed)) throw new Error(`${file} is not a JSON object; fix or move it, then run this again — it was left unchanged`);
  return parsed;
}

/** Copy an agent config aside before changing it, once. Re-running an installer must not
 *  overwrite the backup with the already-modified file, or the original is lost on the
 *  second run — so an existing backup is left alone. Returns the backup path when one was
 *  written.
 *
 *  This exists because these installers rewrite files the user did not create and may not
 *  know are involved (`~/.claude/settings.json` holds their theme, plugins and
 *  permissions), and the undo was previously "hope the merge was right". */
export function backupHarnessConfig(file: string): string | null {
  const backup = `${file}.scopebond-backup`;
  // No file to back up, or a backup already there (the exclusive copy refuses to replace it): nothing written.
  try { copyFileSync(file, backup, fsConstants.COPYFILE_EXCL); return backup; } catch { return null; }
}

/** The GitHub Copilot events Scopebond registers. The PascalCase names make Copilot send the VS Code-compatible payload
 *  (`hook_event_name`, `session_id`, `tool_name`, `tool_input`), the same shape Claude Code sends. `PreToolUse` decides;
 *  the others only feed session and after-action observations. `Stop` (the agent finished a turn) is the one event VS
 *  Code's Local harness sends at the end of a turn, since it has no `SessionEnd`; it marks the session active and prints
 *  nothing, so it never blocks or prolongs a turn. */
export const COPILOT_EVENTS = ["PreToolUse", "PostToolUse", "PostToolUseFailure", "SessionStart", "SessionEnd", "Stop"] as const;

/** The PowerShell spelling of a hook command. Copilot runs an entry's `powershell` command on Windows, and PowerShell
 *  reads a command that starts with a quoted path as a string, not a program: the call operator `&` runs it. `npx` there
 *  resolves to `npx.ps1`, which the default script policy refuses, so the portable form names `npx.cmd`. PowerShell ends
 *  with exit 1 whenever the last program failed, which would turn the hook's deny (exit 2) into "hook errored" and lose
 *  its reason, so every form passes the program's own exit code on (`; exit $LASTEXITCODE`), an unquoted path included
 *  (the form `absoluteHookCommand` writes on macOS and Linux when no path has a space). */
export function powershellHookCommand(command: string): string {
  const trimmed = withoutPassExitCode(command).trim();
  if (trimmed.startsWith("\"")) return `& ${trimmed}${PASS_EXIT_CODE}`;
  if (/^npx\s/.test(trimmed)) return `npx.cmd ${trimmed.slice(4)}${PASS_EXIT_CODE}`;
  return `${trimmed}${PASS_EXIT_CODE}`;
}

/** One Copilot hook entry running `command`. No matcher: an entry without one runs for every tool.
 *
 *  `bash` and `powershell` are what the Copilot CLI runs (and the cloud agent runs `bash`). The entry also carries the two
 *  fields VS Code's Local harness documents for its own format, `command` and `timeout`, with the same values: the Copilot
 *  hooks reference documents both for this file format too (`command` is the cross-platform fallback, used only where
 *  `bash`/`powershell` are absent, so nothing runs twice; `timeout` is the alias of `timeoutSec`, used only where
 *  `timeoutSec` is absent). Without `timeout`, a reader that does not know `timeoutSec` would wait its own default (30 s
 *  in VS Code Local), shorter than the hook's own deadline. `command` holds the `bash` form, which also runs in cmd; no
 *  `windows` override is written, because the Copilot file format does not document one. Whether VS Code's Local harness
 *  runs this file at all (it is PascalCase with a numeric version, a mix its reference does not describe) is not known
 *  until a live run records it (`capabilities --prove --copilot`). */
export function copilotHookEntry(command: string): Record<string, unknown> {
  const cmd = command.replace(/\b(claude|cursor|codex)$/, "copilot");
  return { type: "command", bash: cmd, powershell: powershellHookCommand(cmd), command: cmd, timeoutSec: COPILOT_TIMEOUT_SEC, timeout: COPILOT_TIMEOUT_SEC };
}

/** Put Scopebond's Copilot entries into a `version: 1` hooks document, replacing any earlier Scopebond entry and leaving
 *  every other entry alone. */
export function addCopilotHooks(config: Record<string, unknown>, command: string): void {
  config.version = config.version ?? 1;
  const hooks = isRecord(config.hooks) ? config.hooks : (config.hooks = {});
  for (const event of COPILOT_EVENTS) {
    const list = Array.isArray(hooks[event]) ? (hooks as Record<string, unknown[]>)[event] : ((hooks as Record<string, unknown[]>)[event] = []);
    const entry = copilotHookEntry(command);
    placeFlatHook(list, entry);
  }
}

/** Write (idempotently) a harness hook entry pointing at an explicit command string.
 *  Shared by the project installer (npx command) and the user installer (absolute path). */
export function writeHarnessConfig(file: string, harness: Harness, command: string): string {
  return editHarnessConfig(file, (config) => {
  const hooks = isRecord(config.hooks) ? config.hooks : (config.hooks = {});
  if (harness === "copilot") {
    addCopilotHooks(config, command);
  } else if (harness === "cursor") {
    config.version = config.version ?? 1;
    for (const event of ["beforeShellExecution", "beforeMCPExecution", "beforeReadFile", "afterFileEdit"]) {
      const list = Array.isArray((hooks)[event]) ? (hooks as Record<string, unknown[]>)[event] : ((hooks as Record<string, unknown[]>)[event] = []);
      const entry = { command: command.replace(/\bclaude$/, "cursor") };
      placeFlatHook(list, entry);
    }
  } else {
    const list = Array.isArray((hooks).PreToolUse) ? (hooks as Record<string, unknown[]>).PreToolUse : ((hooks as Record<string, unknown[]>).PreToolUse = []);
    const hook = harness === "codex" ? codexHookEntry(command) : { type: "command", command };
    // Codex matchers are regular expressions; omitting the matcher means every tool.
    // A literal "*" is not a valid regular expression and causes Codex to skip the group.
    placeGroupedHook(list, hook, () => (harness === "codex" ? { hooks: [hook] } : { matcher: "*", hooks: [hook] }));
  }
  });
}

function placeFlatHook(list: unknown[], entry: Record<string, unknown>): void {
  let placed = false;
  for (let i = 0; i < list.length; i++) {
    if (!entryMatches(list[i])) continue;
    if (!placed) { list[i] = entry; placed = true; }
    else { list.splice(i, 1); i--; }
  }
  if (!placed) list.push(entry);
}

/** Put Scopebond's `hook` into a list of hook groups (`{ matcher?, hooks: [...] }`), in place of the Scopebond hook
 *  already there. A group another tool shares keeps its matcher and every other hook, and Scopebond's hook keeps its place
 *  and its own timeout (someone may have raised it); any further copy of Scopebond's hook goes, and a group left with no
 *  hook goes with it. With no Scopebond hook there yet, `newGroup()` is added at the end. */
function placeGroupedHook(list: unknown[], hook: Record<string, unknown>, newGroup: () => Record<string, unknown>): void {
  let placed = false;
  for (let i = 0; i < list.length; i++) {
    const group = list[i];
    if (isRecord(group) && Array.isArray(group.hooks) && group.hooks.some(commandIsOurs)) {
      const kept: unknown[] = [];
      for (const h of group.hooks) {
        if (!commandIsOurs(h)) { kept.push(h); continue; }
        if (placed) continue;
        placed = true;
        kept.push(isRecord(h) && typeof h.timeout === "number" ? { ...hook, timeout: h.timeout } : hook);
      }
      if (kept.length) list[i] = { ...group, hooks: kept };
      else { list.splice(i, 1); i -= 1; }
    } else if (commandIsOurs(group)) {
      // A bare entry (no group) of Scopebond's: the first becomes a group, any other goes.
      if (placed) { list.splice(i, 1); i -= 1; } else { list[i] = newGroup(); placed = true; }
    }
  }
  if (!placed) list.push(newGroup());
}

/** A hook list without Scopebond's entries. A group (`{ matcher, hooks: [...] }`) another tool shares keeps its matcher and
 *  every hook that is not Scopebond's; only a group left with no hook at all goes. */
function withoutOurHooks(list: unknown[]): unknown[] {
  const kept: unknown[] = [];
  for (const entry of list) {
    if (isRecord(entry) && Array.isArray(entry.hooks) && !commandIsOurs(entry)) {
      const others = entry.hooks.filter((h) => !commandIsOurs(h));
      if (others.length === entry.hooks.length) kept.push(entry);
      else if (others.length > 0) kept.push({ ...entry, hooks: others });
    } else if (!entryMatches(entry)) kept.push(entry);
  }
  return kept;
}

/** Remove any Scopebond hook entry from a user-level harness config, leaving the rest
 *  intact. Returns true when owned entries or an empty dedicated file were removed.
 *  Unsafe paths, malformed configuration and a held writer lock are refused, never reported as removed. */
export function removeHarnessConfig(file: string): boolean {
  if (readHarnessConfigIfPresent(file) === undefined) return false;
  let removed = false;
  editHarnessConfig(file, (config) => {
    removed = false;
    const hooks = isRecord(config.hooks) ? config.hooks : {};
    for (const [event, value] of Object.entries(hooks)) {
      if (!Array.isArray(value)) continue;
      const kept = withoutOurHooks(value);
      if (JSON.stringify(kept) !== JSON.stringify(value)) { hooks[event] = kept; removed = true; }
    }
  }, { mustExist: true, removeWhen: (config) => {
    // Only the dedicated file may disappear; shared configuration keeps its other commands and settings.
    if (basename(file) !== COPILOT_HOOK_FILE || !isCopilotHooksFolder(dirname(file))) return false;
    if (config.hooks !== undefined && !isRecord(config.hooks)) return false;
    const hooks = isRecord(config.hooks) ? config.hooks : {};
    if (Object.keys(config).some((k) => k !== "version" && k !== "hooks")
      || Object.values(hooks).some((v) => !Array.isArray(v) || v.length > 0)) return false;
    removed = true;
    return true;
  } });
  return removed;
}

/** Whether a folder is one Copilot reads hook files from: a `hooks` folder inside `.github` or Copilot's home. */
function isCopilotHooksFolder(dir: string): boolean {
  if (basename(dir) !== "hooks") return false;
  const parent = resolve(dirname(dir));
  return basename(parent) === ".github" || basename(parent) === ".copilot" || parent === resolve(copilotHome());
}

/** Detect a Cursor install by its user config directory. */
export function cursorDetected(): boolean {
  return adapterPresent("cursor");
}

/** Detect a Codex install by its user config directory. */
export function codexDetected(): boolean {
  return adapterPresent("codex");
}

/** Detect the GitHub Copilot CLI: its program on PATH, or what only the CLI leaves in its folder (`settings.json`, `logs`).
 *  The folder alone is not enough: VS Code's Copilot Chat creates `~/.copilot` too, and VS Code's agent mode is not covered
 *  yet, so a VS Code-only computer is not set up for Copilot by a plain `install`. */
export function copilotDetected(platform: NodeJS.Platform = process.platform): boolean {
  return adapterPresent("copilot", { platform });
}

/** Whether a harness's user config directory exists (Claude Code is always offered). */
export function harnessDetected(harness: Harness): boolean {
  if (harness === "cursor") return cursorDetected();
  if (harness === "codex") return codexDetected();
  if (harness === "copilot") return copilotDetected();
  return true;
}

/** A path component that cmd.exe, Windows PowerShell, PowerShell 7 and Git Bash all read as plain text: no space, quote,
 *  `&`, `(`, `$`, `;`, `%`, backtick or other character any of them treats specially. */
const SHELL_PLAIN_COMPONENT = /^[A-Za-z0-9._@~-]+$/;

/** Finds a Windows path's short (8.3) spelling, or null when there is none to find. */
export type ShortPathFinder = (path: string) => string | null;

const shortPaths = new Map<string, string | null>();
/** The environment variable `windowsShortPath` hands cmd.exe the path in. */
const SHORT_PATH_ENV = "SCOPEBOND_SHORT_PATH";

/** The short (8.3) spelling of an existing Windows path (`C:\PROGRA~1\nodejs`), from cmd.exe's `%~s`. Without a short
 *  name on that volume (8.3 names can be switched off), or for a path that does not exist, cmd prints the path unchanged;
 *  the caller checks the result. Null off Windows, or for a path cmd itself could misread. */
export function windowsShortPath(path: string): string | null {
  if (process.platform !== "win32" || /["\r\n\0]/.test(path)) return null;
  const known = shortPaths.get(path);
  if (known !== undefined) return known;
  // The path reaches cmd.exe through an environment variable, never on its command line, so none of its characters
  // (`%`, `!`, `&`, `^`) are parsed: cmd expands the variable once, inside quotes, with delayed expansion off (/v:off).
  // /u makes cmd write UTF-16LE, so a folder name outside the console's code page reads correctly. /s takes the outer
  // quotes off and leaves the quoted variable inside, so the arguments go verbatim.
  const run = spawnSync(windowsSystemProgram("cmd"), ["/d", "/u", "/v:off", "/s", "/c", `"for %I in ("%${SHORT_PATH_ENV}%") do @echo %~sI"`], {
    env: { ...process.env, [SHORT_PATH_ENV]: path }, windowsVerbatimArguments: true, windowsHide: true, timeout: 10_000, stdio: ["ignore", "pipe", "ignore"],
  });
  const found = run.status === 0 && run.stdout ? Buffer.from(run.stdout).toString("utf16le").trim() || null : null;
  shortPaths.set(path, found);
  return found;
}

/** A Windows path spelled so that every shell a coding agent may run a hook command under reads it the same way, with no
 *  quotes: forward slashes, and the short (8.3) name of any folder whose name has a space or another character a shell
 *  treats specially (`C:\Program Files\nodejs\node.exe` → `C:/PROGRA~1/nodejs/node.exe`). Only the folders up to the
 *  last such name are shortened, so the file name itself (`cli.js`, `scopebond-agent.exe`) stays as it is. Null when
 *  there is no such spelling (not a drive path, or no short name for a folder that needs one).
 *
 *  Why not quotes: PowerShell reads a command that starts with a quoted path as a string, not a program, and stops at the
 *  next word ("Unexpected token"); cmd.exe refuses PowerShell's call operator `&`; and Git Bash drops the backslashes of
 *  an unquoted Windows path. A plain forward-slash path starts the program in all of them. */
export function shellPlainWindowsPath(path: string, shorten: ShortPathFinder = windowsShortPath): string | null {
  const m = /^([A-Za-z]:)[\\/](.*)$/.exec(path);
  if (!m) return null;
  const parts = m[2].split(/[\\/]+/).filter(Boolean);
  let last = -1;
  parts.forEach((part, i) => { if (!SHELL_PLAIN_COMPONENT.test(part)) last = i; });
  let plain = parts;
  if (last >= 0) {
    const short = shorten(`${m[1]}\\${parts.slice(0, last + 1).join("\\")}`);
    const sm = short ? /^([A-Za-z]:)[\\/](.*)$/.exec(short) : null;
    if (!sm || sm[1].toLowerCase() !== m[1].toLowerCase()) return null;
    const shortParts = sm[2].split(/[\\/]+/).filter(Boolean);
    if (shortParts.length !== last + 1 || !shortParts.every((part) => SHELL_PLAIN_COMPONENT.test(part))) return null;
    plain = [...shortParts, ...parts.slice(last + 1)];
  }
  return `${m[1]}/${plain.join("/")}`;
}

/** The Windows hook command line running `program` with `args` (plain words) after it: every path in the shell-plain
 *  spelling, or null when a path has none (the caller then falls back to quoted paths, which cmd.exe and Git Bash run). */
export function windowsHookCommandLine(paths: string[], args: string, shorten: ShortPathFinder = windowsShortPath): string | null {
  const plain = paths.map((p) => shellPlainWindowsPath(p, shorten));
  return plain.every((p): p is string => p !== null) ? `${plain.join(" ")} ${args}` : null;
}

/** Characters Git Bash still expands inside double quotes (`$` and a backtick). cmd.exe expands `%NAME%` there too, but
 *  only a defined variable's name between two `%`, and `!` only under delayed expansion, which a hook shell does not
 *  turn on: a quoted path with those starts under cmd.exe and Git Bash, so it is written, and `doctor` notes it. */
const QUOTED_UNSAFE = /[$`]/;

/** The quoted fallback (a path with no shell-plain spelling) cannot carry a path with a character a shell expands even
 *  inside double quotes: the hook would name a different file and could not start, which leaves the agent unchecked. */
export function refuseUnsafeQuotedPaths(paths: string[]): void {
  const bad = paths.find((p) => QUOTED_UNSAFE.test(p));
  if (bad) {
    throw new Error(`cannot write a hook command naming ${bad}: a shell expands its ${bad.match(QUOTED_UNSAFE)?.[0]} even inside quotes, so the hook could not start. Install Scopebond under a folder whose path has no $ or backtick in it`);
  }
}

/** Whether a Windows hook command is the quoted form (`"<node.exe>" "<cli.js>" codex`, a drive or network path), which
 *  cmd.exe and Git Bash start but PowerShell does not (it reads the quoted path as a string). */
export function isQuotedWindowsHookCommand(command: string): boolean {
  return /^"(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/"])/.test(command.trim());
}

/** The note `status` and `doctor` print for a harness on Windows whose Scopebond entry is the quoted fallback: Codex and
 *  Cursor may run it under PowerShell, which cannot start it, and a hook that cannot start leaves the agent unchecked.
 *  Claude Code runs hooks under Git Bash, which starts it, and Copilot entries carry a PowerShell form of their own.
 *  Null when there is nothing to say. */
export function quotedEntryNote(harness: Harness, files: Array<string | null | undefined>, platform: NodeJS.Platform = process.platform): string | null {
  if (platform !== "win32" || (harness !== "codex" && harness !== "cursor")) return null;
  const quoted = files.flatMap((f) => (f ? configuredHookCommands(f) : [])).find(isQuotedWindowsHookCommand);
  if (!quoted) return null;
  return "its hook entry uses the quoted form (written by an earlier release, or this computer has no short name for one of its folders), which may not start under PowerShell; the Scopebond Agent rewrites it when it can — or reinstall";
}

/** The absolute command a harness entry runs: the current Node executable and the
 *  absolute path to this CLI, so it does not depend on PATH.
 *
 *  On Windows the harness runs this string through whichever shell it (or the user) chose: cmd.exe, PowerShell, or Git
 *  Bash. Each reads quotes differently, so both paths are written in the shell-plain spelling (`shellPlainWindowsPath`),
 *  which all of them start the same way. Only when a path has no such spelling are both paths quoted — the form cmd.exe
 *  and Git Bash run (inside double quotes bash leaves a Windows path's backslashes alone); PowerShell cannot run it. */
export function absoluteHookCommand(cliPath: string, harness: Harness, shorten: ShortPathFinder = windowsShortPath): string {
  if (process.platform === "win32") {
    const plain = windowsHookCommandLine([process.execPath, cliPath], harness, shorten);
    if (plain) return plain;
    refuseUnsafeQuotedPaths([process.execPath, cliPath]);
  }
  const quote = (s: string) => (process.platform === "win32" || /\s/.test(s) ? `"${s}"` : s);
  return `${quote(process.execPath)} ${quote(cliPath)} ${harness}`;
}

/** The command a coding agent's settings run when Scopebond is installed as the single executable: the executable itself
 *  with `hook` and the harness. It needs neither Node nor npm, and the installer keeps its path stable. On Windows the
 *  path is in the shell-plain spelling every hook shell runs (see `absoluteHookCommand`); quoted only when it has none. */
export function nativeHookCommand(harness: Harness, exe: string = process.execPath, shorten: ShortPathFinder = windowsShortPath): string {
  if (process.platform === "win32") {
    const plain = windowsHookCommandLine([exe], `hook ${harness}`, shorten);
    if (plain) return plain;
    refuseUnsafeQuotedPaths([exe]);
  }
  return `"${exe}" hook ${harness}`;
}

/** The program a single-executable hook entry runs (`"<…\scopebond-agent.exe>" hook claude`, or the shell-plain
 *  `C:/…/scopebond-agent.exe hook claude`, given back with backslashes), or null for any other form. */
export function nativeHookProgram(command: string): string | null {
  const m = /^(?:"([^"]+)"|([A-Za-z]:\/\S+))\s+hook\s+(?:claude|cursor|codex|copilot)\s*$/i.exec(command.trim());
  const program = m ? (m[1] ?? m[2].replace(/\//g, "\\")) : null;
  return program && /scopebond-agent(?:\.exe)?$/i.test(program) ? program : null;
}

/** The Windows spelling of a Codex hook command (Codex runs `commandWindows` instead of `command` on Windows, through the
 *  session's shell: cmd.exe, PowerShell or Git Bash). The portable `npx` form names `npx.cmd`, which every one of those
 *  shells starts (PowerShell would pick `npx.ps1`, which the default script policy refuses). A command written on Windows
 *  is already in a form every hook shell runs. Otherwise none: a POSIX path means nothing on Windows. */
export function codexWindowsCommand(command: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const trimmed = command.trim();
  if (/^npx\s/.test(trimmed)) return `npx.cmd ${trimmed.slice(4)}`;
  return platform === "win32" ? trimmed : undefined;
}

/** One Codex hook handler running `command`, with its Windows spelling when there is one. */
export function codexHookEntry(command: string, platform: NodeJS.Platform = process.platform): Record<string, unknown> {
  const commandWindows = codexWindowsCommand(command, platform);
  return { type: "command", command, ...(commandWindows ? { commandWindows } : {}), timeout: 30, statusMessage: "Checking this action with Scopebond" };
}

/** Each hook entry in `file` that runs a single executable which is no longer there: an administrator removed an install
 *  for every user (Program Files) and left the per-user entries behind, or the folder was deleted. The coding agent then
 *  fails to start the hook on every action, shows that as a hook error, and runs the action with no check. */
export function missingHookPrograms(file: string, exists: (path: string) => boolean = existsSync): Array<{ command: string; program: string }> {
  return configuredHookCommands(file).flatMap((command) => {
    const program = nativeHookProgram(command);
    return program && !exists(program) ? [{ command, program }] : [];
  });
}

export function isHarnessConfigured(file: string): boolean {
  try {
    const p = JSON.parse(readConfigText(file));
    if (!isRecord(p) || !isRecord(p.hooks)) return false;
    return Object.values(p.hooks).some((v) => Array.isArray(v) && v.some(entryMatches));
  } catch { return false; }
}

/** Every Scopebond command string a harness config currently runs. `doctor` uses it to
 *  check that a pinned command still resolves: a hook entry that cannot start is worse
 *  than none, because a harness can read the failure as "no hook". */
export function configuredHookCommands(file: string): string[] {
  const found: string[] = [];
  const collect = (entry: unknown): void => {
    if (!isRecord(entry)) return;
    const command = harnessEntryCommand(entry);
    if (command !== undefined && isScopebond(command)) found.push(command);
    // Codex runs `commandWindows` instead on Windows: a different one there is checked too.
    const windows = entry.commandWindows;
    if (typeof windows === "string" && windows !== command && isScopebond(windows)) found.push(windows);
    if (Array.isArray(entry.hooks)) for (const h of entry.hooks) collect(h);
  };
  try {
    const p = JSON.parse(readConfigText(file));
    if (!isRecord(p) || !isRecord(p.hooks)) return [];
    for (const list of Object.values(p.hooks)) if (Array.isArray(list)) for (const e of list) collect(e);
  } catch { return []; }
  return found;
}

/** Whether a hook command is the portable npm form (`npx -y @scopebond/hook@<version> <harness>`). */
export function isNpxHookCommand(command: string): boolean {
  return /(^|\s)npx(\.cmd)?\s/.test(command);
}

/** Whether `npx` is on PATH here. A computer set up only with the signed installer may have no Node.js, so the portable
 *  form a project shares (`init --shared`) cannot start there; the installer's own hook entry covers it instead. */
export function npxAvailable(platform: NodeJS.Platform = process.platform): boolean {
  try { return findProgram(platform === "win32" ? "npx.cmd" : "npx", { platform }) !== null; } catch { return false; }
}

/** Whether a configured hook command can actually start. An `npx` form always can
 *  (npm resolves it); a pinned command names two absolute paths — the Node binary and
 *  the CLI — and either can go away: a Node version manager switching versions, or the
 *  Scopebond home being cleared. Both are exactly what this check exists to catch. */
export function hookCommandResolves(command: string): boolean {
  if (/(^|\s)npx(\.cmd)?\s/.test(command)) return true;
  // `"<node>" "<cli.js>" claude`: check every token that names a file on disk.
  const tokens = command.match(/"[^"]+"|\S+/g) ?? [];
  let checked = 0;
  for (const raw of tokens) {
    const candidate = raw.replace(/^"|"$/g, "");
    if (!/\.(m|c)?js$|\.exe$/i.test(candidate)) continue;
    checked += 1;
    if (!existsSync(candidate)) return false;
  }
  // A bare `node cli.js` form on POSIX has no .exe to check; the .js still counted.
  return checked > 0 || !/[\\/]/.test(command.split(/\s+/)[0] ?? "");
}

/** Remove the user-level home (keys, policy, receipts). */
export function purgeHome(): void {
  rmSync(userHome(), { recursive: true, force: true });
}

/** The Claude Code events the observation emitters listen to, beyond PreToolUse. */
export const LIFECYCLE_EVENTS = GROUPED_LIFECYCLE_EVENTS.claude;

/** Add (idempotently) the session lifecycle and after-action hook entries to a supported grouped
 *  config file, running the same Scopebond command that already handles PreToolUse: the
 *  command tells the events apart. Codex definitions still require native trust review.
 *  Nothing else in the file changes. */
export function wireLifecycleHooks(file: string, command: string, harness: keyof typeof GROUPED_LIFECYCLE_EVENTS = "claude"): string {
  return editHarnessConfig(file, (config) => {
  const hooks = isRecord(config.hooks) ? config.hooks : (config.hooks = {});
  for (const event of GROUPED_LIFECYCLE_EVENTS[harness]) {
    const list = Array.isArray((hooks)[event]) ? (hooks as Record<string, unknown[]>)[event] : ((hooks as Record<string, unknown[]>)[event] = []);
    const hook = { type: "command", command };
    placeGroupedHook(list, hook, () => (event.startsWith("Session") ? { hooks: [hook] } : { matcher: "*", hooks: [hook] }));
  }
  });
}

/** Remove only the lifecycle entries `wireLifecycleHooks` added, leaving PreToolUse and every
 *  other setting alone. Returns the number removed. */
export function unwireLifecycleHooks(file: string): number {
  return pruneHarnessEntries(file, () => true, LIFECYCLE_EVENTS);
}
