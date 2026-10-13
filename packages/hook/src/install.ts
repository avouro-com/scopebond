// The user-level installer. One install per developer machine (not per repo):
// keys and a starter policy live in a user-level home (~/.scopebond, override
// SCOPEBOND_HOME), and the hook is registered by absolute path in the user-level agent
// config (~/.claude/settings.json, ~/.cursor/hooks.json, ~/.codex/hooks.json,
// ~/.copilot/hooks/scopebond.json). When a
// user-level install exists, a project-local `.scopebond` is used only if the user
// trusted that exact policy (`scopebond trust`, or `init` in the project): a cloned
// repository, or an agent inside it, must not be able to swap in its own policy.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants, mkdirSync, writeFileSync, existsSync, readFileSync, realpathSync, rmSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { findProgram, programPath } from "@scopebond/gateway/node";
import { readIfPresent, replaceFile } from "./safe-fs.js";

export type Harness = "claude" | "cursor" | "codex" | "copilot";

/** Every coding agent the hook can be wired into, in the order `status` and `doctor` list them. */
export const HARNESSES: readonly Harness[] = ["claude", "cursor", "codex", "copilot"];

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
  if (harness === "cursor") return join(homedir(), ".cursor", "hooks.json");
  if (harness === "codex") return join(homedir(), ".codex", "hooks.json");
  if (harness === "copilot") return join(copilotHome(), "hooks", COPILOT_HOOK_FILE);
  return join(homedir(), ".claude", "settings.json");
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
export function pruneHarnessEntries(file: string, remove: (command: string) => boolean): number {
  let config: Record<string, unknown> | undefined;
  try { config = readHarnessConfigIfPresent(file); } catch { return 0; }
  if (config === undefined) return 0;
  const hooks = isRecord(config.hooks) ? config.hooks : null;
  if (!hooks) return 0;
  let removed = 0;
  const commandsOf = (e: unknown): string[] => {
    if (!isRecord(e)) return [];
    const command = harnessEntryCommand(e);
    const own = command !== undefined && isScopebond(command) ? [command] : [];
    const nested = Array.isArray(e.hooks) ? e.hooks.flatMap(commandsOf) : [];
    return [...own, ...nested];
  };
  for (const [event, value] of Object.entries(hooks)) {
    if (!Array.isArray(value)) continue;
    const kept = value.filter((e) => !(entryMatches(e) && commandsOf(e).some(remove)));
    removed += value.length - kept.length;
    (hooks as Record<string, unknown[]>)[event] = kept;
  }
  if (removed > 0) writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  return removed;
}

/** The file in the user home that pins trusted project policies: absolute project
 *  config dir → SHA-256 of its policy.json. It lives under the protected home, so the
 *  governed agent cannot write it. */
export function trustedProjectsFile(): string {
  return join(userHome(), "trusted-projects.json");
}

function policyDigest(dir: string): string | null {
  try { return createHash("sha256").update(readFileSync(join(dir, "policy.json"))).digest("hex"); } catch { return null; }
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
  const digest = policyDigest(dir);
  if (!digest) throw new Error(`no policy at ${join(dir, "policy.json")}`);
  const trusted = readTrusted();
  if (legacyTrustKey(dir) !== trustKey(dir)) delete trusted[legacyTrustKey(dir)];
  trusted[trustKey(dir)] = digest;
  mkdirSync(userHome(), { recursive: true });
  replaceFile(trustedProjectsFile(), JSON.stringify(trusted, null, 2) + "\n");
  return digest;
}

/** Whether the project's policy is exactly the one the user trusted. */
export function isTrustedProject(dir: string): boolean {
  const digest = policyDigest(dir);
  if (!digest) return false;
  const trusted = readTrusted();
  return trusted[trustKey(dir)] === digest || trusted[legacyTrustKey(dir)] === digest;
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
  return tokens.some((token) => {
    const t = unquote(token).toLowerCase();
    return t.includes("scopebond") || /cli\.(m|c)?js$/.test(t);
  });
};
const isScopebond = isScopebondHookCommand;

/** The command one hook entry runs. Claude Code, Cursor and Codex name it `command`; a GitHub Copilot entry names one
 *  per shell (`bash`, `powershell`), and Scopebond writes the same command in both, so `bash` stands for the entry (the
 *  `powershell` form only adds PowerShell's call operator in front). */
export function harnessEntryCommand(e: unknown): string | undefined {
  if (!isRecord(e)) return undefined;
  for (const key of ["command", "bash", "powershell"]) { const value = e[key]; if (typeof value === "string") return value; }
  return undefined;
}

/** Whether a harness hook entry (either shape: a bare command, or a group with a
 *  nested `hooks` array) is a Scopebond entry. */
export const harnessEntryMatches = (e: unknown): boolean =>
  isRecord(e) && (isScopebond(harnessEntryCommand(e)) || (Array.isArray(e.hooks) && e.hooks.some((h) => isScopebond(harnessEntryCommand(h)))));
const entryMatches = harnessEntryMatches;

/** Read an agent's JSON config for merging. A missing file is an empty config; a file
 *  that exists but does not parse as a JSON object is an error — rewriting it would
 *  silently delete the user's other settings, so the installer stops instead. */
/** A config file's text without a UTF-8 byte-order mark: Windows PowerShell 5.1 writes one
 *  (Set-Content -Encoding UTF8), and JSON.parse refuses the whole file because of it. */
export function readConfigText(file: string): string {
  return readFileSync(file, "utf8").replace(/^\uFEFF/, "");
}

export function readHarnessConfig(file: string): Record<string, unknown> {
  return readHarnessConfigIfPresent(file) ?? {};
}

/** `readHarnessConfig`, but undefined when there is no file. The file is read directly (a missing file is the read's
 *  ENOENT), never checked first: a check followed by the read and a later write races a path swap between them. */
function readHarnessConfigIfPresent(file: string): Record<string, unknown> | undefined {
  const raw = readIfPresent(file);
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

/** One Copilot hook entry running `command`. No matcher: an entry without one runs for every tool. */
export function copilotHookEntry(command: string): Record<string, unknown> {
  const cmd = command.replace(/\b(claude|cursor|codex)$/, "copilot");
  return { type: "command", bash: cmd, powershell: powershellHookCommand(cmd), timeoutSec: COPILOT_TIMEOUT_SEC };
}

/** Put Scopebond's Copilot entries into a `version: 1` hooks document, replacing any earlier Scopebond entry and leaving
 *  every other entry alone. */
export function addCopilotHooks(config: Record<string, unknown>, command: string): void {
  config.version = config.version ?? 1;
  const hooks = isRecord(config.hooks) ? config.hooks : (config.hooks = {});
  for (const event of COPILOT_EVENTS) {
    const list = Array.isArray(hooks[event]) ? (hooks as Record<string, unknown[]>)[event] : ((hooks as Record<string, unknown[]>)[event] = []);
    const at = list.findIndex(entryMatches);
    const entry = copilotHookEntry(command);
    if (at >= 0) list[at] = entry; else list.push(entry);
  }
}

/** Write (idempotently) a harness hook entry pointing at an explicit command string.
 *  Shared by the project installer (npx command) and the user installer (absolute path). */
export function writeHarnessConfig(file: string, harness: Harness, command: string): string {
  const present = readHarnessConfigIfPresent(file);
  const config = present ?? {};
  const before = present !== undefined ? JSON.stringify(config) : null;
  const hooks = isRecord(config.hooks) ? config.hooks : (config.hooks = {});
  if (harness === "copilot") {
    addCopilotHooks(config, command);
  } else if (harness === "cursor") {
    config.version = config.version ?? 1;
    for (const event of ["beforeShellExecution", "beforeMCPExecution", "beforeReadFile", "afterFileEdit"]) {
      const list = Array.isArray((hooks)[event]) ? (hooks as Record<string, unknown[]>)[event] : ((hooks as Record<string, unknown[]>)[event] = []);
      const at = list.findIndex(entryMatches);
      const entry = { command: command.replace(/\bclaude$/, "cursor") };
      if (at >= 0) list[at] = entry; else list.push(entry);
    }
  } else {
    const list = Array.isArray((hooks).PreToolUse) ? (hooks as Record<string, unknown[]>).PreToolUse : ((hooks as Record<string, unknown[]>).PreToolUse = []);
    const at = list.findIndex(entryMatches);
    // Codex matchers are regular expressions; omitting the matcher means every tool.
    // A literal "*" is not a valid regular expression and causes Codex to skip the group.
    const entry = harness === "codex"
      ? { hooks: [{ type: "command", command, timeout: 30, statusMessage: "Checking this action with Scopebond" }] }
      : { matcher: "*", hooks: [{ type: "command", command }] };
    if (at >= 0) list[at] = entry; else list.push(entry);
  }
  // A settings file that already holds exactly this entry is left byte-for-byte
  // untouched — no rewrite, no backup. A running agent session watches this file, and
  // rewriting it (even with the same content) is what disturbed a live session on re-login.
  if (before !== null && JSON.stringify(config) === before) return file;
  backupHarnessConfig(file);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  return file;
}

/** Remove any Scopebond hook entry from a user-level harness config, leaving the rest
 *  intact. Returns true if the file existed. */
export function removeHarnessConfig(file: string): boolean {
  let config: Record<string, unknown> | undefined;
  try { config = readHarnessConfigIfPresent(file); } catch { return true; } // unreadable: leave it untouched
  if (config === undefined) return false;
  const hooks = isRecord(config.hooks) ? config.hooks : {};
  for (const [event, value] of Object.entries(hooks)) {
    if (Array.isArray(value)) (hooks as Record<string, unknown[]>)[event] = value.filter((e) => !entryMatches(e));
  }
  // Copilot's `scopebond.json` is Scopebond's own file: once nothing else is in it, it goes rather than stay behind empty.
  // A file someone added their own hooks or settings to is kept, with only Scopebond's entries removed.
  if (basename(file) === COPILOT_HOOK_FILE && isCopilotHooksFolder(dirname(file))) {
    const othersLeft = Object.keys(config).some((k) => k !== "version" && k !== "hooks")
      || Object.values(hooks).some((v) => !Array.isArray(v) || v.length > 0);
    if (!othersLeft) { rmSync(file, { force: true }); return true; }
  }
  writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  return true;
}

/** Whether a folder is one Copilot reads hook files from: a `hooks` folder inside `.github` or Copilot's home. */
function isCopilotHooksFolder(dir: string): boolean {
  if (basename(dir) !== "hooks") return false;
  const parent = resolve(dirname(dir));
  return basename(parent) === ".github" || basename(parent) === ".copilot" || parent === resolve(copilotHome());
}

/** Detect a Cursor install by its user config directory. */
export function cursorDetected(): boolean {
  return existsSync(join(homedir(), ".cursor"));
}

/** Detect a Codex install by its user config directory. */
export function codexDetected(): boolean {
  return existsSync(join(homedir(), ".codex"));
}

/** Detect the GitHub Copilot CLI: its program on PATH, or what only the CLI leaves in its folder (`settings.json`, `logs`).
 *  The folder alone is not enough: VS Code's Copilot Chat creates `~/.copilot` too, and VS Code's agent mode is not covered
 *  yet, so a VS Code-only computer is not set up for Copilot by a plain `install`. */
export function copilotDetected(platform: NodeJS.Platform = process.platform): boolean {
  const home = copilotHome();
  if (existsSync(join(home, "settings.json")) || existsSync(join(home, "logs"))) return true;
  const names = platform === "win32" ? ["copilot", "copilot.cmd"] : ["copilot"];
  return names.some((name) => { try { return findProgram(name, { platform }) !== null; } catch { return false; } });
}

/** Whether a harness's user config directory exists (Claude Code is always offered). */
export function harnessDetected(harness: Harness): boolean {
  if (harness === "cursor") return cursorDetected();
  if (harness === "codex") return codexDetected();
  if (harness === "copilot") return copilotDetected();
  return true;
}

/** The absolute command a harness entry runs: the current Node executable and the
 *  absolute path to this CLI, so it does not depend on PATH.
 *
 *  Both paths are always quoted on Windows, even without a space in them. A harness
 *  runs this string through a shell, and that shell may be bash (Git Bash, WSL, a
 *  dev container), where an unquoted Windows path loses every backslash and the
 *  hook dies with MODULE_NOT_FOUND. Inside double quotes bash leaves a backslash
 *  alone unless it precedes $ ` " \ or a newline — none of which occur in a Windows
 *  path — and cmd.exe and PowerShell accept quoted paths too. */
export function absoluteHookCommand(cliPath: string, harness: Harness): string {
  const quote = (s: string) => (process.platform === "win32" || /\s/.test(s) ? `"${s}"` : s);
  return `${quote(process.execPath)} ${quote(cliPath)} ${harness}`;
}

/** The command a coding agent's settings run when Scopebond is installed as the single executable: the executable itself,
 *  quoted, with `hook` and the harness. It needs neither Node nor npm, and the installer keeps its path stable. */
export function nativeHookCommand(harness: Harness, exe: string = process.execPath): string {
  return `"${exe}" hook ${harness}`;
}

/** The program a single-executable hook entry runs (`"<…\scopebond-agent.exe>" hook claude`), or null for any other form. */
export function nativeHookProgram(command: string): string | null {
  const m = /^"([^"]+)"\s+hook\s+(?:claude|cursor|codex|copilot)\s*$/i.exec(command.trim());
  return m && /scopebond-agent(?:\.exe)?$/i.test(m[1]) ? m[1] : null;
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
export const LIFECYCLE_EVENTS = ["SessionStart", "SessionEnd", "PostToolUse", "PostToolUseFailure"] as const;

/** Add (idempotently) the session lifecycle and after-action hook entries to a Claude Code
 *  config file, running the same Scopebond command that already handles PreToolUse: the
 *  command tells the events apart. Only Claude Code is wired: its lifecycle events are the
 *  ones the hook's tested mapping covers. Nothing else in the file changes. */
export function wireLifecycleHooks(file: string, command: string): string {
  const config = readHarnessConfig(file);
  backupHarnessConfig(file);
  mkdirSync(dirname(file), { recursive: true });
  const hooks = isRecord(config.hooks) ? config.hooks : (config.hooks = {});
  for (const event of LIFECYCLE_EVENTS) {
    const list = Array.isArray((hooks)[event]) ? (hooks as Record<string, unknown[]>)[event] : ((hooks as Record<string, unknown[]>)[event] = []);
    const at = list.findIndex(entryMatches);
    const entry = event.startsWith("Session")
      ? { hooks: [{ type: "command", command }] }
      : { matcher: "*", hooks: [{ type: "command", command }] };
    if (at >= 0) list[at] = entry; else list.push(entry);
  }
  writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  return file;
}

/** Remove only the lifecycle entries `wireLifecycleHooks` added, leaving PreToolUse and every
 *  other setting alone. Returns the number removed. */
export function unwireLifecycleHooks(file: string): number {
  let config: Record<string, unknown> | undefined;
  try { config = readHarnessConfigIfPresent(file); } catch { return 0; }
  if (config === undefined) return 0;
  const hooks = isRecord(config.hooks) ? config.hooks : null;
  if (!hooks) return 0;
  let removed = 0;
  for (const event of LIFECYCLE_EVENTS) {
    const value = (hooks)[event];
    if (!Array.isArray(value)) continue;
    const kept = value.filter((e) => !entryMatches(e));
    removed += value.length - kept.length;
    if (kept.length) (hooks as Record<string, unknown[]>)[event] = kept; else delete (hooks)[event];
  }
  if (removed > 0) writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  return removed;
}
