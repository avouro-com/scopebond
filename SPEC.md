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

## Conformance vectors

Implementations should pass the shared vectors, which define the exact bytes and behavior:

- [`vectors/canonicalization.json`](packages/policy-schema/vectors/canonicalization.json) — canonical serialization.
- [`vectors/evidence-contract.json`](packages/policy-schema/vectors/evidence-contract.json) — realtime results, execution states, redaction, unsupported versions.
- [`vectors/action-taxonomy.json`](packages/policy-schema/vectors/action-taxonomy.json) — taxonomy verdicts.

## Interoperability

A receipt is a self-contained, vendor-neutral artifact: it can be produced by any Scopebond
connector (hook, gateway, MCP proxy, GitHub Action) and verified by anyone with the payload
and the attester's public key. Scopebond aims to interoperate with other agent-receipt and
governance formats; contributions and interop reports are welcome.
