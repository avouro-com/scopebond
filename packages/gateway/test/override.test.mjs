import { test } from "node:test";
import assert from "node:assert/strict";
import { createGateway, sha256, validateEvidencePayload, validateOverrideRecord, verifyReceipt } from "../dist/index.js";

const AT = "2026-10-05T12:00:00Z";
const CONTROL_TOKEN = "test-control-token-000000000001";
const policy = {
  vocabulary_version: "1.0", policy_id: "warn", version: 1,
  clauses: [{ id: "cap", type: "spend_limit", mode: "enforce", asset: "USDC", max_per_action: 1000000 }],
};
const gw = (config = {}) => createGateway({ authentication: { mode: "insecure-development" }, now: () => AT, policy, mode: "check_only", control: { bearerToken: CONTROL_TOKEN }, ...config });
const over = { action_type: "payout.create", asset: "USDC", amount: 2000000 };
const record = (extra = {}) => ({
  version: 1, rule: "spend-cap", method: "agent_dialog", state: "allowed", repeat_of: null,
  reason_digest: sha256("Approved refund for a known customer"), reason_length: 36, os_user_digest: null, decided_at: AT, ...extra,
});

test("a person's override turns a policy denial into a signed, approved receipt that verifies offline", async () => {
  const gateway = gw();
  const asked = [];
  const result = await gateway.handleAction({ intent: over }, { override: async (ctx) => { asked.push(ctx); return record(); } });
  assert.equal(result.allowed, true, result.reason);
  assert.match(result.reason, /allowed by override/);
  const p = result.receipt.payload;
  assert.equal(p.realtime_result, "approved");
  assert.equal(p.execution.state, "cooperative_allow");
  assert.deepEqual(p.override, record());
  assert.equal(asked.length, 1);
  assert.equal(asked[0].verdict.clause_id, "cap");
  assert.equal(asked[0].action_id, p.action_ref.action_id);
  assert.equal(validateEvidencePayload(p), true);
  assert.equal(verifyReceipt(result.receipt, gateway.attester.publicKeyPem).valid, true);
});

test("no override is asked for an allowed action, and declining keeps the denial with no override field", async () => {
  const gateway = gw();
  let asked = 0;
  const allowed = await gateway.handleAction({ intent: { ...over, amount: 10 } }, { override: async () => { asked += 1; return record(); } });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.receipt.payload.override, undefined);
  const declined = await gateway.handleAction({ intent: over }, { override: async () => { asked += 1; return null; } });
  assert.equal(declined.allowed, false);
  assert.equal(declined.receipt.payload.realtime_result, "deny");
  assert.equal(declined.receipt.payload.override, undefined);
  assert.equal(asked, 1, "asked only for the denial");
});

test("the kill switch is never overridable", async () => {
  const gateway = gw();
  const killed = await gateway.app.request("/v1/kill", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${CONTROL_TOKEN}` }, body: "{}" });
  assert.equal(killed.status < 300, true);
  let asked = 0;
  const result = await gateway.handleAction({ intent: over }, { override: async () => { asked += 1; return record(); } });
  assert.equal(result.allowed, false);
  assert.equal(asked, 0);
  assert.equal(result.receipt.payload.override, undefined);
});

test("an override record has one exact shape, and only an approved decision may carry one", () => {
  assert.equal(validateOverrideRecord(record()), true);
  assert.equal(validateOverrideRecord(record({ method: "harness_prompt", state: "offered", reason_digest: null, reason_length: null })), true);
  // D144: an action a standing allowance let through names the allowance and carries the digest of its reason.
  assert.equal(validateOverrideRecord(record({ method: "allowance", repeat_of: "alw_0123456789abcdefghij" })), true);
  assert.equal(validateOverrideRecord(record({ method: "allowance", repeat_of: null })), false, "an allowance is always named");
  assert.equal(validateOverrideRecord(record({ method: "allowance", state: "offered", repeat_of: "alw_0123456789abcdefghij" })), false);
  for (const bad of [
    record({ reason_digest: null }), record({ state: "offered" }), record({ method: "harness_prompt", state: "offered" }),
    record({ rule: "Not A Rule" }), record({ repeat_of: "short" }), record({ person: "x" }), record({ version: 2 }), null,
  ]) assert.equal(validateOverrideRecord(bad), false, JSON.stringify(bad));
});
