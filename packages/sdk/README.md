# @scopebond/sdk

Operator-side SDK: sign an agent's action intents (Ed25519) and submit them to a
Scopebond gateway. Zero dependencies (`node:crypto` + `fetch`).

```ts
import { createSigner, submit } from "@scopebond/sdk";

const agent = createSigner(); // or load a persisted PKCS8 privateKeyPem
const signed = agent.sign({ action_type: "payout.create", asset: "USDC", amount: 500000 });

const result = await submit("http://localhost:8787", signed);
// → { allowed, reason, receipt }  (the gateway's decision + countersigned receipt)
```

The SDK imports the same strict canonical serializer as the schema, verifier and
gateway, so signatures and intent hashes use identical bytes across packages.

- `createSigner({ privateKeyPem? })` generates or loads an Ed25519 key. Its `kid`
  is always derived from the public key and becomes `intent.signer`.
- `sign(intent, { requestId?, issuedAt?, expiresAt?, ttlMs? })` binds the exact
  intent digest, agent key, replay id and validity window in one envelope.
- `approve(intent, policyRef, options?)` creates a signed, single-use approval
  bound to the exact intent and active policy version/digest.
- `verifyIntentSignature(signed, publicKeyPem)` checks the signature, digest,
  signer and fingerprint-bound key id.
- `submit(gatewayUrl, signed, fetchImpl?)` preserves the full signed envelope.

The gateway rejects unsigned, expired, future, substituted and replayed
authorizations. Key rotation and hardware-backed signers remain planned.

## Test

```
pnpm test
```
