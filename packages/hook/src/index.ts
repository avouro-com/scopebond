// @scopebond/hook — the Claude Code, Cursor + Codex connector. The library surface is
// the deterministic mapper and the check-only runtime; the `scopebond-hook`
// binary is the thin harness adapter over them.

export { mapClaudeToolUse, mapCodexToolUse, mapCursorEvent, fillPushBranch } from "./map.js";
export type { Mapped, NormalizedIntent } from "./map.js";
export { createHookRuntime, starterPolicy, upgradeStarterPolicy } from "./runtime.js";
export type { RuntimeConfig, Decision } from "./runtime.js";
export {
  compile, defaultRules, describeRules, loadRules, saveRules, rulesPath, pathRuleFor, RULES_FILE,
} from "./rules.js";
export type { RuleSet, PathRule } from "./rules.js";
export { scaffold, harnessSnippet, installHarness } from "./init.js";
export {
  userHome, userHarnessFile, projectHarnessFile, resolveConfigDir, writeHarnessConfig, removeHarnessConfig,
  cursorDetected, codexDetected, absoluteHookCommand, isHarnessConfigured, purgeHome,
  readHarnessConfig, trustProjectPolicy, isTrustedProject, untrustedProjectPolicy, trustedProjectsFile,
  harnessScopes, harnessScopeLabel, configuredHookCommands, hookCommandResolves,
  isScopebondHookCommand, harnessEntryMatches,
} from "./install.js";
export type { Harness, HarnessScopes } from "./install.js";
export { explainDeny, describeAction, findClause } from "./explain.js";
export type { ExplainDenyInput, ExplainIntent, ExplainPolicy, ExplainClause } from "./explain.js";
export {
  ensureDurableRuntime, isEphemeralPath, nodeModulesRootOf, runtimeRoot, runtimeDirFor, pinnedCliPath,
} from "./runtime-install.js";
export type { PinResult } from "./runtime-install.js";
export { connectCloud, loadConnection, attachExporter, flushBounded, connectionPath } from "./cloud.js";
export type { HookConnection } from "./cloud.js";
export { scrubSecrets, scrubParam, redactCommand, digest, sha256 } from "./minimize.js";
