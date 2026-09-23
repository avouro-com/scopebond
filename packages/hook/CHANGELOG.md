# @scopebond/hook

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
