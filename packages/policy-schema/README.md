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
  the product docs). Exposed at the `./registry` subpath, which also exports
  `actionRegistry`, `TAXONOMY_VERSION`, `getActionType(id)` and
  `validateActionParams(type, params)`. Parameters are carried under `intent.params`;
  bound-able ones are constrained by an `action_allowlist` clause's `param_bounds`.
- `src/canonical.ts` — the shared strict RFC-8785-target canonical serializer used
  by schema, verifier, gateway and SDK signature/hash boundaries.
- `vectors/action-taxonomy.json` — schema conformance (valid/invalid parameter
  payloads per action type) for `validateActionParams`.
- `vectors/evidence-contract.json` — shared execution-state, legacy/unknown-version
  and synthetic-secret cases used by Node, WebCrypto and offline verification tests.
- `vectors/canonicalization.json` — shared canonical-byte vectors used across packages.
- `vectors/observation-contract.json` — deterministic observation vectors: canonical
  bytes, `observation_hash`, Ed25519 signatures under a test-only public key, and
  negative cases (changed payload, wrong signer, missing domain, unknown field, unknown
  version, unknown event). No private key is published.
- `vectors/example-policy.json` — example policy input.

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
