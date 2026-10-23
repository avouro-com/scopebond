import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { findProgram } from "@scopebond/gateway/node";

export const ADAPTER_REGISTRY_VERSION = 1;
export const ADAPTERS = {
  claude: { label: "Claude Code", directory: ".claude", file: "settings.json", surfaces: ["cli"], approval: "restart", decisionEvents: ["PreToolUse"], capabilities: ["shell", "file_read", "file_write", "mcp", "block", "observe", "lifecycle"] },
  cursor: { label: "Cursor", directory: ".cursor", file: "hooks.json", surfaces: ["desktop"], approval: "restart", decisionEvents: ["beforeShellExecution", "beforeMCPExecution", "beforeReadFile"], capabilities: ["shell", "file_read", "mcp", "block", "observe"] },
  codex: { label: "Codex", directory: ".codex", file: "hooks.json", surfaces: ["cli", "desktop"], approval: "trust", decisionEvents: ["PreToolUse"], capabilities: ["shell", "file_write", "mcp", "block", "observe", "lifecycle"] },
  copilot: { label: "GitHub Copilot CLI", directory: ".copilot", file: "hooks/scopebond.json", surfaces: ["cli"], approval: "restart", decisionEvents: ["PreToolUse"], capabilities: ["shell", "file_read", "file_write", "mcp", "block", "observe", "lifecycle"] },
} as const;

/** Grouped lifecycle events supported by each observation adapter. Other families retain their own event schemas. */
export const GROUPED_LIFECYCLE_EVENTS = {
  claude: ["SessionStart", "SessionEnd", "PostToolUse", "PostToolUseFailure"],
  codex: ["SessionStart", "SessionEnd", "PostToolUse"],
} as const;

export type Harness = keyof typeof ADAPTERS;
export const HARNESSES: readonly Harness[] = Object.freeze(Object.keys(ADAPTERS) as Harness[]);
export function isHarness(value: unknown): value is Harness {
  return typeof value === "string" && Object.hasOwn(ADAPTERS, value);
}

export interface AdapterProfile { home?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform }
export function adapterProfileHome(profile: AdapterProfile = {}): string {
  let home = profile.home ?? homedir();
  // Resolve the explicitly selected profile root, not links inside a tool's configuration.
  // This preserves intentional home-directory aliases without following a swapped hooks path.
  try { home = realpathSync(home); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return resolve(home);
}
export function adapterDirectory(harness: Harness, profile: AdapterProfile = {}): string {
  const home = adapterProfileHome(profile);
  const env = profile.env ?? process.env;
  return harness === "copilot" && env.COPILOT_HOME ? adapterProfilePath(env.COPILOT_HOME, profile) : join(home, ADAPTERS[harness].directory);
}
const contained = (part: string): boolean => part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
/** Resolve only the selected profile's alias. Links beneath that root still reach the configuration path guard. */
export function adapterProfilePath(file: string, profile: AdapterProfile = {}): string {
  const part = relative(resolve(profile.home ?? homedir()), resolve(file));
  return contained(part) ? resolve(adapterProfileHome(profile), part) : resolve(file);
}
/** Automatic enrollment is limited to the selected profile. Explicit installation may use a relocated tool home. */
export function adapterWithinProfile(harness: Harness, profile: AdapterProfile = {}): boolean {
  return withinAdapterProfile(adapterDirectory(harness, profile), profile);
}
export function withinAdapterProfile(file: string, profile: AdapterProfile = {}): boolean {
  return contained(relative(adapterProfileHome(profile), adapterProfilePath(file, profile)));
}
export function adapterFile(harness: Harness, profile: AdapterProfile = {}): string {
  return join(adapterDirectory(harness, profile), ADAPTERS[harness].file);
}

/** Detection is presence evidence, never invocation or authorization. A Copilot Chat folder alone is not CLI evidence. */
export function adapterPresent(harness: Harness, profile: AdapterProfile = {}): boolean {
  const exists = (file: string) => {
    try { lstatSync(file); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  };
  const directory = adapterDirectory(harness, profile);
  if (harness !== "copilot") return exists(directory);
  if (exists(join(directory, "settings.json")) || exists(join(directory, "logs"))) return true;
  const platform = profile.platform ?? process.platform;
  return (platform === "win32" ? ["copilot", "copilot.cmd"] : ["copilot"]).some((name) => {
    try { return findProgram(name, { platform, env: profile.env ?? process.env }) !== null; }
    catch { return false; }
  });
}
