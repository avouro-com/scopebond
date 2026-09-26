# @scopebond/hook

The Scopebond connector for **Claude Code**, **Cursor**, and **OpenAI Codex**. It checks every tool
call a coding agent makes against your policy *before it runs*, blocks the ones
outside policy, and records a signed receipt — locally, on the machine, and
optionally mirrored to your Scopebond Cloud workspace for monitoring.

- **What it does:** checks supported agent actions before they run and blocks an
  action when it breaks your policy.
- **Where it works:** actions the coding agent routes through its tool system
  (shell, file, MCP, web). A process started outside the harness is not covered.

## Install once for your machine

```
npm i -g @scopebond/hook
scopebond install                   # detects Cursor and Codex
scopebond install --codex           # set up Codex only
```

`install` sets Scopebond up **once per developer machine**, not per repository: it
scaffolds a user-level home (`~/.scopebond`, override `SCOPEBOND_HOME`) with a
signing key, a countersigning key and a starter policy, and registers the hook by
absolute path in your user-level `~/.claude/settings.json`, `~/.cursor/hooks.json`,
or `~/.codex/hooks.json`. After Codex setup, open Codex, run `/hooks`, review
Scopebond, and choose **Trust** once. Every project you open is then governed by your
user-level policy. A project's own `.scopebond/policy.json` applies only after you trust it
in that project (`scopebond trust`, or `init` there), pinned to its exact contents: a
repository you clone, or an agent working in it, cannot swap in a weaker policy, and any
later edit to that file stops it applying until you trust it again.

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
npx @scopebond/hook init            # Claude Code
npx @scopebond/hook init --cursor   # Cursor
npx @scopebond/hook init --codex    # Codex, then approve it once with /hooks
```

`init` scaffolds `.scopebond/` in the current project (a machine signing key, a
countersigning key, a starter policy — "protect main and production paths" — and a
`.gitignore` so none of it is committed) and configures `.claude/settings.json`,
`.cursor/hooks.json`, or `.codex/hooks.json`. Then run one safe command in the agent and see the receipt in
`.scopebond/receipts.db`. `init`, `trust` and `uninstall` are meant for a person at a
terminal: in a script or CI, pass `--yes`.

Check what it did with `npx @scopebond/hook status` (which agents are configured, in
which scope) and `npx @scopebond/hook doctor` (whether each configured command can
actually start).

### The hook command `init` installs

The hook runs once per tool call, so the command has to start fast. `init` copies this
package into `~/.scopebond/runtime/<version>/` once per machine and points your agent
at that absolute path. Measured on one Windows machine, through a shell, warm cache:

| Command in the agent config | Median per tool call |
|---|---|
| pinned absolute path (the default) | **151 ms** |
| `npx -y @scopebond/hook@<version>` | 1053 ms |

That ~900 ms is npm re-resolving a package already on disk, on every action. Pass
`--npx` to `init` if you would rather have the portable command, and `init` falls back
to it automatically when it cannot make a durable copy — slow beats broken. `doctor`
re-checks that the pinned paths still resolve, so a cleared home or a switched Node
version shows up as a problem rather than as a hook that silently cannot start.

### What each agent can actually stop

| | Claude Code | Cursor | Codex |
|---|---|---|---|
| Shell commands | prevented | prevented | prevented |
| File reads | prevented | prevented | prevented |
| MCP tool calls | prevented | prevented | prevented |
| File writes / edits | prevented | **recorded, not prevented** | prevented |

Cursor reports a file edit only *after* it is written (`afterFileEdit`; it has no
before-edit hook), so an out-of-policy edit there is signed and flagged, not blocked —
and the message says so rather than claiming otherwise. For edits that must be stopped
before they land, make `@scopebond/github-action` a required check on pull requests.

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
`.scopebond/cloud.json` (a secret — never commit it), **and configures your coding
agent for you** (it merges the hook into the agent's settings, preserving anything
already there — pass `--no-install` to skip, `--cursor` for Cursor, or `--codex` for Codex). The
enrollment argument can be a file, an inline blob, or JSON on stdin, so the portal
can hand you a single copy-paste command with nothing to save.

From then on every receipt is mirrored to the workspace through a **durable outbox**:
delivery is best-effort and never blocks a tool call, and receipts are retained
locally and retried if the workspace is unreachable. `npx @scopebond/hook flush`
delivers anything still queued — run it on a session-end hook (and set
`SCOPEBOND_HOOK_FLUSH_MS=0`) if you want zero per-call latency.

## How it works

Each tool call is mapped to a normalized [Action Taxonomy](https://github.com/avouro-com/scopebond)
action (`shell.exec`, `git.push`, `file.write`, `mcp.tool.call`, …), signed by the
machine key and decided against your policy by an in-process check-only gateway.
An allowed action is recorded and the agent proceeds. A denied action is blocked.
Unknown tools are recorded as *not evaluated* and grant nothing — they fall through to
the coding agent's own permission prompt, so the hook never turns an unrecognised
action into an approval. Anything unexpected fails closed (deny) with a repair message.

**What a block says.** A denial names the action, the rule that decided, why that rule
exists (the clause's own description), the engine's technical detail and where to change
it. The same text goes to the agent, so it can choose another approach instead of
retrying a blocked call:

```
Scopebond blocked git.push origin main — rule "protect-branches" (enforce).
Why: Deny pushes to main, master and release/* (any case, any refspec spelling), …
Detail: param ref fails pattern
Change the rule: edit clause "protect-branches" in /repo/.scopebond/policy.json
```

Commands are stored as a scrubbed head plus a digest; file contents are never
stored; common secret shapes are removed before signing.

**What a shell command is checked for.** A command line is split into every command it
runs (`&&`, `;`, pipes, `$( )` and backticks — also inside double quotes — `bash -c`,
`eval`, `trap`, `su -c`, `script -c`, `watch`, `parallel`, `cmd /c`, `pwsh -Command`
and `-EncodedCommand`, `find -exec`, `env -S`), with shell keywords and grouping
(`if … then`, `for … do`, `{ … }`, `!`, `case`) and wrappers (`sudo`, `env`, `time`,
`nice`, `xargs`, `timeout`, `strace`, `busybox` …, each with its own option arity)
stripped so the real program is seen; the wrappers are checked too. Each command is
checked as a program, and the files it reads or writes are checked like the Read and
Write tools: operands of programs that output or copy file content (`cat`, `grep`,
`tar`, …), copies and moves (`cp`, `mv`, `rsync`, `scp`, `Copy-Item`), writers and
editors (`tee`, `touch`, `sed -i`, `yq -i`, `ed`, `vim`, `Set-Content`), git's own writes
(`checkout -- p`, `restore`, `mv`, `rm`, `config core.hooksPath`), secrets sent or staged
(`curl -T`, `-d @file`, `gh gist create`, `git add`) and redirections, including
`x>file` without spaces. Existence and metadata checks (`ls`, `test -f`, `[ -f ]`,
`stat`) and a secret file's name in a string are not reads. Paths are compared
case-insensitively; Windows `\` paths, 8.3 short names (`CLAUDE~1`), `::$DATA` streams
and trailing dots are normalized; and a glob, variable or brace list that could name a
protected file or directory (`.scope*/agent.key`, `.*/*`, `$HOME/.ssh/id_rsa`) is
treated as that file. Every destination of a `git push` is checked in the common
spellings (`refs/heads/main`, `HEAD:main`, a second refspec, `--repo`, `--all`,
`--mirror`); a push whose destination is not on the command line (a git alias, a
configured push refspec, `send-pack`) is denied, and a tags-only push is allowed. The
agent running the hook's own `init`, `install`, `trust`, `uninstall` or `connect` is
denied, and those commands also refuse a non-interactive terminal unless `--yes` is
passed.

**Limits.** The hook sees the command text, not what a program does at run time. It
does not follow a variable whose value it cannot see (`cat $FILE`), a path assembled
inside a script or interpreter (`python script.py`), aliases and functions defined in
an earlier call, git aliases from a config file, recursive reads of a parent of a
protected directory (`grep -r . `, `cp -r ~ /tmp`), or deletion expressed as arguments
(`find -delete`, `git clean`). Commands whose written files are named only inside their
input — `patch`, `git apply`, `git am`, `tar x`, `unzip`, `7z x`, `cpio -i` — are
recorded with an unevaluated write: allowed in normal mode, denied in strict mode.
Reading any `*.pem` file is denied, including a public certificate, because a PEM file
is often a private key. For stronger guarantees, run the agent behind the Scopebond
gateway or in a sandbox; the hook is a guardrail for a cooperating agent, not a jail.

**Strict mode.** A shell command that cannot be parsed (an unbalanced quote) or whose
program is only known at run time (`$cmd`, `$(…) args`) is checked with an empty
program name, which the starter policy denies in every mode — edit the `safe-shell`
clause to change that. By default a tool with no taxonomy mapping, or a write whose
target the command text does not name, is recorded *not evaluated* (not blocked). Add
`--strict` (or `SCOPEBOND_HOOK_STRICT=1`) to deny those too — fail-closed coverage for
anything the taxonomy does not map.

## Library

The mapper and runtime are exported for testing and embedding:

```js
import { mapClaudeToolUse, mapCodexToolUse, createHookRuntime } from "@scopebond/hook";
```

`mapClaudeToolUse`, `mapCursorEvent`, and `mapCodexToolUse` are pure functions (native payload →
normalized action). `createHookRuntime` builds the check-only gateway from a
policy, a machine key and a local receipt log; pass `cloud: { connection }` (from
`connectCloud`) to mirror receipts to a workspace.

Experimental alpha; controlled test use only.
