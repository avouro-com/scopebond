# Scopebond receipt specification (v1)

**Status:** Stable draft · covers `@scopebond/policy-schema` evidence contract v1 · Apache-2.0

A Scopebond receipt is a countersigned, portable record of one decision a policy made
about one action an AI agent tried to take. It is the evidence half of Scopebond:
enforcement blocks an out-of-policy action before it runs, and a receipt records what was
decided so anyone can check it later — offline, with no account, no network, and no trust
in the signer's server.

This document is prose over the machine-readable source of truth. The normative schema is
[`packages/policy-schema/schema/receipt.schema.json`](packages/policy-schema/schema/receipt.schema.json);
the action taxonomy is [`packages/policy-schema/registry/actions-1.0.json`](packages/policy-schema/registry/actions-1.0.json);
the conformance vectors are in [`packages/policy-schema/vectors/`](packages/policy-schema/vectors/).
Where this prose and the schema disagree, the schema wins.

## What a valid signature proves — and does not

A valid signature proves two things about the receipt's payload:

- **Integrity** — the payload has not been altered since it was signed.
- **Provenance** — it was signed by the holder of the attester key identified in the receipt.

It supports those properties **for what the signer asserted**. It does **not** by itself prove:

- that any **external effect** occurred (`execution.external_effect` is always the constant
  `not_independently_verified`);
- that the record is **complete** (that every action was captured);
- **compliance** with any standard, framework or contract.

Scopebond keeps these distinctions explicit and never mixes evidence classes. A receipt is
evidence of a decision, not a certification.

## Envelope

A receipt is a JSON object with exactly two members:

```json
{ "payload": { … }, "signature": { "alg": "Ed25519", "sig": "<base64>" } }
```

The signature covers the **canonical serialization of the entire `payload`**. Receipts
v1 are signed with `Ed25519` by an attester of kind `gateway`, and that is the only
combination the reference verifiers accept. The schema also names `ES256`, `secp256k1` and
`EIP-712` signatures and `module` / `resource` attesters; these are **reserved** for later
versions, and a conforming v1 verifier reports a receipt that uses one as unsupported —
never as valid.

### Canonicalization

The target is **RFC 8785 (JSON Canonicalization Scheme)**: object keys sorted, no
insignificant whitespace, ECMAScript number serialization. `payload.canonicalization` is the
constant `"RFC8785"`. The current implementation uses a deterministic sorted-key serializer
that matches RFC 8785 for the values receipts contain; the canonicalization vectors
([`vectors/canonicalization.json`](packages/policy-schema/vectors/canonicalization.json))
pin the exact bytes for nested key order, number formatting and Unicode.

## Payload fields

| Field | Meaning |
|---|---|
| `type` | Always `scopebond:receipt`. |
| `evidence_version` | Always `1.0`. |
| `canonicalization` | Always `RFC8785`. |
| `intent` | The action the agent signed: `action_type` (see the taxonomy) plus optional `asset`, `amount`, `params`. |
| `intent_hash` / `action_ref` | `action_ref.authorized_intent_hash` and `evidence_intent_hash` (SHA-256 hex); `intent_hash` is a compatibility alias. `action_ref.action_id` is the stable idempotency key. |
| `policy_hash` / `policy_ref` / `policy_version` | The registered policy's digest, id and version the decision was made against. |
| `verifier_version` | The `violates()` verifier version that produced the verdict. |
| `realtime_result` | The decision: `allow`, `deny`, `approved`, `timeout`, or `not_evaluated`. |
| `executed` | Whether the gateway itself executed the action (see execution states). |
| `execution` | `{ state, assertion, reference, external_effect }` — see below. |
| `redaction` | `{ profile: "scopebond:minimized-intent/v1", paths }` — which fields were minimized before signing. Receipts carry no file contents, prompts or secrets. |
| `authorization` | The identity mode: `authenticated`, `insecure_development`, `boundary`, or `pep`. |
| `attester` | `{ kind: gateway\|module\|resource, kid }` — the countersigning key. |
| `timestamp` | RFC 3339 date-time. |
| `evidence_class` | `signed_intent`, `pep_authorized` or `boundary` (see below). Absent on legacy receipts; inferred at read time, never upgraded. |
| `principal` | Required for `pep_authorized`: the validated `{ subject, issuer }`. |
| `boundary` | Required for `boundary`: `{ gate, outcome_ref, attribution }`. |

### Execution states (`execution.state`)

| State | Meaning |
|---|---|
| `simulated` | The default no-op: the gateway simulated the action, did not perform it (`assertion: gateway_simulation`). |
| `observed_not_evaluated` | Recorded but not checked against a rule (`realtime_result: not_evaluated`). |
| `denied` | Blocked by policy before running. |
| `allowed_pending` | Allowed; execution outcome not yet resolved. |
| `cooperative_allow` | Allowed in cooperative (check-only) mode — the agent performs the action itself; the gateway did not execute it. |
| `executed` | The gateway executed the action (`executed: true`). |
| `failed` | Execution was attempted and failed. |
| `outcome_unknown` | An ambiguous result (e.g. an adapter timeout); never assumed successful. |

### Evidence classes and authorization modes

- **`signed_intent`** (`authorization.mode: authenticated`) — the agent cryptographically
  signed its intent; the strongest class.
- **`pep_authorized`** (`mode: pep`) — a policy-enforcement point decided a request that
  carried the caller's own identity; the receipt's `principal` is that validated identity.
- **`boundary`** (`mode: boundary`) — no agent signature: a gate (`merge`, `deploy`,
  `egress`, `platform_event`) attested a consequence; the receipt's `boundary.attribution`
  names the actor. This is what the GitHub required-check connector emits per pull-request head.
- **`insecure_development`** — a development-only mode with no agent authorization; never for
  production evidence.

## Action taxonomy v1

`intent.action_type` is one of the registered types (`taxonomy_version` 1.0). Bounds in a
policy apply to the `boundable` parameters of each action.

| `action_type` | Risk class | Summary |
|---|---|---|
| `shell.exec` | destructive | A shell command executed by a coding agent's harness. |
| `file.read` | sensitive | A file read by a coding agent. |
| `file.write` | destructive | A file write or edit by a coding agent. |
| `git.push` | destructive | A git push, derived from a shell command when unambiguous. |
| `package.install` | sensitive | A dependency installed by a coding agent. |
| `net.fetch` | sensitive | An outbound network fetch by a coding agent's tool. |
| `http.call` | sensitive | A governed HTTP action the gateway may dispatch or check. |
| `mcp.tool.call` | sensitive | A Model Context Protocol tool invocation routed through a proxy or client. |
| `pr.open` | sensitive | A pull request opened by an agent. |
| `pr.merge` | destructive | A pull request merge, gated before it can land. |
| `deploy.release` | destructive | A deployment or release to an environment, gated via OIDC. |

## Verifying a receipt

Verification is deterministic and offline — no network, no clock dependence, no account:

1. Canonicalize `payload` (RFC 8785).
2. Verify `signature.sig` over those bytes with the attester's public key (identified by
   `payload.attester.kid`), using `signature.alg`.
3. Confirm the payload validates against the schema (evidence version, required fields,
   the `evidence_class` ↔ `principal`/`boundary` and `execution.state` ↔ `executed`/`realtime_result`
   invariants the schema encodes).
4. Read the verdict from `realtime_result` and the execution semantics from `execution`.

Reference implementations:

```bash
npx @scopebond/gateway verify ./receipt.json         # verify a single receipt
scopebond-hook verify                                # verify every local receipt (hook)
```

`@scopebond/verify` exposes the deterministic `violates(policy, receipts, claimed)` verdict
library and its conformance suite, and — at `@scopebond/verify/signature` —
`verifyReceiptSignature(receipt, publicKey)`, which performs steps 1–2 plus the key-binding
check (`attester.kid` is derived from the key) with WebCrypto only, so the same bytes verify
in Node, browsers, Cloudflare Workers and offline. It accepts the attester key as SPKI PEM
or as an Ed25519 JWK.

## Anchors

An anchor commits to a prefix of a gateway's receipt log with a single Merkle root,
so a published root fixes exactly which receipts existed. The **log** is the
gateway's receipts in append order; a receipt's position in it (0-based) is its
stable sequence number and its **leaf index**. A store never reorders, removes or
inserts before existing receipts, and a gateway refuses to sign a new anchor when
the log no longer reproduces the previous anchor's root.

Anchors form a chain: each carries `prev_anchor_hash`, the `anchor_hash` of the
anchor before it (`null` for the first). Verifiers dispatch on `algo`.

### v1 — `sha256-merkle` (legacy)

Produced by earlier gateway releases; verifiers keep accepting it for existing
anchors. Fields: `seq`, `algo`, `merkle_root`, `count`, `from`, `to`,
`prev_anchor_hash`, `timestamp`, `anchor_hash`.

- Leaf: lowercase hex SHA-256 of the UTF-8 bytes of the canonical (RFC 8785) receipt `payload`.
- Node: lowercase hex SHA-256 of the UTF-8 bytes of the two child **hex strings** concatenated.
- An odd node at any level is paired with itself. The empty log is SHA-256 of the empty string.
- `anchor_hash`: hex SHA-256 of canonical(anchor without `anchor_hash`).

Weaknesses, stated plainly: leaves and interior nodes are not domain separated, so
an interior node can be presented as a leaf; duplicating the odd node means
different logs share a root (`[a,b,c]` and `[a,b,c,c]` produce the same root); the
anchor is **unsigned**, so anyone with write access to the store can rewrite
receipts and recompute every anchor to match; and the v1 proof endpoint reported
`included` computed by the server. A v1 anchor is evidence only as strong as the
integrity of the store it was read from, or of a copy published elsewhere.

### v2 — `rfc9162-sha256`

The Merkle Tree Hash of RFC 9162 §2.1 with SHA-256. For the log `D[n]` of receipt
payloads:

- Leaf input: the UTF-8 bytes of canonical(receipt `payload`) (RFC 8785) — the same
  bytes v1 hashes.
- Leaf hash: `SHA-256(0x00 ‖ leaf input)`.
- Node hash: `SHA-256(0x01 ‖ left ‖ right)` over the raw 32-byte child digests.
- `MTH({})` = `SHA-256("")`; `MTH({d0})` = leaf hash of `d0`; for `n > 1`, let `k`
  be the largest power of two **strictly smaller** than `n`, then
  `MTH(D[n]) = node(MTH(D[0:k]), MTH(D[k:n]))`. Nothing is duplicated.
- All digests are exchanged as 64-character lowercase hex.

A v2 anchor:

```json
{
  "type": "scopebond:anchor",
  "seq": 3,
  "algo": "rfc9162-sha256",
  "tree_size": 42,
  "root": "<hex MTH of the first tree_size receipts>",
  "prev_anchor_hash": "<anchor_hash of anchor seq 2 (v1 or v2), or null>",
  "timestamp": "2026-09-23T00:00:00.000Z",
  "attester": { "kind": "gateway", "kid": "key:…" },
  "anchor_hash": "<hex>",
  "signature": { "alg": "Ed25519", "sig": "<base64>" }
}
```

The **body** is the anchor without `anchor_hash` and `signature`. Let `B` be the
UTF-8 bytes of canonical(body) (RFC 8785). Then `anchor_hash` = hex `SHA-256(B)`,
and `signature.sig` is the standard-base64 Ed25519 signature over `B` by the
gateway attester key — the same key that countersigns receipts; `attester.kid` is
that key's fingerprint and must match the verifying key. The first v2 anchor's
`prev_anchor_hash` is the last v1 anchor's `anchor_hash`, so the chain continues
across the upgrade. After a v2 anchor, a v1 anchor in the same chain is invalid.

**Inclusion proof** (`GET /v1/anchors/proof?leaf=<leaf hash>|intent_hash=<h>[&anchor_seq=<n>]`)
returns `leaf_hash`, `leaf_index`, `tree_size`, `audit_path` (RFC 9162 §2.1.3.1
`PATH`, leaf level first, hex) and the signed `anchor`. The server does not assert
inclusion; the client verifies the anchor signature, takes `tree_size` and `root`
from the signed anchor, and runs the RFC 9162 §2.1.3.2 algorithm.

**Consistency proof** (`GET /v1/anchors/consistency?from=<seq>[&to=<seq>]`) returns
`first_size`, `second_size` and `proof` (RFC 9162 §2.1.4.1 `PROOF(m, D[n])`),
verified with §2.1.4.2 against the two signed roots; it shows the later anchor
extends the earlier one without rewriting it.

Reference implementation: `@scopebond/verify/anchor` (WebCrypto only):
`verifyInclusionProof`, `verifyConsistencyProof`, `verifyAnchorSignature`,
`verifyAnchorChain`, `verifyAnchorRoot`, `merkleTreeHash` and `merkleRootV1`.
Vectors: [`vectors/merkle-rfc9162.json`](packages/verify/vectors/merkle-rfc9162.json).

## Conformance vectors

Implementations should pass the shared vectors, which define the exact bytes and behavior:

- [`vectors/canonicalization.json`](packages/policy-schema/vectors/canonicalization.json) — canonical serialization.
- [`vectors/evidence-contract.json`](packages/policy-schema/vectors/evidence-contract.json) — realtime results, execution states, redaction, unsupported versions.
- [`vectors/action-taxonomy.json`](packages/policy-schema/vectors/action-taxonomy.json) — taxonomy verdicts.
- [`vectors/merkle-rfc9162.json`](packages/verify/vectors/merkle-rfc9162.json) — v2 anchor Merkle roots, inclusion and consistency proofs.

## Interoperability

A receipt is a self-contained, vendor-neutral artifact: it can be produced by any Scopebond
connector (hook, gateway, MCP proxy, GitHub Action) and verified by anyone with the payload
and the attester's public key. Scopebond aims to interoperate with other agent-receipt and
governance formats; contributions and interop reports are welcome.
