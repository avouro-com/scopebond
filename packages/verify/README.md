# @scopebond/verify

**License and hosting:** this package is free, Apache-2.0 open-source software.
Scopebond Cloud, the hosted shared workspace, is a separate proprietary service
and is not included in this package.

`scopebond-verify` — the deterministic, reproducible verdict library. The same
code runs in the gateway (real-time, single receipt) and during later review (over the
full receipt set). The reference `violates()` implementation and conformance
vectors make policy evaluation reproducible across integrations.

```js
import { violates, validateIntent, validatePolicy } from "@scopebond/verify";

validatePolicy(policy); // full, closed vocabulary-v1 document
validateIntent(intent); // closed action shape with finite numeric values
const v = violates(policy, receipts, claimed, { at, gatewaysComplete });
// → { violated, clause_id, explanation, inputs_hash, undetermined? }
```

`inputs_hash` uses the shared strict canonical serializer also used by gateway and
SDK signatures; cross-package vectors pin the resulting bytes.

## Guarantees

- **Pure & deterministic** — no network, no wall-clock. The evaluation timestamp
  is an input (`opts.at`, default `claimed.timestamp`), so a verdict reproduces
  bit-for-bit; `inputs_hash` commits to every input.
- **Only executed actions can violate.** A denied, non-executed action (enforce
  mode, prevented) is never a violation; a monitored action that executed over a
  limit is. The coverage buckets of the vocabulary (§4/§5) fall out of this rule.
- **Ambiguity resolves for the operator** — limits use strict `>`; exactly at the
  limit is allowed.
- **All applicable clauses are considered** — an enforcing violation outranks
  approval and monitor violations regardless of clause order.
- **Action allowlists are closed** — when present, an unlisted action violates
  the allowlist; bounded numeric and patterned values must have the required type.
- **`global` scope** returns `undetermined` (not `violated`) when the caller signals
  the cross-gateway receipt set is incomplete.

## Bounded prior history

A live evaluation does not need every receipt ever recorded: only `spend_limit` with a
`max_per_window`, `rate_limit` and `sequence` (with `min_gap` / `forbidden_within`) read
prior receipts, and each reads only a window ending at the evaluation time. Two exports
let a caller load just that much:

```js
import { historyNeed, boundPrior, violates } from "@scopebond/verify";

const need = historyNeed(policy);
// { kind: "none" }              no clause reads prior receipts
// { kind: "window", ms }        the longest window / sequence gap, in milliseconds
// { kind: "all" }               anything else (see below)
const v = violates(policy, boundPrior(need, receipts, at), claimed, { at });
```

- **`historyNeed(policy)`** is `none` when every clause is one that reads only the
  claimed action (`action_allowlist`, `require_approval`, `time_window`, the endpoint /
  address / contract lists, `key_policy`, `force_push_guard`); `window` with the largest
  `window` of a windowed `spend_limit` or `rate_limit` and the largest sequence gap
  (`max(min_gap, forbidden_within)`); and `all` for an invalid policy, a duration it cannot
  convert, or any other clause type — including `oracle_condition` and any type added
  later, so a new stateful clause cannot silently lose history. `scope: "global"` does
  not widen the window: a global clause is still windowed, and its scope only decides
  `undetermined`.
- **`boundPrior(need, receipts, at)`** is the bounded set, defined exactly: for `none`,
  no receipts; for `window`, every receipt in order except those whose timestamp parses to
  a time **at or before `at − ms`**; for `all`, every receipt. A receipt with an
  unparseable timestamp is kept. Envelopes (`{ payload, signature }`) are read through
  their payload.

**Same decision.** Windows are half-open — `rate_limit` / `spend_limit` count receipts in
`(at − window, at]` and `sequence` looks for a first action in `(at − gap, at]` — so a
receipt `boundPrior` drops can never be counted. Copies of one action (a reconciled
outcome) share its timestamp, so de-duplication sees all of them or none. For any prior
set whose executed receipts are well formed, `violated`, `clause_id`, `explanation` and
`undetermined` are identical with and without the bound; the test suite checks this for
every conformance and taxonomy vector, every verdict test, and randomized histories.
The one input the bound can change is a malformed executed receipt outside the window:
the `invalid executed receipt in policy input` check applies to the set passed in.

**`inputs_hash`.** `inputs_hash` commits to the receipts actually passed. A gateway
that bounds its history returns a verdict whose hash commits to `boundPrior(...)`, which
anyone can recompute from the same log, policy and `at`. No receipt records
`inputs_hash` — receipts carry `policy_hash`, `intent_hash` and `verifier_version` — so
claim-time verification over the full receipt set is unaffected.

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

## Receipt signatures (`@scopebond/verify/signature`)

```js
import { verifyReceiptSignature } from "@scopebond/verify/signature";
const result = await verifyReceiptSignature(receipt, attesterPublicKeyPemOrJwk);
// { valid, signature_valid, key_binding_valid, alg_supported, attester_kind_supported }
```

Verifies the attester's Ed25519 signature over the RFC 8785 canonical payload and checks
that `payload.attester.kid` is the key's derived id. WebCrypto only, no `node:` imports:
the same code runs in Node, browsers and Cloudflare Workers. Receipts v1 use `Ed25519`
from a `gateway` attester; other algorithms and attester kinds the schema reserves are
reported as unsupported, never valid. It never throws for a malformed receipt or key.

## Conformance suite

`vectors/conformance.json` is the reference vector suite (D27): every implemented
clause type across prevented / covered / ambiguity / refused cases. `pnpm test`
runs every vector through `violates()` and checks the verdict. A gateway build is
"Scopebond-compatible" only if it produces identical verdicts on this suite.

## Anchor verification (`@scopebond/verify/anchor`)

Verifies the gateway's receipt-log anchors with WebCrypto only (Node, browsers,
Workers). v2 anchors (`algo: "rfc9162-sha256"`) use the RFC 9162 Merkle tree and are
Ed25519-signed by the attester; legacy v1 anchors (`sha256-merkle`) still verify.

```js
import { verifyAnchorSignature, verifyInclusionProof, receiptLeafHash } from "@scopebond/verify/anchor";

await verifyAnchorSignature(anchor, attesterPublicJwk);
await verifyInclusionProof({
  leaf_hash: await receiptLeafHash(receipt.payload),
  leaf_index, tree_size: anchor.tree_size, audit_path, root: anchor.root,
});
```

Also: `verifyConsistencyProof`, `verifyAnchorChain`, `verifyAnchorRoot`,
`merkleTreeHash`, `inclusionProof`, `consistencyProof`, `merkleRootV1`. Exact
definitions: SPEC.md "Anchors"; vectors: `vectors/merkle-rfc9162.json`.

## Summary records (`@scopebond/verify/summary`)

A summary record (`type: "scopebond:summary"`, `evidence_class: "summary"`) stands in
for many routine receipts when a computer sends its evidence. Every action still has
its own signed receipt; the summary carries their number, an RFC 9162 Merkle Tree Hash
over their payloads' leaf hashes (taken in order of timestamp, then action id, so anybody
holding the receipts can recompute it), counts by action
type, result, program and working folder (a digest), and the actions repeated in the
window. It never covers a denied, overridden, approved or timed-out action: those are
always sent in full. The signature uses the receipts' key over
`"scopebond:summary/v1\n"` followed by the RFC 8785 canonical payload, so a summary can
never pass as a receipt. Schema: `@scopebond/policy-schema/summary.schema.json`.

```js
import { validateSummary, verifySummarySignature, verifySummaryCoverage } from "@scopebond/verify/summary";

validateSummary(summary);                                // closed shape and cross-field rules
await verifySummarySignature(summary, attesterPublicKey); // signature and key binding
await verifySummaryCoverage(summary, receipts);           // count, root, window, routine only, totals
```

Cross-field rules beyond the schema: the window does not end before it starts; the
counts add up to `receipt_count`; each repeat lies in the window and repeats at most
`receipt_count` times. Coverage also checks that every covered receipt lies in the
window, that none is a deny, override, approval or timeout, and that the totals per
action type and result match. Also: `summaryRoot`, `summaryOrder`, `summarySigningInput`.

## Evidence-chain heads and anchors (`@scopebond/verify/chain`)

A Scopebond workspace keeps one evidence chain per environment: a sequence number for
every record it admits, and evidence segments (compressed canonical JSON, each with a
Merkle root over its records' leaves) that name the digest of the segment before them.
Every delivery answer carries the chain's head: the newest sequence number and the newest
segment's digest and last sequence number, under an opaque `anchor_id` (a salted hash,
never a workspace name or id). The computer keeps these heads, and each day's newest head
per chain is published as a signed list in a public, append-only log. Heads held outside
the workspace are what make a deleted, truncated or re-chained segment visible: the
segment files alone can be rewritten into a chain that verifies.

```js
import { verifyAnchorList, checkChainHeads, verifySegmentChain } from "@scopebond/verify/chain";

await verifyAnchorList(list);                       // shape, key id, list and head signatures
checkChainHeads(keptHeads, list.heads);             // no chain goes back; one position, one segment
await verifySegmentChain(segmentTexts, keptHeads, { publicKey: computerKey }); // links, gaps, leaves, roots
```

A head is signed with Ed25519 over `"scopebond:chain-head/v1\n"` followed by the RFC 8785
canonical head; a list over `"scopebond:chain-anchors/v1\n"` followed by the canonical
list without `signed` and `signature`. The list publishes its key; the key id is `seg_`
plus the first 16 hex of SHA-256 over the base64 SPKI, so a changed key shows. A list or
head marked `signed: false` was published without a key: it can still be compared, but
does not show who published it. With `publicKey`, `verifySegmentChain` checks the
signature of every record and summary that names that key and counts the others (an
environment's other computers sign with their own keys). Also: `verifyChainHeadSignature`,
`isSignedChainHead`, `segmentKeyId`.

## Examples

Runnable end to end against a real gateway (asserted in CI by `pnpm run test:examples`):

- [`examples/verify-receipt-offline.mjs`](../../examples/verify-receipt-offline.mjs) —
  `verifyReceiptSignature` on a gateway receipt; a tampered copy fails.
- [`examples/verify-anchor-inclusion.mjs`](../../examples/verify-anchor-inclusion.mjs) —
  a signed v2 anchor and an inclusion proof verified offline; a wrong-index proof fails.

## `[PLANNED]`

- `oracle_condition` (best-effort external data) and active-key/list history inputs.
- Exact **RFC 8785 (JCS)** canonicalization for `inputs_hash` (currently a
  deterministic sorted-key serialization).
- Expanded vectors as the vocabulary grows.

## Types

Written in TypeScript; ships `.d.ts`. Public types include `Policy`, `Clause`,
`Receipt`, `Intent`, `Approval`, `Verdict`, `Options`, `HistoryNeed`, and
`ValidationResult`.

## Test

```
pnpm test   # tsc build, then node --test
```
