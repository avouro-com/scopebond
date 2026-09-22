# @scopebond/hook

The Scopebond connector for **Claude Code** and **Cursor**. It checks every tool
call a coding agent makes against your policy *before it runs*, blocks the ones
outside policy, and records a signed receipt — locally, on the machine, and
optionally mirrored to your Scopebond Cloud workspace for monitoring.

- **Label:** in-path · prevents (a Claude Code `PreToolUse` deny via exit code 2
  blocks even in bypass-permissions mode).
- **Ceiling:** it governs actions the harness routes through its tool system
  (shell, file, MCP, web). A process started outside the harness is not covered.

## Install once for your machine

```
npm i -g @scopebond/hook
scopebond install                   # detects Cursor; add --claude / --cursor to pick
```

`install` sets Scopebond up **once per developer machine**, not per repository: it
scaffolds a user-level home (`~/.scopebond`, override `SCOPEBOND_HOME`) with a
signing key, a countersigning key and a starter policy, and registers the hook by
absolute path in your user-level `~/.claude/settings.json` (and `~/.cursor/hooks.json`
when Cursor is present). Every project you open is then governed, and a project-local
`.scopebond/` still takes precedence when you want a per-repo policy.

```
scopebond status                    # home, which agents are configured, cloud, receipts
scopebond doctor                    # node version, config location, cloud reachability
scopebond log                       # recent decisions        scopebond verify   # offline
scopebond uninstall                 # remove the hook (add --purge to delete keys too)
```

### Install as a Claude Code plugin

Scopebond is also a Claude Code plugin (this repo is a plugin marketplace):

```
/plugin marketplace add avouro-com/scopebond
/plugin install scopebond
```

### Per-repository enroll (alternative)

```
npx @scopebond/hook init            # Claude Code (or: init --cursor)
```

`init` scaffolds `.scopebond/` in the current project (a machine signing key, a
countersigning key, a starter policy — "protect main and production paths" — and a
`.gitignore` so none of it is committed) and configures `.claude/settings.json` or
`.cursor/hooks.json`. Then run one safe command in the agent and see the receipt in
`.scopebond/receipts.db`.

## Connect it to your workspace (optional)

To see the receipts in your hosted Scopebond workspace, create a connection from
the portal's **Connect** step (it gives you a one-use enrollment bundle), save it
as `scopebond-enrollment.json`, then:

```
npx @scopebond/hook connect https://<your-workspace> scopebond-enrollment.json
```

In Windows PowerShell, use `npx.cmd` instead of `npx` if script execution policy blocks `npx.ps1`; no execution-policy change is needed. Enrollment registers both the gateway attester and the hook's separate agent signing key with proof of possession, so Cloud can verify authenticated receipts.

`connect` does the whole setup in one command: it scaffolds `.scopebond/` if needed,
enrolls this machine's countersigning key, stores a scoped machine credential in
`.scopebond/cloud.json` (a secret — never commit it), **and configures Claude Code
for you** (it merges the hook into `.claude/settings.json`, preserving anything
already there — pass `--no-install` to skip, or `--cursor` for Cursor). The
enrollment argument can be a file, an inline blob, or JSON on stdin, so the portal
can hand you a single copy-paste command with nothing to save.

From then on every receipt is mirrored to the workspace through a **durable outbox**:
delivery is best-effort and never blocks a tool call, and receipts are retained
locally and retried if the workspace is unreachable. `scopebond-hook flush` delivers
anything still queued — run it on a session-end hook (and set
`SCOPEBOND_HOOK_FLUSH_MS=0`) if you want zero per-call latency.

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
policy, a machine key and a local receipt log; pass `cloud: { connection }` (from
`connectCloud`) to mirror receipts to a workspace.

Experimental alpha; controlled test use only.
