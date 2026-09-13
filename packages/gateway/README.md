# @scopebond/gateway

> **Experimental alpha:** use controlled test systems only. Open enforcement,
> authentication, concurrency, durability and sensitive-data findings must be
> resolved before production reliance. With no `executor` configured, allowed
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
- **Kill switch** — halt one or all agents instantly; while killed, everything is denied.

Clause modes: `enforce` blocks in real time; `monitor` lets the action through but
signs and flags it (covered at claim time); `require_approval` holds without a valid
approval.

## Quickstart

```bash
npx @scopebond/gateway ./policy.json      # serves on :8787
```

```bash
curl -sX POST localhost:8787/v1/evaluate \
  -H 'content-type: application/json' \
  -d '{"intent":{"action_type":"payout.create","asset":"USDC","amount":500000}}'
```

Routes: `POST /v1/evaluate`, `POST /mcp` (MCP ingress), `POST /v1/kill` · `/v1/resume`,
`GET /v1/receipts`, `GET /v1/status`, `GET /v1/attester`, `GET /.well-known/jwks.json`,
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
| `SCOPEBOND_ANCHOR_INTERVAL` | `24h` | anchor cadence (`24h`, `1h`, `30m`; `0`/`off` disables) |
| `SCOPEBOND_POLICY_WATCH` | `1` | hot-reload the policy file on change (`0` disables) |
| `SCOPEBOND_CLOUD_URL` | — | mirror receipts to a hosted control plane (e.g. `https://cloud.scopebond.com`) |
| `SCOPEBOND_CLOUD_KEY` | — | tenant API key (`sbk_…`) for the Cloud (required with the URL) |
| `SCOPEBOND_CLOUD_FLUSH_MS` | `15000` | Cloud export flush interval |

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
import { createGateway } from "@scopebond/gateway";
const { app, handleAction } = createGateway({ policy });
// app is a Hono app (serve it anywhere); handleAction(req) evaluates directly.
```

Swappable interfaces (D40 — an interface with a local implementation):
`ReceiptStore` and `Executor`. Node-only durable stores and the key loader live
under the `@scopebond/gateway/node` subpath (they use `node:fs` / `node:sqlite`):

```ts
import { loadOrCreateAttester, openReceiptStore } from "@scopebond/gateway/node";
const { attester } = loadOrCreateAttester({ file: "./scopebond-attester.key" });
const { store } = openReceiptStore({ db: "./scopebond.db" });
const { app } = createGateway({ policy, attester, store });
```

## `[PLANNED]`

- Push the anchor Merkle root to an external transparency log (Sigstore Rekor / chain).
- A Cloudflare **D1** edge receipt store (KV store is in) for the hosted path.
- Fuller MCP surface; MCP-passthrough executor.

## Test

```
pnpm test   # tsc build, then node --test (in-process via app.request)
```
