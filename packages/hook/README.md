# @scopebond/hook

The free, open-source Scopebond connector for **Claude Code**, **Cursor**, and
**OpenAI Codex**. It checks supported actions delivered through the configured
hook against your policy and signs decision records locally. Some actions are
observed after they happen: Cursor file edits are recorded, not prevented. See
the coverage table below before choosing what to protect.

**License and hosting:** this package is Apache-2.0 open-source software.
Scopebond Cloud, the hosted shared workspace, is a separate proprietary service.
You can use the hook locally without a Cloud account, or optionally connect it
for shared activity, rule review, and retained evidence. For hosted setup, start
with the [workspace getting-started guide](https://scopebond.com/get-started).

- **What it does:** blocks supported actions when a configured rule requires it,
  and records evaluated decisions and supported observations.
- **Where it works:** actions the coding agent routes through its tool system
  (shell, file, MCP, web). A process started outside the harness is not covered.

## Install once for your machine

```
npm i -g @scopebond/hook@latest
scopebond install                   # detects Cursor and Codex
scopebond install --codex           # set up Codex only
```

In Windows PowerShell type `npm.cmd` and `scopebond.cmd` (PowerShell's default script policy blocks
the plain names; the `.cmd` forms work without changing it).

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
npx -y @scopebond/hook@latest init            # Claude Code
npx -y @scopebond/hook@latest init --cursor   # Cursor
npx -y @scopebond/hook@latest init --codex    # Codex, then approve it once with /hooks
```

`init` scaffolds `.scopebond/` in the current project (a machine signing key, a
countersigning key, a starter policy — "protect main and production paths" — and a
`.gitignore` so none of it is committed) and wires your agent to the hook. Then run one
safe command in the agent and see the receipt in `.scopebond/receipts.db`. `init`, `trust`
and `uninstall` are meant for a person at a terminal: in a script or CI, pass `--yes`.
`npx -y @scopebond/hook@latest init --dry-run` shows what it would write, and changes nothing.

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

Check what it did with `npx -y @scopebond/hook@latest status` (which agents are configured, in
which scope) and `npx -y @scopebond/hook@latest doctor` (whether each configured command can
actually start).

### Changing the rules

`.scopebond/policy.json` is **generated**. The thing you edit is `.scopebond/rules.json`,
a short readable list, and `policy.json` is compiled from it — so a limit is a line in a
list, not a 700-character lookahead:

```
npx -y @scopebond/hook@latest rules                      # what is blocked, in plain English
npx -y @scopebond/hook@latest rules allow dd             # stop blocking a program
npx -y @scopebond/hook@latest rules protect infra/       # never write there
npx -y @scopebond/hook@latest rules protect-branch production
npx -y @scopebond/hook@latest rules apply                # recompile after editing rules.json by hand
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
npx -y @scopebond/hook@latest capabilities            # the manifest, per agent host / action / phase
npx -y @scopebond/hook@latest capabilities --prove    # run the safe fixtures in temp directories
npx -y @scopebond/hook@latest capabilities --prove --save   # and record the result beside the policy
npx -y @scopebond/hook@latest capabilities --json
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
npx -y @scopebond/hook@latest login https://<your-workspace>
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
npx -y @scopebond/hook@latest connect https://<your-workspace> scopebond-enrollment.json
```

In Windows PowerShell, use `npx.cmd` instead of `npx` if script execution policy blocks `npx.ps1`; no execution-policy change is needed. Every command the hook prints for you to run uses `npx.cmd` on Windows.

### Is it delivering?

`status` shows when this computer last delivered records, how many are waiting to send and the
last problem. Records are never dropped from the queue while they wait: a long outage only makes
the queue longer. If the workspace refuses this computer's connection (it was revoked, replaced or
removed), `status` says **NOT DELIVERING** with the time it stopped and the one command that fixes
it, which is signing in again. `status` also says **NOT DELIVERING** when records have waited more
than five minutes and the workspace has accepted nothing since they were queued, whatever the
last error says, and names `flush`, which sends the queue with no time limit and prints the
workspace's answer. Each tool call gives delivery a short time (800 ms, `SCOPEBOND_HOOK_FLUSH_MS`)
before the hook exits; an attempt cut off by that limit is recorded as a `timeout` error rather
than as nothing. `status --json` prints the same in one machine-readable shape (`scopebond.status.v1`) for tools and support: `delivery.last_error_code` is `timeout` for a cut-off attempt, `state` is `recording_locally` for a stalled queue, and `config.user_connection_shadowed` is true when a project setup takes precedence over your user-level sign-in in the current folder. `doctor` also checks that the workspace still accepts the connection,
not only that it is reachable, and fails when it does not, when the queue is stalled, or when this
folder's own setup takes precedence over your sign-in without being connected.

`status` and `doctor` also say when an agent would ask Scopebond more than once for each action:
the hook in your user settings and a project's, twice in one file, or an enabled Claude Code plugin
beside a settings entry. Every action would then be signed and sent twice. `dedupe` keeps the
user-level entry (`--keep project` or `--keep plugin` to keep another) and removes the rest,
leaving other tools' hooks alone; the Scopebond Agent's daily self-check reports the same.

The connection renews itself: in the last 30 days of its 90-day credential the hook renews it during its rules check, proving it still holds the key it enrolled with. With each rules check it also tells the workspace how many records wait to send (counts and one error line, never a record), so the portal can show a computer that checks in but is not delivering.

Signing in sets Scopebond up for you across projects, from whatever folder you run it: it connects `~/.scopebond` and puts the hook in your user-level agent settings (`~/.claude/settings.json`, `~/.cursor/hooks.json` or `~/.codex/hooks.json`), so every project on this computer is checked. `--project` connects the current folder's own setup (`.scopebond/`) instead. Signing in again never rewrites a settings file that already holds the right hook entry.

A folder can still have its own project setup, from `init` or an earlier `login --project`. When that setup is trusted, it takes precedence over your sign-in for agent sessions opened in that folder: their rules come from it, and their records go to its own connection, or stay on this computer when it has none. `login` says so when you run it from such a folder, with how to remove it (delete the folder's `.scopebond/` and the Scopebond entry in its project agent settings), and `status` and `doctor` show it too.

Enrollment registers both the gateway attester and the hook's separate agent signing key with proof of possession, so Cloud can verify authenticated receipts.

`connect` does the whole setup in one command: it scaffolds `.scopebond/` if needed,
enrolls this machine's countersigning key, stores a scoped machine credential in
`.scopebond/cloud.json` (a secret — never commit it), **and configures your coding
agent for you** (it merges the hook into the agent's settings, preserving anything
already there — pass `--no-install` to skip, `--cursor` for Cursor, or `--codex` for Codex). The
enrollment argument can be a file, an inline blob, or JSON on stdin, so the portal
can hand you a single copy-paste command with nothing to save.

From then on every receipt is mirrored to the workspace through a **durable outbox**:
delivery is best-effort and never blocks a tool call, and receipts are retained
locally and retried if the workspace is unreachable. `npx -y @scopebond/hook@latest flush`
delivers anything still queued — run it on a session-end hook (and set
`SCOPEBOND_HOOK_FLUSH_MS=0`) if you want zero per-call latency. Records then wait until the
session ends, so during a long session `status` and `doctor` report them as not delivered.

**Reconnecting.** Run `login` again from any folder: it repairs your user-level connection
instead of creating a second one; pass `--project` to reconnect the setup of the folder you
are in. If the workspace
no longer accepts this computer's countersigning key (the computer was replaced or
disconnected there), `login` replaces the key and keeps the old one in
`.scopebond/retired-keys/`.

**Records signed by an earlier key.** The new connection cannot deliver records the earlier
key signed, so they leave the delivery queue but stay in the local log.
`npx -y @scopebond/hook@latest recover` asks the workspace to accept them, waits while an owner or
admin approves it there, then sends them; the workspace checks each signature against the
key it kept and labels the records as recovered.

### Rules set by your workspace

A connected computer keeps its own rules (`.scopebond/rules.json`) until someone who manages
the workspace changes a rule for it there. From then on the workspace decides, rule by rule,
whether a matching action is **blocked** or only **recorded**, and can add entries to this
computer's lists (protected branches, programs, allowed sites). The workspace never sends
patterns: the hook compiles its choices with the same compiler as `rules apply`.

- **When it applies.** At most once every five minutes, a tool call also checks for changes,
  alongside sending its activity record and capped at about one and a half seconds
  (`SCOPEBOND_POLICY_SYNC_MS`); every other call only reads two small files. A change therefore
  applies within a few minutes of the agent's next action, and a workspace that is slow or
  unreachable never holds up the agent for longer than the cap. The new rules govern from the
  next action. `npx -y @scopebond/hook@latest policy sync` checks right now.
- **What is checked.** A rules document must be complete, issued for this computer, match its
  digest and be newer than the one in force; the resulting policy must load. Anything else is
  refused, the rules already in force stay, and the refusal is reported to the workspace.
- **What is confirmed.** After loading, the hook tells the workspace exactly which version it
  loaded, so the workspace shows *Applied* only for computers that confirmed it.
- **What the workspace cannot change.** Protection of Scopebond's own settings and of the
  agents' hook settings, the machine key policy, fail-closed handling of anything unreadable,
  and this computer's own opt-ins (`allowed_roots`, `protect_remote_database`).
- **Overrides.** The workspace can set a rule to *Block, user may override* and say who may
  override. A matching action is then blocked until the person at the computer allows it once,
  with a reason, in the Scopebond Agent's window (`@scopebond/agent`): the hook asks the running
  agent and waits up to 45 seconds (20 seconds for Codex and Cursor), then blocks. The receipt
  records the override, the reason's digest and the rule; the workspace adds who and why. Where the
  workspace allows it and the window is not available, Claude Code's own prompt is offered instead,
  but only in a permission mode where Claude Code really asks; that prompt takes no reason and is
  recorded as *offered*. Scopebond's own protection, rules set to Block and the kill switch are
  never overridable, and the workspace's daily limit holds.
- **Going back.** While the workspace sets the rules, `rules` edits and `policy load` are
  refused here. If the connection is revoked, or the workspace stops setting rules for this
  computer, the hook recompiles `policy.json` from `rules.json`: a computer is never left
  without rules. `status` shows which rules are in force and when they were last checked.

Set `SCOPEBOND_POLICY_SYNC=off` to stop the five-minute check (the rules in force stay).

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

`scopebond budget load <export.json>` does the same for an action budget exported from the
workspace: it checks the document type and version, the policy digest (over the policy
without its acknowledgement), the scope digest, the environment, the validity window and the
fail-closed contract, and refuses a budget an independent installation cannot enforce (one
shared across installations). `--yes` writes it into `dispatch.json` as an acknowledged
budget for this agent (replacing an older workspace budget, never a newer one) and queues
the acknowledgement with the export id, budget id and version, and digests the workspace
expects. The export names the agent key it is for (`agent_kid`): a different key than this
machine's is refused (and acknowledged as rejected); an export whose key the workspace could not
state (null) loads with a warning that its identity could not be bound, and an export without
the field is refused. The budget's actor is that key. An enforced budget denies new dispatch
once its export has expired, until you load a new one.

When this machine is connected with `observations:write`, the dispatch boundary can also use
the workspace: an approval granted there for exactly the request is found and consumed at
dispatch with nothing to copy (the guard asks `GET /v1/monitoring/approvals/active` with the
request hash, action type and opaque target id; the denial message still prints the request
hash and target id to approve). Leaving `{ "cloud_approval_id": "<id>" }` in `approvals/`
still works and is used first. Only the consume approves: a lookup that finds nothing, fails
or finds another request approves nothing. A delegated session this machine does not know is resolved from the workspace
(scope entries are digests of `action_type NUL target-id` or `action_type NUL *`, over the
same opaque target id; the workspace's own `covers` answer for the action decides when it
gives one) and cached for 15 seconds. With approvals required for an action type in
`dispatch.json`, each typed operation also carries `approval_request_hash` (the hash the guard
consumes with) and a `resource_id` equal to the guard's target id, so a consumed approval can be
matched to its intent; the field is a claim and authorizes nothing. If the workspace cannot be reached and no valid local approval is
presented, an enforced action is denied. Targets reach the workspace only as keyed opaque ids.
Set `"cloud": false` in `dispatch.json` to keep everything local.

#### Typed operations: git, GitHub and package installs

A `tool_intent` carries one closed typed operation read from the request the hook is about to
allow: the raw shell command or the MCP tool input, never a model-written summary. It replaces the
generic shell operation for the same receipt when it can be described:

| Operation | From | What it carries |
|---|---|---|
| `git` commit | `git commit` | repository id, current branch as a keyed ref id with a protected flag, HEAD before the commit |
| `git` push, delete, mirror | `git push` (`--delete`, `:ref`, `--mirror`) | the same, plus `force`, the remote as a keyed id (a name and its URL give one id; credentials in a URL are dropped) and `resolution` |
| `github_resource` pr_create, release_create | `gh pr create`, `gh release create`, the GitHub MCP `create_pull_request` | keyed repository id and the base and head commits, or the release commit, read from the local clone; `required_check_policy_version` is `unbound` unless `SCOPEBOND_REQUIRED_CHECK_POLICY_VERSION` is set |
| `package` install, add, update | `npm`, `pnpm`, `yarn`, `pip`, `uv` with named packages | manager, the version pinned in `package.json`'s `packageManager` when it names that manager, and per package the name, an exact version only when the request pinned one, and the registry host only when the command named one |

Unknown facts stay unknown. An unresolved ref or remote is `resolution: "unresolved"`;
`integrity_status` is always `unknown` because nothing is verified before the install runs; lifecycle
scripts are `blocked` only for `--ignore-scripts`, `unknown` for npm, pnpm and yarn otherwise, and
`not_supported` for pip and uv. A command that installs whatever a lockfile or requirements file lists
(`npm ci`, `pnpm install`, `pip install -r`, `uv sync`) names no packages and stays a plain shell
operation; so does anything after a `cd` in the same command line, `git -C`, a pull request from a fork
or another repository, and `gh pr edit` or `gh pr merge`, whose pull request is named only by number and
has no head or base commit without a platform read-back this hook does not do (the capability manifest lists
`github.pr_change` and `deploy.run` as unsupported). Non-registry package sources are named `url:`,
`git:` or `local:` with credentials and queries dropped. These cells are observation-only and stay
`configured_unverified` after `capabilities --prove` (a fixture proves the derivation on this machine, not the host);
no proof is sent for them because they have no receipt of their own action type to name.

Reference sets refer to refs, remotes and repositories by these keyed ids. `scopebond observations id ref main`,
`observations id remote <url>`, `observations id ghrepo owner/name` and `observations id mcp <server> <tool>`
print the id this installation gives a value; it reads the local key and sends nothing.

#### Typed operations: network, Cloudflare and databases

The same rules apply: the operation is read from the raw command (or a Claude Code `WebFetch` input),
unknown facts stay unknown, and a command the reader cannot place fully stays a plain shell operation.

| Operation | From | What it carries |
|---|---|---|
| `network` | `WebFetch` (Claude Code), `curl`, `wget`, `Invoke-WebRequest`, `Invoke-RestMethod` and their aliases | scheme, lowercase IDNA host, effective port, method, and `read` (GET, HEAD, OPTIONS), `write` (DELETE, or a POST, PUT or PATCH with no body) or `upload` (a POST, PUT or PATCH with a body or file) |
| `cloudflare_resource` | `wrangler` (also through `npx`, `pnpm exec`, `npm exec`): `deploy`, `delete`, `pages deploy`, `pages project create/delete`, `d1 create/delete`, `r2 bucket create/delete`, `r2 bucket dev-url enable/disable`, `r2 object put/delete` | resource kind and verb, keyed account and resource ids, the `--env` as an environment class and keyed binding, and a SHA-256 of the directory a Pages deploy sends or the file an R2 put sends |
| `database` | `wrangler d1 execute` and `d1 migrations apply`, `psql` (`-c`, `-f`), `sqlite3` | provider, verb (read, insert, update, delete, delete_all, create, alter, drop, migrate), `predicate_class` bounded, all or not_applicable, a keyed database id and a keyed digest of the statement or of the local migration set |

What never leaves the machine: the URL path, query and credentials, headers and request bodies; SQL text,
table and column names, literals and rows; recipient details; file contents. The database digest is an HMAC under
the installation key, so another installation cannot reproduce it. The SQL classifier is deliberately
conservative: an `UPDATE` or `DELETE` counts as bounded only when a top-level AND-ed condition is selective (an OR,
a tautology such as `1=1`, `LIKE '%'` or `IS NOT NULL` alone counts as every row), and SQL it cannot place (dynamic
SQL, `CALL`, `VACUUM`, a `CTE` that writes, an unbalanced quote) produces no database operation at all, because the
closed schema has no unknown verb.

Known limits, said plainly: a redirect hop is never followed or bound (`redirect_binding` is always omitted, so a
redirected request is not qualified against the origin's approval); a request sent through a proxy,
`--resolve`, `--connect-to`, a config file or more than one URL is not described; IPv6 literals and non-HTTP
schemes are not described; `wrangler` has no DNS command, so `dns_record` changes are not seen; `d1 execute` records
the environment only from `--local` or `--env`, and `environment_class` is otherwise `unknown` (the hook cannot tell which database
is production); a `d1 migrations apply` digest covers the whole local migrations directory, not only the pending files;
account ids come from an inline `CLOUDFLARE_ACCOUNT_ID=`, the Wrangler config or this process's environment and are
`unbound` when none names one. The shell receipt of a command still carries the redacted command head the hook has
always recorded (a scrubbed prefix of up to 64 characters), which can include the start of an inline SQL statement.

Capability cells `network.request`, `cloudflare.resource` and `database.exec` are observation-only and stay
`configured_unverified` without a real-host proof. `browser.action`, `communication.send` and `visibility.change`
are registered as `unsupported` with their reasons: no host this hook supports sends an approved browser or
communications event (a browser or mail tool arrives as a generic MCP call with no origin, verb, destination or
attachment set), and no supported source reports a resource's visibility before and after.
`observations id net-dest <host> <port>`, `observations id cf <kind> <name>` and `observations id database <pg|sqlite> <key>`
print the keyed ids for writing reference sets.

**Optional enforcement.** `scopebond-hook rules protect-remote-database` (off by default; `rules.json` field
`protect_remote_database`) adds an enforce clause that denies, before the command runs, SQL against a remote
database (a `wrangler d1` command without `--local`, or `psql` to a host other than this machine) that drops a table,
deletes or updates every row, drops or renames inside an `ALTER`, or cannot be read. The hook cannot tell which
database is production, so every remote database is covered; `wrangler d1 execute` with neither `--local` nor `--remote`
is treated as remote because Wrangler's default has differed between versions. Everything else stays observation.

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
npx -y @scopebond/hook@latest prune                      # report the footprint
npx -y @scopebond/hook@latest prune --before 90d --yes   # archive, then remove, anything older
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
agent running the hook's own `init`, `install`, `trust`, `uninstall`, `connect` or
`login` is denied, and those commands also refuse a non-interactive terminal unless
`--yes` is passed. So is the agent switching off the Scopebond Agent: `scopebond-agent
autostart off`, stopping it by name (`pkill -f scopebond-agent`, `taskkill`, `wmic …
terminate`), or a global uninstall of `@scopebond/agent` or `@scopebond/hook` (`npm
uninstall -g`, `pnpm rm -g`, `yarn global remove`, `bun remove -g`). `scopebond-agent
status`, `flush`, `check`, `repair` and `autostart on` stay allowed. A person can still
run any of these from their own terminal, which the hook never sees.

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
