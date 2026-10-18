# @scopebond/hook

The free, open-source Scopebond connector for **Claude Code**, **Cursor**,
**OpenAI Codex** and **GitHub Copilot**. It checks supported actions delivered through the configured
hook against your policy and signs decision records locally. Some actions are
observed after they happen: Cursor file edits are recorded, not prevented. See
the coverage table below before choosing what to protect.

**License and hosting:** this package is Apache-2.0 open-source software.
Scopebond Cloud, the hosted shared workspace, is a separate proprietary service.
You can use the hook locally without a Cloud account, or optionally connect it
for shared activity, rule review, and retained evidence. For hosted setup, start
with the [workspace getting-started guide](https://scopebond.com/get-started).

- **What it does:** records every supported action and what each rule would decide. A rule
  blocks only once you (or your workspace) turn it on; Scopebond's own protection is always on,
  so a coding agent can never switch Scopebond off, change its settings or uninstall it.
- **Default:** monitor. Every rule starts by recording, not blocking. Turn one on with
  `rules enforce <rule>`.
- **Where it works:** actions the coding agent routes through its tool system
  (shell, file, MCP, web). A process started outside the harness is not covered.

## Install once for your machine

### Windows: the signed installer

On Windows, install Scopebond with the signed installer
([scopebond.com/get-started](https://scopebond.com/get-started#desktop-agent), or `winget install Avouro.Scopebond`).
It installs one signed program, `scopebond-agent.exe`, that is both the Scopebond Agent and this hook, and needs
neither Node.js nor npm. It installs for you alone in `%LOCALAPPDATA%\Programs\Scopebond`, or for every user in
`%ProgramFiles%\Scopebond`, and puts that folder on PATH. Then:

```
scopebond-agent setup https://<your-workspace>   # sign in, set up the coding agents, start with Windows
scopebond-agent hook status                      # every hook command below, after `hook`
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
scopebond install                   # detects Cursor and Codex
scopebond install --codex           # set up Codex only
```

The npm commands in the rest of this page are for macOS and Linux, and for computers that already have Scopebond
from npm. With the signed installer on Windows, type `scopebond-agent hook <command>` instead of
`npx -y @scopebond/hook@latest <command>` or `scopebond <command>`. On a Windows computer set up from npm, type
`npm.cmd`, `npx.cmd` and `scopebond.cmd` in PowerShell (its default script policy blocks the plain names; the `.cmd`
forms work without changing it).

`install` sets Scopebond up **once per developer machine**, not per repository: it
scaffolds a user-level home (`~/.scopebond`, override `SCOPEBOND_HOME`) with a
signing key, a countersigning key and a starter policy, and registers the hook by
absolute path in your user-level `~/.claude/settings.json`, `~/.cursor/hooks.json`,
or `~/.codex/hooks.json`. After Codex setup, open Codex, run `/hooks`, review
Scopebond, and choose **Trust** once. Every project you open is then governed by your
user-level policy. A project's own `.scopebond/policy.json` applies only after you trust it
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
folder without them. The Scopebond Agent rewrites a quoted Codex or Cursor entry into the plain
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
names, in any case and in their `%…%`, `$env:…` and short-name spellings; an install moved elsewhere is not covered. A project set up by an earlier version, whose rules were never
edited, moves to recording on the first run after the update and keeps the old policy as
`policy.previous.json`; a project with its own edits keeps blocking what it blocked.
Each clause description is generated from the list too, so it
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
before-edit hook), so an out-of-policy edit there is signed as recorded after the fact
(`execution.state: "observed_after"`, `executed: true`), not as denied. `log` shows it as
"recorded, not prevented", it is never counted as a block, and the message says so rather
than claiming otherwise. For edits that must be stopped before they land, make
`@scopebond/github-action` a required check on pull requests.

Cursor is told `allow` only when every action of the call was checked and permitted. An
action a monitored rule finds out of policy (recorded, not blocked) gets no opinion
(`ask`), so Cursor's own approval still decides, as Claude Code's and Codex's do when the
hook stays silent.

A hook entry the coding agent cannot start at all (a moved Node, a removed install) lets
actions run with no check: the agents treat that as a non-blocking error. Any failure the
hook program itself can still catch answers deny (Claude Code: exit 2). For Codex and
Cursor, which send nothing between actions, the Scopebond Agent checks their entries on
each maintenance pass and keeps each outage as a `hook_unresolvable` delivery gap that the
rules check reports to the workspace; `doctor` reports it on any computer.

Codex has no native file-read event: reads it makes through shell commands are derived
from the command (`cat .env`) and checked, but a read that never goes through a shell
is not seen. Run `capabilities` (below) for the exact per-cell picture.

### What the hook understands about cloud, Kubernetes, databases, deployments and secrets

A coding agent reaches production through command-line tools and MCP servers. When it runs a known tool, the hook reads
the actual command line (or MCP tool call) and records the operation as an Action Taxonomy 1.1 action **beside** the
command's own `shell.exec` (or `mcp.tool.call`), in the same action group. So one rule set governs `aws s3 rb`,
`kubectl delete`, `vercel --prod` or `gh secret set` the same way whether Claude Code, Cursor, Codex or GitHub Copilot
ran it. The reading is deterministic: no model, no network, no heuristics beyond the words of a name, and no content.

| Tool | Subcommands read | Action |
|---|---|---|
| `aws` | `s3 rm`, `s3 rb`, `s3 sync` to a bucket (`--delete` deletes), `s3 mb`; `ec2 terminate/run/stop/start/reboot-instances`; `iam` (any change); `ssm put-parameter`; `secretsmanager create-secret/put-secret-value/update-secret`; `cloudformation deploy`, `deploy create-deployment`; any other `delete-*`, `terminate-*`, `deregister-*`, `create-*`, `update-*`/`put-*`/`modify-*`/… operation | `cloud.resource.delete/create/modify`, `iam.change`, `secret.write`, `deploy.release` |
| `gcloud` | `… create/delete/update/patch/stop/start/reset/resize` (not the local groups `config`, `auth`, `components`), `storage rm`, `iam …`, `… add/remove-iam-policy-binding`, `set-iam-policy`, `run/functions/app deploy`, `secrets create`, `secrets versions add` | the same, and `deploy.release` |
| `az` | `… create/delete/delete-batch/purge/update/stop/start/restart/deallocate/resize`, `role assignment/definition`, `ad sp create-for-rbac`, `ad … credential reset`, `ad user/group`, `keyvault secret set`, `webapp deploy/up`, `webapp/functionapp deployment source config-zip` | the same; a web app without `--slot` deploys to its production slot |
| `kubectl` | `apply`, `create`, `replace`, `patch`, `scale`, `set`, `rollout restart/undo/pause/resume`, `label`, `annotate`, `autoscale`, `expose`, `edit`, `drain`, `cordon`, `uncordon`, `taint`; `delete`; `exec`, `attach`, `debug` | `k8s.apply`, `k8s.delete`, `k8s.exec` |
| `helm` | `install`, `upgrade`, `rollback`; `uninstall` | `k8s.apply`, `k8s.delete` (kind `helm-release`) |
| `terraform`, `tofu`, `terragrunt` | `apply` (with `-auto-approve`, `-target`), `apply` of a saved plan (`saved_plan`, risk class destructive: the command does not show whether it destroys), `apply -destroy`, `destroy`; Terragrunt's `run-all` | `cloud.resource.modify`, `cloud.resource.delete` (provider `unknown`) |
| `pulumi`, `cdk`, `sst` | `pulumi destroy`, `cdk destroy`, `sst remove` | `cloud.resource.delete` |
| `wrangler` | `deploy`, `versions deploy`, `pages deploy`; `secret put/bulk/delete`; `delete`, `d1/r2/kv/pages project/queues create/delete`; `d1 migrations apply` | `deploy.release`, `secret.write`, `cloud.resource.*`, `db.migrate` |
| `vercel` | a deployment (`vercel`, `deploy`, `redeploy`; production with `--prod` or `--target production`, else preview), `promote`, `rollback`; `env add`, `env rm`; `remove`, `project rm` | `deploy.release`, `secret.write`, `cloud.resource.delete` |
| `fly`, `flyctl` | `deploy`; `secrets set` (one per name), `secrets import`; `destroy`, `apps destroy`, `machine destroy`, `volumes destroy` | `deploy.release`, `secret.write`, `cloud.resource.delete` |
| `gh` | `secret set`; `repo delete`; `api` with a method that changes something (`POST`, `PUT`, `PATCH`, `DELETE`; a read is not a fetch here) | `secret.write`, `cloud.resource.delete` (provider `github`), `net.fetch` |
| migrations | `prisma migrate deploy/dev/reset`, `prisma db push`; `drizzle-kit push/migrate/drop`; `rails`/`rake db:migrate` (with `VERSION=`, down), `db:rollback`, `db:reset`, `db:migrate:reset`, `db:drop`, …; `alembic upgrade/downgrade`; `flyway migrate/undo/clean`; `knex migrate:latest/rollback`; `sequelize db:migrate[:undo]` | `db.migrate` (`up`, `down`, `reset`) |
| more | `eb deploy/terminate`, `serverless deploy/remove` (no `--stage`: the default `dev` stage), `heroku config:set`, `heroku apps:destroy`, `vault kv put`, `vault write` (not a login, transit or PKI path), `doppler secrets set/upload`, `op item create/edit` | `deploy.release`, `cloud.resource.delete`, `secret.write` |

The tools are found directly or through `npx`, `pnpm`/`yarn`/`bun` (`exec`, `dlx`), `npm exec`, `uv`/`poetry`/`pipenv run`,
`python -m` and `bundle exec`, past the runner's own options that take a value (`pnpm --filter db exec`, `uv run --env-file .env`).

| MCP server (by a word of its configured name; in Cursor, also of its URL or launch command) | Tools read | Action |
|---|---|---|
| `github` | `create_pull_request`, `merge_pull_request`, `push_files`, `create_or_update_file`, `delete_file` | `pr.open`, `pr.merge`, `git.push` to the named branch, `file.write` per path (with `repo`; a file in that repository, recorded and not decided by this computer's file rules) |
| `filesystem` | `write_file`, `edit_file`, `create_directory`, `move_file`; `read_file`, `read_text_file`, `read_media_file`, `read_multiple_files`, `list_directory`, `directory_tree`, `search_files`, `get_file_info` | `file.write`, `file.read` (paths resolved like any other) |
| `postgres`, `sqlite`, `mysql` | `query`, `read_query`, `write_query`, `execute_sql`, … | `db.exec`: verb, predicate class and risk from the SQL classifier; the SQL itself is never recorded |
| `slack` | `slack_post_message`, `slack_reply_to_thread`, `post_message`, `send_message` | `communication.send` |
| `playwright`, `puppeteer` | `browser_navigate`, `puppeteer_navigate` | `net.fetch` (host only) |
| `fetch` | `fetch` | `net.fetch` (host, `GET`) |
| `linear`, `jira` | `create_issue`, `update_issue`, `createJiraIssue`, `editJiraIssue` | `work.item.create`, `work.item.update` |

**What an action carries.** Identifiers and closed values only: provider, service, kind, region, Kubernetes context and
namespace, a migration's direction, a secret store, and `env` or `environment` when the command names one (an AWS
profile, a GCP project, a Terraform folder or var file, `--env`, a slot or stage whose words say prod, staging or dev).
Names are keyed digests (`resource_digest`, `name_digest`, `target_digest`, `channel_digest`, `project_digest`) under
this computer's digest key. Never a secret's value, a file's contents, SQL or message text, or a URL's path and query.
Every action also carries `via` (the tool or server), `derived_from` (`shell.exec` or `mcp.tool.call`) and, for the
1.1 types and `deploy.release`, `risk_class`.

**What the rules do with them.** Five rules, all recording by default and never blocking until a person
(`rules enforce <rule>`) or the workspace turns them on:

| Rule | Blocks | Catalog class |
|---|---|---|
| `cloud-destructive` | `cloud.resource.delete`, `k8s.delete`, `k8s.exec`, and `cloud.resource.modify` of a saved plan | H06 |
| `production-deploy` | `deploy.release` to production, or whose environment the command does not show | H07 |
| `secret-write` | `secret.write` | H08 |
| `iam-change` | `iam.change` | H09 |
| `database-migrate` | `db.migrate` going `down` or `reset`, except against a development database the command names (`up` is recorded) | H10 |

Cloud creates and changes, `k8s.apply`, `db.exec`, messages, work items and pull requests are recorded
(`observe-targets`). A rule of your own can bound any parameter, for example
`{ "action_types": ["cloud.resource.delete"], "param_bounds": { "env": { "pattern": "^(?!production$).+" } } }`.
**Which policies decide them.** A policy decides derived actions only when it opts in: one of its clauses names an
action type Action Taxonomy 1.1 introduced, other than `db.exec` (which policies named before 1.1). Every policy this
version compiles opts in, through the target-rule clauses above. Under a policy that does not (one an earlier hook
compiled, or a workspace policy that carries none of those types), the derived actions are recorded and never
decided, so that policy decides every call exactly as it did before they existed: a `gh api` call, a GitHub MCP push
or a fetch MCP call is not newly checked by a push, file, site or database rule it already has. Under a policy that
opts in, a push or a file read or write read from an MCP call is decided by the rules for those types (a `push_files`
to `main` is a push to `main`; a `filesystem` write to `.scopebond/` is refused like any other), and a `fetch` or
browser MCP call by a site rule. A site rule's list is matched exactly: `github.com` does not cover `api.github.com`
(write `*.github.com` for that). Derived actions have no observation operation of their own: the closed observation
schema has no type for them yet, and the command's own operation is still recorded.

**At most 20 per call.** Beyond 20 derived actions in one call, those of each type are recorded as one, with `count`
and `members_digest` and the parameters they all share; a parameter they do not share is left out, so a rule that
bounds it refuses the call. A file read or written on this computer is never folded: each path is checked.

**Honest limits.** Only the subcommands above are read. A tool or subcommand not listed, a help (`--help`, or `help`
in the subcommand slot), list or describe command, or a dry run (`--dry-run`, `--dryrun`, `-refresh-only`,
`terraform plan`) derives nothing: the command stays the plain `shell.exec` it always was, still checked by
`safe-shell`. An option the reader does not know does not hide a command: when it stops the reader but one of the
tool's destructive words (`delete`, `destroy`, `uninstall`, `rb`, `rm`, `exec`, `deploy`, `reset`, `downgrade`,
`drop`, `remove`, …) is among the command's words, the action is still recorded with its names left out and a
deployment's environment `unknown` (`kubectl --warnings-as-errors delete ns prod` is a `k8s.delete`). A name read
after such an option is left out (the action keeps its type). A name
known only at run time (`$FN`, `$(…)`) is never digested as a name. `terraform`'s provider is the configuration's, so
it is `unknown`; the environment of a command comes only from words it shows, never from a profile file, the current
kube context or environment variables the command does not set itself.

### What the hook sees being installed

When a coding agent installs or runs software from outside the project, the hook records it as a `software.install`
action (Action Taxonomy 1.2) beside the command or file write that does it, in the same action group and in the same
signed receipts. It is detection only: the hook says what is installed, from where and how, and never judges whether it
is safe. A rule (or Scopebond Cloud's verdicts) decides that.

| Route (`route`) | Read from |
|---|---|
| `npm`, `pnpm`, `yarn`, `bun` | `install`/`i`/`add`/`update` with named packages (`name@range`, `@scope/name@tag`, aliases, git and tarball URLs), `-g`, `--registry` or `NPM_CONFIG_REGISTRY=`, `--ignore-scripts`; `npm ci`, a bare `install` (`from_manifest`); `create`/`init <initializer>` (the `create-*` package) |
| `npx` | `npx`, `npm exec` (with `--yes`: `auto_confirm`), `--package`; `pnpm dlx`, `yarn dlx`, `bunx` and `bun x` use the manager's route |
| `pip`, `uv`, `poetry`, `pipx` | `pip install` (also `python -m pip`), requirements with `==`, ranges and extras, VCS and URL specs, `-r` (`from_manifest`), `-i`/`--index-url`; `uv add`, `uv pip install`, `uv tool install`, `uvx`, `uv tool run`, `uv sync`; `poetry add`/`install`/`update`; `pipx install`/`run`/`inject` |
| `cargo`, `go`, `gem`, `brew` | `cargo install`/`add` (`--git`, `--version`); `go install`, `go get`, `go run module@version`; `gem install`, `bundle add`/`install`; `brew install`/`reinstall`/`upgrade`, `brew tap`, `brew bundle` |
| `curl_pipe_shell` | a fetch fed to a shell or interpreter: `curl … \| sh`, `wget -qO- … \| sudo bash`, `sh -c "$(curl …)"`, `bash <(curl …)`, `bash -c '…'` around any of these, `iwr … \| iex`, `iex (…DownloadString(…))` |
| `download_exec` | a fetch saved to a file that the same command line makes executable or runs (`chmod +x`, `./file`, `bash file`, `Start-Process`, `msiexec`, `dpkg -i`; `executed: true`), or that is a program or installer by its name (`.exe`, `.msi`, `.pkg`, `.dmg`, `.deb`, `.rpm`, `.sh`, `.AppImage`, …; `executed: false`) |
| `git_clone`, `git_clone_run` | `git clone` and `gh repo clone`; `git_clone_run` when the same command line goes on to run what is in the clone (`cd repo && npm install`, `./repo/install.sh`, `make -C repo`) |
| `docker_pull`, `docker_run` | `docker`/`podman`/`nerdctl` `pull`, `run`, `create` (the image, its tag or digest, and its registry when the reference names one); `docker compose pull/up/run` (`from_manifest`) |
| `mcp_settings` | `claude mcp add`/`add-json`, `codex mcp add`, `code --add-mcp`, and a write or edit of `.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, `~/.claude.json`, `.codex/config.toml` or `.copilot/mcp-config.json`: one action per server, described by its launch command (`npx` package, `uvx` package, container image) or its URL (`ecosystem: "remote"`) |

Each action carries `route`, `ecosystem`, `verb` and, when the request shows them, `name`, `version`, `source_url`,
`source_domain`, `from_manifest`, `global`, `lifecycle_scripts`, `auto_confirm`, `executed` and `mcp_server`, plus
`via`, `derived_from` and `risk_class: "sensitive"`. A URL keeps only its scheme, host and path: credentials, the
query and the fragment are removed and token-like parts masked. A file's contents, a server's environment values and
headers, and local paths are never recorded. No registry is assumed when the command names none.

Under the starter rules an install is recorded and decides nothing new. A rule can match it, for example
`{ "type": "action_allowlist", "action_types": ["software.install"], "param_bounds": { "route": { "pattern": "^(?!curl_pipe_shell$).+" } } }`
blocks scripts piped to a shell. The cases are public: `@scopebond/policy-schema/vectors/install-detection.json`.
Limits: an install inside a script file the agent runs (`./setup.sh`) or in a later tool call than its download or
clone is not connected to it, and system package managers (`apt`, `dnf`, `winget`, `choco`) are not read yet.

### Rule packs

What the hook knows about more tools and MCP servers can also come as **rule packs**: signed data in the
`scopebond:pack/v1` format (`@scopebond/policy-schema`, "Rule packs"), never code. A pack's grammars read a tool's
command line and its profiles read MCP calls, and they derive taxonomy actions exactly as the readers above do,
beside the command's own `shell.exec` (or `mcp.tool.call`), decided by the rules like any other action.

**Where they live.** In the `packs` folder of the hook's state directory (the folder that holds `policy.json`):
`packs/index.json` is `{ "v": 1, "checked_at": "<RFC 3339>", "packs": [{ "id", "version", "sha256" }] }`, and each
pack is `packs/<id>@<version>.json`, byte for byte as it was served. Whoever delivers packs writes the pack files
first and the index last, with `checked_at` the time of the successful check-in and `sha256` the hex SHA-256 of
each file. Only listed packs are read, one version per id.

**When a pack is used.** On every tool call, and only when all of these hold: the index is readable and was checked
in no more than 30 days ago; the file matches its `sha256`; it is a valid pack with the listed id and version; and its
Ed25519 signature verifies with a policy-signing key this release trusts (the same keys as signed rules), inside that
key's validity window. Otherwise the pack is not used, and only the open detection and the starter protections
apply: a missing, damaged, unsigned or expired pack never allows anything, it only stops adding actions. No network
is needed to use a cached pack.

**Precedence, for now.** The readers built into this release (the tables above) and the packs run side by side. For
each command and each MCP call, when the built-in readers derive any action, those are used and the packs' are not;
the packs' are used only when the built-in readers derive none. Among packs, the first by id that derives anything
wins.

**`packs`.** `scopebond packs` (or `packs list --json`) shows the packs in force, until when, and why any other is
not used. `packs verify <file>` checks a pack file (format, signature and the pack's own vectors) and changes
nothing; `packs add <file>` checks it the same way and puts it in force for 30 days; `packs remove <id>` takes it
out. `add` and `remove` need a terminal or `--yes`. Every pack's vectors run in this package's tests through
`runPackVectors`; the public ones are `@scopebond/policy-schema/vectors/example-pack.json`.

### GitHub Copilot

```
npx -y @scopebond/hook@latest install --copilot      # user-level: ~/.copilot/hooks/scopebond.json
npx -y @scopebond/hook@latest init --copilot         # this project: .github/hooks/scopebond.json
npx -y @scopebond/hook@latest init --copilot --shared   # the portable npx form, to commit
```

`install --copilot` writes Scopebond's own hook file in Copilot's user hooks folder
(`~/.copilot/hooks/`, `%USERPROFILE%\.copilot\hooks\` on Windows, or `$COPILOT_HOME/hooks/`
when `COPILOT_HOME` is set); a plain `install` adds it when it finds the Copilot CLI (the
`copilot` program on PATH, or the CLI's `settings.json` or `logs` in that folder; the folder
alone is not enough, because VS Code's Copilot Chat creates it too). `init --copilot`
writes `.github/hooks/scopebond.json` in the project. The file is a `version: 1` hooks
document registering `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `SessionStart`,
`SessionEnd` and `Stop`, each with a `bash` and a `powershell` command and `timeoutSec: 60`, and no
matcher (every tool). The `powershell` command ends with `; exit $LASTEXITCODE`, so a deny
(exit 2) reaches Copilot as a deny with its reason rather than as PowerShell's generic
exit 1. The PascalCase event names make Copilot send the same payload shape Claude Code
does. `uninstall` removes Scopebond's entries, and the file once nothing else is in it.

**How far it can be relied on:** cooperative · prevents if honored · a hook timeout fails
open in Copilot. Copilot honors a hook's deny (Scopebond answers
`{"permissionDecision":"deny","permissionDecisionReason":"…"}` and exits 2, which Copilot
treats as a deny whatever stdout says), and treats a hook that crashes or exits non-zero as
a deny. But a hook that runs past its `timeoutSec` is skipped and the action runs. Scopebond
therefore gives each check its own deadline (45 s, inside the 60 s it installs) and denies
when it cannot decide in time; a slow policy load or a held lock ends as a deny, not a
timeout. A hook Copilot never starts at all is outside what the hook can see.

| Copilot tool (reported as) | Scopebond action | Before it runs |
|---|---|---|
| `bash`, `powershell` (`Bash`), including `mode: "async"` / `"detached"` sessions | `shell.exec`, plus the reads, writes and pushes derived from the command | checked |
| `write_bash` (what it types into a running shell session) | `shell.exec`, read as a command in that shell | checked |
| `read_bash`, `stop_bash`, `list_bash` | `tool.<name>` | recorded, not evaluated (they run nothing new) |
| `view` (`Read`), `grep`, `glob` | `file.read` | checked |
| `create` (`Write`), `edit`, `str_replace_editor`, `apply_patch` (`Edit`) | `file.write` | checked |
| `web_fetch` (`WebFetch`) | `net.fetch` | recorded (observed by default) |
| MCP tools, `task`, `web_search`, anything else | `tool.<name>` | recorded, not evaluated (strict mode denies) |

The tool names are those in GitHub's Copilot hooks reference. Under the PascalCase events
Copilot reports both shells as `Bash`; on Windows its shell is PowerShell, so a Windows
`Bash` command is read as PowerShell. The reference does not say how MCP tool names appear
in a hook payload, so MCP coverage is not claimed for Copilot (`capabilities` lists it as
unsupported).

#### Copilot surfaces: CLI, VS Code agent mode, cloud coding agent

The same hook file runs in three places. **Verified on a live install: not yet** for VS Code
agent mode and the cloud coding agent; their `capabilities` cells are configured and
unverified, labelled `cooperative · prevents if honored · a hook timeout fails open`, and
nothing in this package claims more until a real run is recorded (see "Checking the tool
names on a real install" below). What follows is from GitHub's
[Copilot hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference) and
VS Code's [agent hooks](https://code.visualstudio.com/docs/agent-customization/hooks) and
[Local hooks reference](https://code.visualstudio.com/docs/agents/reference/hooks-reference)
pages, read 2026-10-13.

| Surface | Hook files it reads | Payload and tool names | Scopebond's answer |
|---|---|---|---|
| Copilot CLI | `~/.copilot/hooks/*.json`, `.github/hooks/*.json`, the `hooks` block of `.github/copilot/settings*.json`, `~/.copilot/settings.json` and `.claude/settings*.json` | GitHub's (table above) | `permissionDecision`; deny exits 2 |
| VS Code, **Copilot** session target (Agent Host) | the Copilot CLI's: VS Code runs the same SDK hook implementation | GitHub's | as the CLI |
| VS Code, **Local** session target (extension host) | `.github/hooks/*.json`, `~/.copilot/hooks/*.json`; `.claude/settings*.json` and `~/.claude/settings.json` only with `chat.useClaudeHooks` on (off by default) | VS Code's own: the payload adds `tool_use_id`; the tool names are not published | `hookSpecificOutput.permissionDecision` (written beside the top-level fields); deny exits 2 with the reason on stderr |
| Copilot cloud coding agent | only `.github/hooks/*.json` in the cloned repository (the default branch); only an entry's `bash` (or `command`) runs | GitHub's, Linux only (no `powershell`) | an `ask` becomes a deny (below); deny exits 2 |

- **VS Code** registers `SessionStart`, `PreToolUse`, `PostToolUse` and `Stop` through the same
  PascalCase entries. `Stop` only marks the session active; it prints nothing, so it never
  blocks or prolongs a turn. Because the Local harness's tool names are not published, a
  Local call is mapped only where its name is one Scopebond knows; any other name is recorded
  as `tool.<name>`, not evaluated, and never answered "allow" (strict mode,
  `SCOPEBOND_HOOK_STRICT=1`, denies it). `install --copilot` writes the user-level file both
  the CLI and VS Code read.
- **Known gaps in VS Code's Local harness** (from its reference; not yet checked live):
  - Whether Local runs Scopebond's hook file at all is unknown. Its reference recognises the
    Copilot format by a numeric `version` with lower camelCase events; this file uses
    PascalCase events. Each entry also carries Local's own `command` and `timeout` fields
    (the Copilot CLI ignores `command` while `bash`/`powershell` are present, and reads
    `timeout` only without `timeoutSec`, so nothing runs twice). The tool-name recording
    below shows whether Local ran it.
  - Local's default timeout is 30 s. The entry sets `timeout: 60`; if Local ignores it, a
    check slower than 30 s fails open there (the hook's own deadline is 45 s).
  - In Local, a hook that fails to start, or exits non-zero other than 2, is a non-blocking
    warning: the action runs. Scopebond's own failures exit 2.
  - Guardrail protection of hook files does not apply to Local tool names yet: a Local write
    under a tool name Scopebond does not map is recorded, not refused.
  - VS Code's `chat.useHooks`, `chat.hookFilesLocations` and `chat.useClaudeHooks` settings
    can switch hooks off. A write that sets one of them in `.vscode/settings.json`, a
    `*.code-workspace` file or VS Code's user `settings.json` through a tool Scopebond maps (in
    any coding agent) is refused like a write of a hook file; any other edit of those files is
    untouched. A change made in VS Code's settings screen is outside the hook.
- **The cloud coding agent** is recognised by two things together: no user-level Scopebond
  hook file for Copilot (the sandbox has no user-level hook files at all), and the sandbox's
  own environment (`COPILOT_AGENT_PROMPT` or `GITHUB_COPILOT_API_TOKEN` present; only their
  presence is read, never a value) or a GitHub Actions run (`GITHUB_ACTIONS=true`). There an
  answer that would be "ask" is a deny that says why: "this action needs a person's approval,
  and the Copilot cloud agent has no one to ask, so it is denied" (the cloud agent turns every
  "ask" into a deny anyway). How the heuristic can be wrong, and why that is safe: the Copilot
  CLI in a GitHub Actions step with no user-level install is read as the cloud agent, so its
  "ask" is a deny (no one is there to answer it either); a sandbox that stops setting those
  variables is read as the CLI and answered "ask", which the cloud agent reads as a deny.
  `init --copilot --shared` writes the repository file with a `bash` command on every entry.

#### Checking the tool names on a real install

```
npx -y @scopebond/hook@latest capabilities --prove --copilot
```

This runs the usual fixtures, then opens an hour's recording on this computer: while it is
open, every Copilot hook call notes which surface sent it, the tool name exactly as sent, the
event, the argument names (never their values) and what Scopebond made of it, in
`copilot-tool-names.json` beside the policy. Use each surface (the CLI, VS Code with the Copilot
and with the Local session target): run `git status`, read a file, create and edit a file,
fetch a page, and create `.github/hooks/probe.json` (denied wherever the tool name is mapped).
Run the command again to list what was seen per surface; a name marked "recorded, not
evaluated" or "not in GitHub's documented names" is one Scopebond does not check yet. If no
"VS Code Local harness" section appears after using the Local session target, the hook is not
running there.

Scopebond's own protection covers Copilot's hook settings as it does the other agents':
writes to `~/.copilot/hooks/`, `~/.copilot/settings.json`, `~/.copilot/mcp-config.json`
(the CLI's MCP servers), `.github/hooks/`, `.github/copilot/settings.json` and
`.github/copilot/settings.local.json` are always denied (guardrail configuration, not CI
configuration), as is removing those folders or starting `copilot` with `COPILOT_HOME`
pointed elsewhere. This holds in every coding agent whose tool names Scopebond maps (not in
VS Code's Local harness yet, whose tool names are unpublished), and it covers
**every file** under `.github/hooks/` and `~/.copilot/hooks/`, including a project's own hook
scripts: a coding agent cannot edit them, and a person changes them outside the agent.
`COPILOT_HOME` itself is not followed: a Copilot folder moved there is not protected.

- **Copilot CLI** reads the user-level and repository-level files.
- **VS Code agent mode** reads the same `.github/hooks/*.json` and `~/.copilot/hooks/*.json`
  files (see "Copilot surfaces" above). Verified on a live install: not yet. Its Local
  harness's tool names are not published, so its calls are recorded as unevaluated tools
  until a live run confirms them; `capabilities` lists its cells as configured and
  unverified, never verified.
- **The cloud coding agent**, per GitHub's hooks documentation, loads hooks from
  `.github/hooks/*.json` on the repository's default branch, runs only the `bash` command,
  and treats `ask` as deny. It can run the hook
  as a repository of your workspace with a repository token (see
  [Cloud coding agents and CI](#cloud-coding-agents-and-ci-init---repo)); that is not
  verified on a real run yet, so keep gating its pull requests with
  `@scopebond/github-action`. A hook file written by `init --copilot` (no `--repo`) with no
  token and no Scopebond setup there fails closed and denies every action, naming the cause:
  "Scopebond is not set up in this environment; the Copilot cloud agent is not covered". The
  `init --repo` file instead reads as not governed there (see below).
- Copilot also reads the `hooks` block of a project's `.claude/settings.json`. A project set
  up for Claude Code with `init` is then checked when Copilot runs there too; with a
  Copilot hook file as well, each action is checked twice.

### Cloud coding agents and CI: `init --repo`

Some agent runs have no person signed in and no computer of their own: Claude Code on the
web, Codex cloud tasks, the GitHub Copilot coding agent, and agent steps inside GitHub
Actions. Each starts from a fresh checkout of the repository, so the hook has to come from
files committed there, and its connection from a secret.

```
npx -y @scopebond/hook@latest init --repo --dry-run   # what it would write
npx -y @scopebond/hook@latest init --repo --yes
```

`init --repo` writes, in the current repository, only the committed hook files, each with
the version-pinned `npx -y @scopebond/hook@<version> <agent> --from-repo` command:

| File | Read by |
|---|---|
| `.claude/settings.json` | Claude Code (on the web, and `claude` in a CI step) |
| `.codex/hooks.json` | Codex (cloud tasks, and `codex` in a CI step) |
| `.github/hooks/scopebond.json` | the GitHub Copilot coding agent (and the Copilot CLI) |

It merges with what each file already holds: other settings and other hooks are kept (in
Claude Code and Codex, only Scopebond's own entry leaves a matcher group; the group's other
hooks and matcher stay), an earlier Scopebond entry is replaced rather than duplicated, and
running it twice changes nothing. The three files are written together: each new file is
staged beside its target and renamed into place, and a failure puts back any already
replaced, so either all three change or none does. The Copilot entries are `bash` commands (`type: "command"`), the only form the
cloud agent runs. It makes no keys and writes no `.scopebond` folder; a file that is not
JSON stops it before anything is written.

Then, for each place the agent runs, give it the repository's token as the secret
`SCOPEBOND_REPO_TOKEN` (create the token in your workspace, under Computers, Repositories):

- GitHub Copilot coding agent: a secret in the repository's `copilot` environment.
- An agent step in GitHub Actions: `env: SCOPEBOND_REPO_TOKEN: ${{ secrets.SCOPEBOND_REPO_TOKEN }}`.
- Claude Code on the web and Codex cloud tasks: the cloud environment's environment
  variables or secrets.

Set `SCOPEBOND_URL` as well when your workspace is not at `https://cloud.scopebond.com`. The
sandbox must be allowed to run `npx` (the npm registry) and to reach the workspace.

**What the hook does with the token.** On its first tool call in a sandbox with
`SCOPEBOND_REPO_TOKEN` set and no connection of its own, the hook sets itself up in the
sandbox's home folder (`~/.scopebond`: fresh keys and the starter rules, so the checkout
stays clean), signs a proof with both new keys over the token's SHA-256 digest and the time,
and sends it to `POST /v1/repository/enroll`. The workspace answers with a short-lived
delivery credential for that one repository, kept in `cloud.json`; the hook then fetches
the workspace's rules and decides the call, and records are delivered as that repository
(and carry the repository's `host/owner/name` in their context, as on any computer). Until
the workspace's rules have loaded once, every call is denied ("this repository's rules are
not loaded yet"), and the rules check is tried again on the next call: a fresh sandbox never
decides with only the starter rules.

The connection records which token made it (a SHA-256 of the token's digest, never the
token). It is used only while it is unexpired and was made with the token now set; a
credential that ran out, or one made with another repository's token (a shared or
self-hosted runner), is set aside with its whole folder, and the repository enrols again
with fresh keys (the workspace never takes a key twice). A connection a person made on the
same computer always wins, and is looked for before the token is read.

**Where there is no token.** The committed entries carry `--from-repo`. On a computer with
no `SCOPEBOND_REPO_TOKEN` and no Scopebond connection (a contributor's laptop, a run you did
not give the secret), such an entry checks nothing: it prints "Scopebond: this repository's
hook is not connected on this computer; nothing is checked" to stderr, records nothing, and
lets the agent's own permission flow decide, as it would without Scopebond. That computer is
simply not governed. A computer signed in to Scopebond, or a run with the token, is checked
as usual, and fails closed as usual.

The token is never written to disk, printed, or sent anywhere but that one request. When
the workspace refuses it (revoked, unknown, or rate limited) or cannot be reached, the call
is denied (fail closed) with the reason and the fix, never with the token.

**Not a boundary on its own.** A coding agent can edit files in its own checkout, these hook
files included, and an action that runs before the hook is loaded is not seen. The committed
files make the agent's runs checked and recorded; the merge boundary stays the
[`@scopebond/github-action`](../github-action) as a required check, with `.github/` and the
default branch protected by branch protection or a ruleset. Each of these cloud runs is unverified until a real
run's records are seen in the workspace; check one before relying on it.

### What this hook can honestly claim: `capabilities`

```
npx -y @scopebond/hook@latest capabilities            # the manifest, per agent host / action / phase
npx -y @scopebond/hook@latest capabilities --prove    # run the safe fixtures in temp directories
npx -y @scopebond/hook@latest capabilities --prove --save   # and record the result beside the policy
npx -y @scopebond/hook@latest capabilities --prove --copilot  # and record the tool names Copilot really sends
npx -y @scopebond/hook@latest capabilities --json
```

Each cell is one connector version, agent host (Claude terminal / desktop, Codex CLI /
desktop, Cursor, Copilot CLI / VS Code / cloud agent), action type and phase (before or
after the action), in one of these states (Copilot CLI cells also carry `enforcement`:
"cooperative · prevents if honored · a hook timeout fails open in Copilot"; the VS Code and
cloud agent cells carry "cooperative · prevents if honored · a hook timeout fails open" and a
"verified on a live install: not yet" gap):

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

### Checking the workspace's evidence chain

Each delivery answer from the workspace carries its evidence chain's head (how many records
it had admitted and its newest evidence segment, signed by the workspace when it has a
signing key). The hook keeps them in `chain-heads.json` beside its receipts, each with this
computer's own times for the delivery it answered (when it was sent, and when the answer
arrived), which the workspace cannot choose. The workspace
also publishes each day's heads in a public, append-only log. To check that what the
workspace holds still agrees with what it told this computer:

```
scopebond verify --anchor <file-or-https-url-of-a-published-day>
scopebond verify --anchor <day.json> --segments <folder of downloaded evidence segments>
```

`verify` exits non-zero when a chain went back below a head this computer kept (judged by
the order this computer sent its deliveries and received their answers as well as by the
times the workspace put on its heads), when one position names two different segments, or when a kept head's segment
is no longer in the chain: records were removed, reordered or re-chained after the
workspace acknowledged them. A list or segment that cannot be checked is reported, not
crashed on. With `--segments`, every segment's digest, leaves, Merkle root, links and sequence
numbers are checked, and every record signed with this computer's key is verified.

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
leaving other tools' hooks alone; the Scopebond Agent's daily self-check reports the same. It never leaves none:
`--keep plugin` with no enabled Scopebond plugin changes nothing and says so. A settings file it edits is backed up
first (`settings.json.scopebond-backup`, as the installer does) and replaced whole.

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
With summary records on, routine records wait for their five-minute window to close and then
leave as one signed summary: `flush` reports them on their own line ("N routine record(s) held
for the summary window until HH:MM", with the date when that is not today) and exits 0 when they
are all that is left. A `flush` with only such records left sends nothing and does not contact
the workspace. A record stamped further ahead than one window (a clock set wrong) is sent in
full rather than held for a window that will not close, and counts as pending until it is. `flush` exits 1 when anything else is left or the last delivery attempt
failed, even with nothing left in the queue.

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
- **What is reported back.** Every rules check also says what this computer runs for each rule
  (blocks or records) and whether the workspace or the person at the computer set it, so the
  workspace shows what is true on the computer, not only what it asked for.
- **Changing a rule on the computer.** On a computer the workspace manages, `rules enforce <rule>`
  and `rules monitor <rule>` apply only where the workspace allows changes on computers;
  otherwise the command says the workspace sets it and changes nothing. Either way the workspace
  sees the result at once.
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
- **Allowances and "Ask an admin".** In the window a person may also choose **Allow for 15 min**
  or **Always allow this here…** (when the workspace offers it): the same action — the same type
  and parameters, whatever tool call it comes from — is then allowed by a standing *allowance*
  that expires (30 days by default) and that the workspace lists for an admin to confirm or
  revoke. A rule set to *Block, person may ask* offers only **Ask an admin**: the action stays
  blocked and the request goes to the workspace; an approved request comes back as an allowance
  with the next rules check. The receipt of an action an allowance lets through says
  `method: "allowance"` and names it. An allowance is bound to one rule, never applies to
  Scopebond's own protection, and stops applying when it expires, is used up (a one-time one) or
  the workspace revokes it, or the person stops it ("Stop allowing" in the tray: it stops applying at once, and the agent
  sends the workspace the ended record). Where the workspace sets the unblock terms, each allowance a person makes also
  says how it was unblocked (`unblocked`: `automatic` or `person`). The hook keeps them, and the last blocks a person may act on, in its
  own folder (`allowances.json`, `requests.json`, `blocked.json`), which the coding agent cannot
  change. The hook tells the workspace it understands these settings
  (`x-scopebond-hook-capabilities: allowances`); a workspace sends them only then. A workspace may also set the one length
  a person's unblock lasts (the rule's `lasts`: `once`, `15m` or `always`), so the window and the tray offer only that
  length with nothing to choose, and say that every unblock is reviewed by an admin later, who may undo it (`review`); it
  sends these only to a hook that reports `unblock_terms`. A rule's override terms may also say `"minutes": "unlimited"`
  (once a person allows an action, the same action stays allowed from then on, with no time window) and
  `"daily_limit": "unlimited"` (no limit on how many a person may allow per day), besides the numbers (`minutes` 0 to 60,
  `daily_limit` 1 to 50); any other value refuses the rules document. A workspace sends `"unlimited"` only to a hook that
  reports `unlimited_terms` (`x-scopebond-hook-capabilities: allowances,session_budgets,service_rules,unblock_terms,unlimited_terms`).
- **Session budgets.** A workspace may limit what one coding-agent session may do, for example an
  overnight run: at most 50 file writes, no pushes and no package installs, until the budget
  expires (two hours after it is set, unless the workspace says otherwise). An admin sets one
  for a session, or approves one from a person's *Ask an admin* request (an allowance an admin
  approves *for this session* applies in that session only). The workspace sends them in its
  rules document as `session_budgets` (the schema is `@scopebond/policy-schema`'s
  `session-budgets.schema.json`), naming the session by the same keyed id receipts carry as
  `context.session_id`. The hook counts each tool call once per limit before it runs (a retry of
  the same call is not counted twice; a call a rule denies gives its count back) and keeps the
  counts in its own folder (`session-budgets.json`, bounded, written atomically). It counts tool
  calls, not files: one Write is one file write, and a shell command that writes ten files is one
  shell command. A shell command that installs packages (`npm install`, `pnpm add`, `pip install`,
  `uv add` and the like) counts as `package.install`; a push in a shell command is its own
  `git.push`. A budget may set `count_shell_as_write` to count every other shell command as a
  file write (off by default). Beyond a limit the call is denied with the reason **session
  budget**; a `monitor` budget records it and allows. While an `enforce` budget is in force the
  session may not start another coding agent (`claude`, `codex`, `cursor-agent`, `copilot`,
  `gh copilot` and the like), whose actions it would not count; a person can still start a new
  session (`/clear`), which is not under the budget, by design. An edit Cursor reports only
  after it ran is counted but never refused; the calls after it are refused once over. When a
  budget expires it ends: the session's rules alone decide again. Every receipt a budget counted or refused carries
  `payload.budget` (the budget, the action type, the count, the limit and the state). If the
  count cannot be read or written for a session that has a budget, the limited actions are
  denied, never let through without a limit. A malformed `session_budgets` list refuses the whole
  rules document (the rules in force stay); a hook older than this ignores the member. The hook
  says it understands budgets (`x-scopebond-hook-capabilities: allowances,session_budgets,service_rules,unblock_terms,unlimited_terms`;
  `service_rules` is the blocked services below).
- **Going back.** While the workspace sets the rules, `rules` edits and `policy load` are
  refused here. If the connection is revoked, or the workspace stops setting rules for this
  computer, the hook recompiles `policy.json` from `rules.json`: a computer is never left
  without rules. `status` shows which rules are in force and when they were last checked.

Set `SCOPEBOND_POLICY_SYNC=off` to stop the five-minute check (the rules in force stay).

Every call the hook makes to the workspace (sign-in and enrollment, the rules check and its
confirmation, record delivery and summaries, observations, credential renewal, recovery,
`doctor`'s checks and the uninstall notice) carries `x-scopebond-hook-version`, so a
workspace can hold a minimum version on every route.

#### Blocked services

A workspace can block a service its coding agents use by name, and the hook blocks it on this
computer like any other rule set to Block:

- **MCP server**: a call to a server whose configured name contains the blocked name as a word,
  in any case (`github` blocks `github`, `github-mcp` and `plugin_github_github`, not `githubx`).
- **Host**: a fetch by the coding agent's web-fetch tool (and a `gh api` call that changes
  something) to that host, in any case; `curl`, `wget` and similar are recorded, not blocked.
  `host:port` blocks that port only; a host without a port is blocked on every port. A key with
  the default port (`:80`, `:443`) is refused, since a request's host never shows it.
- **Program**: a shell command whose program is that name, with or without a path or `.exe`
  (`ffmpeg` blocks `/usr/bin/ffmpeg` and `FFMPEG.EXE`, not `ffprobe`).
- **Package**: an install that names the package for that manager, as `manager:name`
  (`npm:zod`, `pip:requests`); `pnpm add zod` is not blocked by `npm:zod`. Every package the
  command names is checked, however many, also beside `-r requirements.txt` or `-e .`; a spec that
  cannot be read is skipped, and an install whose named packages none can be read is blocked while
  the workspace blocks any package. The blocked install is recorded as that package's
  `package.install`, before the command; any other install is recorded exactly as before.

The agent is told plainly: *Your workspace blocks the program ffmpeg.* The block is recorded like
any rule block (a denied receipt), appears among the recent blocks on this computer and reaches
the workspace with the next delivery. The deciding rule is one of the policy clauses
`blocked-mcp-servers`, `blocked-hosts`, `blocked-programs` and `blocked-packages`. For an MCP server, a host or a program,
an ordinary rule that blocks the same action decides first and is the one named; a blocked
package decides before its install command. A blocked service cannot be allowed at the computer,
and an allowance made under another rule does not carry it through.

The workspace sends the list as `blocked_services` in its rules document (at most 500 entries,
each `{ "kind": "mcp_server" | "host" | "cli" | "package", "key": "…" }`), only to a hook that
says it reads it (`x-scopebond-hook-capabilities: allowances,session_budgets,service_rules,unblock_terms,unlimited_terms`).
The document's `rules_digest` then covers the list too: it is the SHA-256 of the canonical JSON
of `{ "rules": …, "blocked_services": … }`, so a changed list is refused like changed rules, and
so is a malformed one; the rules in force stay. Without the list nothing changes.

### Signed rules

A workspace can sign its rules, so a computer installs only rules its workspace issued for it,
even if the answer passed through something that could change it.

- **What is signed.** A rules document, and the workspace's answer that it sets no rules for
  this computer, may carry `signature` (Ed25519, base64) and `key_id`. The signature covers the
  [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) canonical JSON of
  `{ v: 1, workspace, computer, revision, rules_digest, local_changes, managed, issued_at }`.
  The hook builds that object from its own connection: `workspace` is the workspace id in
  `cloud.json` (`organization_id`) and `computer` this installation's id, so an answer signed for
  another computer or workspace never verifies here. `revision`, `rules_digest`, `issued_at`
  (RFC 3339) and `local_changes` (absent means `false`) are the document's; `managed` is `true`
  for a rules document and `false` for the "no rules" answer, which is sent with status 200 as
  `{ "type": "scopebond:managed-rules", "version": 1, "managed": false, "installation_id": …,
  "revision": 0, "rules_digest": "000…0" (64 zeros), "local_changes": false, "issued_at": …,
  "key_id": …, "signature": … }` (a 204 is the unsigned form of the same answer).
- **Signed grants.** A rules document's `allowances`, `revoked_allowances`, `session_budgets`
  and `request_answers` decide whether a blocked action is let through, so they are signed
  too. `grants_digest` is the lowercase hex SHA-256 of the canonical JSON of
  `{ allowances, revoked_allowances, session_budgets, request_answers }` (each absent member as
  `[]`), and `grants_signature` is over the same payload as the rules, by the same key and at
  the same `issued_at`, with `grants_digest` as `rules_digest`, `local_changes: false`,
  `managed: true` and `kind: "grants"`: a rules signature never passes as a grants signature,
  nor the reverse. When either field is present both must be, the digest must match the
  document's own lists and the signature must verify; otherwise the answer is refused like a
  bad rules signature. In `enforce` mode a signed document that carries any of those lists
  without `grants_signature` is refused as `unsigned_policy`. A change to those lists alone
  (the same revision and rules digest, for example a revoked allowance) is installed, not
  treated as unchanged.
- **What is refused.** A signature that does not verify (a changed digest or switch, a forged
  answer), a `key_id` this release does not trust, a key whose validity window does not hold
  both the answer's `issued_at` and the present moment, an answer for another computer or
  workspace, an answer issued before the signed one in force (a replay), and an answer issued
  more than an hour ahead of this computer's clock. A refusal keeps the rules in force, is
  confirmed to the workspace and shows in `status` and `doctor`. The version in force served
  again is checked the same way. To go back to earlier rules, the workspace issues them as a
  new, higher revision: an older revision is never installed.
- **Modes.** `dual` (the default): a signed answer must verify; an unsigned one is still accepted
  and recorded as `unsigned_policy`. `enforce`: an unsigned answer is refused too, and so are a
  204 and a 401, which cannot be signed; the computer keeps the policy it has and never falls
  back to no rules. Set `SCOPEBOND_POLICY_SIGNATURE_MODE=enforce`, or `"policy_signature_mode":
  "enforce"` in `cloud.json`; when either says `enforce`, `enforce` applies. Dual mode is a
  step towards enforce, not a protection by itself: whoever can change the answer on its way can
  also remove its signature, and it is then accepted as unsigned. In either mode a stale answer
  is not detected: a replayed "nothing changed" (304), or the signed document in force served
  again after the workspace has issued a newer one, keeps the rules as they are.
- **Keys.** The trusted keys are pinned in the release (`src/policy-keys.ts`: `key_id`,
  `public_key` as SPKI PEM or the raw 32-byte key in base64, `not_before`, `not_after`). This
  release pins Scopebond Cloud's policy signing key, `pol_088707688c36e0f6` (valid
  2026-10-13T21:00:18Z to 2027-10-13T21:00:18Z), which Scopebond Cloud also publishes at
  `https://cloud.scopebond.com/.well-known/scopebond-policy-keys.json`. Its id is `pol_` and the
  first 16 hex digits of the SHA-256 of the key's SPKI DER in base64. Rotation is a release
  too: the next key ships ahead of time with a future `not_before`.
  `SCOPEBOND_POLICY_KEYS_JSON` (a JSON array of the same entries) adds keys, for tests and for
  trying a key before it is pinned. An entry whose window closes before it opens, or whose
  `public_key` does not read as an Ed25519 key, is left out, and `doctor` says why.
- **What is reported.** `status --json` has `policy_signature: { mode, last, reason }`, where
  `last` is `verified`, `unsigned` or `refused`; each rules check tells the workspace the same
  (`x-scopebond-policy-signature`).

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

Each receipt holds the normalized action (scrubbed as above), the decision, the rule set's
digest and the signatures. It may also carry a `context` saying where it was produced, so
a workspace can group records by session and filter them by tool, model and repository:
`harness` (`claude`, `cursor` or `codex`), `harness_version` (Cursor reports one; Claude
Code and Codex do not, so it is `null`), `model` (the model id when the coding agent puts it
in the hook input, else `null`; the transcript is never read), `session_id` (the same keyed
opaque id the observations carry, never the coding agent's own session id), `repository`
(the git remote `origin`'s fetch URL as `host/owner/name`: lowercase host, no credentials, no
`.git`; `null` outside a repository, without an `origin`, or when the remote could name a
person or a machine rather than a hosted repository: a host without a dot, an IP address, a
path that starts in a server folder such as home, users or srv, or a `~user` segment) and `branch`
(the name someone chose for it). It holds no local path, no credential and no prompt, and the
signature covers it, so `verify` checks it like the rest; `log` shows it after the action.
Verify these receipts with this release or later: an earlier `scopebond verify` (or
`@scopebond/gateway` `verifyReceipt`) reports a receipt carrying `context` as invalid, because
the payload's key list is closed (`evidence_version` stays `1.0`). A computer that is not connected always records it. A
connected computer adds it only once its workspace has said it reads it: the rules check
(`GET /v1/policy`) or a delivery answer carries `x-scopebond-receipt-context: 1`, kept as
`receipt_context` in the rules state beside the hook's settings. Until then, and after a
rules check answers without it, receipts are recorded and sent without a context. Signing
in to a workspace (`login`, `connect`) forgets what the previous one said and checks the
rules at once, and only an accepted delivery answer counts.

**The computer name.** Signing in (`login`, and the Scopebond Agent's first sign-in)
sends this computer's host name so the person approving it can tell which computer it
is. Set `SCOPEBOND_HOSTNAME_MODE` to choose what is sent:

| Value | Sent |
|---|---|
| `full` (default) | the host name, as the system reports it |
| `hash` | the first 12 hex characters of the SHA-256 of the lower-cased host name: stable for this computer, and it does not give the name back |
| `off` | no computer name; the workspace names the computer itself |

Any other value is read as `hash`. Receipts themselves do not carry the host name.

**The machine id.** So the workspace can tell that a computer signing in again is the same
computer, the hook sends a machine id: `m1:` and a SHA-256 hash of your operating system's
own machine id (Windows `MachineGuid`, macOS `IOPlatformUUID`, Linux `/etc/machine-id`)
together with the workspace's id, so each workspace sees a different value and none can be
turned back into the original. The original id never leaves this computer and is never
written to a file, a receipt or a log, or shown; only the hash is sent, in the body of a
sign-in (`login`, `connect`) and in the `x-scopebond-machine-id` header of the rules check,
deliveries and observation uploads. Before the workspace is known (the start of a sign-in) the
hash uses `unscoped` in place of its id. The hash is kept in `machine-id.json` beside
`cloud.json`, and worked out again once a day. Where the operating system has no machine
id, nothing is sent; the host name or a network address is never used instead.

**Where receipts live, and how much room they take.** `.scopebond/receipts.db` in the
project, about 3 KiB per action (each receipt is kept once and each policy once). A tool
call's decision does not read that log unless the policy has a windowed limit, and then
only the window; the replay check is one indexed lookup. So neither the time nor the
memory of a call grows with the log: on a 767 MB log written by an older version, a call
peaked at 69 MB (it was 233 MB, and 504 MB for a three-part shell command).

A computer connected to a workspace removes a receipt only after the workspace
acknowledged it, once that is 30 days ago (the workspace can set 7–365 days); a receipt
the workspace has not acknowledged, or refused, is never removed, an anchored log is never
pruned, and a policy that reads a longer window keeps that window (a window widened later
counts only the history still kept). With no workspace, nothing is
removed automatically — these are your evidence. The Scopebond Agent does this upkeep;
without it, a hook call does a short pass once a day. A log written by an older version
is rewritten once to the current layout in a separate background process (767 MB became
93 MB with every receipt kept). `prune` reports the footprint and the retention, and
bounds it when you choose to:

```
npx -y @scopebond/hook@latest prune                      # report the footprint and the retention
npx -y @scopebond/hook@latest prune --compact            # run the upkeep now and return the free space
npx -y @scopebond/hook@latest prune --before 90d --yes   # archive, then remove, anything older
```

`prune --before` writes the receipts it will remove to a JSONL file beside the database
first, so they stay verifiable, and it refuses outright once the log has been anchored — a
receipt's position is its anchor leaf index, so removing one would make an existing anchor
unverifiable. An archive is readable only by your user account and is never removed by Scopebond; `prune` lists the
archives that exist and their size, and `--no-archive` removes without writing one.

**What stays on this computer, and for how long.** The receipt log keeps every receipt in full, including details the
workspace's *Standard* evidence detail never sends; the retention above applies to it. The delivery queue keeps a
record until the workspace acknowledges it. The local observation queue keeps the newest 1,000 refused observations and
counts the older ones it removes. Archives written by `prune --before` stay until you delete them.

**What is sent to the workspace.** By default the *Standard* evidence detail, until the
workspace sets its evidence detail to *Full* (it says so on each rules check); then every
receipt is sent. Under *Standard*, the notable receipts are sent in full at once — anything not plainly allowed (a block, an override, an approval, an
action a Monitor rule matched), pushes, MCP calls, web fetches, and writes outside the
project or to CI, agent or Scopebond settings — and the routine ones leave as one signed
summary per five minutes (`scopebond:summary`, see `@scopebond/verify/summary`): their
count, a Merkle root over them, counts by action type, program and folder, and the
commands repeated. Every receipt stays here for the retention above, and anybody holding
them can check them against the summary. The Scopebond Agent sends the summaries; without
it, `flush` (for example at the end of a session) does; a hook call sends only when it
recorded something notable.

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
configured push refspec, `send-pack`) is denied, and a tags-only push is allowed. An alias
or refspec given through git's environment (`GIT_CONFIG_COUNT` with `GIT_CONFIG_KEY_<n>`, or
`GIT_CONFIG_PARAMETERS`) on the git command, an enclosing command or an earlier `export` counts
the same as one given with `-c`; a push that names its destination is judged by that
destination. The
agent running the hook's own `init`, `install`, `trust`, `uninstall`, `connect` or
`login` is denied, and those commands also refuse a non-interactive terminal unless
`--yes` is passed. So is the agent switching off the Scopebond Agent: `scopebond-agent
autostart off`, stopping it by name (`pkill -f scopebond-agent`, `taskkill`, `wmic …
terminate`), or a global uninstall of `@scopebond/agent` or `@scopebond/hook` (`npm
uninstall -g`, `pnpm rm -g`, `yarn global remove`, `bun remove -g`). `scopebond-agent
status`, `flush`, `check`, `repair` and `autostart on` stay allowed. So is starting a coding
agent without this computer's hooks (its settings overridden, its permission checks skipped,
or its config folder moved with `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `CURSOR_CONFIG_DIR`,
`XDG_CONFIG_HOME` or the home folder set on the agent's command, an enclosing `sh -c`, or an
earlier `export`, `set` or PowerShell `$env:` in the same command; an agent's name in a message
or an argument starts nothing), and removing or renaming a folder that holds what this protects:
the project's or the home folder's own `.claude`, `.cursor`, `.codex` or `.scopebond`, the
project's `.git`, or a folder above them. The same names elsewhere (a test fixture, a vendored
library's `.git`) and a `git clean -x` that cannot reach the project's `.scopebond` or personal
hook settings stay allowed. A person can still
run any of these from their own terminal, which the hook never sees. These denials, and the
denial of any edit to Scopebond's own folder, hold whatever the rules say: they are not rules
that can be set to record. A command that names Scopebond but cannot be read (an alias, a
script, a variable) is treated as an attempt to change its settings and denied.

**Removing Scopebond.** `uninstall` tells each workspace this computer is connected to before
anything is removed. Unless an owner or admin disconnected the computer or allowed its removal
in the workspace first, the workspace raises a critical alert. A workspace that cannot be
reached never stops the uninstall; the command says it could not tell it.

**Limits.** The hook sees the command text, not what a program does at run time. A
variable set earlier in the same command (`x=.claude; rm -rf $x`, `export`, a `for` loop, cmd
`set`, PowerShell `$x =` or `$env:x =`, or an enclosing command's prefix) is read with each
value it may hold. It does not follow a variable whose value it cannot see (`cat $FILE` records no read unless
the text around the variable could name a protected file), a path assembled inside a
script or interpreter (`python script.py`; Scopebond's own folder named in an
interpreter's arguments or inline code is treated as read), aliases, functions and variables
defined in an earlier call (where the agent's shell persists between calls), git aliases from
the user's own config files, recursive reads of a parent of a protected directory
(`grep -r . `, `cp -r ~ /tmp`), a folder named through a variable set outside the command
(`rm -rf $DIR`), or
deletion expressed as arguments (`find -delete`, `git clean`) other than of a protected folder
by name or, with `git clean -x`, of a project that holds a `.scopebond`. Commands whose written
files are named only inside their
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
