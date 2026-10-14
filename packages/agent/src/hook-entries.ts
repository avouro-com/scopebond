// The Scopebond hook entries in this user's coding-agent settings, as the signed install wants them: every one runs this
// executable (`"<exe>" hook <harness>`). An entry another install wrote (`"node" "…\@scopebond\hook\dist\cli.js" claude`
// from npm, or an npx form) is replaced by that form, and any copies of it are taken out, through the hook's own settings
// helpers; nothing else in those files changes. Also: which entries cannot start, and what file they are missing.

import { existsSync } from "node:fs";
import {
  configuredHookCommands, harnessEntryMatches, nativeHookCommand, pruneHarnessEntries, readHarnessConfig, userHarnessFile, wireLifecycleHooks, writeHarnessConfig,
  type Harness,
} from "@scopebond/hook";

/** The programs a hook command names (an `.exe`, or a `.js` Node runs) that are not on disk. */
export function missingPrograms(commands: string[], exists: (file: string) => boolean = existsSync): string[] {
  const missing = new Set<string>();
  for (const command of commands) {
    for (const raw of command.match(/"[^"]+"|\S+/g) ?? []) {
      const file = raw.replace(/^"|"$/g, "");
      if (/\.(m|c)?js$|\.exe$/i.test(file) && /[\\/]/.test(file) && !exists(file)) missing.add(file);
    }
  }
  return [...missing];
}

/** Whether a settings file has a Scopebond entry for an event other than the one before each tool call (Claude Code's
 *  session and after-action observations). */
function hasLifecycleEntries(file: string): boolean {
  try {
    const hooks = readHarnessConfig(file).hooks;
    if (!hooks || typeof hooks !== "object") return false;
    return Object.entries(hooks as Record<string, unknown>).some(([event, list]) => event !== "PreToolUse" && Array.isArray(list) && list.some(harnessEntryMatches));
  } catch { return false; }
}

export interface EntryChange { harness: Harness; file: string; reason: string }

/** Point every Scopebond hook entry in this user's settings at `exe` (`"<exe>" hook <harness>`). Only settings that already
 *  hold a Scopebond entry are touched; the ones already in that form are left byte for byte. Returns the files changed. */
export function useNativeHookEntries(harnesses: Harness[], exe: string = process.execPath): EntryChange[] {
  const changed: EntryChange[] = [];
  for (const harness of harnesses) {
    const file = userHarnessFile(harness);
    const ours = configuredHookCommands(file);
    if (!ours.length) continue;
    let native: string;
    try { native = nativeHookCommand(harness, exe); } catch (error) {
      changed.push({ harness, file, reason: `could not be moved to the signed install: ${(error as Error).message}` });
      continue;
    }
    if (ours.every((c) => c === native)) continue;
    try {
      const lifecycle = harness === "claude" && hasLifecycleEntries(file);
      // The first entry becomes this executable's (the hook keeps a backup of the file as it was), then every other copy
      // goes, and the session and after-action entries come back with the same command when there were any.
      writeHarnessConfig(file, harness, native);
      pruneHarnessEntries(file, (command) => command !== native);
      if (lifecycle) wireLifecycleHooks(file, native);
      changed.push({ harness, file, reason: "moved to the Scopebond Agent installed by the signed installer" });
    } catch (error) {
      changed.push({ harness, file, reason: `could not be moved to the signed install: ${(error as Error).message}` });
    }
  }
  return changed;
}

/** Whether a Scopebond hook entry for `harness` runs something other than `exe`. */
export function hasForeignHookEntries(harness: Harness, exe: string = process.execPath): boolean {
  let native: string;
  try { native = nativeHookCommand(harness, exe); } catch { return false; } // no entry can be written for this path

  return configuredHookCommands(userHarnessFile(harness)).some((c) => c !== native);
}
