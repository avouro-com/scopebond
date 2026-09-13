# @scopebond/gateway

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
npx scopebond-gateway ./policy.json      # serves on :8787
```

```bash
curl -sX POST localhost:8787/v1/evaluate \
  -H 'content-type: application/json' \
  -d '{"intent":{"action_type":"payout.create","asset":"USDC","amount":500000}}'
```

Routes: `POST /v1/evaluate`, `POST /mcp` (MCP ingress), `POST /v1/kill` · `/v1/resume`,
`GET /v1/receipts`, `GET /v1/status`, `GET /v1/attester`, `GET /.well-known/jwks.json`,
`GET /healthz`.

On first run the gateway generates and persists an Ed25519 attester key
(`./scopebond-attester.key`, mode 0600) and a durable SQLite receipt store
(`./scopebond.db`), so **receipts stay verifiable and survive restarts**. Configure:

| Env | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | listen port |
| `SCOPEBOND_KEY_FILE` | `./scopebond-attester.key` | attester private key (PKCS8 PEM) |
| `SCOPEBOND_ATTESTER_KEY` | — | attester key inline (PEM), e.g. from a secret store |
| `SCOPEBOND_DB` | `./scopebond.db` | SQLite receipt store path |
| `SCOPEBOND_RECEIPTS_FILE` | — | use an append-only JSONL log instead of SQLite |

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

`verify` accepts a bare `scopebond:receipt` or a `/v1/evaluate` response. It checks
the **Ed25519 signature** and that the recorded **`intent_hash`** matches the intent
(tampering fails both). In code:

```ts
import { verifyReceipt } from "@scopebond/gateway";
const { valid } = verifyReceipt(receipt, publicKeyPem);
```

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

- Real action forwarding (HTTP proxy / MCP passthrough) executors — HTTP forwarding is in.
- Daily anchoring of the receipt log (tamper-evidence) + a Cloudflare D1/KV edge store.
- Policy hot-reload; fuller MCP surface.

## Test

```
pnpm test   # tsc build, then node --test (in-process via app.request)
```
