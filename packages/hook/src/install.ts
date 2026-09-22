// SB112 — the user-level installer. One install per developer machine (not per repo):
// keys and a starter policy live in a user-level home (~/.scopebond, override
// SCOPEBOND_HOME), and the hook is registered by absolute path in the user-level agent
// config (~/.claude/settings.json, ~/.cursor/hooks.json). A project-local `.scopebond`
// still wins when present, so per-project policies keep working.

import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type Harness = "claude" | "cursor";

/** The user-level Scopebond home. `SCOPEBOND_HOME` overrides it (tests, CI). */
export function userHome(): string {
  return process.env.SCOPEBOND_HOME ?? join(homedir(), ".scopebond");
}

/** The user-level agent config file for a harness. `HOME`/`USERPROFILE` (via homedir)
 *  roots it; SCOPEBOND_HOME does not move the agent's own config. */
export function userHarnessFile(harness: Harness): string {
  return harness === "cursor" ? join(homedir(), ".cursor", "hooks.json") : join(homedir(), ".claude", "settings.json");
}

/** Resolve the config dir for a hook event, most specific first:
 *  explicit override → the payload's project → $CLAUDE_PROJECT_DIR → the user home.
 *  A project dir counts only when it has been scaffolded (a policy.json), so a bare
 *  working directory never shadows the user-level install. */
export function resolveConfigDir(payloadCwd: string | undefined): string {
  if (process.env.SCOPEBOND_HOOK_DIR) return process.env.SCOPEBOND_HOOK_DIR;
  const candidates: string[] = [];
  if (payloadCwd) candidates.push(join(payloadCwd, ".scopebond"));
  if (process.env.CLAUDE_PROJECT_DIR) candidates.push(join(process.env.CLAUDE_PROJECT_DIR, ".scopebond"));
  for (const dir of candidates) {
    if (existsSync(join(dir, "policy.json"))) return dir;
  }
  const home = userHome();
  if (existsSync(join(home, "policy.json"))) return home;
  // Nothing scaffolded yet: prefer the payload project, else the user home.
  return candidates[0] ?? home;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isScopebond = (cmd: unknown): boolean =>
  typeof cmd === "string" && (
    /@scopebond\/hook|scopebond-hook(\s|$)/.test(cmd) ||
    // the user-level absolute form: `<node> <…/cli.js> claude|cursor`
    /cli\.js["']?\s+(claude|cursor)\s*$/.test(cmd) ||
    /(^|["\s])scopebond(["'\s]).*\b(claude|cursor)\b/.test(cmd)
  );
const entryMatches = (e: unknown): boolean =>
  isRecord(e) && (isScopebond(e.command) || (Array.isArray(e.hooks) && e.hooks.some((h) => isRecord(h) && isScopebond(h.command))));

/** Write (idempotently) a harness hook entry pointing at an explicit command string.
 *  Shared by the project installer (npx command) and the user installer (absolute path). */
export function writeHarnessConfig(file: string, harness: Harness, command: string): string {
  mkdirSync(dirname(file), { recursive: true });
  let config: Record<string, unknown> = {};
  if (existsSync(file)) { try { const p = JSON.parse(readFileSync(file, "utf8")); if (isRecord(p)) config = p; } catch { /* start fresh on unreadable */ } }
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
    const entry = { matcher: "*", hooks: [{ type: "command", command }] };
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
  try { const p = JSON.parse(readFileSync(file, "utf8")); config = isRecord(p) ? p : {}; } catch { return true; }
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

/** The absolute command a user-level harness entry runs: the current Node executable
 *  and the absolute path to this CLI, so it does not depend on PATH. */
export function absoluteHookCommand(cliPath: string, harness: Harness): string {
  const quote = (s: string) => (/\s/.test(s) ? `"${s}"` : s);
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

/** Remove the user-level home (keys, policy, receipts). */
export function purgeHome(): void {
  rmSync(userHome(), { recursive: true, force: true });
}
