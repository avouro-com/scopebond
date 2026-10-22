import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findProgram } from "@scopebond/gateway/node";

export const ADAPTER_REGISTRY_VERSION = 1;
export const ADAPTERS = {
  claude: { label: "Claude Code", directory: ".claude", file: "settings.json", surfaces: ["cli"], approval: "restart", decisionEvents: ["PreToolUse"], capabilities: ["shell", "file_read", "file_write", "mcp", "block", "observe", "lifecycle"] },
  cursor: { label: "Cursor", directory: ".cursor", file: "hooks.json", surfaces: ["desktop"], approval: "restart", decisionEvents: ["beforeShellExecution", "beforeMCPExecution", "beforeReadFile"], capabilities: ["shell", "file_read", "mcp", "block", "observe"] },
  codex: { label: "Codex", directory: ".codex", file: "hooks.json", surfaces: ["cli", "desktop"], approval: "trust", decisionEvents: ["PreToolUse"], capabilities: ["shell", "file_write", "mcp", "block", "observe"] },
  copilot: { label: "GitHub Copilot CLI", directory: ".copilot", file: "hooks/scopebond.json", surfaces: ["cli"], approval: "restart", decisionEvents: ["PreToolUse"], capabilities: ["shell", "file_read", "file_write", "mcp", "block", "observe", "lifecycle"] },
} as const;

export type Harness = keyof typeof ADAPTERS;
export const HARNESSES: readonly Harness[] = Object.freeze(Object.keys(ADAPTERS) as Harness[]);
export function isHarness(value: unknown): value is Harness {
  return typeof value === "string" && Object.hasOwn(ADAPTERS, value);
}

export interface AdapterProfile { home?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform }
export function adapterDirectory(harness: Harness, profile: AdapterProfile = {}): string {
  const home = profile.home ?? homedir();
  const env = profile.env ?? process.env;
  return harness === "copilot" ? env.COPILOT_HOME || join(home, ADAPTERS[harness].directory) : join(home, ADAPTERS[harness].directory);
}
export function adapterFile(harness: Harness, profile: AdapterProfile = {}): string {
  return join(adapterDirectory(harness, profile), ADAPTERS[harness].file);
}

/** Detection is presence evidence, never invocation or authorization. A Copilot Chat folder alone is not CLI evidence. */
export function adapterPresent(harness: Harness, profile: AdapterProfile = {}): boolean {
  const directory = adapterDirectory(harness, profile);
  if (harness !== "copilot") return existsSync(directory);
  if (existsSync(join(directory, "settings.json")) || existsSync(join(directory, "logs"))) return true;
  const platform = profile.platform ?? process.platform;
  return (platform === "win32" ? ["copilot", "copilot.cmd"] : ["copilot"]).some((name) => {
    try { return findProgram(name, { platform, env: profile.env ?? process.env }) !== null; }
    catch { return false; }
  });
}
