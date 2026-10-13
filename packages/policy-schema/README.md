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
  `work.item.create|update`. Each action carries the taxonomy version that introduced it;
  the 1.0 types are unchanged. Exposed at the `./registry` subpath, which also exports
  `actionRegistry`, `TAXONOMY_VERSION`, `getActionType(id)` and
  `validateActionParams(type, params)`. Parameters are carried under `intent.params`;
  bound-able ones are constrained by an `action_allowlist` clause's `param_bounds`.
- `src/canonical.ts` — the shared strict RFC-8785-target canonical serializer used
  by schema, verifier, gateway and SDK signature/hash boundaries.
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
default, `SESSION_BUDGET_DEFAULT_SECONDS`) and optionally `source` (`request` or `admin`).
The rules-document check reads only the members it knows, so a hook that predates session
budgets ignores the member; a hook that knows it refuses a document whose list is malformed.
`vectors/session-budgets.json` holds valid and invalid lists.

A receipt a session budget counted or refused carries the optional, closed `payload.budget`:
`version`, `scope`, `budget_id`, `budget_version`, `mode`, `operation`, `count` (with this
action), `max` and `state` (`within`, `at_limit`, `over`, `expired` or `unavailable`,
`RECEIPT_BUDGET_STATES`). As with `context`, a receipt check older than this release reports a
receipt carrying it as invalid.

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
