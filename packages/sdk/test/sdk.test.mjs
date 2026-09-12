import { test } from "node:test";
import assert from "node:assert/strict";
import { createSigner, verifyIntentSignature, submit } from "../dist/index.js";

test("signs an intent, sets signer=kid, and round-trip verifies", () => {
  const signer = createSigner({ kid: "key:agent-1" });
  const signed = signer.sign({ action_type: "payout.create", asset: "USDC", amount: 500000 });
  assert.equal(signed.intent.signer, "key:agent-1");
  assert.equal(signed.alg, "Ed25519");
  assert.ok(signed.signature.length > 0);
  assert.equal(verifyIntentSignature(signed, signer.publicKeyPem), true);
});

test("tampering with the intent invalidates the signature", () => {
  const signer = createSigner();
  const signed = signer.sign({ action_type: "payout.create", asset: "USDC", amount: 500000 });
  signed.intent.amount = 999999; // tamper
  assert.equal(verifyIntentSignature(signed, signer.publicKeyPem), false);
});

test("a generated signer derives a stable kid from its public key", () => {
  const s = createSigner();
  assert.match(s.kid, /^key:[0-9a-f]{16}$/);
});

test("submit POSTs the intent to /v1/evaluate", async () => {
  const signer = createSigner({ kid: "key:agent-1" });
  const signed = signer.sign({ action_type: "payout.create", asset: "USDC", amount: 500000 });
  let captured;
  const fakeFetch = async (url, init) => {
    captured = { url, body: JSON.parse(init.body) };
    return { json: async () => ({ allowed: true, reason: "allowed", receipt: {} }) };
  };
  const res = await submit("http://localhost:8787/", signed, fakeFetch);
  assert.equal(captured.url, "http://localhost:8787/v1/evaluate");
  assert.equal(captured.body.intent.action_type, "payout.create");
  assert.equal(captured.body.intent.signer, "key:agent-1");
  assert.equal(res.allowed, true);
});
