// SB112 — the user-level installer. One install per developer machine (not per repo):
// keys and a starter policy live in a user-level home (~/.scopebond, override
// SCOPEBOND_HOME), and the hook is registered by absolute path in the user-level agent
// config (~/.claude/settings.json, ~/.cursor/hooks.json, ~/.codex/hooks.json). When a
// user-level install exists, a project-local `.scopebond` is used only if the user
// trusted that exact policy (`scopebond trust`, or `init` in the project): a cloned
// repository, or an agent inside it, must not be able to swap in its own policy.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type Harness = "claude" | "cursor" | "codex";

/** The user-level Scopebond home. `SCOPEBOND_HOME` overrides it (tests, CI). */
export function userHome(): string {
  return process.env.SCOPEBOND_HOME ?? join(homedir(), ".scopebond");
}

/** The user-level agent config file for a harness. `HOME`/`USERPROFILE` (via homedir)
 *  roots it; SCOPEBOND_HOME does not move the agent's own config. */
export function userHarnessFile(harness: Harness): string {
  if (harness === "cursor") return join(homedir(), ".cursor", "hooks.json");
  if (harness === "codex") return join(homedir(), ".codex", "hooks.json");
  return join(homedir(), ".claude", "settings.json");
}

/** The project-level agent config file for a harness — what `init` writes, so the
 *  hook travels with the repository rather than the machine. */
export function projectHarnessFile(harness: Harness, cwd: string = process.cwd()): string {
  if (harness === "cursor") return join(cwd, ".cursor", "hooks.json");
  if (harness === "codex") return join(cwd, ".codex", "hooks.json");
  return join(cwd, ".claude", "settings.json");
}

/** Which config files actually carry a Scopebond hook for this harness. There are two
 *  places it can live — the project config `init` writes and the user config `install`
 *  writes — and `status`/`doctor` must look at both: checking only the user one told
 *  everyone who ran `init` that their install had failed. */
export interface HarnessScopes { project: string | null; user: string | null }

export function harnessScopes(harness: Harness, cwd: string = process.cwd()): HarnessScopes {
  const project = projectHarnessFile(harness, cwd);
  const user = userHarnessFile(harness);
  return {
    project: isHarnessConfigured(project) ? project : null,
    user: isHarnessConfigured(user) ? user : null,
  };
}

/** One word for where a harness is wired, for a status line. */
export function harnessScopeLabel(scopes: HarnessScopes): string {
  if (scopes.project && scopes.user) return "configured (project + user)";
  if (scopes.project) return "configured (this project)";
  if (scopes.user) return "configured (user-level)";
  return "";
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

const trustKey = (dir: string): string => resolve(dir).replace(/\\/g, "/").toLowerCase();

/** Pin the project's current policy as trusted. Editing the policy afterwards un-trusts
 *  it until the user trusts it again, so a rewrite by the agent never takes effect. */
export function trustProjectPolicy(dir: string): string {
  const digest = policyDigest(dir);
  if (!digest) throw new Error(`no policy at ${join(dir, "policy.json")}`);
  const trusted = readTrusted();
  trusted[trustKey(dir)] = digest;
  mkdirSync(userHome(), { recursive: true });
  writeFileSync(trustedProjectsFile(), JSON.stringify(trusted, null, 2) + "\n");
  return digest;
}

/** Whether the project's policy is exactly the one the user trusted. */
export function isTrustedProject(dir: string): boolean {
  const digest = policyDigest(dir);
  return !!digest && readTrusted()[trustKey(dir)] === digest;
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
  const dirs = [payloadCwd, process.env.CLAUDE_PROJECT_DIR].filter(Boolean).map((d) => join(d as string, ".scopebond"));
  return dirs.find((d) => existsSync(join(d, "policy.json")) && !isTrustedProject(d)) ?? null;
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
 *  install a duplicate hook — which would double-check every tool call. */
export const isScopebondHookCommand = (cmd: unknown): boolean =>
  typeof cmd === "string" && (
    /@scopebond[\\/]hook/.test(cmd) ||
    /scopebond-hook(\s|$)/.test(cmd) ||
    // the absolute form: `<node> <…/cli.js> claude|cursor|codex`
    /cli\.js["']?\s+(claude|cursor|codex)\s*$/.test(cmd) ||
    /(^|["\s])scopebond(["'\s]).*\b(claude|cursor|codex)\b/.test(cmd)
  );
const isScopebond = isScopebondHookCommand;

/** Whether a harness hook entry (either shape: a bare command, or a group with a
 *  nested `hooks` array) is a Scopebond entry. */
export const harnessEntryMatches = (e: unknown): boolean =>
  isRecord(e) && (isScopebond(e.command) || (Array.isArray(e.hooks) && e.hooks.some((h) => isRecord(h) && isScopebond(h.command))));
const entryMatches = harnessEntryMatches;

/** Read an agent's JSON config for merging. A missing file is an empty config; a file
 *  that exists but does not parse as a JSON object is an error — rewriting it would
 *  silently delete the user's other settings, so the installer stops instead. */
export function readHarnessConfig(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, "utf8");
  if (!text.trim()) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (error) {
    throw new Error(`${file} is not valid JSON (${(error as Error).message}); fix or move it, then run this again — it was left unchanged`);
  }
  if (!isRecord(parsed)) throw new Error(`${file} is not a JSON object; fix or move it, then run this again — it was left unchanged`);
  return parsed;
}

/** Write (idempotently) a harness hook entry pointing at an explicit command string.
 *  Shared by the project installer (npx command) and the user installer (absolute path). */
export function writeHarnessConfig(file: string, harness: Harness, command: string): string {
  const config = readHarnessConfig(file);
  mkdirSync(dirname(file), { recursive: true });
  const hooks = isRecord(config.hooks) ? config.hooks : (config.hooks = {});
  if (harness === "cursor") {
    config.version = config.version ?? 1;
    for (const event of ["beforeShellExecution", "beforeMCPExecution", "beforeReadFile", "afterFileEdit"]) {
      const list = Array.isArray((hooks as Record<string, unknown>)[event]) ? (hooks as Record<string, unknown[]>)[event] : ((hooks as Record<string, unknown[]>)[event] = []);
      const at = list.findIndex(entryMatches);
      const entry = { command: command.replace(/\bclaude$/, "cursor") };
      if (at >= 0) list[at] = entry; else list.push(entry);
    }
  } else {
    const list = Array.isArray((hooks as Record<string, unknown>).PreToolUse) ? (hooks as Record<string, unknown[]>).PreToolUse : ((hooks as Record<string, unknown[]>).PreToolUse = []);
    const at = list.findIndex(entryMatches);
    // Codex matchers are regular expressions; omitting the matcher means every tool.
    // A literal "*" is not a valid regular expression and causes Codex to skip the group.
    const entry = harness === "codex"
      ? { hooks: [{ type: "command", command, timeout: 30, statusMessage: "Checking this action with Scopebond" }] }
      : { matcher: "*", hooks: [{ type: "command", command }] };
    if (at >= 0) list[at] = entry; else list.push(entry);
  }
  writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  return file;
}

/** Remove any Scopebond hook entry from a user-level harness config, leaving the rest
 *  intact. Returns true if the file existed. */
export function removeHarnessConfig(file: string): boolean {
  if (!existsSync(file)) return false;
  let config: Record<string, unknown>;
  try { config = readHarnessConfig(file); } catch { return true; } // unreadable: leave it untouched
  const hooks = isRecord(config.hooks) ? config.hooks : {};
  for (const [event, value] of Object.entries(hooks)) {
    if (Array.isArray(value)) (hooks as Record<string, unknown[]>)[event] = value.filter((e) => !entryMatches(e));
  }
  writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  return true;
}

/** Detect a Cursor install by its user config directory. */
export function cursorDetected(): boolean {
  return existsSync(join(homedir(), ".cursor"));
}

/** Detect a Codex install by its user config directory. */
export function codexDetected(): boolean {
  return existsSync(join(homedir(), ".codex"));
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

export function isHarnessConfigured(file: string): boolean {
  if (!existsSync(file)) return false;
  try {
    const p = JSON.parse(readFileSync(file, "utf8"));
    if (!isRecord(p) || !isRecord(p.hooks)) return false;
    return Object.values(p.hooks).some((v) => Array.isArray(v) && v.some(entryMatches));
  } catch { return false; }
}

/** Every Scopebond command string a harness config currently runs. `doctor` uses it to
 *  check that a pinned command still resolves: a hook entry that cannot start is worse
 *  than none, because a harness can read the failure as "no hook". */
export function configuredHookCommands(file: string): string[] {
  if (!existsSync(file)) return [];
  const found: string[] = [];
  const collect = (entry: unknown): void => {
    if (!isRecord(entry)) return;
    if (isScopebond(entry.command)) found.push(String(entry.command));
    if (Array.isArray(entry.hooks)) for (const h of entry.hooks) collect(h);
  };
  try {
    const p = JSON.parse(readFileSync(file, "utf8"));
    if (!isRecord(p) || !isRecord(p.hooks)) return [];
    for (const list of Object.values(p.hooks)) if (Array.isArray(list)) for (const e of list) collect(e);
  } catch { return []; }
  return found;
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
