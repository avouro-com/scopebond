# @scopebond/policy-schema

**License and hosting:** this package is free, Apache-2.0 open-source software.
Scopebond Cloud, the hosted shared workspace, is a separate proprietary service
and is not included in this package.

The Scopebond **policy vocabulary** as machine-readable artifacts: the JSON Schema
for a policy document, the JSON Schema for the `scopebond:receipt` envelope, the
vocabulary constants, and test vectors. This is the contract that prevention,
evidence, and coverage all share.

## Contents

- `schema/policy.schema.json` — the policy document (closed schema: unknown clause
  types or fields make a policy invalid).
- `schema/action.schema.json` — the closed action-intent boundary used before
  hashing, evaluation or dispatch.
- `schema/receipt.schema.json` — evidence contract v1 for `scopebond:receipt`.
- `schema/receipt-legacy.schema.json` — the prior unversioned envelope, retained only
  for explicit compatibility handling.
- `schema/observation.schema.json` — the closed `scopebond:observation` v1 envelope
  and its kind-specific data union (session, capability, health, policy acknowledgement,
  tool intent/outcome, platform outcome, verification, integrity, export), the typed
  operation union and the signed wrapper/batch shapes. It is separate from the receipt:
  receipts, their canonicalization and their signatures are unchanged.
- `src/index.ts` — loads the schemas and exports the policy and evidence constants.
- `registry/actions-1.0.json` — Action Taxonomy v1: the coding, GitHub, MCP and HTTP
  action types and their parameter bounds (machine source; the human index lives in
  the product docs). Taxonomy 1.1 (`TAXONOMY_VERSION`) adds the types a coding agent
  reaches through cloud, Kubernetes, database, deployment, secret, messaging and tracker
  tools: `cloud.resource.create|modify|delete`, `k8s.apply|delete|exec`, `db.migrate`,
  `db.exec`, `secret.write`, `iam.change`, `communication.send` and
  `work.item.create|update`. Taxonomy 1.2 adds `software.install`: software an agent installs or
  runs from outside the project (a package, a script fed to a shell, a downloaded program, a cloned repository, a
  container image or an MCP server), with its route, ecosystem, name, version and source, and no verdict. Each action
  carries the taxonomy version that introduced it;
  the 1.0 types are unchanged. Exposed at the `./registry` subpath, which also exports
  `actionRegistry`, `TAXONOMY_VERSION`, `getActionType(id)` and
  `validateActionParams(type, params)`. Parameters are carried under `intent.params`;
  bound-able ones are constrained by an `action_allowlist` clause's `param_bounds`.
- `schema/pack.schema.json` and `src/pack.ts` — the closed rule-pack format (`scopebond:pack/v1`):
  command grammars, MCP profiles, rules and vectors, signed as data (see "Rule packs"). Exposed
  at the `./pack` subpath: `validatePack`, `packSigningInput`, `packRef`, `comparePackVersions`.
- `src/canonical.ts` — the shared strict RFC-8785-target canonical serializer used
  by schema, verifier, gateway and SDK signature/hash boundaries.
- `vectors/install-detection.json` — install detection conformance: coding-agent requests on every route and the
  exact `software.install` actions each must derive.
- `vectors/action-taxonomy.json` — schema conformance (valid/invalid parameter
  payloads per action type) for `validateActionParams`.
- `vectors/evidence-contract.json` — shared execution-state, legacy/unknown-version
  and synthetic-secret cases used by Node, WebCrypto and offline verification tests,
  and the receipt-context cases (valid and invalid `payload.context` objects).
- `vectors/canonicalization.json` — shared canonical-byte vectors used across packages.
- `vectors/observation-contract.json` — deterministic observation vectors: canonical
  bytes, `observation_hash`, Ed25519 signatures under a test-only public key, and
  negative cases (changed payload, wrong signer, missing domain, unknown field, unknown
  version, unknown event). No private key is published.
- `vectors/example-policy.json` — example policy input.

## Receipt context

A receipt's payload may carry an optional `context` object describing where the receipt
was produced, so a workspace can group records by session and filter them by tool, model
and repository. It is a closed object: an unknown key inside it makes the receipt invalid,
like an unknown key anywhere else in the payload. Every member is optional and may be
`null` when the connector does not know it. A receipt without `context` is unchanged.

| Member | Type | Meaning |
|---|---|---|
| `harness` | string, `^[a-z][a-z0-9-]{0,39}$` | The connector or coding tool that produced the receipt, for example `claude`, `cursor`, `codex`, `copilot` or `gateway`. |
| `harness_version` | string, at most 64 | The version that tool reports, when it reports one. |
| `model` | string, at most 128 | The model id that tool reports, when it reports one. |
| `session_id` | string, 1–200 | An opaque session id the connector assigns. Never the tool's own raw session id. |
| `repository` | string, at most 200 | The git remote `origin` as `host/owner/name`: lowercase host, no scheme, no credentials, no `.git`, no dot segments (`.`, `..`, `%2e…`). Never a local path. |
| `branch` | string, at most 200 | The current branch, when known. |

`context` carries no local paths, no credentials and no prompts (`branch` is the name a
person chose for it) and is covered by the signature like the rest of the payload: it sorts under RFC 8785 like
any other member (`vectors/canonicalization.json`, `receipt-context-member-order`).
`RECEIPT_CONTEXT_KEYS` lists the members.

A receipt check older than this release (`@scopebond/gateway` `verifyReceipt` and
`validateEvidencePayload` before this version, `npx @scopebond/gateway verify`, or an
earlier hook's `scopebond verify`) reports a receipt that carries `context` as invalid,
because the payload's key list is closed; `evidence_version` stays `1.0`. Verify such
receipts with a release that knows `context`. (`@scopebond/verify`'s
`verifyReceiptSignature` checks only the signature and key binding, so it verifies them
in any version.)

## Session budgets

`schema/session-budgets.schema.json` is the `session_budgets` member a workspace may add to the
rules document it sends a hook: limits on what one coding-agent session may do, in the gateway's
action-budget words. Each budget is a closed object: `budget_id`, `scope` (`"session"`),
`session_id` (the opaque id receipts carry as `context.session_id`), `limits` (each
`{ operations, max }`: at most `max` tool calls with an action of those types, `0` for none),
`mode` (`enforce` or `monitor`), `version`, `expires_at` (two hours after it is set by
default, `SESSION_BUDGET_DEFAULT_SECONDS`; after it the budget no longer applies) and optionally `source` (`request` or
`admin`) and `count_shell_as_write` (count other shell commands as file writes; off by default).
The rules-document check reads only the members it knows, so a hook that predates session
budgets ignores the member; a hook that knows it refuses a document whose list is malformed.
`vectors/session-budgets.json` holds valid and invalid lists.

A receipt a session budget counted or refused carries the optional, closed `payload.budget`:
`version`, `scope`, `budget_id`, `budget_version`, `mode`, `operation`, `count` (with this
action), `max` and `state` (`within`, `at_limit`, `over` or `unavailable`,
`RECEIPT_BUDGET_STATES`). As with `context`, a receipt check older than this release reports a
receipt carrying it as invalid.

## Matched clause

A receipt whose action a clause denied, recorded under monitor, held for approval or a person
overrode names the clause in the optional `payload.clause_id`, and the bound of it that failed
in the optional `payload.failed_bound` (`<param>:<bound>`, `RECEIPT_FAILED_BOUND_PATTERN`:
`program:pattern`, `path:pattern`, `amount:max_per_action`). The bound names the param, never
its value. `failed_bound` appears only with `clause_id`, and both only with a `realtime_result`
of `deny`, `approved` or `timeout` (`RECEIPT_MATCH_RESULTS`); an allowed action carries neither.
When several clauses matched, `clause_id` names an enforced clause first, then one that needs
approval, then a monitored one, and among clauses of one mode the first by policy order.
Receipts without them are unchanged. `vectors/evidence-contract.json` (`receipt_match`) holds
valid and invalid examples.

## Plugin slot

A hook that loaded a signed plugin may sign what it gave an action into two optional members:
`payload.pattern_id` (64 lowercase hex, `RECEIPT_PATTERN_ID_PATTERN`) and `payload.intel`, an
opaque slot of standard padded base64 carrying 1 to 4096 bytes (`RECEIPT_INTEL_PATTERN`,
`RECEIPT_INTEL_MAX_BYTES`, `RECEIPT_INTEL_MAX_LENGTH`). What the slot holds is not described:
the open code stores it, covers it with the signature and verifies it as bytes.
`isReceiptIntel` and `isReceiptPatternId` check the shapes. A receipt made without a plugin
carries neither and is unchanged. `vectors/evidence-contract.json` (`receipt_intel`) holds
valid and invalid examples. A receipt check older than this release reports a receipt carrying
them as invalid.

## Observation envelope

An observation is signed as Ed25519 over the UTF-8 bytes of the literal domain
`scopebond:observation/v1` followed by one LF byte, then the RFC 8785 canonical payload
(`observationSigningInput`). `observation_hash` is the SHA-256 of those bytes, as 64
lowercase hex characters. The wire wrapper is
`{ "payload": …, "signature": { "alg": "Ed25519", "kid": "…", "value": "<unpadded base64url>" } }`
with no other keys. `source_receipt_hash` is the SHA-256 of `scopebond:source-receipt/v1`
plus LF plus the canonical **full signed receipt envelope**.

The schema fixes shape and closedness; there are no free-form or raw-content fields.
A verifier also enforces these cross-field rules: repeated `session_id`,
`installation_generation`, `sequence`, `parent_action_id` and `source_receipt_hash`
must equal the envelope; a `tool_intent` `request_digest` must equal its operation's;
integrity results must agree with their hashes (`unavailable` never carries an actual
hash); and each typed operation obeys its own field rules (for example `outside_root`
only when a file path is resolved). Limits: at most 100 observations per batch, 16 KiB per
observation and 1 MiB per request. An observation is evidence of its source's assertion,
not proof of an external effect; the receiving service derives tenant and agent identity
from the credential, never from the payload.

## Rule packs

A rule pack (`scopebond:pack/v1`, `schema/pack.schema.json`, `src/pack.ts`) is signed
data that teaches an engine what a command-line tool or an MCP server does. It is never
code: every operator in it is one of a closed set, and an engine refuses a pack with an
unknown field or operator as a whole.

```json
{
  "format": "scopebond:pack/v1",
  "id": "example", "version": "1.0.0", "issued_at": "2026-10-01T00:00:00Z",
  "title": "optional",
  "signature": { "alg": "Ed25519", "key_id": "…", "value": "<base64>" },
  "grammars": [], "profiles": [], "rules": [], "vectors": []
}
```

- **Grammars** read one tool's command line: `programs` (canonical names; also read
  through package runners such as `npx` or `uv run` unless `launchers` is false), the
  options it knows (`options.valued`, `options.flags`), what an unknown option does
  (`unknown_options`: `uncertain`, positionals after it are not trusted, or `stop`; with
  `strict_unknown`, an unknown `--name=value` ends the trusted positionals too), which options
  may stand before a command's path (`path_options`: `known` ones only, or `none`), whether
  the words after `--` are positionals (`double_dash`), help and dry-run forms that derive
  nothing (`skip`), and `commands`. A command matches a
  `path` of subcommand words (a literal word, `any`, `not`, `pattern`, `optional`, or
  `skip` up to n words, each optionally bound to a `var`), an optional `when`
  condition and `max_positionals`, and `emit`s taxonomy actions. The first command that
  matches decides (an empty `emit` derives nothing). When nothing is derived and an
  option the grammar does not know was seen, the first `fallback` whose condition holds
  derives its actions with no names, so an option before the subcommand cannot hide it
  (`fallback_on_any_option`: any option lets it run; `fallback_only_unread`: only when no
  command's path matched).
- **Profiles** say which MCP servers (by the words of the configured server name, or of
  its URL or launch command) and which tools perform which actions.
- **Parameters** are expressions with one operator each. Sources: `const`, `flag`,
  `flags`, `present`, `positional`, `positionals` (`past_unknown` reads on past an unknown
  option), `any_positional`, `word_after`,
  `words_after`, `assign` (the command's own `NAME=value` prefix), `arg_assign`, `var`,
  `item` (in `for_each`), `tool`; local facts an engine may not have (`env_var`,
  `file_sha256`, `dir_sha256`, `file_text`, `dir_sql`, `config_value`); MCP arguments
  (`arg`, `arg_list`, `arg_items`, `server`). Transforms: `env_of`, `env_class`, `ident`,
  `literal`, `digest`, `digest_list` (keyed digests; names are never recorded in the
  clear), `host_of`, `match`, `replace`, `lower`, `upper`, `map`, `first`, `concat`,
  `join`, `sorted`, `count`, `split`, `scrub`, `sql` (the open SQL classifier's verb,
  predicate class or risk, never the text) and `if`. Conditions: `has`, `word`,
  `defined`, `eq`, `in`, `matches`, `all`, `any`, `not`, `count`, `unknown_option`. A value that cannot be
  read is left out, never guessed. The engine adds `via` and `derived_from` to every
  action; a pack cannot set them, and cannot emit `shell.exec` or `mcp.tool.call`.
- **Rules** are `action_allowlist` clauses of the policy language, exactly as
  `policy.schema.json` defines them.
- **Vectors** are inputs (a shell command, or an MCP server, tool and arguments) and the
  exact actions the pack must derive. An expected `{ "digest_of": [...] }` stands for the
  engine's keyed digest of those parts. Every engine runs a pack's vectors before it
  trusts the pack, and in its own CI.

**Signing.** Ed25519 over the UTF-8 bytes of `scopebond:pack/v1`, one LF, then the RFC 8785
canonical pack without its `signature` member (`packSigningInput`), with a policy-signing
key. Patterns are limited to 200 characters, must pass the shared pattern check (`./pattern`:
`patternProblem` refuses back-references, look-behind and every shape that can backtrack
catastrophically), and run only on words cut to 512 characters. `validatePack` checks the shape and the
cross-field rules (unique ids, no program read by two grammars, registered action types,
command-line operators only in grammars and MCP ones only in profiles); the signature is
the engine's to verify.

**Engine levels.** The format grows only by adding fields, and each addition raises the
engine level (`PACK_ENGINE_LEVEL`, now 2). Level 2 adds `requires: { engine, action_types? }`
on the pack and, on a rule, `title` (at most 80 characters), `blockable` (the rule may
block; it needs `param_bounds`), `default_mode` (`monitor` or `block`, block only when
blockable), `safer_way` (at most 160 characters, a hint for the coding agent) and
`allow_patterns` (`{ id, title, param, kind }`, kind one of `path_prefix`, `path_glob`,
`package_name`, `host`, `mcp_tool`). A pack that uses a level-2 field says
`requires.engine: 2`; an engine that predates level 2 reads such a field as unknown and
refuses that pack alone. `packEngineProblem` says why an engine cannot run a valid pack
(`engine_too_old`, or `unknown_action_type` for a type `requires.action_types` names that
it does not know); `validatePack(doc, { engine: 1 })` reads a pack as a level-1 engine does. `validatePack(doc, { unsigned: true })` reads a
local pack, whose trust root is the policy that names it: its `signature` may be left out.

**Taxonomy extensions.** `scopebond:taxonomy-ext/v1` (`src/taxonomy-ext.ts`, at the
`./taxonomy-ext` subpath) adds action types as signed data:
`{ format, issued_at, types: [{ action_type, params: { name: "string" | "number" | "boolean" }, mutating, target_opt_in }], signature }`,
signed like a pack over `scopebond:taxonomy-ext/v1`, one LF, then the canonical document
without `signature`. An extension never redefines a built-in type. `getActionType` reads
the extension in force (`setActionTypeExtension`) after the built-in registry.

`vectors/example-pack.json` is a small public pack built from made-up tools
(`test/build-example-pack.mjs`), signed with a test-only key whose private half is derived
from a published phrase (`vectors/example-pack-key.json`); nothing trusts it outside
tests. `vectors/pack-format.json` holds valid and invalid documents.

## Status

Vocabulary v1 per the specification. The evidence schema distinguishes simulations,
observations, denials, pending actions, reported execution, failures and unknown
outcomes. It fixes the policy/action references and redaction profile inside the
signed payload and states that external effects are not independently verified.
The policy conformance vectors remain in `@scopebond/verify`. That package exports
runtime policy and action validators and uses these schemas before a verdict is
computed; Cloud ingestion applies its separate receipt boundary.

## Test

```
pnpm test   # tsc build, then node --test
```
