// A receipt names the policy clause that matched (`clause_id`) and the bound that failed (`failed_bound`), for a denied
// action and for one a monitored clause would have blocked, so a reader does not re-work the rule out of its own copy
// of the policy. An allowed action carries neither, and a receipt made before these fields still verifies.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createAttester, createGateway, verifyReceipt, validateEvidencePayload, buildReceipt } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(join(here, "../../policy-schema/vectors/evidence-contract.json"), "utf8")).receipt_match;
const policyWith = (mode) => ({
  vocabulary_version: "1.0", policy_id: "match-test", version: 1,
  clauses: [
    { id: "safe-shell", type: "action_allowlist", mode, action_types: ["shell.exec"], param_bounds: { program: { pattern: "^(?!rm$).+" } } },
    { id: "protect-read", type: "action_allowlist", mode, action_types: ["file.read"], param_bounds: { path: { pattern: "^(?!\\.env$).+" } } },
  ],
});
const gatewayWith = (attester, mode) => createGateway({ authentication: { mode: "insecure-development" }, policy: policyWith(mode), attester, mode: "check_only" });
const rmRoot = { intent: { action_type: "shell.exec", params: { program: "rm", args: ["-rf", "/"] } } };

test("a denied rm -rf / names safe-shell and a bound on program, never the command", async () => {
  const attester = createAttester();
  const result = await gatewayWith(attester, "enforce").handleAction(rmRoot);
  assert.equal(result.allowed, false);
  const p = result.receipt.payload;
  assert.equal(p.realtime_result, "deny");
  assert.equal(p.execution.state, "denied");
  assert.equal(p.clause_id, "safe-shell");
  assert.match(p.failed_bound, /^program:/);
  assert.equal(p.failed_bound, "program:pattern");
  assert.equal(validateEvidencePayload(p), true);
  assert.equal(verifyReceipt(result.receipt, attester.publicKeyPem).valid, true);
  const tampered = structuredClone(result.receipt);
  tampered.payload.clause_id = "protect-read";
  assert.equal(verifyReceipt(tampered, attester.publicKeyPem).valid, false, "the fields are covered by the signature");
});

test("a monitored rm -rf / carries them too, with its monitor state", async () => {
  const attester = createAttester();
  const result = await gatewayWith(attester, "monitor").handleAction(rmRoot);
  assert.equal(result.allowed, true);
  const p = result.receipt.payload;
  assert.equal(p.realtime_result, "deny", "would have blocked");
  assert.equal(p.execution.state, "cooperative_allow", "and was let through");
  assert.equal(p.clause_id, "safe-shell");
  assert.equal(p.failed_bound, "program:pattern");
  assert.equal(verifyReceipt(result.receipt, attester.publicKeyPem).valid, true);
});

test("a monitored read of .env names protect-read and path:pattern", async () => {
  const attester = createAttester();
  const { receipt } = await gatewayWith(attester, "monitor").handleAction({ intent: { action_type: "file.read", params: { path: ".env" } } });
  assert.equal(receipt.payload.clause_id, "protect-read");
  assert.equal(receipt.payload.failed_bound, "path:pattern");
  assert.equal(JSON.stringify(receipt.payload).includes(".env\",\"clause"), false);
});

test("an allowed action carries neither", async () => {
  const attester = createAttester();
  for (const mode of ["enforce", "monitor"]) {
    const result = await gatewayWith(attester, mode).handleAction({ intent: { action_type: "shell.exec", params: { program: "ls" } } });
    assert.equal(result.receipt.payload.realtime_result, "allow");
    assert.equal("clause_id" in result.receipt.payload, false, mode);
    assert.equal("failed_bound" in result.receipt.payload, false, mode);
    assert.equal(verifyReceipt(result.receipt, attester.publicKeyPem).valid, true);
  }
});

test("an overridden denial keeps the clause it overrode", async () => {
  const attester = createAttester();
  const record = { version: 1, rule: "safe-shell", method: "harness_prompt", state: "offered", repeat_of: null, reason_digest: null, reason_length: null, os_user_digest: null, decided_at: "2026-10-20T00:00:00.000Z" };
  const { receipt } = await gatewayWith(attester, "enforce").handleAction(rmRoot, { override: async () => record });
  assert.equal(receipt.payload.realtime_result, "approved");
  assert.equal(receipt.payload.clause_id, "safe-shell");
  assert.equal(receipt.payload.failed_bound, "program:pattern");
  assert.equal(verifyReceipt(receipt, attester.publicKeyPem).valid, true);
});

test("a receipt made before these fields still verifies", async () => {
  const attester = createAttester();
  const { receipt } = await gatewayWith(attester, "enforce").handleAction(rmRoot);
  const old = structuredClone(receipt.payload);
  delete old.clause_id;
  delete old.failed_bound;
  delete old.type;
  const resigned = await buildReceipt(old, attester);
  assert.equal("clause_id" in resigned.payload, false);
  const verified = verifyReceipt(resigned, attester.publicKeyPem);
  assert.equal(verified.valid, true);
  assert.equal(verified.contract_valid, true);
});

test("the payload check follows the shared vectors", async () => {
  const attester = createAttester();
  const { receipt } = await gatewayWith(attester, "enforce").handleAction(rmRoot);
  const base = structuredClone(receipt.payload);
  delete base.clause_id;
  delete base.failed_bound;
  for (const [list, expected] of [[vectors.valid, true], [vectors.invalid, false]]) {
    for (const vector of list) {
      const payload = { ...structuredClone(base), ...vector.fields, realtime_result: vector.realtime_result };
      if (vector.realtime_result === "not_evaluated") payload.execution = { ...payload.execution, state: "observed_not_evaluated" };
      assert.equal(validateEvidencePayload(payload), expected, vector.name);
    }
  }
});
