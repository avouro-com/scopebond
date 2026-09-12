# @scopebond/policy-schema

The Scopebond **policy vocabulary** as machine-readable artifacts: the JSON Schema
for a policy document, the JSON Schema for the `scopebond:receipt` envelope, the
vocabulary constants, and test vectors. This is the contract that prevention,
evidence, and coverage all share — published before the proxy (D27).

## Contents

- `schema/policy.schema.json` — the policy document (closed schema: unknown clause
  types or fields make a policy invalid).
- `schema/receipt.schema.json` — the `scopebond:receipt` (ACTA envelope; ADR-006).
- `src/index.mjs` — loads the schemas and exports `CLAUSE_TYPES`, `CLAUSE_MODES`,
  `REALTIME_RESULTS`, `COVERAGE_BUCKETS`, `VOCABULARY_VERSION`.
- `vectors/` — example policies (valid and, over time, invalid) used as conformance vectors.

## Status

Vocabulary v1 per the specification. The clause set and receipt envelope are
encoded; **conformance vectors are being filled in** — the target (per the spec
§11) is, for every clause type and mode, at least one prevented, one covered, one
refused, and one ambiguity case. `[PLANNED]` an `ajv`-based `validate()` helper and
the full vector suite shared with `@scopebond/verify`.

## Test

```
pnpm test   # tsc build, then node --test
```
