# @scopebond/hook

## 0.14.0

### Minor Changes

- 3308250: `status --json` prints the delivery and identity status in one machine-readable shape (`scopebond.status.v1`): `state` (`delivering`, `recording_locally` or `not_governing`), the last delivery and its error code, records waiting and the age of the oldest, delivery gaps by reason, this computer's installation, generation, key and credential expiry, and which configurations exist. The desktop agent and support read this, not the human text.

  A record the workspace refuses on its own (the rest of the batch stored) now leaves the delivery queue as a `rejected` gap instead of being retried with every batch, so one bad record can never hold up the ones behind it; it stays in the local log. The SQLite outbox gains `recordGap` and `gapsByReason`.

  A delivery conformance suite runs the real runtime and queue against a workspace that refuses the connection, fails with 5xx, stays unreachable for eight days, and refuses single records: in every case each record is delivered or accounted for.

### Patch Changes

- Updated dependencies [3308250]
  - @scopebond/gateway@0.12.0

## 0.13.0

### Minor Changes

- 6e61a3b: A connected computer now renews its machine credential by itself. Credentials last 90 days; in the last 30 the hook renews it during its rules check, proving it still holds the signing key it enrolled with, and saves the new credential in `cloud.json`. A computer no longer stops delivering on day 90 because nobody signed it in again. An outage or refusal leaves the saved connection unchanged, and the next check tries again.

  The rules check also tells the workspace how many records wait to send, since when, and the last delivery problem (`x-scopebond-pending`, `x-scopebond-oldest-pending-at`, `x-scopebond-last-error`), so the portal can show a computer that checks in but is not delivering. It sends counts and one error line, never a record.

### Patch Changes

- Updated dependencies [6e61a3b]
  - @scopebond/gateway@0.11.0

## 0.12.0

### Minor Changes

- c299d50: `status` and `doctor` now tell the truth about delivery. Each delivery attempt is remembered after the hook exits: when this computer last delivered records, when it last tried, how many records wait and since when, and the last problem. A refused connection (HTTP 401 from record delivery or the rules check) is shown as **NOT DELIVERING** since the time it started, with the one command that fixes it; it clears on the next accepted delivery. `doctor` checks that the workspace still accepts the connection, not only that it is reachable, and fails when records have waited more than an hour or the connection is refused.

  The delivery queue no longer drops records: no 10,000-record or 64 MiB cap and no 7-day expiry. A record leaves the queue only when the workspace accepts it, or when a key change sets it aside for `recover`.

  Signing in again leaves an agent settings file that already holds the right hook entry byte-for-byte untouched (no rewrite, no backup), and `login` notes when it is run inside a coding agent's own terminal. Commands the hook prints use `npx.cmd` on Windows, where PowerShell's default script policy refuses `npx`.

  `login` and `connect` for this computer (the default) now put the hook in the user-level agent settings (`~/.claude/settings.json`, `~/.cursor/hooks.json`, `~/.codex/hooks.json`), so every project is checked. Before, with no existing setup they wrote the current folder's project settings, so a sign-in run from a scratch folder governed only that folder. `--project` keeps a per-project connection and placement.

## 0.11.0

### Minor Changes

- 0a30e9c: Workspace rules can name exact targets a rule skips: paths for the secret-read and CI-configuration rules (an exact path, or a folder ending in `/**`) and branches for the push rule. An exclusion matches exactly, same case, so it is never broader than what was typed, and an exclusion that would touch the always-on protection of Scopebond's own settings or the agents' hook settings is dropped when the policy is compiled. The rules fetch now sends the hook's version (`x-scopebond-hook-version`), so a workspace can send these lists only to computers that understand them; earlier hook versions refuse a document that carries them.

  A document with the same version as the one in force but different rules is now accepted (the workspace can change what reaches a computer without a new version, for example when an agent moves to another team); an older version, or the same rules again, is still refused. An exclusion can never reach Scopebond's own settings or the agents' hook settings or climb out of its folder (no "." or ".." segments), a branch exclusion is one exact name starting with a letter or digit, and skipping ordinary pushes to a branch keeps its force-push, deletion and mirror protection.

- 1b8be99: Reconnecting a computer always works now. When the workspace refuses this computer's countersigning key because the computer was replaced or disconnected there, `login` and `connect` replace the key and enroll again with the same, unspent token. The old key is kept in `retired-keys/`. Queued receipts signed by the earlier key leave the delivery queue as `rekeyed` gaps, so they no longer hold up newer receipts, and they stay in the local log.

  New `recover` command: it finds the local records an earlier key signed, asks the workspace to accept them, waits while an owner or admin approves it there, then sends them in bounded batches and reports how many were recovered, already present or refused. Nothing is re-signed.

  `login` and `connect` run from a folder without its own project setup now repair the connection the hook actually uses, usually the user-level one, instead of creating a second, project-level setup beside it. `--project` sets up the current folder explicitly.

  Gateway changes: enrollment refusals are a `CloudEnrollmentError` that carries the HTTP status and the workspace's code. `SqliteReceiptStore.page()` walks a large log without loading it into memory. `SqliteCloudOutbox.discardNotSignedBy()` sets aside queued receipts signed by another key.

- 4242eda: A connected computer sends its records to the address its workspace names at enrollment. When the enrollment answer carries `ingest_url` (a workspace's regional ingest address), the hook keeps it in `cloud.json` and uses it for record delivery, observations, proof receipts, `flush` and `recover`; sign-in, rules and the portal still use the workspace URL. Only an HTTPS origin without credentials is accepted (or `http://localhost` for development); anything else is ignored and the workspace URL is used, as are connections made before this version.

### Patch Changes

- Updated dependencies [1b8be99]
  - @scopebond/gateway@0.10.0

## 0.10.0

### Minor Changes

- c37c604: Rules set by your workspace. A connected computer keeps its own rules until someone who manages the workspace changes one; it then checks for changes at most every five minutes, alongside a tool call's record delivery and capped at about one and a half seconds, installs a newer version only after checking that it is complete, issued for this computer, matches its digest and loads, and confirms exactly which version it loaded. Each rule is blocked or only recorded as the workspace chooses, and the workspace can add entries to the computer's lists; it cannot relax the protection of Scopebond's own settings and the agents' hook settings. `rules` edits and `policy load` are refused while the workspace sets the rules; a revoked connection, or a workspace that stops setting them, restores the computer's own rules. New: `policy sync`, a `rules` line in `status`, and `SCOPEBOND_POLICY_SYNC=off`.

## 0.9.0

### Minor Changes

- b65261d: Dispatch boundary for the hook. A `dispatch.json` beside the policy turns on per-agent action budgets (one count per tool call, however many intents it maps to, kept across hook processes), single-use approvals for named action types and, with `SCOPEBOND_DELEGATION`, a delegated child scope checked against its whole ancestry on every call. New `budget` and `delegation` commands manage them; the suggested 100 per 60 seconds template is monitor-only. Off unless configured.
- b08c8df: With approvals required in `dispatch.json`, typed operations carry `approval_request_hash` (the hash the dispatch guard consumes with) and a `resource_id` equal to the guard's target id. `scopebond budget load` verifies the export's `agent_kid` against this machine's agent key (refusing a mismatch, warning on null) and writes it as the budget's actor. Workspace approvals no longer need a hand-copied id.
- 7c6fa19: `scopebond budget load <export.json> [--yes]` loads an action budget exported from the workspace. It verifies the export (type and version, the policy digest over the policy without its acknowledgement, the scope digest, the environment, the validity window and the fail-closed contract), refuses one this installation cannot enforce, writes the budget into `dispatch.json` as an acknowledged policy (replacing an older workspace budget for the agent, never a newer one), and queues the `policy_ack` for the workspace with the export id, budget id and version and digests it expects. Without `--yes` it only checks. When the machine is connected with `observations:write`, approvals left in `approvals/` as `{ "cloud_approval_id": "..." }` are consumed in the workspace at dispatch, and delegated sessions unknown locally are resolved there. `"cloud": false` in `dispatch.json` keeps everything local.
- aa4db1c: Capability manifest and safe proof fixtures. `scopebond capabilities` prints, per agent host (Claude Code terminal and desktop, Codex CLI and desktop, Cursor), action type and event phase, whether the hook is `unsupported`, `inactive`, `configured_unverified`, `degraded` or `verified_reporting`, with the fields it emits, whether it acts before or after the action, and the limits its test vectors document. `--prove` runs allow, deny, signature and grouping fixtures in temporary directories without reading or changing any agent setting; a local fixture never makes a cell verified, an observation-only action (Cursor's after-edit event, monitor-mode fetch and MCP calls) is proven with a labelled success fixture and no deny claim, and nested tool orchestration stays unsupported.

  Receipts from one tool call now share one action group: `action_group`, `action_group_size` and `action_group_seq` are added inside the signed intent's `params` (no new top-level receipt key), derived from the harness's tool-call id when it sends one.

  Rule coverage: a push destination that is a variable, substitution or glob is now treated as unresolved and denied; `iex`/`Invoke-Expression` and a shell fed from standard input (`curl ... | sh`) are analysed or treated as opaque rather than allowed; `ln -s`, `mklink` and `New-Item -ItemType Junction/SymbolicLink` record their target as a write; the default protected-write set also covers `.cursor/mcp.json`, `.githooks/`, `bitbucket-pipelines.yml`, `.travis.yml`, `.drone.yml`, `cloudbuild.yaml`/`.yml`, `azure-pipelines.yaml` and `.buildkite/` (an installed policy that still carries the previous set is upgraded in memory, as before). New optional `allowed_roots` in `rules.json` denies writes whose physical target (symlinks, junctions, rename and link destinations followed) is outside the roots or cannot be resolved; absent, nothing changes. A catalog classifier (`classifyIntent`) is derived from the same rule set and is tested against the compiled policy.

- 7ffed9c: Opt-in observation emitters. When a workspace enrollment grants `observations:write` (and supplies an installation id and generation), the hook signs and uploads `scopebond:observation` records to `POST /v1/observations`: Claude Code session start and stop, a 60-second heartbeat while a session is active, receipt-queue age, tool intents with a keyed request-binding digest (Claude Code, Codex and Cursor), Claude Code tool outcomes, capability proofs from `capabilities --prove`, and a policy acknowledgement helper. A local outbox allocates sequence numbers transactionally across process restarts, keeps observation ids stable across retries, removes only acknowledged items, retries only deferred ones, and keeps refused items in a visible terminal-error queue (`scopebond observations status --refused`). A stale generation or unsupported version is never retried, and a workspace without the route is marked unsupported. Sending is best effort and cannot change a policy decision; without the scope nothing is emitted. New `scopebond observations` command and a status line. Capability proofs name the fixture receipts they stand on (`proof_digests`, delivered first and signed with the machine's own keys); `scopebond policy load <export.json> [--yes]` verifies an exported policy, loads it atomically and acknowledges it; the installation id may come from the enrollment's `gateway_id`.
- 5a86ea0: Typed network, Cloudflare and database operations on `tool_intent`. The hook now reads the raw command (or a Claude Code WebFetch input) and sends a closed `network` operation (scheme, IDNA host, effective port, method, read, write or upload) for WebFetch, curl, wget and the PowerShell web cmdlets, a `cloudflare_resource` operation for Wrangler deploy, Pages, D1 create and delete, R2 bucket and object commands, and a `database` operation (verb, bounded or all predicate class, keyed database id, keyed statement or migration-set digest) for `wrangler d1 execute`, `d1 migrations apply`, `psql` and `sqlite3`. SQL text, rows, names, URL paths, queries, credentials, bodies and account ids never leave the machine; SQL the classifier cannot place, redirects, proxies and multi-URL commands produce no operation. New observation-only capability cells: `network.request`, `cloudflare.resource`, `database.exec`; `browser.action`, `communication.send` and `visibility.change` are listed as unsupported with reasons. New opt-in rule `scopebond-hook rules protect-remote-database` denies destructive or unreadable SQL against a remote database before it runs. `observations id` learns `net-dest`, `cf` and `database`.
- d5ba4cb: Typed git, GitHub and package operations on `tool_intent`. The hook reads the raw command (or the GitHub MCP tool input) it is about to allow and sends a closed `git` (commit, push, delete, mirror), `github_resource` (pr_create, release_create) or `package` (install, add, update for npm, pnpm, yarn, pip and uv) operation in place of the generic shell one, linked to the receipt of that command. Refs, remotes and repositories are keyed opaque ids (credentials in a remote URL are dropped); an unresolved ref or remote, unpinned versions, unknown integrity and lifecycle-script status stay unknown; a command that names no packages, follows a `cd`, or names a pull request only by number is not described. Pushes now carry a `remote_id` and the delete and mirror verbs. New observation-only capability cells (`git.commit`, `package.install`, `github.resource`) are fixture-proven at most; `github.pr_change` and `deploy.run` are listed as unsupported. `scopebond observations id <kind> <value>` prints the keyed id for a ref, remote, repository or MCP tool, for writing reference sets.

### Patch Changes

- Updated dependencies [b65261d]
- Updated dependencies [b08c8df]
- Updated dependencies [b08c8df]
- Updated dependencies [7c6fa19]
- Updated dependencies [aac4f6f]
  - @scopebond/gateway@0.9.0
  - @scopebond/policy-schema@0.5.0
  - @scopebond/sdk@0.1.3

## 0.8.1

### Patch Changes

- 3d7330b: `connect` and `login` now trust the project policy they set up when a user-level install exists, as `init` does. Before this, the hook ignored the untrusted project and used the user-level policy, which has no workspace connection, so a connected project's actions never reached the workspace even though the command reported success. Setup commands (`init`, `install`, `connect`, `login`) also stop early with a plain message on Node older than 22.13, instead of failing later on a missing module.

## 0.8.0

### Minor Changes

- 3167b96: `login <workspace-url>` connects this computer to a Scopebond Cloud workspace without pasting anything. It asks the workspace for a short code, prints it with the page to open, and waits while someone who manages the workspace approves it for an environment and agent; the approval hands back a single-use enrollment that completes exactly as `connect` does (the same agent wiring, `--cursor`, `--codex`, `--no-install`). `slow_down`, denial and expiry are handled; the device code is kept in memory and never printed or written. `connect` is unchanged.
- d3ab02c: Command and MCP-argument digests in receipts are now keyed (HMAC-SHA-256 under a per-machine `.scopebond/digest.key`, created by `init` or on first use) and labelled `hmac-sha256:`. A plain SHA-256 of a command whose scrubbed head is printed beside it left only the unseen remainder to guess, so a short secret the scrubber missed could be recovered offline from a receipt; MCP arguments were digested unscrubbed. Digests still match for identical actions on the same machine. The starter policy already denies agent reads of `.scopebond/` and `*.key`.
- 86782ee: `init` no longer writes a machine-specific hook command into a file your team shares. The fast, pinned command names paths that exist only on the machine that ran `init`; in a committed `.claude/settings.json` it could not start on a teammate's machine, and Claude Code, Cursor and Codex treat a hook that cannot start as a non-blocking error — so the teammate's agent ran with no check while the file said it was governed.

  - Claude Code: the pinned command goes to `.claude/settings.local.json`, kept out of git for this clone through `.git/info/exclude` (the repository's `.gitignore` is not touched). Running `init` again removes a pinned entry an older version wrote into `.claude/settings.json`.
  - Cursor and Codex: the pinned command goes into the project file only while git does not already track it; a tracked file gets the portable `npx` command.
  - `init --shared` writes the portable command to the shared file so everyone who clones the project gets the hook (it fails closed with a setup message until they run `init`).
  - `doctor` flags a machine-specific command in a file git shares, even when it starts on this machine.
  - `install` pins a durable copy instead of registering npm's temporary `npx` cache path, which npm may clear.
  - `connect` leaves an already-configured hook as it is.
  - `init --dry-run` shows what it would write; `connect` errors say where an enrollment comes from; `status`/`doctor` hints print a runnable command; Node's experimental SQLite warning is no longer printed.

## 0.7.0

### Minor Changes

- 2b03b41: Make the connector do what the site says: a readable block message, a hook that starts
  fast, diagnostics that tell the truth, and honest Cursor coverage.

  - **`init` pins the hook to a durable path instead of `npx`.** The command it installed
    ran `npx -y @scopebond/hook@<version>` on every tool call, which re-resolves a package
    already on disk. `init` now copies this package to `~/.scopebond/runtime/<version>/`
    once per machine and points the agent at that absolute path. Measured on one Windows
    machine, through a shell, warm cache: **151 ms per tool call, down from 1053 ms.** Pass
    `--npx` to keep the portable command; `init` falls back to it automatically when no
    durable copy can be made, and `doctor` now verifies that a pinned command still
    resolves, so a cleared home or a switched Node version surfaces as a problem rather
    than a hook that cannot start.
  - **A denial explains itself.** The message was the engine's internal reason — `param
program fails pattern`. It now names the action, the deciding rule, that rule's own
    description, the technical detail and the file to edit. The same text reaches the
    coding agent, so it can choose another approach instead of retrying a blocked call.
  - **`status` and `doctor` no longer contradict `init`.** Both checked only the
    user-level agent config, so after a per-project `init` they reported "Claude Code: not
    configured". They now report both scopes and name the files, and `doctor` treats "no
    agent configured at all" as a problem, because nothing is enforced in that state.
  - **Cursor: an allowed action no longer prompts.** The adapter answered `ask` even for
    an action a rule had evaluated and permitted, putting a confirmation dialog in front
    of every ordinary command. An evaluated allow now answers `allow`; `ask` is reserved
    for actions no rule covers, which still defer to Cursor's own prompt.
  - **Cursor: file edits are described as recorded, not prevented.** Cursor reports an
    edit only after writing it (`afterFileEdit`), so an out-of-policy edit cannot be
    blocked there. Such a decision is now flagged post-hoc, worded as "recorded an
    out-of-policy …" rather than "blocked", and `init --cursor` prints what is prevented
    and what is only recorded.
  - **Fixed: unparseable input to the Cursor adapter answered `ask`.** Invalid JSON on
    stdin fell through to evaluation with an empty payload and became an `ask`, so an
    unreadable request reached a prompt the user would likely accept. It now denies, like
    every other adapter.
  - **Fixed: a user-level `install` on Windows wrote a command that bash could not run.**
    Absolute paths were quoted only when they contained a space, so an unquoted Windows
    path lost its separators under Git Bash, WSL or a dev container and the hook died with
    `MODULE_NOT_FOUND`. Both paths are now always quoted on Windows.
  - **Fixed: re-running `init` could install a second hook entry.** The duplicate check
    did not recognise a pinned Windows path (`@scopebond\hook`), so a repeat `init` would
    have left the hook checking every tool call twice. There is now one shared matcher for
    every command form the installer has ever written.
  - Printed guidance uses plain `npx` on every platform instead of `npx.cmd`, and the
    non-interactive refusal explains why it refuses and how to proceed.

- 978e7a3: Make the limits editable, bound what the hook writes to disk, and make `install` safe to
  try.

  - **`rules` — the limits in plain terms.** `policy.json` is 6.7 KB of generated regular
    expression (the `safe-shell` clause alone is a ~700-character case-folded negative
    lookahead), so "it is a plain JSON file — edit the limits" was not true in practice and
    the starter policy was effectively the only policy. The lists those patterns are built
    from now live in `.scopebond/rules.json`, and `policy.json` is compiled from them:

    ```
    scopebond-hook rules                    # what is blocked, in plain English
    scopebond-hook rules allow dd
    scopebond-hook rules protect infra/
    scopebond-hook rules protect-branch production
    scopebond-hook rules apply              # recompile after editing rules.json by hand
    ```

    The compiled patterns are **identical** to the ones already shipped — a test pins them
    against `starterPolicy()`, so the readable front end cannot change what is enforced.
    Clause descriptions are now generated from the lists, so they stay true after an edit
    (and the block message quotes them).

  - **The local store stops growing without bound.** The hook is one short-lived process per
    tool call, and it never closed its SQLite handle — so each process left its write-ahead
    log on disk for the next one to extend. Measured: **~11 KiB of WAL per receipt, against
    ~1.7 KiB once the handle is closed**, and the WAL file is now gone entirely after a run.
    (It also released a Windows file lock that stopped `.scopebond` being removable.)
    `ReceiptStore` gains optional `recent(limit)` and `count()`; both stores implement
    `close()` with a truncating checkpoint.

  - **`prune` bounds the store, without ever losing evidence quietly.** `status` now reports
    the receipt count and size, and `prune --before 90d` archives the receipts it will
    remove to a JSONL file beside the database before removing them, then VACUUMs. It
    refuses outright once the log has been anchored, because a receipt's position is its
    anchor leaf index and removing one would make an existing anchor unverifiable. Nothing
    is ever deleted automatically.

  - **`log` answers "what got blocked this week".** It had no filters and read every receipt
    ever recorded in order to print the last 20. It now takes `--deny` and `--since 7d`, and
    reads a tail (`ORDER BY id DESC LIMIT`) with a bounded scan when filtering. `verify`
    still reads everything — that is the point of it — but reports progress instead of
    looking hung on a long history.

  - **`install --dry-run`, and a backup before any change.** `install` rewrites agent config
    files the user did not create (`~/.claude/settings.json` holds their theme, plugins and
    permissions) and the undo was "hope the merge was right". It now prints exactly which
    files it would touch with `--dry-run`, and copies each config to
    `<file>.scopebond-backup` before its first modification.

  - **Fixed: `uninstall` ignored the project hook.** Like `status` and `doctor` before it, it
    looked only at the user-level config — so after the per-project `init` the site tells
    people to run, it reported "no user-level harness config found" and left the hook in
    place. It now removes both scopes and says what it kept.

  - **Per-command help.** `--help` was a single line listing 15 command names. `help` now
    describes each command, and `help <command>` gives its arguments and an example.

  Known remaining inefficiency: the authority tables store the policy snapshot per action,
  so a tool call costs ~25 KiB rather than the ~2 KiB of the receipt itself. Deduplicating
  it by digest needs a schema migration in the authority storage that backs duplicate-action
  detection, so it is deliberately left for its own change rather than bundled here.

### Patch Changes

- Updated dependencies [978e7a3]
- Updated dependencies [978e7a3]
  - @scopebond/gateway@0.8.0

## 0.6.0

### Minor Changes

- 792c40f: Security: `force_push_guard` now covers branch deletion and all-branch pushes, and its default protects nested release branches.

  The clause previously fired only on a `--force` push whose single resolved ref matched the protected set. Three destructive pushes slipped through:

  - **Deletion** (`git push origin :main`, `git push origin --delete main`) removes a protected branch and is destructive even without `--force`; it was treated as an ordinary push.
  - **All-branch force pushes** (`git push --all --force`, `git push --mirror`) reach every branch — so they necessarily rewrite the protected ones, and `--mirror` also prunes — but their whole-repo push carried no single protected ref to match.
  - The default protected set was `["main", "master", "release/*"]`; the single-star glob does not cross `/`, so `release/1.0/hotfix` was unprotected. The default is now `release/**`.

  The hook mapper marks these on the `git.push` intent it emits (`delete` for `:dst`/`--delete`, `all` for `--all`/`--mirror`/`--branches`), and `force_push_guard` denies a delete of a protected ref (regardless of `force`), a force-push to all branches, and a force-push to a protected ref, still allowing ordinary pushes, feature-branch force-pushes and a non-forced `--all`. A destructive push whose target ref cannot be resolved still fails closed. The hook's own starter policy already denied these through its stricter ref allowlist; this closes the gap for customer policies that use the `force_push_guard` clause.

- a42fc81: Security: canonicalize shell and path inputs before policy evaluation, and stop a project policy from overriding the user's.

  - A project `.scopebond/policy.json` no longer overrides an existing user-level install unless the user trusted that exact policy (`scopebond trust`, or `init` in the project). A later edit un-trusts it, so neither a cloned repository nor the governed agent can swap in a weaker policy.
  - `git push` destinations are checked in the common spellings: `refs/heads/main`, `HEAD:main`, a second refspec, `-o`/`--repo` options, combined `-uf` flags, `--all` and `--mirror`. A push whose destination is not on the command line (a git alias, a configured push refspec, `send-pack`, `subtree push`) is denied; a tags-only push (`--tags`) is allowed.
  - Shell commands are decomposed through keywords and grouping (`if`/`for`/`while`/`{ }`/`!`/`case`), `eval`, `trap`, substitutions inside double quotes, `env -S`, `su -c`, `script -c`, `watch`, `parallel`, `cmd /c`, `pwsh -Command`/`-EncodedCommand` and `find -exec`, and through wrappers (`sudo`, `time`, `nice`, `xargs`, `timeout`, `strace` …) with their own option arities; wrappers such as `sudo` are checked as programs too. Trailing `#` comments are handled.
  - Files read or written through the shell reach the same guards as the Read and Write tools in the common spellings: copies and moves, writers and editors (`tee`, `sed -i`, `yq -i`, `ed`, `vim`), git's own writes (`checkout -- p`, `restore`, `mv`, `rm`, `config core.hooksPath`), secrets sent or staged (`curl -T`, `-d @file`, `gh gist create`, `git add`), redirections without spaces, a directory reached with `cd`, protected directories given as operands (`cp -r ~/.ssh`), and globs, variables or brace lists that could name a protected file (`.*/*`). Existence and metadata checks (`ls`, `test -f`, `stat`) and a secret file's name in a string no longer count as reads.
  - Everyday agent commands are no longer misread as policy violations: a here-document body is inert data (a commit message or PR body written with `git commit -m "$(cat <<EOF …)"`, a note written with `cat <<EOF > f`), never a sequence of commands — but a body fed to a shell (`bash <<EOF …`) still runs and is evaluated, and a here-doc redirected to a protected file is still a write. An inline HTTP payload is data, not a filename: `curl -d '{…}'`, `--data-raw`, `--json` and `wget --post-data` values are inline unless they name a file with `@` (`-d @.env`, `-F up=@secret` still read). A protected path named in inline interpreter code (`node -e`, `python -c`) is recorded only when the same snippet also calls a file or process API, so a path merely mentioned in a log string is not a finding. A `chmod`/`chown` mode or owner (`+x`, `0755`, `root:wheel`) is not recorded as a written path.
  - Paths and program names are matched case-insensitively; `.exe` suffixes, Windows backslash paths, 8.3 short names (`CLAUDE~1`), PowerShell backtick escapes, `::$DATA` streams and trailing dots are normalized.
  - The starter policy now also protects SSH, AWS, Kubernetes, Docker, GnuPG, gcloud and Azure credentials (and their directories), the GitHub CLI's `hosts.yml`, Claude Code's `.credentials.json`, key containers (`*.pem`, `*.p12`, `*.pfx`), `.envrc`, `.git/config`, Husky hooks, `.claude/hooks`, `.claude/agents`, `.mcp.json` and `.gitlab-ci.yaml`, and denies `shred`, `truncate`, `unlink`, `wipe`, `diskpart` and `Clear-Content`. `.env` templates ending in `.example`, `.sample`, `.template` or `.dist` stay readable. Starter policies written by earlier versions are upgraded in memory.
  - Behaviour change: a shell command that cannot be parsed, or whose program is only known at run time (`$cmd`, `$(…) args`), is now evaluated with an empty program and denied by the starter policy in normal mode too (it was previously recorded as not evaluated).
  - The agent running the hook's own `init`, `install`, `trust`, `uninstall` or `connect` is denied, and `init`, `trust` and `uninstall` refuse a non-interactive stdin unless `--yes` is passed.
  - `init` and `install` refuse to overwrite an agent settings file that is not valid JSON instead of replacing it.
  - The Claude Code plugin pins the current hook version, and its manifest version follows the hook version.

  Documented limits: the hook reads the command text only. It cannot see a variable's value, a path built inside a script, aliases or functions from an earlier call, git aliases in a config file, or recursive reads of a parent of a protected directory. Writes named only inside a patch or archive (`patch`, `git apply`, `tar x`, `unzip`) are recorded as not evaluated (denied in strict mode). Reading any `*.pem` file is denied, public certificates included.

- 8332610: Privacy: the command digest no longer hands back what the scrubber removed, and the scrubber catches two more common secret shapes.

  - **Digest over scrubbed text.** `redactCommand` recorded a scrubbed, truncated head followed by a SHA-256 of the _original_ command, so a secret the head removed (`psql --password hunter2 …`) was still brute-forceable from the retained digest. The digest is now taken over the scrubbed command, so the receipt reveals nothing the head already hid.
  - **Attached `-p`/`-u` values.** `mysql -phunter2` / `psql -uadmin` put a password or user on argv with no separator, and passed through unchanged. The scrubber now masks an attached `-p`/`-u` value in the command head; a space-separated operand (`mkdir -p dir`, `-p value`) is untouched, and the `--password`/`--user` forms remain handled as before.
  - **Custom secret-named headers.** A header whose name looks like a credential (`X-Custom-Secret:`, `My-Token:`) now has its value masked, alongside the existing `Authorization`/`X-API-Key` rules. Bare `key:` is deliberately excluded so ordinary `key: value` text is left alone.

  Both new rules apply to free text (the command head) only, never to the structured parameters a policy matches on, so policy evaluation is unchanged. Command scrubbing remains best-effort — secrets should not be passed on argv in the first place.

### Patch Changes

- Updated dependencies [df4fc67]
- Updated dependencies [f2e4d62]
- Updated dependencies [5329932]
  - @scopebond/gateway@0.7.0
  - @scopebond/policy-schema@0.4.1

## 0.5.0

### Minor Changes

- 2d2a9eb: Add OpenAI Codex support through its `PreToolUse` hook. Scopebond can install or connect Codex with `--codex`, maps shell, patch, and MCP actions into the existing policy runtime, blocks protected actions before they run, and explains the one-time `/hooks` approval step in plain language.

### Patch Changes

- 7343f01: Register the hook's separate agent signing key during enrollment using a challenge signed by both keys. Require the server to acknowledge that key before saving the connection, so authenticated receipts can be uploaded. Let doctor and flush exit normally after network requests to avoid a Windows shutdown assertion.
- Updated dependencies [f212f82]
- Updated dependencies [7343f01]
  - @scopebond/policy-schema@0.4.0
  - @scopebond/gateway@0.6.1
  - @scopebond/sdk@0.1.2

## 0.4.0

### Minor Changes

- 4c55503: Self-protection completeness and a runnable first run (security).

  The starter policy protected the hook's own keys and config only against the
  native file tools. Three gaps let a governed agent reach them anyway; all are now
  closed, with regression cases in the mapper suite and the bypass corpus:

  - **Shell reads of the signing key or a secret file** (`cat .scopebond/attester.key`,
    `head .env`) mapped to `shell.exec` only, bypassing the `file.read` guard entirely.
    A reader program's operands (and the targets of `>`/`>>` redirections) now also
    emit `file.read`/`file.write` intents, so the same `protect-read`/`protect-write`
    clauses apply. Reading the attester key — which would let an agent forge receipts —
    is denied.
  - **Windows backslash paths** (`.scopebond\policy.json`) did not match the guard
    patterns, which are written with `/`. Paths are normalized to `/` before matching.
  - **The `PowerShell` and generic `Shell` tools were unmapped**, so a command like
    `Remove-Item -Recurse -Force .` fell through to an un-evaluated `tool.<name>` and
    was allowed. They now decompose like `Bash`, and the starter policy's destructive
    denylist covers the Windows/PowerShell forms (`del`, `rd`, `rmdir`, `erase`,
    `deltree`, `format`, `Remove-Item`).

  Also: `init` now prints runnable `npx -y @scopebond/hook@<version> …` commands for
  the follow-up steps (the previous `scopebond-hook …` form is not on PATH after an
  `npx` install), and `engines` requires Node `>=22.13` (the cloud outbox needs
  `node:sqlite`, which is unavailable/flagged on 22.0–22.12).

  Existing scaffolded policies are unchanged — only newly-initialized policies pick up
  the tighter destructive denylist; the mapper-level protections apply to every install.

- e6143b0: Real install package: a once-per-machine, user-level installer (SB112).

  - New `scopebond` bin (alongside `scopebond-hook`) and commands: `install`
    (user-level home in `~/.scopebond`, hook registered by absolute path in
    `~/.claude/settings.json` / `~/.cursor/hooks.json`, Cursor auto-detected),
    `status`, `doctor`, `uninstall` (`--purge`), and `login` (points at `connect`
    until device-code login ships).
  - Hook events now resolve their config most-specific first: an explicit
    `SCOPEBOND_HOOK_DIR`, then the payload's project `.scopebond`, then
    `$CLAUDE_PROJECT_DIR`, then the user-level home — so one install governs every
    project while a project-local policy still wins.
  - Ships as a Claude Code plugin (a `.claude-plugin` marketplace at the repo root):
    `/plugin marketplace add avouro-com/scopebond` then `/plugin install scopebond`.

### Patch Changes

- c07b340: Starter policy: block writes to CI config and reads of environment secret files (SB81).

  `npx @scopebond/hook init` now scaffolds a starter policy whose `protect-write` clause
  also denies writes to CI configuration (`.github/workflows/`, `.github/actions/`,
  `.gitlab-ci.yml`, `.circleci/`, `azure-pipelines.yml`, `Jenkinsfile`) and whose
  `protect-read` clause also denies reads of environment secret files (`.env`, `.env.*`),
  while still allowing `.env.example`/`.sample`/`.template`. This closes the gap between
  the documented protection ("a write to your CI config — blocked before it runs") and the
  shipped default. Existing scaffolded policies are unchanged — the policy is a plain JSON
  file the operator edits; only newly-initialized policies pick up the tighter defaults.

## 0.3.0

### Minor Changes

- 0f0012c: Make the hook usable in one command and honest on first run.

  - `init` now configures the agent automatically (idempotent; `--no-install` prints
    the snippet instead), and both `init` and `connect` install a **version-pinned**
    `npx -y @scopebond/hook@<version> <harness>` command rather than a bare
    `scopebond-hook`, so a missing global binary is fetched instead of silently
    skipped (which a harness can treat as "no hook" and fail open). A legacy bare
    command is replaced in place, never duplicated.
  - New commands: `scopebond-hook log` (recent decisions), `scopebond-hook verify`
    (every local receipt verified offline against the attester key), and
    `scopebond-hook test "<command>"` (show a command's decision without recording
    it), so a new user reaches a visible, verifiable receipt in the first minute.
  - The starter policy no longer breaks ordinary work: `net.fetch` and MCP tool calls
    are observed (recorded, not blocked) instead of denied by the closed allowlist,
    and a bare `git push` is allowed on a non-protected branch — the runtime resolves
    the current branch and fills it in (`fillPushBranch`), so only pushes to
    `main`/`master`/`release/*` are denied. If the branch can't be resolved the ref
    stays absent and the policy fails closed.
  - The README leads with the hook and the 60-second flow and lists all eight
    packages; collateral vocabulary is out of the lead.

- 5277099: Close command-injection bypasses in the hook and stop it suppressing the host's
  own review.

  Previously the mapper read only the first token of a Bash command, so a denied
  program could ride in behind an allowed one — `echo hi && rm -rf x`,
  `bash -c 'rm -rf /'`, `$(rm -rf x)`, `FOO=1 rm -rf x`, `git push origin +main`,
  `git -C /repo push origin main` all slipped past the starter policy. A new shell
  decomposer (`decomposeShell`) splits a command into every simple command it will
  run — across `&&`/`||`/`|`/`;`/`&`/newline separators, `bash -c`/`sh -c` scripts
  (including combined flags like `-lc`), `$( )`/backtick/`( )` substitutions and
  subshells, and `sudo`/`env`/`xargs`/assignment prefixes — and `mapClaudeToolUse`
  and `mapCursorEvent` now return one intent per simple command (an array). The
  runtime evaluates all of them and denies the call if any one is out of policy;
  `git push` parsing understands `-C`, `--force`/`-f`/`--force-with-lease` and a
  leading `+` force refspec. A command that cannot be parsed with confidence is
  opaque: denied in strict mode, observed otherwise — never trusted.

  The hook no longer returns `permissionDecision:"allow"` (Claude Code) or
  `permission:"allow"` (Cursor) for an in-policy action, which used to suppress the
  user's normal permission prompt. It records the receipt and defers: only an
  out-of-policy action is blocked outright.

  The starter policy now protects the hook's own control surface — it denies writes
  to `.scopebond/**`, `.claude/settings*`, `.cursor/hooks*` and `.git/hooks/**`, and
  reads of `*.key` and `.scopebond/**` — so a governed agent cannot rewrite its own
  policy or read the signing keys. Adds a 42-case bypass corpus, decomposition,
  self-protection and ReDoS-timing tests.

### Patch Changes

- 738a8dc: Fix the secret scrubber, which leaked credentials into receipts. For single-token
  secret shapes (GitHub, GitLab, npm, Slack, Stripe, OpenAI/Anthropic, Google and AWS
  keys, JWTs and high-entropy blobs) the replace callback treated the match offset as a
  capture group and emitted the secret followed by `***` instead of masking it — the
  un-redacted value was then signed into the receipt, written to the local store and
  exported to Cloud. The scrubber is rewritten as explicit `pattern → replacement`
  rules covering private-key blocks, credential flags and headers, URL userinfo,
  credential-named `NAME=value` assignments and the token families above. Structured
  mapper parameters (program, git-push remote and ref, fetch host and path) are scrubbed
  too, so a secret embedded in a command can no longer survive as a path-split fragment,
  while ordinary policy-matched values (branch names, remotes, commit ids) are left
  intact. Adds a property-based regression suite that asserts no secret fragment reaches
  the signed receipt, the on-disk store or the Cloud export.
- Updated dependencies [4dd6919]
  - @scopebond/gateway@0.6.0

## 0.2.1

### Patch Changes

- 5378c06: Make `scopebond-hook connect` a true one-command setup for non-technical onboarding. The enrollment argument now accepts an inline base64 blob or raw JSON (not just a file path), so the portal can hand out a single copy-paste command with nothing to save; and `connect` now **auto-configures the agent** by merging the hook into `.claude/settings.json` (or `.cursor/hooks.json` with `--cursor`), preserving existing settings and idempotent on re-run (`--no-install` to skip). New export: `installHarness`.

## 0.2.0

### Minor Changes

- 4b8dab1: Add Cloud connect + auto-export to `@scopebond/hook` (connector session C). A connected hook mirrors every signed receipt to a Scopebond workspace so activity appears in the hosted portal, with no change to the local decision.

  - `scopebond-hook connect <workspace-url> <enrollment-bundle.json>` enrolls the machine's countersigning key with the workspace using the portal's one-use handoff (reusing the gateway's `completeCloudEnrollment`), scaffolds the machine if needed, and stores a scoped machine credential in `.scopebond/cloud.json` (ignored from git).
  - When connected, `createHookRuntime` wraps its receipt store with the gateway's durable Cloud exporter (`SqliteCloudOutbox` + `createCloudExporter`): delivery is best-effort and never blocks a tool call, receipts are retained locally and retried if the workspace is unreachable, and a short bounded flush keeps the hot path fast (`SCOPEBOND_HOOK_FLUSH_MS`, default 800 ms).
  - `scopebond-hook flush` delivers anything still queued — run it on a session-end hook for zero per-call latency.
  - `scaffold` now also writes `.scopebond/.gitignore` so keys, the Cloud credential and the local log are never committed. New exports: `connectCloud`, `loadConnection`, `attachExporter`, `flushBounded`, `connectionPath`, `HookConnection`.

- 4c43cdf: Add `@scopebond/hook` — the Claude Code and Cursor connector (a leaf package; no vendor SDKs). It maps each coding-agent tool call to a normalized Action Taxonomy action, checks it against policy in-path via a local check-only (M0) gateway before it runs, and records a signed receipt on the machine.

  - `scopebond-hook claude` / `scopebond-hook cursor` read a hook payload on stdin and return a deny (Claude: exit code 2) or an allow; unknown tools are recorded as not evaluated and grant nothing; any failure fails closed to deny with a repair message.
  - `scopebond-hook init [--cursor]` scaffolds a machine signing key, a countersigning key and a starter "protect main and production paths" policy, and prints the harness configuration.
  - Data minimization: file contents are never stored, shell commands are reduced to a scrubbed head plus a digest, and common secret shapes are removed before signing.
  - The pure mapper (`mapClaudeToolUse`, `mapCursorEvent`) and the `createHookRuntime` runtime are exported. Cloud export and the coverage-gap report are intentionally out of this initial release.

- 67bd0a9: Add an opt-in **strict mode** to the hook. By default an unmapped tool (one with no Action Taxonomy mapping) is observed and recorded `not_evaluated`, matching the connector conformance vector. With `strict` (`--strict` or `SCOPEBOND_HOOK_STRICT=1`, or `createHookRuntime({ strict: true })`), an unmapped tool is instead policy-checked and denied by a closed allowlist — fail-closed coverage for tools the taxonomy does not yet map, for security-conscious deployments.

### Patch Changes

- Updated dependencies [ed6a822]
- Updated dependencies [27be98a]
- Updated dependencies [973507f]
- Updated dependencies [6417866]
- Updated dependencies [8ad0aab]
- Updated dependencies [0cb916f]
- Updated dependencies [c17c1fb]
- Updated dependencies [1fd3470]
- Updated dependencies [1260a51]
  - @scopebond/policy-schema@0.3.0
  - @scopebond/gateway@0.5.0
  - @scopebond/sdk@0.1.1
