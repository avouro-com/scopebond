import { test } from "node:test";
import assert from "node:assert/strict";
import { createGateway, MemoryReceiptStore, StaticPrincipalKeyRegistry, verifyReceipt } from "../dist/index.js";
import { createSigner } from "@scopebond/sdk";

const AT = "2026-09-18T12:00:00Z";
const CONTROL_TOKEN = "test-control-token-000000000001";
const capPolicy = {
  vocabulary_version: "1.0", policy_id: "m0", version: 1,
  clauses: [{ id: "cap", type: "spend_limit", mode: "enforce", asset: "USDC", max_per_action: 1000000 }],
};

// A dispatch executor that records whether it was ever invoked — a cooperative
// (check-only) allow must never call it.
function spyExecutor() {
  const calls = [];
  return { executor: { id: "spy:dispatch", mode: "dispatch", execute: (intent) => { calls.push(intent); return { ref: "spy:ref" }; } }, calls };
}

const gw = (config) => createGateway({ authentication: { mode: "insecure-development" }, now: () => AT, ...config });

test("check-only records an allowed action as cooperative_allow — decided, signed, never executed", async () => {
  const { executor, calls } = spyExecutor();
  const gateway = gw({ policy: capPolicy, mode: "check_only", executor });
  const result = await gateway.check({ intent: { action_type: "payout.create", asset: "USDC", amount: 500000 } });

  assert.equal(result.allowed, true, result.reason);
  const p = result.receipt.payload;
  assert.equal(p.execution.state, "cooperative_allow");
  assert.equal(p.executed, false, "a cooperative allow is never executed");
  assert.equal(p.execution.assertion, "none", "the gateway asserts nothing about execution");
  assert.equal(p.execution.external_effect, "not_independently_verified");
  assert.equal(p.realtime_result, "allow");
  assert.equal(calls.length, 0, "the executor is never invoked in check-only mode");
  assert.equal(verifyReceipt(result.receipt, gateway.attester.publicKeyPem).valid, true, "the receipt verifies offline");
});

test("check-only denies an over-limit action (fail closed), still not executed", async () => {
  const gateway = gw({ policy: capPolicy, mode: "check_only" });
  const result = await gateway.check({ intent: { action_type: "payout.create", asset: "USDC", amount: 2000000 } });
  assert.equal(result.allowed, false);
  assert.equal(result.receipt.payload.realtime_result, "deny");
  assert.equal(result.receipt.payload.executed, false);
  assert.equal(result.receipt.payload.execution.state, "denied");
});

test("check() forces cooperative semantics even on an enforce-mode gateway with a dispatch executor", async () => {
  const { executor, calls } = spyExecutor();
  const gateway = gw({ policy: capPolicy, mode: "enforce", executor });

  // check() never dispatches, whatever the configured mode/executor.
  const checked = await gateway.check({ intent: { action_type: "payout.create", asset: "USDC", amount: 500000 } });
  assert.equal(checked.receipt.payload.execution.state, "cooperative_allow");
  assert.equal(checked.receipt.payload.executed, false);
  assert.equal(calls.length, 0, "check() did not dispatch");

  // handleAction on the same enforce-mode gateway DOES dispatch — proving the modes are distinct.
  const dispatched = await gateway.handleAction({ intent: { action_type: "payout.create", asset: "USDC", amount: 500000 } });
  assert.equal(dispatched.receipt.payload.execution.state, "executed");
  assert.equal(dispatched.receipt.payload.executed, true);
  assert.equal(calls.length, 1, "handleAction dispatched exactly once");
});

test("the kill switch denies in check-only mode (fail closed)", async () => {
  const gateway = gw({ policy: capPolicy, mode: "check_only", control: { bearerToken: CONTROL_TOKEN } });
  await gateway.app.request("/v1/kill", { method: "POST", headers: { authorization: `Bearer ${CONTROL_TOKEN}` } });
  const result = await gateway.check({ intent: { action_type: "payout.create", asset: "USDC", amount: 500000 } });
  assert.equal(result.allowed, false);
  assert.equal(result.receipt.payload.realtime_result, "deny");
  assert.equal(result.receipt.payload.executed, false);
});

test("cooperative behavior is never implicit — a default gateway simulates, it does not cooperatively allow", async () => {
  const gateway = gw({ policy: capPolicy });
  const result = await gateway.handleAction({ intent: { action_type: "payout.create", asset: "USDC", amount: 500000 } });
  assert.equal(result.receipt.payload.execution.state, "simulated", "default mode is enforce, not check_only");
});

test("replay protection holds in check-only: a reused signed request_id is rejected, not re-allowed", async () => {
  const agent = createSigner();
  const keys = new StaticPrincipalKeyRegistry([{ kid: agent.kid, publicKeyPem: agent.publicKeyPem, purposes: ["agent"], status: "active" }]);
  const gateway = createGateway({
    authentication: { keys }, policy: capPolicy, now: () => AT, mode: "check_only", store: new MemoryReceiptStore(),
  });
  const signed = agent.sign({ action_type: "payout.create", asset: "USDC", amount: 500000 }, { requestId: "req:fixed-000000000001", issuedAt: AT });
  const first = await gateway.check({ intent: signed.intent, authorization: signed.authorization });
  assert.equal(first.allowed, true, first.reason);
  assert.equal(first.receipt.payload.execution.state, "cooperative_allow");
  // The signed authorization is single-use; replaying it fails closed even in M0.
  await assert.rejects(
    () => gateway.check({ intent: signed.intent, authorization: signed.authorization }),
    /request_id has already been used/,
  );
});

test("windowed spend accumulates across cooperative allows (SB66)", async () => {
  // In cooperative mode the gateway authorized the first payout, so it counts toward
  // the window for the next decision — otherwise a per-window cap could never bind.
  // The receipt still records executed:false; the coercion is for the live decision
  // only, and claim-time verification is unchanged. Conservative by design: an
  // authorized-but-skipped action counts, which over-restricts rather than under.
  const windowed = {
    vocabulary_version: "1.0", policy_id: "m0-window", version: 1,
    clauses: [
      { id: "per", type: "spend_limit", mode: "enforce", asset: "USDC", max_per_action: 700000 },
      { id: "win", type: "spend_limit", mode: "enforce", asset: "USDC", max_per_window: 1000000, window: "P1D", scope: "principal" },
    ],
  };
  const gateway = gw({ policy: windowed, mode: "check_only", store: new MemoryReceiptStore() });
  const one = await gateway.check({ intent: { action_type: "payout.create", asset: "USDC", amount: 600000 } });
  const two = await gateway.check({ intent: { action_type: "payout.create", asset: "USDC", amount: 600000 } });
  assert.equal(one.allowed, true, one.reason);
  assert.equal(two.allowed, false, "the second cooperative payout exceeds the 1,000,000 window and is denied");
  assert.equal(two.receipt.payload.execution.state, "denied");
});

test("rate_limit binds across cooperative allows (SB66)", async () => {
  const oncePerHour = {
    vocabulary_version: "1.0", policy_id: "m0-rate", version: 1,
    clauses: [{ id: "rl", type: "rate_limit", mode: "enforce", action_types: ["social.post"], max_count: 1, window: "PT1H" }],
  };
  const gateway = gw({ policy: oncePerHour, mode: "check_only", store: new MemoryReceiptStore() });
  const first = await gateway.check({ intent: { action_type: "social.post", params: { text: "one" } } });
  const second = await gateway.check({ intent: { action_type: "social.post", params: { text: "two" } } });
  assert.equal(first.allowed, true, first.reason);
  assert.equal(second.allowed, false, "the second post in the window is denied");
  assert.match(second.reason ?? "", /max_count/);
});

test("sequence cooldown sees prior cooperative allows (SB66)", async () => {
  // A cooldown: a second deploy within the forbidden window is a violation because a
  // prior deploy is in range. For it to bind cooperatively, the first (cooperative)
  // deploy must be counted.
  const seq = {
    vocabulary_version: "1.0", policy_id: "m0-seq", version: 1,
    clauses: [{
      id: "sq", type: "sequence", mode: "enforce",
      first_action_types: ["deploy.run"], then_action_types: ["deploy.run"], forbidden_within: "PT1H",
    }],
  };
  const gateway = gw({ policy: seq, mode: "check_only", store: new MemoryReceiptStore() });
  const first = await gateway.check({ intent: { action_type: "deploy.run", params: {} } });
  const second = await gateway.check({ intent: { action_type: "deploy.run", params: {} } });
  assert.equal(first.allowed, true, first.reason);
  assert.equal(second.allowed, false, "a second deploy within the cooldown is denied because the first is counted");
});
