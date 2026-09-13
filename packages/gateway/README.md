# @scopebond/gateway

> **Experimental alpha:** use controlled test systems only. The constrained refund
> adapter demonstrates idempotency and result-query reconciliation; wider upstream
> coverage and distributed hosted coordination remain release gates. With no `executor` configured, allowed
> requests run the built-in simulation and are recorded as `simulated`, never
> `executed`.

The **Scopebond Gateway** — a policy-enforcement proxy that sits between an AI
agent and everything it can touch. One policy, three uses: **prevent · prove · pay**
(the gateway does prevent + prove). Built on [Hono](https://hono.dev) so the same
codebase runs on Node and Workers (ADR-004).

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

```bash
SCOPEBOND_PRINCIPAL_KEYS_FILE=./principal-keys.json SCOPEBOND_CONTROL_TOKEN=<random-24+-character-token> npx @scopebond/gateway ./policy.json
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
| `SCOPEBOND_CLOUD_KEY` | — | tenant API key (`sbk_…`) for the Cloud (required with the URL) |
| `SCOPEBOND_CLOUD_FLUSH_MS` | `15000` | Cloud export flush interval |

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

## Optional: mirror receipts to Scopebond Cloud

Set `SCOPEBOND_CLOUD_URL` + `SCOPEBOND_CLOUD_KEY` and the gateway keeps its local
durable log **and** pushes each receipt to a hosted control plane (retention,
dashboard, hosted verification) — **batched**, never per-request. Fully opt-in and
non-blocking; if the Cloud is unreachable it retries and never disrupts the gateway.
Get a free key + dashboard at [cloud.scopebond.com](https://cloud.scopebond.com).

## Tamper-evidence (anchoring)

The gateway periodically commits the receipt log to a **sha256 Merkle root** — an
"anchor" that fixes exactly which receipts existed, chained to the previous anchor so
the anchor log is itself tamper-evident. Anyone can prove a specific receipt is
covered with an **inclusion proof**, without seeing the others:

```bash
curl -sX POST localhost:8787/v1/anchor                 # anchor now (also runs on a timer)
curl -s "localhost:8787/v1/anchors/proof?intent_hash=<hash>"   # { merkle_root, proof, included }
```

`GET /v1/anchors` lists anchors; `GET /v1/anchors/latest` returns the newest.
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
