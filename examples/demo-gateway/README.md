# Demo gateway (Cloudflare Workers)

The open-source `@scopebond/gateway` deployed at the edge — the live demo behind
**https://try.scopebond.com**. Same core as `npx scopebond-gateway`, but signing
uses WebCrypto and state lives in Workers KV, so one codebase runs on Node and Workers.

- **Attester key** — generated once and persisted in KV (`attester:jwk`), so receipts
  are verifiable against a stable key across requests.
- **Receipts** — stored in KV (`KvReceiptStore`). Durable and light; for high volume
  use a D1-backed store.
- **Policy** — [`policy.json`](./policy.json): a `$10k` per-action cap (enforced) and a
  monitored `$50k/day` limit.

## Endpoints

`POST /v1/evaluate` · `POST /mcp` · `POST /v1/kill` · `POST /v1/resume`
`GET /v1/status` · `GET /v1/receipts` · `GET /v1/attester` · `GET /.well-known/jwks.json`

## Deploy

Runs from the `deploy-demo-gateway` GitHub Actions workflow (manual dispatch). It needs
the repo secret `CLOUDFLARE_SCOPEBOND_TOKEN` (Cloudflare API token with Workers Scripts,
KV, Workers Routes, and DNS edit). The workflow builds the packages, ensures the KV
namespace exists, injects its id, and runs `wrangler deploy`.

Locally (with your own account + `wrangler login`):

```bash
pnpm -r build
cd examples/demo-gateway
wrangler kv namespace create RECEIPTS   # put the id in wrangler.toml
wrangler deploy
```
