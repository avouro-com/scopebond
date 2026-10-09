// An action reported only after it already ran (an agent that tells the hook about an edit once it is written) can be
// recorded, never prevented. A policy denial of one is signed as `observed_after` with `executed: true`; nothing is ever
// dispatched for it and no person is asked to override it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGateway, MemoryReceiptStore, validateEvidencePayload, verifyReceipt } from "../dist/index.js";

const AT = "2026-09-18T12:00:00Z";
const policy = {
  vocabulary_version: "1.0", policy_id: "after", version: 1,
  clauses: [{ id: "protect-write", type: "action_allowlist", mode: "enforce", action_types: ["file.write"], param_bounds: { path: { pattern: "^(?!\\.github/).+" } } }],
};
const write = (path) => ({ intent: { action_type: "file.write", params: { path } } });
function spyExecutor() {
  const calls = [];
  return { executor: { id: "spy:dispatch", mode: "dispatch", execute: (intent) => { calls.push(intent); return { ref: "spy:ref" }; } }, calls };
}
const gw = (config) => createGateway({ authentication: { mode: "insecure-development" }, now: () => AT, store: new MemoryReceiptStore(), ...config });

test("a denied action reported after it ran is signed observed_after, executed, and still a denial to the caller", async () => {
  const gateway = gw({ policy, mode: "check_only" });
  let asked = 0;
  const result = await gateway.handleAction(write(".github/workflows/ci.yml"), { observedAfter: true, override: async () => { asked += 1; return null; } });
  assert.equal(result.allowed, false);
  const p = result.receipt.payload;
  assert.equal(p.realtime_result, "deny", "the violation is recorded");
  assert.equal(p.execution.state, "observed_after");
  assert.notEqual(p.execution.state, "denied", "it was not prevented");
  assert.equal(p.executed, true, "it happened");
  assert.equal(p.execution.assertion, "none");
  assert.equal(asked, 0, "an action that already ran cannot be overridden");
  assert.equal(validateEvidencePayload(p), true);
  assert.equal(verifyReceipt(result.receipt, gateway.attester.publicKeyPem).valid, true);
});

test("an allowed action reported after it ran is a cooperative allow, never dispatched", async () => {
  const { executor, calls } = spyExecutor();
  const gateway = gw({ policy, mode: "enforce", executor });
  const result = await gateway.handleAction(write("src/a.ts"), { observedAfter: true });
  assert.equal(result.allowed, true);
  assert.equal(result.receipt.payload.execution.state, "cooperative_allow");
  assert.equal(calls.length, 0, "nothing is dispatched for an action that already ran");
});

test("the same denial reported before it runs is still denied (prevented)", async () => {
  const gateway = gw({ policy, mode: "check_only" });
  const result = await gateway.handleAction(write(".github/workflows/ci.yml"));
  assert.equal(result.receipt.payload.execution.state, "denied");
  assert.equal(result.receipt.payload.executed, false);
});

test("the evidence check refuses an observed_after receipt that claims it was not executed or was allowed", async () => {
  const gateway = gw({ policy, mode: "check_only" });
  const { receipt } = await gateway.handleAction(write(".github/workflows/ci.yml"), { observedAfter: true });
  assert.equal(validateEvidencePayload({ ...receipt.payload, executed: false }), false);
  assert.equal(validateEvidencePayload({ ...receipt.payload, realtime_result: "allow" }), false);
  assert.equal(validateEvidencePayload({ ...receipt.payload, execution: { ...receipt.payload.execution, state: "denied" } }), false, "a denied receipt is never executed");
});
