// Verify a receipt offline, exactly as a browser or Cloudflare Worker would.
//   1. Issuer side (Node): the gateway decides an action and countersigns a receipt.
//   2. Verifier side: `@scopebond/verify/signature` checks the Ed25519 signature over the
//      RFC 8785 canonical payload and that `payload.attester.kid` is the key's derived id.
//      It uses WebCrypto (`globalThis.crypto.subtle`) only, no `node:` modules, so the
//      `verify()` function below runs unchanged in a browser, a Worker, Deno or Node.
// Run: `pnpm -r build && node examples/verify-receipt-offline.mjs`
import { readFileSync } from "node:fs";
import { createGateway, StaticPrincipalKeyRegistry } from "@scopebond/gateway";
import { createSigner } from "@scopebond/sdk";
import { verifyReceiptSignature } from "@scopebond/verify/signature";

// --- 1. Issue a real receipt (same setup as quickstart.mjs) ---------------------------
const policy = JSON.parse(readFileSync(new URL("./policy.json", import.meta.url), "utf8"));
const agent = createSigner();
policy.clauses.find((clause) => clause.type === "key_policy").active_keys = [agent.kid];
const keys = new StaticPrincipalKeyRegistry([{
  kid: agent.kid, publicKeyPem: agent.publicKeyPem, purposes: ["agent"], status: "active",
}]);
const gateway = createGateway({ policy, authentication: { keys } });
const res = await gateway.handleAction(agent.sign({ action_type: "payout.create", asset: "USDC", amount: 500000 }));

// What a verifier holds: the receipt as JSON, and the attester's public key as published
// by the gateway (GET /v1/attester, or /.well-known/jwks.json). Requested in-process here.
const receiptJson = JSON.stringify(res.receipt);
const attester = await (await gateway.app.request("/v1/attester")).json();
console.log(`issued receipt: payout.create allowed=${res.allowed} attester=${res.receipt.payload.attester.kid}`);

// --- 2. Verify offline: browser / Worker code, WebCrypto only --------------------------
async function verify(label, json, publicKey) {
  const r = await verifyReceiptSignature(JSON.parse(json), publicKey);
  const why = r.valid ? "" : !r.signature_valid ? " (signature does not cover this payload)"
    : !r.key_binding_valid ? " (attester.kid is not this key)" : " (unsupported alg or attester)";
  console.log(`  ${label}: ${r.valid ? "VALID" : "INVALID" + why}`);
  return r.valid;
}

console.log("\nverifying with @scopebond/verify/signature:");
await verify("original receipt, JWK key", receiptJson, attester.jwk);
await verify("original receipt, PEM key", receiptJson, attester.public_key_pem);

// Tamper: raise the payout after the fact. The signature no longer matches.
const tampered = JSON.parse(receiptJson);
tampered.payload.intent.amount = 9900000;
await verify("tampered receipt (amount 500000 -> 9900000)", JSON.stringify(tampered), attester.jwk);

// Wrong key: another gateway's attester key does not verify, and its kid does not match.
const otherGateway = createGateway({ policy, authentication: { keys } });
const otherKey = (await (await otherGateway.app.request("/v1/attester")).json()).jwk;
await verify("original receipt, another gateway's key", receiptJson, otherKey);
