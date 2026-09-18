# @scopebond/hook

The Scopebond connector for **Claude Code** and **Cursor**. It checks every tool
call a coding agent makes against your policy *before it runs*, blocks the ones
outside policy, and records a signed receipt — locally, on the machine, with no
Cloud dependency in this release.

- **Label:** in-path · prevents (a Claude Code `PreToolUse` deny via exit code 2
  blocks even in bypass-permissions mode).
- **Ceiling:** it governs actions the harness routes through its tool system
  (shell, file, MCP, web). A process started outside the harness is not covered.

## Enroll

```
npx @scopebond/hook init            # Claude Code (or: init --cursor)
```

`init` scaffolds `.scopebond/` (a machine signing key, a countersigning key and a
starter policy — "protect main and production paths") and prints the hook
configuration to add to `.claude/settings.json` or `.cursor/hooks.json`. Then run
one safe command in the agent and see the receipt in `.scopebond/receipts.db`.

## How it works

Each tool call is mapped to a normalized [Action Taxonomy](https://github.com/avouro-com/scopebond)
action (`shell.exec`, `git.push`, `file.write`, `mcp.tool.call`, …), signed by the
machine key and decided against your policy by an in-process check-only gateway.
An allowed action is a **cooperative allow** (recorded, never executed by the
hook — the agent performs it); a denied action is blocked. Unknown tools are
recorded as *not evaluated* and grant nothing. Anything unexpected fails closed
(deny) with a repair message.

Commands are stored as a scrubbed head plus a digest; file contents are never
stored; common secret shapes are removed before signing.

**Strict mode.** By default a tool with no taxonomy mapping is recorded *not
evaluated* (not blocked). Add `--strict` (or `SCOPEBOND_HOOK_STRICT=1`) to deny
unmapped tools too — fail-closed coverage for anything the taxonomy does not map.

## Library

The mapper and runtime are exported for testing and embedding:

```js
import { mapClaudeToolUse, createHookRuntime } from "@scopebond/hook";
```

`mapClaudeToolUse` / `mapCursorEvent` are pure functions (native payload →
normalized action). `createHookRuntime` builds the check-only gateway from a
policy, a machine key and a local receipt log.

Experimental alpha; controlled test use only.
