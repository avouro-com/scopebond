import { test } from "node:test";
import assert from "node:assert/strict";
import { createSigner, verifyIntentSignature, submit } from "../dist/index.js";

test("signs an intent, sets signer=kid, and round-trip verifies", () => {
  const signer = createSigner();
  const signed = signer.sign({ action_type: "payout.create", asset: "USDC", amount: 500000 });
  assert.equal(signed.intent.signer, signer.kid);
  assert.equal(signed.authorization.signer.alg, "Ed25519");
  assert.equal(signed.authorization.signer.kid, signer.kid);
  assert.ok(signed.authorization.signature.length > 0);
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
  const signer = createSigner();
  const signed = signer.sign({ action_type: "payout.create", asset: "USDC", amount: 500000 });
  let captured;
  const fakeFetch = async (url, init) => {
    captured = { url, body: JSON.parse(init.body) };
    return { json: async () => ({ allowed: true, reason: "allowed", receipt: {} }) };
  };
  const res = await submit("http://localhost:8787/", signed, fakeFetch);
  assert.equal(captured.url, "http://localhost:8787/v1/evaluate");
  assert.equal(captured.body.intent.action_type, "payout.create");
  assert.equal(captured.body.intent.signer, signer.kid);
  assert.equal(captured.body.authorization.signature, signed.authorization.signature);
  assert.equal(res.allowed, true);
});

test("rejects an arbitrary kid that is not bound to the signing key", () => {
  assert.throws(() => createSigner({ kid: "key:0000000000000000" }), /fingerprint/);
});

test("an approval binds the exact intent and policy reference", () => {
  const agent = createSigner();
  const approver = createSigner();
  const signed = agent.sign({ action_type: "payout.create", amount: 10 });
  const policyRef = { id: "payments", version: 4, digest: "a".repeat(64) };
  const approval = approver.approve(signed.intent, policyRef);
  assert.equal(approval.intent_hash, signed.authorization.intent_hash);
  assert.deepEqual(approval.policy_ref, policyRef);
  assert.equal(approval.approver.kid, approver.kid);
});
