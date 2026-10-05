// Duplicate hooks (SB302): the same agent asking Scopebond twice about each action, because the
// Scopebond hook sits in more than one place it reads — the user settings and a project's, two
// entries in one file, or an enabled Claude Code plugin beside a settings entry. Each answer is
// the same, but every action is signed and delivered twice and `status` reads confusingly.
// Only the decision event counts (PreToolUse; Cursor's beforeShellExecution): the observation
// hooks that ride beside it are expected.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { harnessEntryMatches, localHarnessFile, projectHarnessFile, readHarnessConfig, userHarnessFile, type Harness } from "./install.js";

export type HookScope = "user" | "project" | "local" | "plugin";
export interface HookEntry { scope: HookScope; file: string; command: string }

const decisionEvent = (harness: Harness) => (harness === "cursor" ? "beforeShellExecution" : "PreToolUse");

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The Scopebond commands on the decision event of one config file, in order. */
export function decisionEntries(file: string, harness: Harness): string[] {
  if (!existsSync(file)) return [];
  try {
    const config = JSON.parse(readFileSync(file, "utf8")) as unknown;
    const list = isRecord(config) && isRecord(config.hooks) ? config.hooks[decisionEvent(harness)] : undefined;
    if (!Array.isArray(list)) return [];
    return list.filter(harnessEntryMatches).map((e) => {
      const entry = e as Record<string, unknown>;
      if (typeof entry.command === "string") return entry.command;
      const inner = (entry.hooks as unknown[]).find((h) => isRecord(h) && typeof h.command === "string") as Record<string, unknown> | undefined;
      return String(inner?.command ?? "");
    });
  } catch { return []; }
}

/** hooks.json files of Claude Code plugins that are enabled in the user settings. */
export function enabledPluginHookFiles(home = homedir()): string[] {
  const root = join(home, ".claude", "plugins");
  let enabled: string[] = [];
  try {
    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")) as { enabledPlugins?: Record<string, unknown> };
    enabled = Object.entries(settings.enabledPlugins ?? {}).filter(([, on]) => on === true).map(([id]) => id.split("@")[0]);
  } catch { return []; }
  if (!enabled.length || !existsSync(root)) return [];
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 6 || found.length > 50) return;
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      const path = join(dir, name);
      let isDir = false;
      try { isDir = statSync(path).isDirectory(); } catch { continue; }
      if (isDir) walk(path, depth + 1);
      else if (name === "hooks.json" && enabled.some((plugin) => path.split(sep).includes(plugin))) found.push(path);
    }
  };
  walk(root, 0);
  return found;
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

/** Keep one Scopebond decision entry: the first of the chosen scope (user by default). Entries in
 *  other settings files are removed with their observation hooks; a second entry in the kept
 *  file is dropped. Plugins cannot be edited from here: keep "plugin" to remove every settings
 *  entry instead, or turn the plugin off in Claude Code (/plugin). Other tools' hooks are kept. */
export function dedupeHooks(harness: Harness, keep: HookScope = "user", cwd: string = process.cwd(), home = homedir()): { kept: HookEntry | null; removed: HookEntry[]; plugins: HookEntry[] } {
  const entries = hookEntries(harness, cwd, home);
  const kept = entries.find((e) => e.scope === keep) ?? (keep === "plugin" ? null : entries.find((e) => e.scope !== "plugin") ?? null);
  const removed: HookEntry[] = [];
  const plugins = entries.filter((e) => e.scope === "plugin" && e !== kept);
  const files = [...new Set(entries.filter((e) => e.scope !== "plugin").map((e) => e.file))];
  for (const file of files) {
    const config = readHarnessConfig(file);
    const hooks = isRecord(config.hooks) ? config.hooks : {};
    if (kept && file === kept.file && keep !== "plugin") {
      // The kept file: only a second decision entry goes.
      const list = hooks[decisionEvent(harness)];
      if (Array.isArray(list)) {
        let seen = false;
        hooks[decisionEvent(harness)] = list.filter((e) => {
          if (!harnessEntryMatches(e)) return true;
          if (!seen) { seen = true; return true; }
          return false;
        });
      }
      removed.push(...entries.filter((e) => e.file === file).slice(1));
    } else {
      for (const [event, value] of Object.entries(hooks)) if (Array.isArray(value)) hooks[event] = value.filter((e) => !harnessEntryMatches(e));
      removed.push(...entries.filter((e) => e.file === file));
    }
    writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  }
  return { kept, removed, plugins: keep === "plugin" ? [] : plugins };
}
