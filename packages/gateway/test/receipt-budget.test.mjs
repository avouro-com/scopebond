import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  createAttester, createGateway, verifyReceipt, validateEvidencePayload, validateReceiptBudget, RECEIPT_BUDGET_KEYS,
} from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const policy = {
  vocabulary_version: "1.0", policy_id: "budget-test", version: 1,
  clauses: [{ id: "actions", type: "action_allowlist", mode: "enforce", action_types: ["git.push", "file.write"] }],
};
const budget = { version: 1, scope: "session", budget_id: "sbud_overnight01", budget_version: 2, mode: "enforce", operation: "git.push", count: 1, max: 0, state: "over" };
const gatewayWith = (attester, guard) => createGateway({ authentication: { mode: "insecure-development" }, policy, attester, mode: "check_only", ...(guard ? { dispatchGuard: guard } : {}) });
const push = { intent: { action_type: "git.push", params: { remote: "origin", ref: "main" } } };

test("the budget members match the receipt schema", () => {
  const schema = JSON.parse(readFileSync(join(here, "../../policy-schema/schema/receipt.schema.json"), "utf8"));
  const member = schema.properties.payload.properties.budget;
  assert.deepEqual(Object.keys(member.properties), [...RECEIPT_BUDGET_KEYS]);
  assert.deepEqual(member.required, [...RECEIPT_BUDGET_KEYS]);
  assert.equal(member.additionalProperties, false);
  assert.equal(schema.properties.payload.required.includes("budget"), false);
});

test("validateReceiptBudget accepts the documented shape and refuses anything else", () => {
  assert.equal(validateReceiptBudget(budget), true);
  for (const state of ["within", "at_limit", "over", "unavailable"]) assert.equal(validateReceiptBudget({ ...budget, state }), true, state);
  const bad = [
    { ...budget, state: "fine" }, { ...budget, state: "expired" }, { ...budget, scope: "installation" }, { ...budget, extra: 1 }, { ...budget, max: -1 },
    { ...budget, budget_id: "short" }, { ...budget, operation: "Push" }, { ...budget, mode: "warn" }, { ...budget, version: 2 },
    (() => { const b = { ...budget }; delete b.count; return b; })(), null, "budget",
  ];
  for (const value of bad) assert.equal(validateReceiptBudget(value), false, JSON.stringify(value));
});

test("a receipt refused by a session budget carries the budget, verifies, and the budget is signed", async () => {
  const attester = createAttester();
  const guard = { authorize: async () => ({ allow: false, reason: "budget_exceeded", detail: "session budget", consumed_approvals: [], budgets: [] }) };
  const result = await gatewayWith(attester, guard).handleAction(push, { budget });
  assert.equal(result.allowed, false);
  assert.equal(result.receipt.payload.realtime_result, "deny");
  assert.deepEqual(result.receipt.payload.budget, budget);
  const verified = verifyReceipt(result.receipt, attester.publicKeyPem);
  assert.equal(verified.valid, true);
  assert.equal(verified.contract_valid, true);
  const tampered = structuredClone(result.receipt);
  tampered.payload.budget.max = 5;
  assert.equal(verifyReceipt(tampered, attester.publicKeyPem).valid, false);
});

test("an allowed, counted action carries the budget too; without one the receipt is unchanged", async () => {
  const attester = createAttester();
  const gateway = gatewayWith(attester);
  const counted = { ...budget, operation: "file.write", count: 3, max: 20, state: "within" };
  const allowed = await gateway.handleAction({ intent: { action_type: "file.write", params: { path: "src/a.ts" } } }, { budget: counted });
  assert.equal(allowed.allowed, true);
  assert.deepEqual(allowed.receipt.payload.budget, counted);
  assert.equal(validateEvidencePayload(allowed.receipt.payload), true);
  const plain = await gateway.handleAction(push);
  assert.equal("budget" in plain.receipt.payload, false);
  assert.equal(verifyReceipt(plain.receipt, attester.publicKeyPem).valid, true);
});

test("the gateway refuses to sign an invalid budget, and an unknown key inside it makes a payload invalid", async () => {
  const attester = createAttester();
  const gateway = gatewayWith(attester);
  await assert.rejects(gateway.handleAction(push, { budget: { ...budget, reason: "x" } }), /invalid receipt budget/);
  assert.equal((await gateway.store.list()).length, 0, "nothing was recorded");
  const { receipt } = await gateway.handleAction(push, { budget: { ...budget, state: "within", count: 0, max: 1 } });
  const payload = structuredClone(receipt.payload);
  payload.budget.note = "x";
  assert.equal(validateEvidencePayload(payload), false);
});
