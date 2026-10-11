// Duplicate hooks: the same agent asking Scopebond twice about each action, because the
// Scopebond hook sits in more than one place it reads — the user settings and a project's, two
// entries in one file, or an enabled Claude Code plugin beside a settings entry. Each answer is
// the same, but every action is signed and delivered twice and `status` reads confusingly.
// Only the decision event counts (PreToolUse; Cursor's beforeShellExecution): the observation
// hooks that ride beside it are expected.

import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { backupHarnessConfig, gitShareState, harnessEntryMatches, localHarnessFile, projectHarnessFile, readHarnessConfig, userHarnessFile, type Harness } from "./install.js";

export type HookScope = "user" | "project" | "local" | "plugin";
export interface HookEntry { scope: HookScope; file: string; command: string }

const decisionEvent = (harness: Harness) => (harness === "cursor" ? "beforeShellExecution" : "PreToolUse");

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The Scopebond commands on the decision event of one config file, in order. */
export function decisionEntries(file: string, harness: Harness): string[] {
  if (!existsSync(file)) return [];
  try {
    const config = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as unknown;
    const list = isRecord(config) && isRecord(config.hooks) ? config.hooks[decisionEvent(harness)] : undefined;
    if (!Array.isArray(list)) return [];
    return list.filter(harnessEntryMatches).map((e) => {
      const entry = e as Record<string, unknown>;
      if (typeof entry.command === "string") return entry.command;
      const inner = (entry.hooks as unknown[]).find((h) => isRecord(h) && typeof h.command === "string") as Record<string, unknown> | undefined;
      return typeof inner?.command === "string" ? inner.command : "";
    });
  } catch { return []; }
}

/** hooks.json files of Claude Code plugins that are enabled in the user settings. */
export function enabledPluginHookFiles(home = homedir()): string[] {
  const root = join(home, ".claude", "plugins");
  let enabled: string[] = [];
  try {
    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8").replace(/^\uFEFF/, "")) as { enabledPlugins?: Record<string, unknown> };
    enabled = Object.entries(settings.enabledPlugins ?? {}).filter(([, on]) => on === true).map(([id]) => id.split("@")[0]);
  } catch { return []; }
  if (!enabled.length || !existsSync(root)) return [];
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 6 || found.length > 50) return;
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      const path = join(dir, name);
      let isDir: boolean;
      try { isDir = statSync(path).isDirectory(); } catch { continue; }
      if (isDir) walk(path, depth + 1);
      else if (name === "hooks.json" && enabled.some((plugin) => path.split(sep).includes(plugin))) found.push(path);
    }
  };
  walk(root, 0);
  // Claude Code keeps a plugin both in its marketplace copy and in its installed cache (and may keep
  // older versions): one enabled plugin is one place, so keep one file per plugin, the installed copy first.
  const byPlugin = new Map<string, string>();
  for (const file of found) {
    const plugin = enabled.find((name) => file.split(sep).includes(name));
    if (!plugin) continue;
    const current = byPlugin.get(plugin);
    if (!current || (!current.split(sep).includes("cache") && file.split(sep).includes("cache"))) byPlugin.set(plugin, file);
  }
  return [...byPlugin.values()];
}

/** Every place this agent would run the Scopebond hook from, seen from `cwd`. */
export function hookEntries(harness: Harness, cwd: string = process.cwd(), home = homedir()): HookEntry[] {
  const entries: HookEntry[] = [];
  const add = (scope: HookScope, file: string | null) => {
    if (!file) return;
    for (const command of decisionEntries(file, harness)) entries.push({ scope, file, command });
  };
  const user = userHarnessFile(harness);
  add("user", user);
  const project = projectHarnessFile(harness, cwd);
  if (project !== user) add("project", project);
  const local = localHarnessFile(harness, cwd);
  if (local && local !== user) add("local", local);
  if (harness === "claude") for (const file of enabledPluginHookFiles(home)) add("plugin", file);
  return entries;
}

/** The entries when there is more than one, else null. */
export function duplicateHooks(harness: Harness, cwd: string = process.cwd(), home = homedir()): HookEntry[] | null {
  const entries = hookEntries(harness, cwd, home);
  return entries.length > 1 ? entries : null;
}

export function describeEntry(e: HookEntry): string {
  return e.scope === "plugin" ? `an enabled Claude Code plugin (${e.file})` : `${e.scope} settings (${e.file})`;
}

/** An entry without its Scopebond commands: a flat entry that is Scopebond's goes (null); in a group
 *  ({ matcher, hooks: [...] }) only the Scopebond commands go, and the group goes only when nothing
 *  else is left in it, so a person's own hook that shares a group with ours is kept. */
function withoutScopebond(entry: unknown): unknown {
  if (!harnessEntryMatches(entry)) return entry;
  const record = entry as Record<string, unknown>;
  if (!Array.isArray(record.hooks)) return null;
  const rest = record.hooks.filter((h) => !harnessEntryMatches(h));
  return rest.length ? { ...record, hooks: rest } : null;
}

/** Replace a settings file whole: the edited text goes to a temp file in the same folder (with the file's own permissions),
 *  which is then renamed over it, so an interrupted write never leaves the person's settings half-written. A settings file
 *  that is a link (a dotfiles folder) is replaced where it points, so the link stays. */
function replaceSettings(file: string, text: string): void {
  let target = file;
  try { target = realpathSync(file); } catch { /* not there: written as named */ }
  let mode = 0o600;
  try { mode = statSync(target).mode & 0o777; } catch { /* a new file: owner only */ }
  const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  try { writeFileSync(temp, text, { mode }); renameSync(temp, target); }
  catch (error) { try { rmSync(temp, { force: true }); } catch { /* nothing to remove */ } throw error; }
}

/** Keep one Scopebond decision entry: the first of the chosen scope (user by default). Entries in
 *  other settings files are removed with their observation hooks; a second entry in the kept
 *  file is dropped. Plugins cannot be edited from here: keep "plugin" to remove every settings
 *  entry instead, or turn the plugin off in Claude Code (/plugin). Other tools' hooks are kept.
 *  Nothing is changed when nothing would be kept (`kept` null: "plugin" asked for and no enabled Scopebond plugin found),
 *  so dedupe never leaves the agent without a Scopebond hook. A file it changes is backed up first
 *  (`<file>.scopebond-backup`, as the installer does) and replaced whole. */
export function dedupeHooks(harness: Harness, keep: HookScope = "user", cwd: string = process.cwd(), home = homedir()): { kept: HookEntry | null; removed: HookEntry[]; plugins: HookEntry[]; shared: HookEntry[] } {
  const entries = hookEntries(harness, cwd, home);
  const kept = entries.find((e) => e.scope === keep) ?? (keep === "plugin" ? null : entries.find((e) => e.scope !== "plugin") ?? null);
  if (!kept) return { kept: null, removed: [], plugins: [], shared: [] };
  const removed: HookEntry[] = [];
  const plugins = entries.filter((e) => e.scope === "plugin" && e !== kept);
  const files = [...new Set(entries.filter((e) => e.scope !== "plugin").map((e) => e.file))];
  // A project file git tracks is the team's setting: removing the hook there would take it away from
  // every teammate who has no user-level install. It is left alone and named.
  const shared: HookEntry[] = [];
  for (const file of files) {
    // The kept file is edited only when it is not the team's, or when the person chose to keep the project's.
    if (gitShareState(file) === "tracked" && (file !== kept.file || keep !== "project")) { shared.push(...entries.filter((e) => e.file === file)); continue; }
    const config = readHarnessConfig(file);
    const before = JSON.stringify(config);
    const hooks = isRecord(config.hooks) ? config.hooks : {};
    if (file === kept.file && keep !== "plugin") {
      // The kept file: only a second decision entry goes.
      const list = hooks[decisionEvent(harness)];
      if (Array.isArray(list)) {
        let seen = false;
        hooks[decisionEvent(harness)] = list.flatMap((e) => {
          if (!harnessEntryMatches(e)) return [e];
          if (!seen) { seen = true; return [e]; }
          const rest = withoutScopebond(e);
          return rest === null ? [] : [rest];
        });
      }
      removed.push(...entries.filter((e) => e.file === file).slice(1));
    } else {
      for (const [event, value] of Object.entries(hooks)) if (Array.isArray(value)) hooks[event] = value.flatMap((e) => { const rest = withoutScopebond(e); return rest === null ? [] : [rest]; });
      removed.push(...entries.filter((e) => e.file === file));
    }
    // A file with nothing to change is left exactly as it is.
    if (JSON.stringify(config) !== before) {
      backupHarnessConfig(file);
      replaceSettings(file, JSON.stringify(config, null, 2) + "\n");
    }
  }
  return { kept, removed, plugins: keep === "plugin" ? [] : plugins, shared };
}
