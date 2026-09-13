# Telemetry

The `scopebond-gateway` **CLI** can send anonymous, aggregate usage telemetry that
helps us see which features are used and prioritize development. It is built to be
trustworthy for a security tool: **no personal data, no secrets, no policy contents,
no receipts** — and it is easy to turn off.

## Opt out

Set either of these before starting the gateway:

```bash
SCOPEBOND_TELEMETRY=0        # also accepts: off, false, no
# or the cross-tool standard:
DO_NOT_TRACK=1
```

Telemetry is also **off entirely unless a telemetry key is configured** in the
build, and it is **never** sent by the embedded library (`createGateway`) — only by
the standalone `scopebond-gateway` server, and only **once at startup** (never per
request).

## What is sent

A single `gateway_start` event with:

| Field | Example | Why |
|---|---|---|
| `gateway_version` | `0.1.1` | adoption by version |
| `clause_types` | `["spend_limit","endpoint_allowlist"]` | which policy features are used — **types only** |
| `clause_count` | `3` | rough policy complexity |
| `store_kind` | `sqlite` | which receipt store is used |
| `node_version` | `v22.9.0` | supported-runtime signal |
| `platform` | `linux` | OS family |
| `distinct_id` | a random UUID | de-duplicate installs (see below) |

The `distinct_id` is a random UUID generated on first run and stored at
`~/.scopebond/telemetry-id`. It is not derived from anything about you or your
machine; delete that file to reset it.

## What is NEVER sent

- No policy `id`, clause ids, limits, thresholds, allowlist values, hosts, addresses,
  or any policy contents beyond the list of clause **types**.
- No receipts, intents, or the actions your agents take.
- No keys, secrets, tokens, or attester material.
- No IP address, hostname, username, file paths, or environment variables.
- Nothing per-request — only one event when the server starts.

## Where it goes

When enabled, the event is sent to Scopebond's analytics ingest over HTTPS. You can
point it elsewhere or inspect it with `SCOPEBOND_TELEMETRY_HOST`. The code is right
here — see [`src/telemetry.ts`](src/telemetry.ts).

Telemetry must never disrupt the gateway: sends are fire-and-forget with a short
timeout, and any failure is ignored.
