import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  canonical,
  createAttester,
  createGateway,
  createWebCryptoAttester,
  generateAttesterJwk,
  intentHash,
  minimizeIntentForEvidence,
  verifyReceipt,
} from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(
  join(here, "../../policy-schema/vectors/evidence-contract.json"),
  "utf8",
));
const policy = { policy_id: "evidence-test", version: 3, clauses: [] };
const post = (app, intent) => app.request("/v1/evaluate", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ intent }),
});

test("shared sensitive-data vector is minimized before receipt signing", () => {
  const result = minimizeIntentForEvidence(vectors.sensitive_intent);
  const serialized = JSON.stringify(result.intent);
  for (const forbidden of vectors.forbidden_after_minimization) {
    assert.equal(serialized.includes(forbidden), false, `retained forbidden value: ${forbidden}`);
  }
  assert.deepEqual(result.redactedPaths, vectors.required_redacted_paths);
  assert.match(result.intent.params.body.content_digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(
    canonical(JSON.parse('{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001]}')),
    '{"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27]}',
  );
  assert.throws(() => canonical({ invalid: Number.NaN }), /non-finite/);
  assert.throws(() => canonical({ invalid: undefined }), /rejects undefined/);
});

test("Node and WebCrypto receipts share the v1 contract and offline verification", async () => {
  const nodeAttester = createAttester();
  const workerAttester = await createWebCryptoAttester(await generateAttesterJwk());

  for (const attester of [nodeAttester, workerAttester]) {
    const gateway = createGateway({ policy, attester });
    const response = await post(gateway.app, vectors.sensitive_intent);
    const { receipt } = await response.json();
    const verification = verifyReceipt(receipt, attester.publicKeyPem);

    assert.equal(receipt.payload.evidence_version, vectors.version);
    assert.ok(vectors.execution_states.includes(receipt.payload.execution.state));
    assert.equal(verification.valid, true);
    assert.equal(verification.contract_valid, true);
    assert.equal(verification.supported_version, true);
    assert.equal(verification.key_binding_valid, true);
    assert.equal(verification.legacy, false);
    assert.equal(verification.external_effect_verified, false);
  }
});

test("gateway refuses an attester identity that is not bound to its public key", () => {
  const unbound = createAttester("key:claimed-by-caller");
  assert.throws(
    () => createGateway({ policy, attester: unbound }),
    /kid must match the public-key fingerprint/,
  );
});

test("offline verification labels legacy receipts and rejects signed unknown or inconsistent versions", async () => {
  const attester = createAttester();
  const intent = { action_type: "legacy.action", amount: 1 };
  const legacyPayload = {
    type: "scopebond:receipt",
    intent,
    intent_hash: intentHash(intent),
    policy_hash: "a".repeat(64),
    policy_version: 1,
    verifier_version: "scopebond-verify@0.1.0",
    realtime_result: "allow",
    executed: true,
    execution_ref: "legacy:reported",
    attester: { kind: "gateway", kid: attester.kid },
    timestamp: "2026-09-13T00:00:00.000Z",
  };
  const legacy = {
    payload: legacyPayload,
    signature: { alg: "Ed25519", sig: await attester.sign(canonical(legacyPayload)) },
  };
  const legacyResult = verifyReceipt(legacy, attester.publicKeyPem);
  assert.equal(legacyResult.valid, true);
  assert.equal(legacyResult.legacy, true);
  assert.equal(legacyResult.external_effect_verified, false);

  const gateway = createGateway({ policy, attester });
  const { receipt } = await (await post(gateway.app, { action_type: "current.action" })).json();

  for (const version of vectors.unsupported_versions) {
    const payload = structuredClone(receipt.payload);
    payload.evidence_version = version;
    const candidate = {
      payload,
      signature: { alg: "Ed25519", sig: await attester.sign(canonical(payload)) },
    };
    const result = verifyReceipt(candidate, attester.publicKeyPem);
    assert.equal(result.signature_valid, true);
    assert.equal(result.supported_version, false);
    assert.equal(result.valid, false);
  }

  const inconsistentPayload = structuredClone(receipt.payload);
  inconsistentPayload.policy_ref.digest = "b".repeat(64);
  const inconsistent = {
    payload: inconsistentPayload,
    signature: { alg: "Ed25519", sig: await attester.sign(canonical(inconsistentPayload)) },
  };
  const inconsistentResult = verifyReceipt(inconsistent, attester.publicKeyPem);
  assert.equal(inconsistentResult.signature_valid, true);
  assert.equal(inconsistentResult.policy_ref_valid, false);
  assert.equal(inconsistentResult.valid, false);

  const wrongIdentityPayload = structuredClone(receipt.payload);
  wrongIdentityPayload.attester.kid = "key:0000000000000000";
  const wrongIdentity = {
    payload: wrongIdentityPayload,
    signature: { alg: "Ed25519", sig: await attester.sign(canonical(wrongIdentityPayload)) },
  };
  const wrongIdentityResult = verifyReceipt(wrongIdentity, attester.publicKeyPem);
  assert.equal(wrongIdentityResult.signature_valid, true);
  assert.equal(wrongIdentityResult.key_binding_valid, false);
  assert.equal(wrongIdentityResult.valid, false);

  const contradictoryPayload = structuredClone(receipt.payload);
  contradictoryPayload.execution.state = "executed";
  contradictoryPayload.execution.assertion = "adapter_reported_success";
  contradictoryPayload.executed = false;
  const contradictory = {
    payload: contradictoryPayload,
    signature: { alg: "Ed25519", sig: await attester.sign(canonical(contradictoryPayload)) },
  };
  const contradictoryResult = verifyReceipt(contradictory, attester.publicKeyPem);
  assert.equal(contradictoryResult.signature_valid, true);
  assert.equal(contradictoryResult.contract_valid, false);
  assert.equal(contradictoryResult.valid, false);

  const unsignedEnvelopeDecoration = { ...receipt, injected_claim: "independent external success" };
  const decoratedResult = verifyReceipt(unsignedEnvelopeDecoration, attester.publicKeyPem);
  assert.equal(decoratedResult.signature_valid, true);
  assert.equal(decoratedResult.contract_valid, false);
  assert.equal(decoratedResult.valid, false);
});
