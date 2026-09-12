# @scopebond/gateway

The **Scopebond Gateway** — a policy-enforcement proxy that sits between an AI
agent and everything it can touch. One policy, three uses: **prevent · prove · pay**
(the gateway does prevent + prove). Built on [Hono](https://hono.dev) so the same
codebase runs on Node and Workers (ADR-004).

## What it does

- **Prevent** — evaluates each proposed action against your policy with
  `@scopebond/verify` in real time and **denies out-of-policy actions, failing closed.**
- **Prove** — countersigns every action into an **Ed25519-signed `scopebond:receipt`**
  and stores it (the receipt log / track record).
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
`GET /v1/receipts`, `GET /v1/status`, `GET /healthz`.

## Embed it

```ts
import { createGateway } from "@scopebond/gateway";
const { app, handleAction } = createGateway({ policy });
// app is a Hono app (serve it anywhere); handleAction(req) evaluates directly.
```

Swappable interfaces (D40 — an interface with a local implementation):
`ReceiptStore` (default in-memory; SQLite/D1 later) and `Executor` (default no-op
record; HTTP/MCP forwarding later).

## `[PLANNED]`

- Real action forwarding (HTTP proxy / MCP passthrough) executors.
- Durable receipt store (SQLite/D1) + daily anchoring.
- Persistent attester keys; policy hot-reload; fuller MCP surface.

## Test

```
pnpm test   # tsc build, then node --test (in-process via app.request)
```
