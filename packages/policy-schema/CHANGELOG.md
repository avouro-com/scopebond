# @scopebond/policy-schema

## 0.11.4

### Patch Changes

- 846c95c: Package descriptions and READMEs use one vocabulary (Monitor or Block rules, signed records, protection packs) and list GitHub Copilot with the other supported coding tools. The SDK README's example now signs a coding-agent `shell.exec` action. No code changes.

## 0.11.3

### Patch Changes

- 9a55ade: A workspace can now switch a rule Off (the hook reports the `rule_off` capability): the rule's actions run as routine and match nothing, while Scopebond's own protection and the refusal of commands whose program is only known when they run stay on, and an Off on a rule that can never be off is enforced as Block and noted in `status`.
  
  A workspace can now name exceptions for every rule that takes them, in Monitor as in Block (the hook reports the `exceptions_any_rule` capability): programs and the folders outside the working folder they may delete in for destructive-shell, environment names for production deploys, Kubernetes contexts and Terraform workspaces for cloud deletes, local database addresses for migrations, and sites for network requests; an excepted action matches no rule, and an exception never reaches further than what it names.
  
  An `action_allowlist` clause may carry `exceptions`, sets of bounds that excuse an action from the clause's `param_bounds` when it meets every bound of one set; a delete that reaches outside the working folder records those targets as `delete_targets`.
  
  A bare `git push` or `git push --force-with-lease` whose current branch cannot be read is now judged by the branch git names as its upstream, and is still denied when git cannot tell.
  
  safe-shell now also denies a file-system maker by its family name (`mkfs.<type>`), the PowerShell disk cmdlets `Format-Volume` and `Clear-Disk`, removing every scheduled job (`crontab -r`), and a recursive `chmod`, `chown` or `chgrp` of the whole disk, the home folder or a system folder, while their everyday forms stay allowed.
  
  The always-on protection now refuses reading a `cloud.json` only in a Scopebond folder (any project's own `config/cloud.json` reads as usual), and the coding agents' sub-agent definitions (`.claude/agents`) and `.mcp.json` move from it to the configuration rule a workspace can relax, while `.git/hooks`, `.git/config` and `.husky` stay always protected.
  
  A program run after a `cd` into a protected folder (Scopebond's own, or a credentials folder such as `~/.ssh`) now counts as a read of that folder, whatever its arguments, so `cd ~/.ssh && ls` is judged like reading `~/.ssh`.
- 1b8a705: The agent now counts, per day, the questions it asks a person and the notifications the tray reports showing (`POST /fatigue`), and each rules check sends the counts as `x-scopebond-fatigue: toasts=n;prompts=n;day=YYYY-MM-DD` (counts only, never what was shown).
  
  The pack format now has engine levels: `PACK_ENGINE_LEVEL` is 2, a pack may say `requires: { engine, action_types? }`, and a pack rule may carry `title`, `blockable`, `default_mode`, `safer_way` and `allow_patterns`; a pack that uses any of them must say `requires.engine: 2`, every existing pack validates and reads exactly as before, `validatePack(doc, { engine: 1 })` reads a pack as an older engine does, and `packEngineProblem` says why an engine cannot run a pack (`engine_too_old` or `unknown_action_type`).
  
  A signed taxonomy extension (`scopebond:taxonomy-ext/v1`, at the `./taxonomy-ext` subpath) adds action types as data, and `getActionType` reads the extension in force after the built-in registry, never replacing a built-in type.
  
  A rule pack's rule can now say its own title, whether it may block and whether it blocks by default: the hook reads `blockable` (falling back to the target rules for older packs), applies `default_mode` until a person or the workspace sets the rule, names the block by the rule's `title`, adds the rule's `safer_way` to the deny message's "What to do" line, and keeps these fields out of the policy clause.
  
  A workspace can now set the mode of any rule pack's rule in `pack_rules` (the hook reports the `pack_rules` capability; `pack_rules` is digested with the rules), a person may allow or ask about such a rule when its terms say so, and `rules enforce|monitor` accepts a pack's own rules.
  
  The hook now reads packs at engine level 2 and says so (`x-scopebond-pack-engine: 2` on the rules check and on each pack fetch, and the `pack_engine_2` capability): a pack that needs a newer engine or an action type the hook does not know is skipped and reported (`engine_too_old` or `unknown_action_type`, with what it needs) while every other pack is kept, `SCOPEBOND_PACK_ENGINE_LEVEL` can lower the level to see what an older engine does, and the signed pack list may mark a pack `shadow` (its rules record what they would block) or kill versions (`killed`, covered by the list's digest), which are dropped at once in favour of the version held before.
  
  The hook now fetches and verifies the signed taxonomy extension a workspace names in its pack list (`taxonomy-ext`), so a pack can emit a new kind of action, and a policy that names one of its opt-in types decides those actions, without a new hook.
  
  A rule pack's grammar can now read local facts (an environment variable, a file's digest, a top-level configuration value) in the folder the command runs in, and an MCP profile can read the environment; a pack's own vectors still run without them, so they derive the same on every computer.
  
  Each rules check now reports the packs on the computer in `x-scopebond-packs` (`id@version,…;rejected=id@version:reason,…;engine=2`): the packs in force, the ones not taken and why, and the engine level.
  
  The hook now reads and pins a next policy-signing key from a document the current key signs (`scopebond:policy-next-key/v1`, sent as `policy_next_key` on a rules answer), so the key can be rotated without a release, and a computer its workspace manages enforces signed rules when that document says `managed_signature_mode: "enforce"`.
  
  A rule id the hook does not know in a workspace document, or a malformed `pack_rules` entry, is now skipped and reported (`skipped_rules` on the rules confirmation and in `managed-meta.json`) instead of refusing the whole document.
- 0a0332d: Receipts may now carry two optional members a signed plugin gave the action: `pattern_id` (64 lowercase hex) and `intel`, an opaque slot of padded base64 holding at most 4 KiB. The receipt schema, `isReceiptIntel`/`isReceiptPatternId` and the `receipt_intel` vectors describe their shape only; the gateway signs them through the new `intel` option of `handleAction` and `observeAction`, `validateReceiptIntel` checks them, and a receipt made without them is unchanged byte for byte.
  
  The hook can now load one optional signed plugin from `<home>/intel/current/intel.mjs`: only when the manifest beside it (`{ version, sha256, signature, key_id }`) verifies against a pinned policy key over `scopebond:component/intel/v1` and the module's SHA-256. It is asked about each action within 2 ms (a throw, a promise, a late or malformed answer gives nothing) and its answer is signed into the receipt as `pattern_id` and `intel`; it never changes a decision, and without it the hook writes exactly the receipts it wrote before.
  
  New `scopebond-hook packs test --all` runs the vectors of every rule pack in force with this engine (and `packs test <file>` those of one pack file), exiting non-zero when one fails; it is the check an engine update runs before the new engine is used.
  
  The signed install's hook now runs a newer engine bundle the agent staged and checked: `<home>/engine/current.json` names it, and it is loaded only when its manifest is signed by an updater key the executable carries, its bytes are the ones the manifest names, and it is newer than the engine inside the executable. Otherwise, or when it fails to start (recorded; after two failures it is not tried again), the engine inside the executable decides the call, and hook entries keep the `"<exe>" hook <harness>` form they have today.
  
  The signed Scopebond Agent (per user and for every user) now takes a newer engine without a new installer: when the workspace names `hook_bundle` in its client-version answer, the agent downloads the bundle, checks the manifest's updater-key signature, the archive's and every file's SHA-256 and that it is newer (never an older bundle), stages it under `<home>/engine/<version>/`, runs the new engine's `packs test --all` against the packs in force, and only then names it in `<home>/engine/current.json`. A bundle that fails its vectors, or fails to start twice, is rolled back (to the one before it, else to the engine the installer carries) and never taken again.
  
  The agent installs the plugin component its workspace names (`intel: { version, sha256, url }`): fetched from the workspace only, with the computer's credential and hook version, checked against the named SHA-256 and the pinned policy key, staged under `<home>/intel/<version>/` and switched to as `<home>/intel/current`; it is removed when the workspace is not licensed (402) or stops naming it.
- f760776: A delete outside the working folder whose every target is tracked and committed in a git repository (nothing modified, staged, untracked or ignored under it) is now recorded instead of blocked, as `program_scope` `<program>/git_restorable`, because git can restore it; an untracked or changed target, a target outside any repository, the repository's own top folder, and any git error or slow answer keep the block.
  
  A person who may unblock an action can now allow "Similar commands in this project" instead, where the workspace lets them (`override.patterns`: `person`, `needs_admin` or `off`; the hook reports the `pattern_allowances` capability): the allowance carries `match` (the rule, the action type, the recipe and its bounds) and never matches outside one folder of one project or repository, another rule, or an always-on protection.
  
  The policy schema now defines a rule's pattern recipes (`allow_patterns`: `path_prefix`, `path_glob`, `package_name`, `host`, `mcp_tool`) and the bounds of a pattern allowance (`allowance.match`), with checks that refuse any bound wider than one project folder or repository, a `..` or `.` segment, or a wildcard where a folder is named.
  
  The agent's block offers now carry `similar` (the words, an example it covers and one it does not, and whether it needs an admin), and `POST /blocked/answer` accepts `scope: "similar"` with a length.
  
  The tray's Unblock form shows "Similar commands in this project" beside "Just this command" where it is offered, with its words and examples, and names the result on its button ("Allow similar commands for 30 days").
- 07f7189: The hook now reads local rule packs that `rules.json` names (`"packs": { "local": [...] }`, paths relative to that file): they use the same format and engine as delivered packs, are checked the same way on every call (format, engine level, action types, every vector) without needing a signature (or with one by a key listed in `packs.trusted_keys`), only add rules (a delivered pack with the same id, grammar or MCP server comes first, and a local rule can neither reuse a rule id nor cover a type of call the policy does not), and are named by `packs list`, `status` and `doctor` when they are not used.
  
  `scopebond packs test <file|folder>...` now checks pack files as local packs and runs each vector through the engine, printing a pass/fail line per vector with what the hook would decide (allow, deny, ask) and the rule that matched; `--json` reports every result, and the command exits non-zero when a vector fails or a file is not a usable pack.
  
  The hook package now ships four general rule packs (`git-safety`, `secrets-hygiene`, `build-hygiene`, `ci-guard`) and an authoring guide in its `packs` folder.
  
  `validatePack(doc, { unsigned: true })` reads a local pack, whose `signature` may be left out.

## 0.11.2

### Patch Changes

- 8ed768b: A workspace may now ask for no reason to unblock an action or to ask an admin (`reason_min` 0, accepted by a hook that reports the `optional_reason` capability); an unblock with no reason is recorded with no reason digest and a reason length of 0, while a workspace minimum above 0 still requires a reason as before.
  The Scopebond window and the tray's form accept an answer with no reason where the workspace asks for none, and say a reason is optional.
  An override record with no reason (no digest, length 0) is now a valid receipt member.
  The receipt schema allows an override record with no reason: `reason_digest` null and `reason_length` 0.
- 09e5726: A response fetched with `curl`, `wget` or `iwr` and piped to an interpreter that is given its code another way (`| python -c "…"`, `| python -m json.tool`, `| node -e`, `| ruby -e`, `| perl -e`, `| php -r`, `| deno eval`, `| bun -e`, or a local script such as `| node script.mjs`) is no longer recorded as running a fetched script, since the fetched text is only data; a bare interpreter (`| python`, `| node -`) and a shell still are, also when the text reaches them through filters (`| tee log | bash`), and the install-detection vectors cover each case.
  
  A package runner's command arguments are no longer read as packages: `npx vite --port 4333`, `npx tsc -p tsconfig.json` and `pnpm dlx shadcn@latest add button` record only the command's package, `-y`/`--yes` after the command no longer marks the run as auto-confirmed, and every `-p`/`--package` before the command (or `--from`/`--spec` for `uvx` and `pipx run`) is recorded as a package of its own.
- a879854: Receipts now name the policy clause that matched and the bound that failed, and Monitor is silent in Cursor.
  
  - policy-schema: the receipt schema adds two optional payload members, `clause_id` and `failed_bound` (`<param>:<bound>`, never the param's value), with valid and invalid examples in `vectors/evidence-contract.json`; receipts without them are unchanged.
  - verify: a verdict that names a clause now also names the bound that failed (`failed_bound`), and among matching clauses of one mode it names the first by policy order; the conformance vectors check the bound too.
  - gateway: denied, monitored, held and overridden receipts carry `clause_id` and `failed_bound`, an allowed one carries neither, and `validateEvidencePayload` checks them.
  - hook: in Cursor, an action a monitored rule matches is now answered `allow` (recorded, with no approval prompt); `ask` is kept only for actions Scopebond could not evaluate or holds for a person.

## 0.11.1

### Patch Changes

- ca359b2: Package names and versions in an install are recorded as written. A long scoped name such as `@a-long-scope-name-20-lite/archetype` was masked as `@***`, so Safe Install could not check it by name, and a long repository path in an install URL broke the URL's host. Token shapes, URL credentials and parts that read like a key are still masked. New install-detection vectors cover long names, a key-like name and a URL with credentials.

## 0.11.0

### Minor Changes

- 40270e7: Safe Install: before a detected install runs, a hook connected to a workspace that offers the check asks it for a verdict (block, ask or allow, with reason codes and plain words) within the hook's deadline. A block denies with what was blocked and why; an ask uses the coding agent's own prompt (Claude Code in a mode that prompts, Cursor, GitHub Copilot) or, where the agent cannot ask, denies with how to go ahead; an allow goes on to the rules. Offline or late, the signed block list kept on the computer blocks what it names, earlier answers and a 7-day age gate apply, and anything else is asked about. The verdict, its reason codes and where it came from are signed into the install's receipt (`software.install` gains the optional `verdict`, `verdict_reasons` and `verdict_source` parameters). The gateway's dispatch reasons gain `install_refused`.

## 0.10.0

### Minor Changes

- e4ba261: Rule packs are delivered from a workspace: a rules check answer may name the packs a computer should hold, signed beside the rules, and the hook fetches each one from `/v1/packs/<id>@<version>`, checks its digest, signature and vectors, and keeps exactly the named packs (an empty list leaves none). The pack format gains grammar options for reading a command line the way a tool does (`path_options`, `strict_unknown`, `fallback_on_any_option`, `fallback_only_unread`, `double_dash`), the `unknown_option` condition and `positionals` past an unknown option. The first MCP profile whose words name a server owns its calls. `setBuiltinReaders` turns the built-in readers off for parity checks, `decomposeShell` is exported, and the built-in readers find tools through the shared launcher reader.

## 0.9.0

### Minor Changes

- a71186a: Add the rule-pack format, `scopebond:pack/v1`: signed data (never code) that carries command grammars, MCP profiles, `action_allowlist` rules and conformance vectors. `schema/pack.schema.json` is the closed schema, and the new `./pack` subpath exports `validatePack`, `packSigningInput` (Ed25519 over `scopebond:pack/v1` plus LF and the RFC 8785 canonical pack without its signature), `packRef` and `comparePackVersions`. `vectors/example-pack.json` is a public pack built from made-up tools and signed with a test-only key, and `vectors/pack-format.json` holds valid and invalid documents.
- 1af329c: Action Taxonomy 1.2 adds `software.install`: software a coding agent installs or runs from outside the project, by any route (package managers and runners, a script piped to a shell, a downloaded program, a cloned repository whose scripts run, a container image, an MCP server added to a tool's settings). It carries the route, ecosystem, verb, name, version, source URL and domain, and no verdict. `vectors/install-detection.json` holds the conformance cases for every route.

## 0.8.0

### Minor Changes

- d401d09: Records now carry an optional `context` saying where they were produced, so a workspace can group them by session and
  filter them by tool, model and repository. `schema/receipt.schema.json` adds `payload.context`: a closed object of
  `harness`, `harness_version`, `model`, `session_id`, `repository` (the git remote `origin` as `host/owner/name`) and
  `branch`, each optional and nullable. It carries no local paths, no credentials and no prompts, and the signature covers it. A
  receipt without it is unchanged; an unknown key inside it makes the receipt invalid. New: `RECEIPT_CONTEXT_KEYS`, the
  `receipt_context` cases in `vectors/evidence-contract.json` and a canonicalization vector for a context member.
  
  Compatibility: A receipt check older than this release (`@scopebond/gateway` `verifyReceipt` and `validateEvidencePayload` before this version, `npx @scopebond/gateway verify`, or an earlier hook's `scopebond verify`) reports a receipt that carries `context` as invalid, because the payload's key list is closed; `evidence_version` stays `1.0`. Verify such receipts with a release that knows `context`. (`@scopebond/verify`'s `verifyReceiptSignature` checks only the signature and key binding, so it verifies them in any version.)
- 6797bbd: Session budgets: limits on what one coding-agent session may do. New `schema/session-budgets.schema.json` describes the
  optional `session_budgets` member of a workspace rules document: closed budgets with `budget_id`, `scope: "session"`,
  `session_id` (the id receipts carry as `context.session_id`), `limits` (`{ operations, max }`, `0` for none), `mode`
  (`enforce` or `monitor`), `version`, `expires_at` and an optional `source`, in the gateway's action-budget words.
  `schema/receipt.schema.json` adds the optional, closed `payload.budget` (the budget, the action type counted, the count,
  the limit and the state). New exports: `sessionBudgetsSchema`, `SESSION_BUDGET_SCOPE`, `SESSION_BUDGET_DEFAULT_SECONDS`
  (two hours), `SESSION_BUDGET_MODES`, `SESSION_BUDGET_LIMITS`, `RECEIPT_BUDGET_STATES`, the `SessionBudget` types and
  `vectors/session-budgets.json`.
  
  Compatibility: a document without `session_budgets` and a receipt without `budget` are unchanged. A receipt check older
  than this release reports a receipt carrying `budget` as invalid (the payload's key list is closed); `evidence_version`
  stays `1.0`.
- ad9512d: Action Taxonomy 1.1 (`TAXONOMY_VERSION` is now `1.1`). New types for what a coding agent reaches through cloud, Kubernetes, database, deployment, secret, messaging and tracker tools: `cloud.resource.create`, `cloud.resource.modify` and `cloud.resource.delete` (`provider` aws, gcp, azure, cloudflare, vercel, fly, heroku, github or unknown; `service`, `kind`, `region`, `env`, `resource_digest`, `auto_approve`, `targeted`), `k8s.apply`, `k8s.delete` and `k8s.exec` (`context`, `namespace`, `kind`, `name_digest`, `all`), `db.migrate` (`provider`, `direction` up, down or reset, `env`, `migration_set_digest`), `db.exec` (`provider`, `verb`, `scope`, `risk`, `predicate_class`), `secret.write` (`store`, `name_digest`, `env`), `iam.change` (`provider`, `kind` role, policy, user, key, group or other, `name_digest`, `env`), `communication.send` (`provider`, `channel_digest`) and `work.item.create` / `work.item.update` (`provider`, `project_digest`). Every new type also takes `via`, `derived_from` and `risk_class`. Risk classes: deletes, `k8s.delete`, `k8s.exec` and `db.migrate` destructive, `iam.change` identity, `work.item.*` routine, the rest sensitive. The 1.0 types are unchanged; each action now carries the taxonomy version that introduced it (`1.0` or `1.1`). `vectors/action-taxonomy.json` has valid and invalid cases for every new type.

### Patch Changes

- 9c70fd6: Remove internal reference identifiers from comments and fixtures.

## 0.7.2

### Patch Changes

- 0929cac: Endpoint allowlists and denylists now compare the destination a request reaches, not the text of its host: another spelling of a listed address (decimal, octal, hex, IPv6, IPv4-mapped IPv6), a port on a host listed without one, or another loopback address for a listed loopback host is denied. The HTTP executor also refuses a name that resolves to a denied address, and records a call it refuses before sending as failed.

## 0.7.1

### Patch Changes

- 52502c3: The same action gets the same treatment in Claude Code, Codex and Cursor.
  
  - Cursor is answered `allow` only for a clean evaluated allow. An action a monitored rule finds out of policy now gets no
    opinion (`ask`), so Cursor's own approval decides, as Claude Code's and Codex's do when the hook stays silent.
  - A Cursor edit reported after it was written (`afterFileEdit`) that breaks a blocking rule is signed with the new execution
    state `observed_after` (`realtime_result: "deny"`, `executed: true`) instead of `denied`. `log` shows it as "recorded, not
    prevented", the tray and local counts keep it apart from blocks, and it is never counted as one. The gateway takes this as
    the `observedAfter` action option (nothing is dispatched and no override is asked); the receipt schema, evidence vectors
    and evidence check accept the new state.
  - The hook program answers deny on any failure the commands do not catch themselves (a module that cannot load, an uncaught
    error): Claude Code gets exit 2, Codex and Cursor their deny answer.
  - The Scopebond Agent checks the Codex and Cursor hook entries on each maintenance pass and keeps each outage (an entry that
    cannot start) as one `hook_unresolvable` delivery gap, which the rules check reports with the other gaps; `status` lists
    such outages apart from records that missed delivery.

## 0.7.0

### Minor Changes

- cb4d4e0: People may allow blocked actions for a while, or ask an admin. In the Scopebond window a person may choose **Allow once**,
  **Allow for 15 min**, **Always allow this here…** or **Ask an admin**, as the workspace allows. "For 15 min" and "always"
  leave a standing _allowance_ for the same action (the same type and parameters, whatever tool call it comes from): it is
  bound to one rule, expires (30 days by default), and never applies to Scopebond's own protection. A new rule mode, _Block,
  person may ask_, offers only **Ask an admin**: the action stays blocked and the request goes to the workspace, which answers
  with an allowance on the next rules check. The agent sends a person's allowances and requests to the workspace once, signed
  by the computer's enrolled key.

  The receipt of an action an allowance lets through carries `override.method: "allowance"`, with `repeat_of` naming the
  allowance and `reason_digest` the reason it was made with (receipt schema and `validateOverrideRecord`). The hook reports
  `x-scopebond-hook-capabilities: allowances` on its rules check, so a workspace sends the new mode and terms only to hooks that
  understand them.

  Also: the action key that recognises "the same action" leaves out the tool call's group size and position, so an earlier
  override's repeat window applies to the same command in any call.

  Review fixes before release: the floor check keeps a rule a person may only ask about blocking when another rule on the same
  action lets a person allow; the agent re-reads its files before writing, so an allowance or request the hook wrote during a
  send is kept; allowances and requests are signed over `scopebond:allowance/v1` and `scopebond:request/v1` domain lines;
  "Allow for 15 min" is offered only where the workspace sends the allowance terms; an older agent's "Allow once" on an
  ask-only rule becomes a request to an admin.

- e0f2de4: A session's heartbeat can be sent every five minutes instead of every minute, where the workspace says it reads the
  interval (`x-scopebond-heartbeat-interval-s` on the rules check). Each such heartbeat says so (`interval_s: 300`; the schema
  allows 60–900), and the workspace waits three intervals before calling a computer lost. A workspace that does not say gets
  heartbeats every minute without `interval_s`, as before. Heartbeats continue fifteen minutes after the last hook activity
  (it was ten), so an idle session still sends at least two.
- c877e45: Summary records. A signed `scopebond:summary` document (evidence class `summary`) stands in for many routine receipts when
  a computer sends its evidence: their number, an RFC 9162 root over the receipts it covers, counts by action type, result,
  program and working folder, and the actions repeated in the window. Every action keeps its own signed receipt; a denied,
  overridden, approved or timed-out action is never covered.

  - `@scopebond/policy-schema`: `summary.schema.json`, `summarySchema`, `SUMMARY_TYPE`, `SUMMARY_DOMAIN`, `SUMMARY_RESULTS`,
    `SUMMARY_LIMITS`.
  - `@scopebond/verify/summary`: `validateSummary`, `verifySummarySignature` (domain-separated, so a summary never passes as
    a receipt), `verifySummaryCoverage` (count, root, window, routine only, totals), `summaryRoot`, `summarySigningInput`.
  - `@scopebond/gateway`: `buildSummary` (signs with the receipts' key; at most 500 count lines, the rest folded by action
    type so the counts always add up), `isNotable` (the default test for what is always sent in full) and `repeatKey`.

## 0.6.0

### Minor Changes

- 433c8df: Warn mode. A workspace can set a rule to "Block, user may override": the hook then blocks a matching action until the person at the computer allows it once, with a reason, in the Scopebond Agent's window, or, where the workspace allows it and Claude Code's permission mode really asks the person, offers Claude Code's own prompt. Scopebond's own protection, rules on Block and the kill switch are never overridable; the workspace's daily limit and repeat window hold. The gateway takes an optional override handler on `handleAction` and signs an `override` record (rule, method, state, reason digest) into an approved receipt; `validateOverrideRecord` and the receipt schema define its exact shape.

## 0.5.0

### Minor Changes

- aac4f6f: Add the `scopebond:observation` v1 envelope: a closed JSON Schema (kind-specific data and typed operations), the domain-separated signing constants and `observationSigningInput`, and deterministic signature and hash vectors with negative cases. Receipts are unchanged.

### Patch Changes

- b08c8df: Every typed operation in the observation schema accepts an optional `approval_request_hash` (64 lowercase hex).

## 0.4.1

### Patch Changes

- f2e4d62: Canonicalization refuses malformed (lone-surrogate) strings instead of silently escaping them.

  `canonical()` serialized string values and object keys with `JSON.stringify`, which turns a lone UTF-16 surrogate into a `\udXXX` escape rather than rejecting it. RFC 8785 canonicalizes valid Unicode, and everything `canonical()` produces is signed — so a malformed string could enter a signature in a coerced form. It now throws `TypeError` on a lone surrogate (a high surrogate not followed by a low one, or an unpaired low surrogate) in any string value or key, consistent with how it already rejects non-finite numbers, sparse arrays and `undefined`. Valid surrogate pairs (astral characters) and ordinary non-ASCII text are unaffected.

## 0.4.0

### Minor Changes

- f212f82: Add a `force_push_guard` clause type. It denies a `git.push` that is a force-push to a protected branch (matched against `protected_refs`; glob, default `["main", "master", "release/*"]`), while still allowing ordinary pushes to those branches and force-pushes to feature branches. A force-push whose target ref cannot be resolved is denied (fail closed). This expresses a predicate a per-field `action_allowlist` bound cannot, since it must AND the `force` flag with a protected-ref set.

## 0.3.0

### Minor Changes

- ed6a822: Add Action Taxonomy v1 — the coding, GitHub, MCP and HTTP action types and their parameter bounds, as an extension of the policy vocabulary. `@scopebond/policy-schema` ships the machine-readable registry at `registry/actions-1.0.json` (exposed via the `./registry` subpath) with 11 action types (`shell.exec`, `file.read`, `file.write`, `git.push`, `package.install`, `net.fetch`, `http.call`, `mcp.tool.call`, `pr.open`, `pr.merge`, `deploy.release`), each declaring typed parameters, bound-ability, a risk class and emitting connectors. New exports: `actionRegistry`, `TAXONOMY_VERSION`, `getActionType(id)` and `validateActionParams(type, params)` (a structural parameter check — required present, declared parameters correctly typed; unknown types are reported, never silently allowed). Parameters are carried under `intent.params` and bound-able ones are constrained by an `action_allowlist` clause's `param_bounds`.

  `@scopebond/verify` adds taxonomy verdict conformance vectors (`vectors/taxonomy-verdicts.json`) proving the scalar bounds — enum, pattern, boolean-as-enum, omitted-parameter-denies — and the closed-allowlist deny of an unlisted action type, with no change to the `violates` engine. Array-parameter (e.g. `pr.*` `paths`) element-wise bounds are not yet expressible by `param_bounds` and await a separate vocabulary decision.

- 27be98a: Add element-wise array parameter bounds to `action_allowlist`. A param bound may now be `{ "items": <scalar bound>, "match": "all" | "any" }`, where `items` (`enum` / `min` / `max` / `pattern`) is applied to each element of an array parameter: `match: "all"` (default) requires every element to satisfy it, `match: "any"` requires at least one. This makes path policy expressible — e.g. deny a `pr.merge` whose `paths` touch `infra/prod/**` via `{ "paths": { "items": { "pattern": "^(?!infra/prod/).*" }, "match": "all" } }`.

  Fail-closed: a bounded array parameter that is absent or not an array denies; an empty array vacuously satisfies `match: "all"`. Array bounds are mutually exclusive with a top-level scalar bound, and `match` is only valid with `items` — enforced by `validatePolicy` and the JSON schema. Existing scalar bounds and policies are unchanged. Unblocks the GitHub App boundary connector's path-policy conformance.

- 973507f: Add signed boundary receipts. The evidence contract gains a `boundary` authorization mode — a clean representation for a receipt with **no agent signature**, where a gate attested a consequence and the identity is the receipt's boundary attribution (previously a boundary receipt would have had to misuse `insecure_development`). `@scopebond/policy-schema` adds the matching `authorization` variant to the closed receipt schema.

  `@scopebond/gateway` exports `buildBoundaryReceipt(input, attester)` — a reusable builder for any boundary-lane connector that constructs and signs a `boundary`-class receipt (gate, outcome_ref, attribution, the verdict and the pinned policy), mapping the verdict to an honest execution state (`deny` → `denied`, `allow` → `cooperative_allow`, `not_evaluated` → `observed_not_evaluated`, always `executed: false`).

  `@scopebond/github-action` uses it: with a signing key configured (`SCOPEBOND_ATTESTER_KEY`), the PR check emits a signed boundary receipt per PR head, verifiable offline, signed with the customer's own key in their runner. A `not_evaluated` (human) pull request emits none.

- 6417866: Add a `cooperative_allow` execution state to the receipt evidence contract. It records that an action was evaluated and allowed by policy but **not executed by the gateway** — the model for cooperative (M0 / check-only) enforcement, where the agent performs the action itself. Such a receipt is always `executed: false` with `external_effect: "not_independently_verified"`, so a cooperative allow is never labeled as executed. The verdict engine (`violates`) is unaffected: it evaluates the `executed` flag, not the execution state.
- 8ad0aab: Add the receipt evidence class: every receipt can carry an additive `evidence_class` of `signed_intent`, `pep_authorized` or `boundary`, so a verifier, the workspace and exports say how strong the evidence is without over-claiming.

  - `@scopebond/policy-schema` extends the closed `receipt.schema.json` with optional `evidence_class`, `principal` (required for `pep_authorized`) and `boundary` (`gate` ∈ merge/deploy/egress/platform_event, `outcome_ref`, `attribution` {kind: asserted|inferred, actor}; required for `boundary`), enforced by conditional schema rules, and exports `EVIDENCE_CLASSES`, `BOUNDARY_GATES`, `ATTRIBUTION_KINDS` and their types.
  - `@scopebond/gateway` tags its own signed-intent receipts explicitly, classifies legacy receipts at read time (`signed_intent` when an agent signature is present, else `pep_authorized`), and **never upgrades** an explicitly set class. `verifyReceipt` now reports `evidence_class` and rejects a receipt whose class-required fields are missing or whose foreign class fields are smuggled in. New exports: `classifyEvidenceClass`, `EVIDENCE_CLASSES`, `BOUNDARY_GATES` and the `EvidenceClass`/`BoundaryGate`/`BoundaryEvidence`/`PepPrincipal` types.

  The envelope is otherwise unchanged and receipts emitted before this field still verify. A boundary-receipt builder is intentionally left to the boundary connector that will consume it.

- 1260a51: Add signed PEP-authorized receipts, completing the three-class receipt model. The evidence contract gains a `pep` authorization mode — the honest representation for a receipt with **no agent signature** where a proxy/PEP decided a request carrying the caller's own identity; the identity is the receipt's `principal`. `@scopebond/policy-schema` adds the matching `authorization` variant to the closed receipt schema.

  `@scopebond/gateway` exports `buildPepReceipt(input, attester)` — a reusable builder for any M1/PEP connector (the MCP proxy, gateway interceptors). It constructs and signs a `pep_authorized`-class receipt (the normalized action, the principal, the verdict and the pinned policy), mapping the verdict to an honest execution state (`deny` → `denied`, `allow` → `cooperative_allow`, `not_evaluated` → `observed_not_evaluated`, always `executed: false`). Like the boundary class, it attests only that the PEP authorized the action for the principal — never agent non-repudiation.

## 0.2.0

### Minor Changes

- 875d640: Publish one strict canonical JSON implementation and use it for verifier hashes and signatures across the Scopebond packages.
- Load the schema documents through bundleable JSON modules so strict validation also runs in edge Workers.

## 0.1.0

### Minor Changes

- First public release: the Scopebond policy vocabulary JSON Schemas (policy document
  and `scopebond:receipt`) and the deterministic `scopebond-verify` verdict library —
  `violates(policy, receipts, claimed)` with full v1 clause coverage and the reference
  conformance vector suite. Published as the early open standard (spec + vectors)
  ahead of the proxy.
