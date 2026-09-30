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
`.gitignore` so none of it is committed) and wires your agent to the hook. Then run one
safe command in the agent and see the receipt in `.scopebond/receipts.db`. `init`, `trust`
and `uninstall` are meant for a person at a terminal: in a script or CI, pass `--yes`.
`npx @scopebond/hook init --dry-run` shows what it would write, and changes nothing.

**Where the hook goes, and why.** `init` pins a copy of the hook on this machine so it
starts fast on every tool call. That command names paths that exist only here, so it
never goes into a file your team shares: for Claude Code it goes into
`.claude/settings.local.json`, which `init` keeps out of git for this clone; for Cursor
and Codex it goes into `.cursor/hooks.json` or `.codex/hooks.json` only while git does not
already track that file, and a tracked file gets the portable command instead. A hook
command that cannot start is treated by the agent as a non-blocking error — the agent
carries on with no check — so a machine-specific path in a committed file would leave
every teammate unprotected while the file says otherwise. `doctor` reports that case, and
running `init` again moves an entry an older version wrote into `.claude/settings.json`.

To give everyone who clones the project the hook, use `init --shared`: it writes the
portable command (`npx -y @scopebond/hook@<version> claude`) to `.claude/settings.json`,
`.cursor/hooks.json` or `.codex/hooks.json`. It starts on any machine, more slowly, and
until a teammate runs `init` themselves it blocks their agent's actions with a message
saying how to set it up.

Check what it did with `npx @scopebond/hook status` (which agents are configured, in
which scope) and `npx @scopebond/hook doctor` (whether each configured command can
actually start).

### Changing the rules

`.scopebond/policy.json` is **generated**. The thing you edit is `.scopebond/rules.json`,
a short readable list, and `policy.json` is compiled from it — so a limit is a line in a
list, not a 700-character lookahead:

```
npx @scopebond/hook rules                      # what is blocked, in plain English
npx @scopebond/hook rules allow dd             # stop blocking a program
npx @scopebond/hook rules protect infra/       # never write there
npx @scopebond/hook rules protect-branch production
npx @scopebond/hook rules apply                # recompile after editing rules.json by hand
```

The compiled patterns are identical to the ones this package has always shipped — there
is a test that pins them against the starter policy — so the readable front end cannot
change what is enforced. Each clause description is generated from the list too, so it
stays true after an edit, and a block message quotes it.

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

Codex has no native file-read event: reads it makes through shell commands are derived
from the command (`cat .env`) and checked, but a read that never goes through a shell
is not seen. Run `capabilities` (below) for the exact per-cell picture.

### What this hook can honestly claim: `capabilities`

```
npx @scopebond/hook capabilities            # the manifest, per agent host / action / phase
npx @scopebond/hook capabilities --prove    # run the safe fixtures in temp directories
npx @scopebond/hook capabilities --prove --save   # and record the result beside the policy
npx @scopebond/hook capabilities --json
```

Each cell is one connector version, agent host (Claude terminal / desktop, Codex CLI /
desktop, Cursor), action type and phase (before or after the action), in one of these
states:

| State | Meaning |
|---|---|
| `unsupported` | no hook for it, or it is known to escape interception (nested tool wrappers) |
| `inactive` | the hook could cover it but that agent is not configured |
| `configured_unverified` | configured; never proven, or proven only by a local fixture |
| `degraded` | the current fixtures failed |
| `verified_reporting` | a current proof from a real agent run, acknowledged by Cloud |

`--prove` checks, for every supported cell, that a safe action is allowed and signed, a
violating one is denied at the hook, every receipt verifies against the countersigning
key, and every receipt of a tool call carries one action group. It uses temporary
directories only and never reads or changes agent settings, policy or keys. A local
fixture proves the adapter and policy on this machine; it cannot prove that Codex
desktop or Cursor delivers the event, nor that Cloud received a receipt, so it never
produces `verified_reporting`. Actions the agent only reports after they happened
(Cursor's `afterFileEdit`) and actions the default policy only observes (fetches, MCP
calls) are proven with a known successful fixture, labelled observation-only; no
"denied" result is claimed for them.

**Action groups.** A shell call can produce several receipts (the command, each file it
reads or writes, every pushed ref). They now carry `action_group`, `action_group_size`
and `action_group_seq` inside the signed intent's `params`, so they can be linked and
counted once without guessing; the id comes from the agent's own tool-call id when it
sends one.

**Workspace roots (optional).** `rules.json` accepts `"allowed_roots": ["."]`. With it,
a write whose physical target (symlinks and junctions followed; rename and link
destinations included) is outside the roots, or cannot be resolved, is denied. Without
it nothing changes. Run `rules apply` after adding it.

## Connect it to your workspace (optional)

To see the receipts in your hosted Scopebond workspace, sign this computer in:

```
npx @scopebond/hook login https://<your-workspace>
```

It prints a short code and a link. Someone who manages the workspace opens the link,
checks that the code matches, and approves it for an environment and agent. The
command then finishes connecting on its own: nothing is copied or pasted, and the
code expires after 10 minutes if nobody approves it. Add `--cursor` or `--codex`
for those agents, or `--no-install` to leave the agent's settings alone.

If your workspace does not offer sign-in codes, create a connection from the
portal's **Connect** step (it gives you a one-use enrollment bundle), save it as
`scopebond-enrollment.json`, then:

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

### Session, health and action observations (opt-in)

Beyond receipts, the hook can send a second kind of signed record, an *observation*,
to a workspace that supports them. It is **off unless your workspace enrollment grants
`observations:write`**, and it needs the enrollment to give an installation id (the
enrollment's `gateway_id`, or an explicit `installation_id`) and an
`installation_generation`; without those the hook says so in `scopebond status` and
emits nothing. It never guesses a generation. It
never affects a decision: sending is best effort, bounded, and runs after the decision is
made, so an unreachable workspace, a missing route or a rate limit changes nothing about
what is allowed or denied.

Each observation is Ed25519-signed with the enrolled agent key over the domain
`scopebond:observation/v1` plus a newline and the canonical (RFC 8785) payload, and sent
in batches to `POST /v1/observations` as `{ version: "1.0", items: [{ payload, signature }] }`.
A separate keyed digest binds each tool-call observation to the request the hook actually
evaluated; the key stays on this machine and is never uploaded. Paths, commands, hosts and
session ids never leave the machine: they are reduced to keyed opaque ids or closed enums.

| Kind | Sent when | Hosts |
|---|---|---|
| `session` start / stop | Claude Code `SessionStart` / `SessionEnd` (stop reasons: completed, cancelled, unknown; sleep is inferred) | Claude Code |
| `health` heartbeat | every 60 seconds while a session is explicitly active, from one short helper per session that ends with the session | Claude Code |
| `health` queue | oldest pending receipt time and count, at most every five minutes while a backlog exists | Claude Code |
| `tool_intent` | each evaluated action, linked to its receipt | Claude Code, Codex, Cursor (shell, file, git push, MCP) |
| `tool_outcome` | Claude Code `PostToolUse` / `PostToolUseFailure`, echoing the intent's binding | Claude Code |
| `capability` proof | `scopebond capabilities --prove` (marked as a fixture run, never live) | all |
| `policy_ack` | `scopebond policy load <export.json>`, once an exported policy is loaded or refused | all |

With observations on, `capabilities --prove` signs its fixtures with this machine's own keys
(copied into the temporary directory; the originals are never changed), delivers the fixture
receipts to the workspace first, and only then sends each proof, naming those receipts by
`proof_digests`: the SHA-256 of `scopebond:source-receipt/v1` plus a newline plus the
canonical full signed receipt. Only receipts of the cell's own action type are named. If the
receipts cannot be delivered, no proof is sent. The fixture receipts are real receipts in
the workspace's log.

`scopebond policy load <export.json>` checks a policy exported from the workspace (its
policy hash must match the policy, its scope digest must match the export, agent and
environment, and the environment must be the one this machine is connected to) and says
what loading would replace; `--yes` writes it atomically as `policy.json` (the old one is
kept as `policy.previous.json`). It then acknowledges the load, or the refusal with a
reason, echoing the export's policy hash, policy id, policy version and scope digest
exactly. The export itself carries no signature, so get the file from your workspace.
`scopebond rules apply` recompiles `policy.json` from `rules.json` and would replace a loaded policy.

Codex and Cursor have no tested session or after-action mapping, so those kinds are not
sent for them. Nothing is sent from a sleeping host: a heartbeat gap is recorded as a stop
with reason `sleep`, and an idle session releases its lease with one final heartbeat.

Delivery follows the workspace's answers: only acknowledged items are removed, deferred
items are retried with the same id and sequence, and items the workspace refuses stay in a
local terminal-error queue shown by `scopebond observations status --refused` (an
unsupported version or a stale generation is never retried; a rate limit, a paused plan
(HTTP 402) and a refusal without an item id are handled as the workspace reports them). A workspace without the route
is marked unsupported and nothing more is queued until `scopebond observations retry`.
`scopebond observations wire` adds the Claude Code session and after-action hook entries
(`connect` does it automatically when the enrollment grants the scope); `unwire` removes
only those. `SCOPEBOND_OBSERVATIONS_HEARTBEAT=off` keeps everything except the heartbeat helper.

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

**Where receipts live, and how much room they take.** `.scopebond/receipts.db` in the
project, roughly 25 KiB per tool call. Nothing is ever deleted automatically — these are
your evidence — so `status` reports the count and size, and `prune` bounds it when you
choose to:

```
npx @scopebond/hook prune                      # report the footprint
npx @scopebond/hook prune --before 90d --yes   # archive, then remove, anything older
```

`prune` writes the receipts it will remove to a JSONL file beside the database first, so
they stay verifiable, and it refuses outright once the log has been anchored — a receipt's
position is its anchor leaf index, so removing one would make an existing anchor
unverifiable.

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
