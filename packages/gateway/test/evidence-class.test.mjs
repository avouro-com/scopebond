import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createAttester, createGateway, buildReceipt, verifyReceipt, validateEvidencePayload,
  StaticPrincipalKeyRegistry,
} from "../dist/index.js";
import { createSigner } from "@scopebond/sdk";

const AT = "2026-09-18T12:00:00Z";
const policy = {
  vocabulary_version: "1.0", policy_id: "cls", version: 1,
  clauses: [{ id: "a", type: "action_allowlist", mode: "enforce", action_types: ["payout.create", "pr.merge"] }],
};

// Re-sign a mutated payload with the same attester so its signature stays valid;
// only the evidence-class machinery is under test.
const resign = (attester, payload) => {
  const { type, ...rest } = payload;
  return buildReceipt(rest, attester);
};

async function baseReceipt(attester) {
  const gateway = createGateway({ authentication: { mode: "insecure-development" }, policy, attester, now: () => AT });
  const r = await gateway.handleAction({ intent: { action_type: "payout.create", asset: "USDC", amount: 1 } });
  return r.receipt;
}

test("a v1 receipt without an explicit class classifies and still verifies — 0.4.1 compatibility", async () => {
  const attester = createAttester();
  const receipt = await baseReceipt(attester); // insecure-dev: no agent signature, no evidence_class
  assert.equal(receipt.payload.evidence_class, undefined, "the gateway does not tag an unsigned receipt");
  const v = verifyReceipt(receipt, attester.publicKeyPem);
  assert.equal(v.valid, true, "a receipt emitted before the evidence_class field still verifies");
  assert.equal(v.evidence_class, "pep_authorized", "no agent signature → pep_authorized by inference");
});

test("the gateway tags a signed-intent receipt explicitly and it classifies as signed_intent", async () => {
  const agent = createSigner();
  const attester = createAttester();
  const keys = new StaticPrincipalKeyRegistry([{ kid: agent.kid, publicKeyPem: agent.publicKeyPem, purposes: ["agent"], status: "active" }]);
  const gateway = createGateway({ authentication: { keys }, policy, attester, now: () => AT });
  const signed = agent.sign({ action_type: "payout.create", asset: "USDC", amount: 1 }, { issuedAt: AT });
  const { receipt } = await gateway.handleAction({ intent: signed.intent, authorization: signed.authorization });
  assert.equal(receipt.payload.evidence_class, "signed_intent");
  assert.equal(verifyReceipt(receipt, attester.publicKeyPem).evidence_class, "signed_intent");
});

test("a well-formed boundary receipt validates and classifies as boundary", async () => {
  const attester = createAttester();
  const base = await baseReceipt(attester);
  const receipt = await resign(attester, {
    ...base.payload,
    evidence_class: "boundary",
    boundary: { gate: "merge", outcome_ref: "pr:acme/app#42:head", attribution: { kind: "asserted", actor: "copilot-swe-agent[bot]" } },
  });
  assert.equal(validateEvidencePayload(receipt.payload), true);
  const v = verifyReceipt(receipt, attester.publicKeyPem);
  assert.equal(v.valid, true);
  assert.equal(v.evidence_class, "boundary");
});

test("a boundary receipt missing a required field is rejected", async () => {
  const attester = createAttester();
  const base = await baseReceipt(attester);
  const missingOutcome = await resign(attester, {
    ...base.payload, evidence_class: "boundary",
    boundary: { gate: "merge", attribution: { kind: "asserted", actor: "x" } },
  });
  assert.equal(verifyReceipt(missingOutcome, attester.publicKeyPem).contract_valid, false, "missing outcome_ref");

  const badGate = await resign(attester, {
    ...base.payload, evidence_class: "boundary",
    boundary: { gate: "teleport", outcome_ref: "x", attribution: { kind: "asserted", actor: "x" } },
  });
  assert.equal(verifyReceipt(badGate, attester.publicKeyPem).contract_valid, false, "unknown gate");
});

test("a pep_authorized receipt requires a principal; a boundary receipt cannot smuggle one", async () => {
  const attester = createAttester();
  const base = await baseReceipt(attester);
  const pep = await resign(attester, {
    ...base.payload, evidence_class: "pep_authorized",
    principal: { subject: "sub:agent-7", issuer: "https://idp.example" },
  });
  assert.equal(verifyReceipt(pep, attester.publicKeyPem).valid, true);
  assert.equal(verifyReceipt(pep, attester.publicKeyPem).evidence_class, "pep_authorized");

  const pepMissing = await resign(attester, { ...base.payload, evidence_class: "pep_authorized" });
  assert.equal(verifyReceipt(pepMissing, attester.publicKeyPem).contract_valid, false, "pep needs a principal");

  const smuggled = await resign(attester, {
    ...base.payload, evidence_class: "boundary",
    boundary: { gate: "deploy", outcome_ref: "d:1", attribution: { kind: "inferred", actor: "x" } },
    principal: { subject: "s", issuer: "i" },
  });
  assert.equal(verifyReceipt(smuggled, attester.publicKeyPem).contract_valid, false, "boundary cannot carry a principal");
});

test("the verifier never upgrades an explicit class — a boundary receipt with an agent signature stays boundary", async () => {
  const agent = createSigner();
  const attester = createAttester();
  const keys = new StaticPrincipalKeyRegistry([{ kid: agent.kid, publicKeyPem: agent.publicKeyPem, purposes: ["agent"], status: "active" }]);
  const gateway = createGateway({ authentication: { keys }, policy, attester, now: () => AT });
  const signed = agent.sign({ action_type: "pr.merge", params: { repo: "acme/app", base: "main" } }, { issuedAt: AT });
  const { receipt } = await gateway.handleAction({ intent: signed.intent, authorization: signed.authorization });
  // This receipt carries a real agent signature. Re-label it boundary and confirm
  // the verifier reports boundary, not signed_intent.
  const rebranded = await resign(attester, {
    ...receipt.payload, evidence_class: "boundary",
    boundary: { gate: "merge", outcome_ref: "pr:acme/app#7:head", attribution: { kind: "asserted", actor: "copilot-swe-agent[bot]" } },
  });
  assert.ok(rebranded.payload.authorization.agent, "the receipt still carries an agent signature");
  assert.equal(verifyReceipt(rebranded, attester.publicKeyPem).evidence_class, "boundary", "explicit class is never upgraded");
});
