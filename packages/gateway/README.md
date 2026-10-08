# @scopebond/gateway

> **Experimental alpha:** use controlled test systems only. The constrained refund
> adapter demonstrates idempotency and result-query reconciliation; wider upstream
> coverage and distributed hosted coordination remain release gates. With no `executor` configured, allowed
> requests run the built-in simulation and are recorded as `simulated`, never
> `executed`.

The **Scopebond Gateway** is a free, Apache-2.0 open-source policy-enforcement
proxy for actions routed through its HTTP and MCP interfaces. It connects rules,
control, and signed decision evidence. Built on [Hono](https://hono.dev), it runs
on Node and Workers.

Scopebond Cloud, the hosted shared workspace, is a separate proprietary service;
it is not included in this package. You can self-host the gateway without a Cloud
account and optionally export configured records to a workspace.

## What it does

- **Prevent** — evaluates each proposed action against your policy with
  `@scopebond/verify` in real time and **denies out-of-policy actions, failing closed.**
- **Prove** — countersigns every action into an **Ed25519-signed `scopebond:receipt`**
  with a **persistent attester key**, stored in a **durable receipt log** (the track
  record). Anyone can verify a receipt against the attester's published public key.
- **Kill switch** — durable global or per-agent stops, checked again immediately before dispatch.

Clause modes: `enforce` blocks in real time; `monitor` lets the action through but
signs and flags it (covered at claim time); `require_approval` holds without a valid
approval.

Startup and policy reload require a complete vocabulary-v1 policy with a nonempty
clause set. Invalid reloads leave the last valid, cloned policy snapshot active.
Requests use the closed action schema; action allowlists deny unlisted action types,
and numeric bounds reject string or nonfinite values.

Passive onboarding discovery uses `POST /v1/observe`. It returns `202` with an
`observed_not_evaluated` receipt, never treats the action as allowed, and never
invokes the configured executor.

Every protected action and observation requires a short-lived Ed25519 authorization
from a registered agent key. The signed envelope binds the complete intent digest,
fingerprint-derived key id, request id and validity window. Optional approvals are
separately signed and bind the exact intent and active policy reference; both replay
ids are single-use. Receipts preserve this evidence for offline verification.

Every receipt also carries a stable action id. The in-memory and SQLite stores
atomically consume request and approval IDs and reserve shared budget before dispatch.
A signed `allowed_pending` lifecycle record is persisted before external I/O. Reserved,
dispatching and outcome-unknown actions remain charged conservatively across SQLite restarts. A
policy reload cannot change the snapshot named by an in-flight action. Global-scope
limits fail closed unless `gatewaysComplete: true` declares that the configured
coordinator owns the complete gateway set. Stores without atomic reservations
(including the JSONL and KV implementations) reject dispatch executors explicitly;
they remain suitable for simulation and passive observation.

## Quickstart

Scaffold a working key, key registry and starter policy, then follow the printed steps:

```bash
npx -y @scopebond/gateway@latest init
```

Or wire it up yourself with an existing policy and key registry:

```bash
SCOPEBOND_PRINCIPAL_KEYS_FILE=./principal-keys.json SCOPEBOND_CONTROL_TOKEN=<random-24+-character-token> npx -y @scopebond/gateway@latest ./policy.json
```

```bash
node examples/quickstart.mjs
```

Routes: `POST /v1/evaluate`, `POST /v1/observe`, `POST /mcp` (MCP ingress), `POST /v1/kill` · `/v1/resume`,
`GET /v1/receipts`, `GET /v1/actions/unresolved`, `POST /v1/actions/:actionId/reconcile`,
`GET /v1/status`, `GET /v1/attester`, `GET /.well-known/jwks.json`,
`POST /v1/anchor`, `GET /v1/anchors` · `/v1/anchors/latest` · `/v1/anchors/proof`,
`GET /healthz`.

On first run the gateway generates and persists an Ed25519 attester key
(`./scopebond-attester.key`, mode 0600) and a durable SQLite receipt store
(`./scopebond.db`), so **receipts stay verifiable and survive restarts**. It also
**anchors** the receipt log and **hot-reloads** the policy (below). These mechanisms
do not close the alpha findings described above. Configure:

| Env | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | listen port |
| `SCOPEBOND_KEY_FILE` | `./scopebond-attester.key` | attester private key (PKCS8 PEM) |
| `SCOPEBOND_ATTESTER_KEY` | — | attester key inline (PEM), e.g. from a secret store |
| `SCOPEBOND_DB` | `./scopebond.db` | SQLite receipt store path |
| `SCOPEBOND_RECEIPTS_FILE` | — | use an append-only JSONL log instead of SQLite |
| `SCOPEBOND_PRINCIPAL_KEYS_FILE` | required | JSON array of Ed25519 public keys and `agent`/`approver` purposes |
| `SCOPEBOND_CONTROL_TOKEN` | — | bearer token (minimum 24 characters) enabling receipt/lifecycle reads, reconciliation and kill/resume routes |
| `SCOPEBOND_UNSAFE_ALLOW_UNSIGNED` | — | set to `1` only for local simulation; receipts are marked `insecure_development` |
| `SCOPEBOND_ANCHOR_INTERVAL` | `24h` | anchor cadence (`24h`, `1h`, `30m`; `0`/`off` disables) |
| `SCOPEBOND_POLICY_WATCH` | `1` | hot-reload the policy file on change (`0` disables) |
| `SCOPEBOND_CLOUD_URL` | — | mirror receipts to a hosted control plane (e.g. `https://cloud.scopebond.com`) |
| `SCOPEBOND_CLOUD_CREDENTIAL` | — | scoped machine credential (`sbm_…`) returned once by Cloud gateway enrollment |
| `SCOPEBOND_CLOUD_FLUSH_MS` | `15000` | Cloud export flush interval |
| `SCOPEBOND_CLOUD_OUTBOX` | `<receipt path>.cloud-outbox.db` | durable SQLite delivery outbox |
| `SCOPEBOND_CLOUD_MAX_PENDING` | `10000` | maximum queued receipts before an explicit delivery gap |
| `SCOPEBOND_CLOUD_MAX_BYTES` | `67108864` | maximum queued canonical evidence bytes |
| `SCOPEBOND_CLOUD_MAX_AGE_MS` | `604800000` | maximum queued age (7 days) before an explicit delivery gap |
| `SCOPEBOND_CLOUD_MAX_GAPS` | `10000` | maximum retained gap-detail rows; the cumulative count remains monotonic |

`principal-keys.json` contains public material only. The gateway derives and checks
each `kid`; do not put private keys in this file:

```json
[
  {
    "public_key_pem": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----",
    "purposes": ["agent"],
    "status": "active"
  }
]
```

## Dispatch boundary: approvals, delegation and action budgets

`createGateway({ dispatchGuard })` (and the hook and MCP proxy, through the same guard) checks three things once per parent action, after policy has allowed it and immediately before it is dispatched. They are decided in one SQLite transaction (`dispatch.db`), so two processes cannot both take the last slot or the same approval, and a refusal spends nothing.

- **Single-use approval.** A `DispatchApproval` is signed by an approver key and binds the actor, action type, target, policy digest, `requestHash()` of the actual request (SHA-256 over `scopebond:dispatch-request/v1\n` plus the canonical request) and an expiry of at most five minutes. It is verified and consumed at the boundary; replay, a changed request, another actor, expiry or an unknown approver is rejected and nothing is dispatched. `signDispatchApproval` is the reference signer.
- **Delegation.** A child scope must be a subset of its parent (action types and targets; a target ending in `*` is a prefix) and end no later than it. Every action is checked against the whole chain for scope, expiry and revocation, so revoking a parent refuses its children on the next action. `DispatchStore.revoke` and `importRevocations` (add-only) feed the local list; syncing that list from a workspace is not automatic yet.
- **Action budgets.** An `ActionBudgetPolicy` (actor, operations, `installation` or `shared_gateway`, positive `max`, `window_seconds`, `monitor` or `enforce`, version, expiry, acknowledgement of its exact digest) counts dispatched parent actions, not paths or receipts, in a sliding window kept across processes. A retry of the same call (same `action_group`) does not use a second slot. Enforcement denies on an unacknowledged, expired or withdrawn policy, an unreadable counter, or a clock set behind the last time the store saw; monitor mode never denies and reports the state. A `shared_gateway` limit is refused unless a shared in-path gateway is configured (`sharedGatewayConfigured`): counters on independent installations are independent.

## Optional: mirror receipts to Scopebond Cloud

Create an organization/environment gateway enrollment in Cloud, prove possession of
this gateway's attester key, and set `SCOPEBOND_CLOUD_URL` plus the returned
`SCOPEBOND_CLOUD_CREDENTIAL`. The gateway stores locally first and queues canonical
evidence in a separate SQLite outbox. Exact action-ID retries are free, successful
batches are acknowledged by ID and content hash, and failures use bounded exponential
backoff. Queue count, bytes and age are bounded; overflow, conflicting IDs and expiry
produce explicit delivery-gap events instead of silent deletion. Cloud availability
never changes the local enforcement decision. The current hosted service is not ready
for customer enrollment; use the local/staging acceptance flow until its gates close.
Hosted export uses `node:sqlite` and therefore requires Node 22 or newer. Receipts from
before durable action IDs are retained locally and recorded as `missing_action_id`
delivery gaps rather than uploaded under an invented identity.

The customer workspace supplies a short-lived JSON enrollment bundle. Save it on the
gateway machine and complete possession proof with the same attester key the gateway
will use:

```bash
npx -y @scopebond/gateway@latest enroll https://cloud.scopebond.com scopebond-enrollment.json
```

The command refuses non-HTTPS remote origins, signs the canonical challenge locally,
and prints the scoped exporter credential only to that terminal. Keep the bundle and
returned credential out of URLs, chat, shell arguments and source control.

## Tamper-evidence (anchoring)

The gateway periodically commits the receipt log to an **RFC 9162 Merkle root** — an
"anchor" that fixes exactly which receipts existed, is **Ed25519-signed** by the
attester, and is chained to the previous anchor so the anchor log is itself
tamper-evident. Anyone can prove a specific receipt is covered with an **inclusion
proof**, without seeing the others, and verify it themselves:

Proofs are public by the receipt's leaf hash, which only someone holding the receipt can compute. A lookup by
`intent_hash` says whether an action happened, so it needs the control token.

```bash
curl -sX POST -H "authorization: Bearer $CONTROL_TOKEN" localhost:8787/v1/anchor   # anchor now (also runs on a timer)
curl -s "localhost:8787/v1/anchors/proof?leaf=<leaf-hash>"         # { leaf_index, tree_size, audit_path, anchor }
curl -s "localhost:8787/v1/anchors/consistency?from=1&to=2"    # the later anchor extends the earlier one
```

```js
import { verifyAnchorSignature, verifyInclusionProof, receiptLeafHash } from "@scopebond/verify/anchor";
const ok = await verifyAnchorSignature(p.anchor, attesterJwk) && await verifyInclusionProof({
  leaf_hash: await receiptLeafHash(receipt.payload), leaf_index: p.leaf_index,
  tree_size: p.anchor.tree_size, audit_path: p.audit_path, root: p.anchor.root,
});
```

`GET /v1/anchors` lists anchors; `GET /v1/anchors/latest` returns the newest. Anchors
written by earlier releases (`algo: "sha256-merkle"`, unsigned) keep verifying; the
first new anchor chains to the last of them. See SPEC.md "Anchors".
[PLANNED] pushing the root to an external transparency log (Sigstore Rekor / chain).

## Policy hot-reload

Edit `policy.json` while the gateway runs and it swaps the policy in without a
restart (recomputing the policy hash), **fail safe** — a malformed file is rejected
and the current policy stays in force. `POST`ing a policy over HTTP is deliberately
**not** supported (that would let anyone weaken enforcement); policy changes come
from the watched file or the authenticated hosted control plane.

## Prove it — verify a receipt

Every receipt is independently verifiable against the attester's public key — no
trust in the gateway required.

```bash
# against a running gateway (fetches its public key)
scopebond-gateway verify ./receipt.json --url http://localhost:8787

# fully offline, against a pinned public key
scopebond-gateway keygen ./scopebond-attester.key --out ./attester.pub.pem
scopebond-gateway verify ./receipt.json --key ./attester.pub.pem
```

`verify` accepts a bare `scopebond:receipt` or a `/v1/evaluate` response. Evidence
contract v1 checks the **Ed25519 signature**, authorized/minimized action references,
policy digest/version reference and supported version. Legacy unversioned receipts
remain verifiable but are labeled legacy. In every version, the signature proves
what the gateway attested; an adapter reference does not independently prove an
external effect. In code:

```ts
import { verifyReceipt } from "@scopebond/gateway";
const { valid } = verifyReceipt(receipt, publicKeyPem);
```

V1 receipts use explicit execution states: `simulated`, `observed_not_evaluated`,
`denied`, `allowed_pending`, `executed`, `failed`, and `outcome_unknown`. Before
signing, known credential fields are replaced with `[REDACTED]` and request bodies
with a SHA-256 digest plus byte length. Policy evaluation and a configured executor
still receive the original action; stores and exporters receive only the minimized,
signed receipt.

## Embed it

```ts
import { createGateway, StaticPrincipalKeyRegistry } from "@scopebond/gateway";
const keys = new StaticPrincipalKeyRegistry(principalKeyRecords);
const { app, handleAction } = createGateway({ policy, authentication: { keys } });
// app is a Hono app (serve it anywhere); handleAction(req) evaluates directly.
```

Swappable interfaces (D40 — an interface with a local implementation):
`ReceiptStore` and `Executor`. Node-only durable stores and the key loader live
under the `@scopebond/gateway/node` subpath (they use `node:fs` / `node:sqlite`):

```ts
import { loadOrCreateAttester, openReceiptStore } from "@scopebond/gateway/node";
const { attester } = loadOrCreateAttester({ file: "./scopebond-attester.key" });
const { store } = openReceiptStore({ db: "./scopebond.db" });
const { app } = createGateway({
  policy, attester, store, authentication: { keys },
  control: { bearerToken: process.env.SCOPEBOND_CONTROL_TOKEN! },
});
```

Each evaluation asks the store only for the history the policy can read: `executed(scope)`
and `reserveAction(reservation, decide, scope)` take a `PriorScope` — `none` (a policy of
allowlists and guards reads no history, so no query runs), `since` (a windowed
`rate_limit` / `spend_limit` / `sequence`; an ISO timestamp a day earlier than the window
start, compared as text) or `all`. A store may return more than the scope and the gateway
trims it with `boundPrior`, so a custom store that ignores `scope` stays correct, only
slower. `SqliteReceiptStore` answers `since` from an index on `receipts.timestamp`
(created on open), so the cost of a decision no longer grows with the log.

The replay check works the same way: a store that implements the optional
`authorizationUsed(kind, id, since)` answers whether a request or approval id was already
used with one lookup, within the time a still-valid authorization could have been used
(its lifetime plus the accepted clock skew). A store without it is read in full, as before.

`SqliteReceiptStore` keeps each policy once (actions reference it by digest), each receipt
once (a finished action points at its row), and no lifecycle row or candidate copy for an
action that finished without being dispatched. A new file uses 8 KiB pages and incremental
vacuum. `maintain(options)` does bounded upkeep: it rewrites a file from an earlier version
to this layout, removes finished authority records after a week, removes receipts a
delivery queue acknowledged before `retainAcknowledgedMs` (never one it did not, never in an
anchored log), and returns free pages; with `allowFullVacuum` it rewrites the whole file
once so an older file can shrink. `SqliteCloudOutbox` records each record the workspace holds
(`acknowledge(entries, held)`; a refused record is never in `held`) for that purpose, and keeps
its pending totals instead of counting the queue per record.

Two limits follow from removing old rows. Finished authority records are what the replay check
consults, so keep `stateRetentionMs` longer than your authorizations' `maxLifetimeMs` plus clock
skew (the defaults are seven days against five minutes). And a policy can only count history the
store still holds: retention keeps at least the window of the current policy, so if you later widen
a windowed limit beyond the retention, the first decisions under it see less history than the
window names.

### Constrained support refund adapter

`createSupportRefundExecutor` is the first narrow dispatch integration. It accepts
only `support.refund` with positive integer USD `amount`, bounded `ticket_id`,
`payment_id`, and normalized `reason_code` values. The operator supplies one HTTPS
origin and API token; the agent cannot choose a URL, path, method, headers, or raw
body. Redirects are disabled and the durable action ID becomes the upstream
`Idempotency-Key`. A read-only lookup by that key lets the gateway resolve a lost
response without issuing the refund again. An unavailable or inconclusive lookup
keeps `outcome_unknown` and its conservative authority hold.
Successful calls return only bounded `status`, `refund_id`, and `duplicate` fields;
the receipt retains a digest of the complete response.

```ts
import { createSupportRefundExecutor } from "@scopebond/gateway";

const executor = createSupportRefundExecutor({
  origin: "https://support.example.com",
  apiToken: process.env.SUPPORT_REFUND_TOKEN!,
});
const { app } = createGateway({
  policy, attester, store, executor, authentication: { keys },
  control: { bearerToken: process.env.SCOPEBOND_CONTROL_TOKEN! },
});
```

The configured hostname must also be constrained by deployment egress/private-DNS
controls; string validation cannot prevent DNS rebinding. Use a credential that can
create refunds only through this upstream endpoint and keep it unavailable to the
agent process.

Dispatch executors may implement a read-only `query({ actionId })` method returning
`executed`, confirmed `failed`, or `outcome_unknown`. The gateway queries after an
ambiguous dispatch exception and exposes unresolved records only through the control
API. Set `outboundExecution: false` when opening a restored store: new dispatch and
reconciliation network calls stay disabled until an operator has reviewed the state.

## `[PLANNED]`

- Push the anchor Merkle root to an external transparency log (Sigstore Rekor / chain).
- A Cloudflare **D1** edge receipt store (KV store is in) for the hosted path.
- Fuller MCP surface; MCP-passthrough executor.

## Test

```
pnpm test   # tsc build, then node --test (in-process via app.request)
```
