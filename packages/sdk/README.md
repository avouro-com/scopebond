# @scopebond/sdk

Operator-side SDK: sign an agent's action intents (Ed25519) and submit them to a
Scopebond gateway. Zero dependencies (`node:crypto` + `fetch`).

```ts
import { createSigner, submit } from "@scopebond/sdk";

const agent = createSigner({ kid: "key:my-agent" });   // or load a PEM
const signed = agent.sign({ action_type: "payout.create", asset: "USDC", amount: 500000 });

const result = await submit("http://localhost:8787", signed);
// → { allowed, reason, receipt }  (the gateway's decision + countersigned receipt)
```

- `createSigner({ privateKeyPem?, kid? })` — generates or loads an Ed25519 key;
  `kid` becomes `intent.signer` (used by `key_policy` clauses).
- `verifyIntentSignature(signed, publicKeyPem)` — round-trip verification.
- `submit(gatewayUrl, signed, fetchImpl?)` — POST to `/v1/evaluate`.

## `[PLANNED]`

- Gateway-side verification of the agent signature (the gateway currently
  countersigns; verifying the inbound agent signature is next).
- Key management helpers (rotation, hardware-backed keys).

## Test

```
pnpm test
```
