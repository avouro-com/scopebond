# @scopebond/policy-schema

The Scopebond **policy vocabulary** as machine-readable artifacts: the JSON Schema
for a policy document, the JSON Schema for the `scopebond:receipt` envelope, the
vocabulary constants, and test vectors. This is the contract that prevention,
evidence, and coverage all share — published before the proxy (D27).

## Contents

- `schema/policy.schema.json` — the policy document (closed schema: unknown clause
  types or fields make a policy invalid).
- `schema/action.schema.json` — the closed action-intent boundary used before
  hashing, evaluation or dispatch.
- `schema/receipt.schema.json` — evidence contract v1 for `scopebond:receipt`.
- `schema/receipt-legacy.schema.json` — the prior unversioned envelope, retained only
  for explicit compatibility handling.
- `src/index.ts` — loads the schemas and exports the policy and evidence constants.
- `vectors/evidence-contract.json` — shared execution-state, legacy/unknown-version
  and synthetic-secret cases used by Node, WebCrypto and offline verification tests.
- `vectors/example-policy.json` — example policy input.

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
