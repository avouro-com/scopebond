# @scopebond/verify

`scopebond-verify` — the deterministic, reproducible verdict library. The same
code runs in the gateway (real-time, single receipt) and at claim time (over the
full receipt set). **This is the moat-bearing artifact** (D27): whoever owns the
reference `violates()` and the vectors owns the definition of a scope violation.

```js
import { violates } from "@scopebond/verify";

const v = violates(policy, receipts, claimed, { at, gatewaysComplete });
// → { violated, clause_id, explanation, inputs_hash, undetermined? }
```

## Guarantees

- **Pure & deterministic** — no network, no wall-clock. The evaluation timestamp
  is an input (`opts.at`, default `claimed.timestamp`), so a verdict reproduces
  bit-for-bit; `inputs_hash` commits to every input.
- **Only executed actions can violate.** A denied, non-executed action (enforce
  mode, prevented) is never a violation; a monitored action that executed over a
  limit is. The coverage buckets of the vocabulary (§4/§5) fall out of this rule.
- **Ambiguity resolves for the operator** — limits use strict `>`; exactly at the
  limit is allowed.
- **`global` scope** returns `undetermined` (not `violated`) when the caller signals
  the cross-gateway receipt set is incomplete.

## Implemented

`spend_limit` (per-action + windowed, principal/global), `rate_limit`,
`require_approval`, `sequence`, `time_window`, `endpoint_allowlist` /
`endpoint_denylist`, `address_allowlist` / `address_denylist`,
`contract_allowlist`, `action_allowlist` (param bounds), `key_policy`.

### Intent shape conventions

Finalized alongside the gateway/SDK; used by the clause logic and the vectors:

- amount actions — `intent.asset`, `intent.amount`
- HTTP actions — `intent.params.host`, `.path`, `.method`
- on-chain actions — `intent.params.to`, `.chain_id`, `.contract`, `.selector`
- signing key — `intent.signer`

## Conformance suite

`vectors/conformance.json` is the reference vector suite (D27): every implemented
clause type across prevented / covered / ambiguity / refused cases. `pnpm test`
runs every vector through `violates()` and checks the verdict. A gateway build is
"Scopebond-compatible" only if it produces identical verdicts on this suite.

## `[PLANNED]`

- `oracle_condition` (best-effort external data) and active-key/list history inputs.
- Exact **RFC 8785 (JCS)** canonicalization for `inputs_hash` (currently a
  deterministic sorted-key serialization).
- Expanded vectors as the vocabulary grows.

## Types

Written in TypeScript; ships `.d.ts`. Public types: `Policy`, `Clause`, `Receipt`,
`Intent`, `Approval`, `Verdict`, `Options`.

## Test

```
pnpm test   # tsc build, then node --test
```
