# @scopebond/hook

The free, open-source Scopebond connector for **Claude Code**, **Cursor**,
**OpenAI Codex** and **GitHub Copilot**. It checks supported actions delivered through the configured
hook against your rules and signs a record of each decision locally. Some actions are
observed after they happen: Cursor file edits are recorded, not prevented. See
the coverage table below before choosing what to protect.

**License and hosting:** this package is Apache-2.0 open-source software.
Scopebond Cloud, the hosted shared workspace, is a separate proprietary service.
You can use the hook locally without a Cloud account, or optionally connect it
for shared activity, rule review, and retained signed records. For hosted setup, start
with the [workspace getting-started guide](https://scopebond.com/get-started).

- **What it does:** records each supported action and what each rule would decide. A rule
  blocks only once you (or your workspace) set it to Block. Scopebond's own protection is on
  from the start: Scopebond blocks a coding agent from changing its settings or uninstalling it
  through its tools.
- **Default:** Monitor. Each rule starts in Monitor, recording, not blocking. Set one to Block
  with `rules enforce <rule>`.
- **Where it works:** actions the coding agent routes through its tool system
  (shell, file, MCP, web). A process started outside the harness is not covered.

## Install once for your machine

### Windows: the signed installer

On Windows, install Scopebond with the signed installer
([scopebond.com/get-started](https://scopebond.com/get-started#desktop-agent), or `winget install Avouro.Scopebond`).
It installs one signed program, `scopebond-agent.exe`, that is both the Scopebond service on the computer and this hook, and needs
neither Node.js nor npm. It installs for you alone in `%LOCALAPPDATA%\Programs\Scopebond`, or for every user in
`%ProgramFiles%\Scopebond`, and puts that folder on PATH. Then:

```
scopebond-agent setup https://cloud.scopebond.com   # sign in, set up the coding agents, start with Windows
scopebond-agent hook status                         # every hook command below, after `hook`
scopebond-agent hook rules
```

The coding agents' settings run the program by its full path (`"…\scopebond-agent.exe" hook claude`). Every
command the hook prints for you to run (in a blocked action's message, `status`, `doctor`, help and next steps) is
then the `scopebond-agent hook …` form, never `npx.cmd` or `npm.cmd`, which would fail on a computer without Node.js.
The coding agent may read the install folder, but the always-on protection refuses to let it change or delete
anything there (see [Scopebond's own protection](#changing-the-rules)).

If the program is removed while a coding agent's settings still name it (an administrator removed an install for
every user, say), the coding agent cannot start the hook: it shows a hook error on each action and runs the action
with no check. `status` and `doctor` report that entry as pointing at a missing program and name the fix: reinstall,
or run `install` (or `init` for a project) to point it at the Scopebond that runs them, or `uninstall` to remove it.

### macOS and Linux (and existing npm installs on Windows)

```
npm i -g @scopebond/hook@latest
scopebond install                   # detects Cursor, Codex and the GitHub Copilot CLI
scopebond install --codex           # set up Codex only
```

The npm commands in the rest of this page are for macOS and Linux, and for computers that already have Scopebond
from npm. With the signed installer on Windows, type `scopebond-agent hook <command>` instead of
`npx -y @scopebond/hook@latest <command>` or `scopebond <command>`. On a Windows computer set up from npm, type
`npm.cmd`, `npx.cmd` and `scopebond.cmd` in PowerShell (its default script policy blocks the plain names; the `.cmd`
forms work without changing it).

`install` sets Scopebond up **once per developer machine**, not per repository: it
scaffolds a user-level home (`~/.scopebond` in your operating system account's home folder, override
`SCOPEBOND_HOME`; see [What the hook trusts in its environment](https://scopebond.com/documentation/hook-reference#what-the-hook-trusts-in-its-environment)) with a
signing key, a countersigning key and a starter policy, and registers the hook by
absolute path in your user-level `~/.claude/settings.json`, `~/.cursor/hooks.json`,
or `~/.codex/hooks.json` (`$CODEX_HOME/hooks.json` when `CODEX_HOME` is set, as Codex
itself reads it). After Codex setup, open Codex, run `/hooks`, review
Scopebond, and choose **Trust** once. Every project you open is then checked by your
user-level rules. A project's own `.scopebond/policy.json` applies only after you trust it
in that project (`scopebond trust`, or `init` there), pinned to its exact contents: a
repository you clone, or an agent working in it, cannot swap in a weaker policy, and any
later edit to that file stops it applying until you trust it again. The pin also covers the
project's `rules.json` and the workspace its `cloud.json` names, so a change to either stops
it applying too. In a trusted project, what can let a blocked action through (the workspace
rules document's terms for allowing or asking, allowances, earlier overrides) always comes from
your user-level folder, never from files beside the project's policy.

On Windows a coding agent may run the hook command under cmd.exe, PowerShell or Git Bash
(Codex runs it through the session's shell, which can be PowerShell), and they read quoted
paths differently: PowerShell takes a command that starts with a quoted path as a string and
fails with "Unexpected token". So the hook entry names each path unquoted, with forward
slashes, and with the short (8.3) name of any folder whose name has a space or another
character a shell treats specially — for example
`C:/PROGRA~1/nodejs/node.exe C:/…/.scopebond/runtime/…/cli.js codex` — a form
every one of those shells starts the same way. Codex entries also carry `commandWindows`
(the portable `npx` form becomes `npx.cmd` there). The paths are quoted instead — a form
cmd.exe and Git Bash run but PowerShell does not — when a folder that needs a short name has
no plain one:

- the volume has short (8.3) names switched off;
- the folder's short name keeps a character a shell reads specially, such as `%`, `!`, `&` or
  `^` among its first characters (`100%SU~1`), or a character outside plain ASCII letters,
  digits and `. _ - @ ~`. The lookup itself handles any folder name: the path reaches cmd.exe
  through an environment variable, unparsed, and cmd answers in UTF-16 (`cmd /u`), so names
  outside the console's code page read correctly;
- the path is a network (UNC) path, which has no drive letter.

`status` and `doctor` then note that the Codex or Cursor entry uses the quoted form and may not
start under PowerShell. A quoted path with `$` or a backtick in it is refused outright (Git Bash
expands those even inside double quotes, so the hook could not start): install Scopebond under a
folder without them. The Scopebond service (`@scopebond/agent`) rewrites a quoted Codex or Cursor entry into the plain
form once that form is available (Claude Code runs hooks under Git Bash, which starts the quoted
form). `uninstall` and upgrades recognise both forms, and replace or remove only Scopebond's own
hook in a hook group another tool shares.

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

The shared file always gets the npx form, so it starts on macOS, Linux and any computer with Node.js. A computer
with only the signed Windows installer has no npx, so that entry cannot start there (the coding agent shows a hook
error and the entry checks nothing). `init --shared` run there covers that computer separately: a user-level hook
that starts there already does; otherwise, for Claude Code, it puts the installer's command in
`.claude/settings.local.json` (this computer only, kept out of git); for Cursor and Codex, which have no personal
file, it prints the `install` command that adds a user-level hook. Without `--shared`, `init` from the installer
pins the installer's program, as it pins the npm copy.

Check what it did with `npx -y @scopebond/hook@latest status` (which agents are configured, in
which scope) and `npx -y @scopebond/hook@latest doctor` (whether each configured command can
actually start).

### Changing the rules

`.scopebond/policy.json` is **generated**. The thing you edit is `.scopebond/rules.json`,
a short readable list, and `policy.json` is compiled from it — so a limit is a line in a
list, not a 700-character lookahead:

```
npx -y @scopebond/hook@latest rules                      # what blocks and what records, in plain English
npx -y @scopebond/hook@latest rules enforce safe-shell   # make a rule block (protect-branches, safe-shell, protect-write, protect-read,
                                                         #   cloud-destructive, production-deploy, secret-write, iam-change, database-migrate)
npx -y @scopebond/hook@latest rules monitor safe-shell   # back to recording only
npx -y @scopebond/hook@latest rules allow dd             # stop blocking a program
npx -y @scopebond/hook@latest rules protect infra/       # never write there
npx -y @scopebond/hook@latest rules protect-branch production
npx -y @scopebond/hook@latest rules apply                # recompile after editing rules.json by hand
```

The compiled patterns are identical to the ones this package has always shipped — there
is a test that pins them against the starter policy — so the readable front end cannot
change what a rule matches. Whether a matching action is blocked or only recorded is the
`enforce` list in `rules.json`: empty by default, so every rule records until you turn it on.
Scopebond's own protection (its settings, keys and the agents' hook settings, and on Windows the signed
installer's folder, `%LOCALAPPDATA%\Programs\Scopebond` or `%ProgramFiles%\Scopebond`, which a coding agent may read
but not change or delete) is not a rule in that list: it always blocks. The folder is matched by those standard
names, in any case and in their `%…%`, `$env:…` and short-name spellings; an install moved elsewhere is not covered.
It also covers the shell startup files (`.zshrc`, `.bashrc`, `.profile`, `.zshenv`, fish and PowerShell profiles,
`/etc/profile.d`, `environment.d`), wherever they sit, since a line added there runs in every later session; edit
those yourself. Setting `SCOPEBOND_HOME`, `SCOPEBOND_HOOK_DIR`, `SCOPEBOND_POLICY_KEYS_JSON`, `SCOPEBOND_PACK_ENGINE_LEVEL`,
a `SCOPEBOND_POLICY_SYNC` setting, `NODE_OPTIONS` (any value), `NODE_PATH` or a coding agent's config folder for every later
session (`setx`, `launchctl setenv`), or when starting a coding agent, counts as switching Scopebond off, and once your
own install exists a hook call follows `SCOPEBOND_HOOK_DIR` only to that install or to a project folder you trusted.
Even then, allowances and workspace rules documents are read from your own install, never from the project folder. A project set up by an earlier version, whose rules were never
edited, moves to recording on the first run after the update and keeps the old policy as
`policy.previous.json`; a project with its own edits keeps blocking what it blocked.
Each clause description is generated from the list too, so it
stays true after an edit, and a block message quotes it.

### The hook command `init` installs

Moved to the [hook reference](https://scopebond.com/documentation/hook-reference#the-hook-command-init-installs).

### What each agent can actually stop

| | Claude Code | Cursor | Codex |
|---|---|---|---|
| Shell commands | prevented | prevented | prevented |
| File reads | prevented | prevented | prevented |
| MCP tool calls | prevented | prevented | prevented |
| File writes / edits | prevented | **recorded, not prevented** | prevented |

Cursor reports a file edit only *after* it is written (`afterFileEdit`; it has no
before-edit hook), so an out-of-policy edit there is signed as recorded after the fact
(`execution.state: "observed_after"`, `executed: true`), not as denied. `log` shows it as
"recorded, not prevented", it is never counted as a block, and the message says so rather
than claiming otherwise. For edits that must be stopped before they land, make
`@scopebond/github-action` a required check on pull requests.

Cursor is told `allow` when every action of the call was checked and either permitted or
found out of policy by a monitored rule: monitor records the match and stays silent for the
developer, with no approval prompt. Cursor is told `ask`, so its own approval decides, only
for an action Scopebond could not evaluate (no rule covers it, or the event could not be
read) or one it holds for a person.

A hook entry the coding agent cannot start at all (a moved Node, a removed install) lets
actions run with no check: the agents treat that as a non-blocking error. Any failure the
hook program itself can still catch answers deny (Claude Code: exit 2). For Codex and
Cursor, which send nothing between actions, the Scopebond service checks their entries on
each maintenance pass and keeps each outage as a `hook_unresolvable` delivery gap that the
rules check reports to the workspace; `doctor` reports it on any computer.

Codex has no native file-read event: reads it makes through shell commands are derived
from the command (`cat .env`) and checked, but a read that never goes through a shell
is not seen. Run `capabilities` (below) for the exact per-cell picture.

### Cloud, Kubernetes, databases, deployments and secrets: rule packs

Moved to the [hook reference](https://scopebond.com/documentation/hook-reference#cloud-kubernetes-databases-deployments-and-secrets-rule-packs).

### What the hook sees being installed

Moved to the [hook reference](https://scopebond.com/documentation/hook-reference#what-the-hook-sees-being-installed).

### Safe Install: checks before an install runs

Moved to the [hook reference](https://scopebond.com/documentation/hook-reference#safe-install-checks-before-an-install-runs).

### Rule packs

Moved to the [hook reference](https://scopebond.com/documentation/hook-reference#rule-packs).

### GitHub Copilot

Moved to the [hook reference](https://scopebond.com/documentation/hook-reference#github-copilot).

### Cloud coding agents and CI: `init --repo`

Moved to the [hook reference](https://scopebond.com/documentation/hook-reference#cloud-coding-agents-and-ci-init---repo).

### What this hook can honestly claim: `capabilities`

Moved to the [hook reference](https://scopebond.com/documentation/hook-reference#what-this-hook-can-honestly-claim-capabilities).

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

With the signed installer on Windows, the same commands are `scopebond-agent hook login https://<your-workspace>` and
`scopebond-agent hook connect https://<your-workspace> scopebond-enrollment.json` (or `scopebond-agent setup
https://<your-workspace>`, which also sets up autostart). A per-project connection (`--project`) made there puts the
installer's program in the project's settings for this computer only, as `init` does, since the portable npx form
cannot start without Node.js. On a Windows computer set up from npm, use `npx.cmd` instead of `npx` if script
execution policy blocks `npx.ps1`; no execution-policy change is needed. Every command the hook prints for you to run
uses the form your installation runs: `scopebond-agent hook …` from the installer, `npx.cmd` from npm on Windows.

**The MCP proxy needs Node.js.** `@scopebond/mcp`, the proxy that checks MCP tool calls in-path, is published to npm
only and is not part of the signed Windows installer. To use it on Windows, install a current Node.js LTS release
first; the hook itself does not need it.

### What leaves this computer

Records of the actions the hook decides go only to the workspace this computer is connected to; a computer that is
not connected keeps them in its local log. What a delivery carries, by category:

- **Records** (`POST /v1/ingest`): one signed record per action. With the default evidence detail, a routine action
  (allowed or not evaluated, and not a push, a fetch, an MCP call or a write outside the project or to its CI and agent
  settings) goes instead in a signed summary for its five-minute window (`POST /v1/summaries`: counts by action kind,
  result and program, a keyed digest of the working folder, and how often an identical action repeated); the others
  go one by one at once.
- **In each record**: the kind of action (a command, a file read or write, a push, a fetch, an MCP call, or an action a
  rule pack derived), its parameters as recorded (a command line after the secret masking, cut to its first 64
  characters, with a keyed digest of the masked whole; paths with your home folder written as `~`; branch, remote,
  host, MCP server and tool, and package names), the decision and the rule that matched, the rule set's digest and
  version, the time, key ids and signatures. A command that deletes or writes files also names its `targets`: the
  paths a delete names, or else the files the command writes (never ones it only reads), relative inside the working
  folder and full (home as `~`) outside it, at most 16 of at most 1,024 characters each, paths only. They are left
  out when any one is known only at run time, is a protected place, a root or a wildcard that takes a whole folder,
  or when there are more than 16. A block's digest then uses the one kind of place they all share (repository, build
  output, temp, home, system); targets of more than one kind read as unknown. Shell records from older hooks have no
  `targets`, and an allowance never depends on them. Once the workspace says it reads it, also the context: the coding tool,
  its version, the model id it reports, an opaque session id, the repository as `host/owner/name`, and the branch.
- **Beside each batch**: the delivery queue's id and the numbers this computer gave the records, signed with this
  computer's key when the connection names its credential.
- **A plugin slot**, only when a signed plugin component is installed: an opaque value of at most 4 KiB and a pattern
  id the plugin produced for a record. The hook signs them into the record and does not read them.

Not in a record: the contents of files (a record names a path; a rule pack may record a single value it reads from a
configuration file, such as an environment name, or a keyed digest of a file), a command's text past its first 64
characters, values the masking finds (passwords, tokens, keys: written `***`), and this computer's keys. The
workspace credential only authenticates the request. Observations, the rules check, the computer name and the
machine id are described in their own sections.

To see exactly what the next delivery holds, run:

```
scopebond intel show            # a summary by category, then the first request's body
scopebond intel show --json     # every request; add --raw to see a plugin slot's base64
```

`intel show` runs this computer's own uploader against a copy of its delivery queue and prints the request bodies
it builds, without sending or changing anything. A plugin slot is shown as `<opaque, N bytes>`. When nothing is
waiting, it says so and shows the fields one record carries.

### Checking the workspace's evidence chain

Moved to the [hook reference](https://scopebond.com/documentation/hook-reference#checking-the-workspaces-evidence-chain).

### Is it delivering?

Moved to the [hook reference](https://scopebond.com/documentation/hook-reference#is-it-delivering).

### Rules set by your workspace

Moved to the [hook reference](https://scopebond.com/documentation/hook-reference#rules-set-by-your-workspace).

### What the hook trusts in its environment

Moved to the [hook reference](https://scopebond.com/documentation/hook-reference#what-the-hook-trusts-in-its-environment).

### Signed rules

Moved to the [hook reference](https://scopebond.com/documentation/hook-reference#signed-rules).

### Session, health and action observations (opt-in)

Moved to the [hook reference](https://scopebond.com/documentation/hook-reference#session-health-and-action-observations-opt-in).

## How it works

Each tool call is mapped to a normalized [Action Taxonomy](https://github.com/avouro-com/scopebond)
action (`shell.exec`, `git.push`, `file.write`, `mcp.tool.call`, …), signed by the
machine key and decided against your policy by an in-process check-only gateway.
An allowed action is recorded and the agent proceeds. A denied action is blocked.
A tool Scopebond has no mapping for is let through unchecked only when it is known to be
harmless: it only reads, only loads a skill's instructions (what the skill leads to is checked
as its own tool calls), or only drives the agent's own task list, plan or question to you
(Claude Code's `TodoWrite`, `AskUserQuestion`, `WebSearch`, `Task` or `Skill`, Codex's `update_plan`;
the lists are in `src/unknown-tools.ts`). Such a tool is recorded as *not evaluated* and left
to the coding agent's own permission prompt. Any other tool is blocked, in every mode, with a
reason naming it; where the coding agent can ask you (Claude Code in a mode that prompts,
Cursor, the Copilot CLI), you are asked instead. To allow a tool, add its `tool.<name>` type
(`tool.brandnewtool` for `BrandNewTool`) to `observe` in `.scopebond/rules.json` and run
`scopebond rules apply`; the policy then decides it. Anything unexpected fails closed (deny)
with a repair message.
So does a call that has not decided shortly before the coding agent's own hook time limit
(55 seconds for Claude Code, 45 for GitHub Copilot, 28 for Codex and Cursor), since an agent
runs an action unchecked when its hook times out; `SCOPEBOND_HOOK_DEADLINE_MS` can only
shorten that deadline. The waits a call takes on purpose fit inside it: the person's answer in
the Scopebond window waits at most what the deadline leaves, and a hook call waits at most 8
seconds for another process's lock on the local log. A lock wait cannot be interrupted while it
lasts, so several in one call on a heavily contended log can still outlast the agent's limit.

**Known limits.** `test/bypass-corpus/` lists indirect ways to reach a blocked action
(interpreter one-liners, indirect writes, renamed programs, `xargs` and `find -exec`, quoting,
`cmd /c` and PowerShell `-EncodedCommand`) with the outcome the hook gives each: blocked, or
recorded by name. The ones it does not meet yet are marked `expected_gap`, with the reason.

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

**Your home folder is written as `~`.** A home folder's path carries your account name
(Windows and macOS keep it under a `Users` folder, Linux under `home`), so before an
action is signed the hook replaces it with `~` everywhere it appears: the working folder
(`cwd`), file paths and the command line. A project in your home folder is recorded as
`~/repo`, and `cat` of a notes file there as `cat ~/notes.txt`. Another account's home
folder keeps its place but not its name: the name is recorded as `~other`. Shared
folders (`Public`, `Shared`, `Default`) are left as they are. A path inside the working
folder is recorded relative to it, as before.

- The home folder is the one the system reports, plus the `HOME` and `USERPROFILE`
  values, so a shell with its own `HOME` (Git Bash, WSL) is covered, as are the Git Bash
  (`/c/…`) and WSL (`/mnt/c/…`) spellings of a Windows home. A Windows home is matched in
  any case and with either separator. A home of `/` or a bare drive is never replaced.
- Rules keep matching. A rule written relative (`.env`, `.ssh/`) or from the home folder
  (`~/secrets/`) matches the recorded paths as it is. A rule that names the home folder
  by its full path is read as `~/secrets/` when the hook loads the rules, and
  `rules protect <path>` stores a full home path as `~/…`. Workspace-root scoping
  (`allowed_roots`) still resolves the real, absolute paths before anything is masked.
- A rule that names *another* account's home folder by its full path does not match the
  `~other` form: write that account's name as `~other` in the rule (or re-add it with
  `rules protect`, which does this for you) if you need one.
- Receipts are signed after masking, so `verify` checks exactly what was recorded.

### What a record contains

Moved to the [hook reference](https://scopebond.com/documentation/hook-reference#what-a-record-contains).

## Library

Moved to the [hook reference](https://scopebond.com/documentation/hook-reference#library).
