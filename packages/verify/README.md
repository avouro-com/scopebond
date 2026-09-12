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

## Implemented in this slice

`spend_limit` (per-action + windowed), `rate_limit`, `require_approval`,
`sequence`, `time_window`.

## `[PLANNED]`

- Remaining clause types: allowlists/denylists (endpoint, address, contract),
  `action_allowlist` param bounds, `oracle_condition`, `key_policy`.
- Active-key history input; `best_effort` list/oracle history.
- Exact **RFC 8785 (JCS)** canonicalization for `inputs_hash` (currently a
  deterministic sorted-key serialization).
- The full **conformance vector suite** (§11): every clause type and mode with a
  prevented, covered, refused, and ambiguity case, shared with `@scopebond/policy-schema`.
- TypeScript types (this slice ships typed JSDoc-friendly ESM).

## Test

```
node --test
```
