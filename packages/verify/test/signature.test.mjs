import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { canonical } from "@scopebond/policy-schema/canonical";
import { verifyReceiptSignature, deriveKeyId } from "../dist/signature.js";

// A receipt signed the way the gateway signs: Ed25519 over the RFC 8785 canonical payload.
function signed(payloadOver = {}, alg = "Ed25519") {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" });
  const kid = "key:" + createHash("sha256").update(canonical({ crv: jwk.crv, kty: jwk.kty, x: jwk.x })).digest("hex").slice(0, 16);
  const payload = { evidence_version: "1", attester: { kind: "gateway", kid }, intent: { action_type: "git.push", params: { ref: "main" } }, realtime_result: "deny", ...payloadOver };
  const sig = sign(null, Buffer.from(canonical(payload)), privateKey).toString("base64");
  return { receipt: { payload, signature: { alg, sig } }, pem: publicKey.export({ type: "spki", format: "pem" }).toString(), jwk, kid };
}

test("a genuine receipt verifies with the PEM key and with the JWK", async () => {
  const { receipt, pem, jwk } = signed();
  for (const key of [pem, jwk]) {
    const r = await verifyReceiptSignature(receipt, key);
    assert.deepEqual(r, { valid: true, signature_valid: true, key_binding_valid: true, alg_supported: true, attester_kind_supported: true });
  }
});

test("deriveKeyId matches the gateway's kid derivation", async () => {
  const { jwk, kid } = signed();
  assert.equal(await deriveKeyId(jwk), kid);
});

test("tampering, a different key, a mismatched kid and unsupported kinds are not valid", async () => {
  const { receipt, pem } = signed();
  const tampered = structuredClone(receipt);
  tampered.payload.realtime_result = "allow";
  assert.equal((await verifyReceiptSignature(tampered, pem)).signature_valid, false);

  const other = signed();
  const wrongKey = await verifyReceiptSignature(receipt, other.pem);
  assert.equal(wrongKey.signature_valid, false);
  assert.equal(wrongKey.valid, false);

  const renamed = signed({ attester: { kind: "gateway", kid: "key:0000000000000000" } });
  const kidMismatch = await verifyReceiptSignature(renamed.receipt, renamed.pem);
  assert.equal(kidMismatch.signature_valid, true);
  assert.equal(kidMismatch.key_binding_valid, false);
  assert.equal(kidMismatch.valid, false);

  const moduleKind = signed({ attester: { kind: "module", kid: "x" } });
  const kind = await verifyReceiptSignature(moduleKind.receipt, moduleKind.pem);
  assert.equal(kind.attester_kind_supported, false);
  assert.equal(kind.valid, false);

  const es256 = signed({}, "ES256");
  const alg = await verifyReceiptSignature(es256.receipt, es256.pem);
  assert.equal(alg.alg_supported, false);
  assert.equal(alg.valid, false);
});

test("malformed receipts and keys never throw", async () => {
  const { receipt, pem } = signed();
  for (const [r, k] of [[null, pem], [{}, pem], [{ payload: {}, signature: {} }, pem], [receipt, "not a key"], [receipt, { kty: "RSA" }], [{ payload: {}, signature: { alg: "Ed25519", sig: "%%%" } }, pem]]) {
    const out = await verifyReceiptSignature(r, k);
    assert.equal(out.valid, false);
  }
});
