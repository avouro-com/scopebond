import { test } from "node:test";
import assert from "node:assert/strict";
import { violates, durationToMs } from "../src/violates.mjs";

const rcpt = (o) => ({
  intent: o.intent, executed: o.executed ?? true, realtime_result: o.rr ?? "allow",
  approval: o.approval, intent_hash: o.intent_hash, timestamp: o.ts,
  attester: { kind: "gateway", kid: "g1" },
});
const spend = (amount, ts, extra = {}) => rcpt({ intent: { action_type: "payout.create", asset: "USDC", amount }, ts, ...extra });

test("durationToMs parses ISO-8601 durations", () => {
  assert.equal(durationToMs("P1D"), 86400000);
  assert.equal(durationToMs("PT30M"), 1800000);
  assert.equal(durationToMs("PT4H"), 14400000);
});

test("prevented: a denied, non-executed over-limit action is not a violation (bucket A)", () => {
  const policy = { clauses: [{ id: "tx-cap", type: "spend_limit", mode: "enforce", asset: "USDC", max_per_action: 1000000 }] };
  const claimed = spend(2000000, "2026-09-12T12:00:00Z", { executed: false, rr: "deny" });
  const v = violates(policy, [], claimed);
  assert.equal(v.violated, false);
});

test("covered row 4: a monitored, executed over-limit action is a violation", () => {
  const policy = { clauses: [{ id: "tx-cap", type: "spend_limit", mode: "monitor", asset: "USDC", max_per_action: 1000000 }] };
  const claimed = spend(2000000, "2026-09-12T12:00:00Z", { rr: "deny" }); // executed anyway (monitor)
  const v = violates(policy, [], claimed);
  assert.equal(v.violated, true);
  assert.equal(v.clause_id, "tx-cap");
});

test("ambiguity resolves for the operator: exactly at the limit is allowed", () => {
  const policy = { clauses: [{ id: "tx-cap", type: "spend_limit", mode: "enforce", asset: "USDC", max_per_action: 1000000 }] };
  const v = violates(policy, [], spend(1000000, "2026-09-12T12:00:00Z"));
  assert.equal(v.violated, false);
});

test("covered row 1: windowed aggregate over the limit (each action under it)", () => {
  const policy = { clauses: [{ id: "daily", type: "spend_limit", mode: "monitor", asset: "USDC", max_per_window: 5000000, window: "P1D", scope: "principal" }] };
  const receipts = [spend(3000000, "2026-09-12T10:00:00Z")];
  const claimed = spend(3000000, "2026-09-12T12:00:00Z");
  const v = violates(policy, receipts, claimed);
  assert.equal(v.violated, true);
  assert.equal(v.clause_id, "daily");
});

test("covered row 3: rate limit exceeded across a window", () => {
  const policy = { clauses: [{ id: "rl", type: "rate_limit", mode: "monitor", action_types: ["payout.create"], max_count: 2, window: "P1D" }] };
  const receipts = [spend(1, "2026-09-12T09:00:00Z"), spend(1, "2026-09-12T10:00:00Z")];
  const claimed = spend(1, "2026-09-12T11:00:00Z"); // 3rd in window
  assert.equal(violates(policy, receipts, claimed).violated, true);
});

test("covered row 5: executed without a valid approval; valid approval clears it", () => {
  const policy = { clauses: [{ id: "appr", type: "require_approval", mode: "require_approval", action_types: ["payout.create"], approvers: ["key:ops-lead"] }] };
  const noApproval = rcpt({ intent: { action_type: "payout.create" }, ts: "2026-09-12T12:00:00Z", intent_hash: "abc" });
  assert.equal(violates(policy, [], noApproval).violated, true);

  const approved = rcpt({ intent: { action_type: "payout.create" }, ts: "2026-09-12T12:00:00Z", intent_hash: "abc", approval: { approver: "key:ops-lead", intent_hash: "abc" } });
  assert.equal(violates(policy, [], approved).violated, false);
});

test("covered row 6: sequence violation (pay within forbidden window of a beneficiary change)", () => {
  const policy = { clauses: [{ id: "seq", type: "sequence", mode: "monitor", first_action_types: ["beneficiary.update"], then_action_types: ["payout.create"], forbidden_within: "PT30M" }] };
  const receipts = [rcpt({ intent: { action_type: "beneficiary.update" }, ts: "2026-09-12T12:00:00Z" })];
  const soon = rcpt({ intent: { action_type: "payout.create" }, ts: "2026-09-12T12:10:00Z" });
  assert.equal(violates(policy, receipts, soon).violated, true);
  const later = rcpt({ intent: { action_type: "payout.create" }, ts: "2026-09-12T12:45:00Z" });
  assert.equal(violates(policy, receipts, later).violated, false);
});

test("global scope with an incomplete gateway set is undetermined, not violated", () => {
  const policy = { clauses: [{ id: "g", type: "spend_limit", mode: "monitor", asset: "USDC", max_per_window: 5000000, window: "P1D", scope: "global" }] };
  const v = violates(policy, [spend(3000000, "2026-09-12T10:00:00Z")], spend(3000000, "2026-09-12T12:00:00Z"), { gatewaysComplete: false });
  assert.equal(v.violated, false);
  assert.equal(v.undetermined, true);
});

test("inputs_hash is a stable 64-char hex over identical inputs", () => {
  const policy = { clauses: [{ id: "tx-cap", type: "spend_limit", asset: "USDC", max_per_action: 1000000 }] };
  const claimed = spend(500000, "2026-09-12T12:00:00Z");
  const a = violates(policy, [], claimed).inputs_hash;
  const b = violates(policy, [], claimed).inputs_hash;
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, b);
});
