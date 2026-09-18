// @scopebond/hook — the Claude Code + Cursor connector. The library surface is
// the deterministic mapper and the check-only runtime; the `scopebond-hook`
// binary is the thin harness adapter over them.

export { mapClaudeToolUse, mapCursorEvent } from "./map.js";
export type { Mapped, NormalizedIntent } from "./map.js";
export { createHookRuntime, starterPolicy } from "./runtime.js";
export type { RuntimeConfig, Decision } from "./runtime.js";
export { scaffold, harnessSnippet } from "./init.js";
export { scrubSecrets, redactCommand, digest, sha256 } from "./minimize.js";
