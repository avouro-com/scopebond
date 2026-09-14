import assert from "node:assert/strict";
import test from "node:test";
import { createWebCryptoAttester, generateAttesterJwk, completeCloudEnrollment } from "../dist/index.js";

test("Cloud enrollment binds the returned credential to the gateway attester", async () => {
  const attester = await createWebCryptoAttester(await generateAttesterJwk());
  const proofCanonical = '{"challenge":"challenge_abc","enrollment_id":"enrollment-1","type":"scopebond:gateway-enrollment","version":1}';
  let submitted;
  const result = await completeCloudEnrollment({
    url: "https://cloud.scopebond.test",
    bundle: { enrollment_token: "sbe_test-token", proof_canonical: proofCanonical },
    attester,
    fetch: async (url, init) => {
      assert.equal(String(url), "https://cloud.scopebond.test/v1/enroll");
      assert.equal(init.redirect, "error");
      submitted = JSON.parse(init.body);
      return new Response(JSON.stringify({
        credential_id: "credential-1", credential: "sbm_scoped-secret",
        organization_id: "org-1", environment_id: "env-1", gateway_id: "gateway-1",
        attester_kid: attester.kid, scopes: ["receipt:ingest", "gateway:heartbeat"],
        expires_at: "2026-12-12T00:00:00.000Z",
      }), { status: 201, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(submitted.enrollment_token, "sbe_test-token");
  assert.equal(submitted.public_key_pem, attester.publicKeyPem);
  assert.ok(submitted.signature);
  assert.equal(result.credential, "sbm_scoped-secret");
  assert.equal(result.attester_kid, attester.kid);
});

test("Cloud enrollment rejects insecure remote origins and altered proof bytes", async () => {
  const attester = await createWebCryptoAttester(await generateAttesterJwk());
  const bundle = {
    enrollment_token: "sbe_test-token",
    proof_canonical: '{"version":1,"type":"scopebond:gateway-enrollment"}',
  };
  await assert.rejects(
    completeCloudEnrollment({ url: "http://cloud.example", bundle, attester }),
    /requires HTTPS/,
  );
  await assert.rejects(
    completeCloudEnrollment({ url: "https://cloud.example", bundle, attester }),
    /not canonical/,
  );
});
