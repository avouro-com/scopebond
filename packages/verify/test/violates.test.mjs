import { test } from "node:test";
import assert from "node:assert/strict";
import { violates, durationToMs, validateIntent, validatePolicy } from "../dist/violates.js";

const rcpt = (o) => ({
  intent: o.intent, executed: o.executed ?? true, realtime_result: o.rr ?? "allow",
  approval: o.approval, intent_hash: o.intent_hash, action_id: o.action_id, timestamp: o.ts,
  attester: { kind: "gateway", kid: "g1" },
});
const spend = (amount, ts, extra = {}) => rcpt({ intent: { action_type: "payout.create", asset: "USDC", amount }, ts, ...extra });
const valid = (fragment) => ({ vocabulary_version: "1.0", policy_id: "test", version: 1, ...fragment });

test("durationToMs parses ISO-8601 durations", () => {
  assert.equal(durationToMs("P1D"), 86400000);
  assert.equal(durationToMs("PT30M"), 1800000);
  assert.equal(durationToMs("PT4H"), 14400000);
});

test("prevented: a denied, non-executed over-limit action is not a violation (bucket A)", () => {
  const policy = valid({ clauses: [{ id: "tx-cap", type: "spend_limit", mode: "enforce", asset: "USDC", max_per_action: 1000000 }] });
  const claimed = spend(2000000, "2026-09-12T12:00:00Z", { executed: false, rr: "deny" });
  const v = violates(policy, [], claimed);
  assert.equal(v.violated, false);
});

test("covered row 4: a monitored, executed over-limit action is a violation", () => {
  const policy = valid({ clauses: [{ id: "tx-cap", type: "spend_limit", mode: "monitor", asset: "USDC", max_per_action: 1000000 }] });
  const claimed = spend(2000000, "2026-09-12T12:00:00Z", { rr: "deny" }); // executed anyway (monitor)
  const v = violates(policy, [], claimed);
  assert.equal(v.violated, true);
  assert.equal(v.clause_id, "tx-cap");
});

test("ambiguity resolves for the operator: exactly at the limit is allowed", () => {
  const policy = valid({ clauses: [{ id: "tx-cap", type: "spend_limit", mode: "enforce", asset: "USDC", max_per_action: 1000000 }] });
  const v = violates(policy, [], spend(1000000, "2026-09-12T12:00:00Z"));
  assert.equal(v.violated, false);
});

test("covered row 1: windowed aggregate over the limit (each action under it)", () => {
  const policy = valid({ clauses: [{ id: "daily", type: "spend_limit", mode: "monitor", asset: "USDC", max_per_window: 5000000, window: "P1D", scope: "principal" }] });
  const receipts = [spend(3000000, "2026-09-12T10:00:00Z")];
  const claimed = spend(3000000, "2026-09-12T12:00:00Z");
  const v = violates(policy, receipts, claimed);
  assert.equal(v.violated, true);
  assert.equal(v.clause_id, "daily");
});

test("distinct action ids count separately even with identical intents and timestamps", () => {
  const policy = valid({ clauses: [{ id: "daily", type: "spend_limit", mode: "enforce", asset: "USDC", max_per_window: 100, window: "P1D", scope: "principal" }] });
  const at = "2026-09-12T12:00:00Z";
  const prior = spend(60, at, { action_id: "action:000000000000001" });
  const claimed = spend(60, at, { action_id: "action:000000000000002" });
  assert.equal(violates(policy, [prior], claimed).violated, true);
});

test("covered row 3: rate limit exceeded across a window", () => {
  const policy = valid({ clauses: [{ id: "rl", type: "rate_limit", mode: "monitor", action_types: ["payout.create"], max_count: 2, window: "P1D" }] });
  const receipts = [spend(1, "2026-09-12T09:00:00Z"), spend(1, "2026-09-12T10:00:00Z")];
  const claimed = spend(1, "2026-09-12T11:00:00Z"); // 3rd in window
  assert.equal(violates(policy, receipts, claimed).violated, true);
});

test("covered row 5: executed without a valid approval; valid approval clears it", () => {
  const policy = valid({ clauses: [{ id: "appr", type: "require_approval", mode: "require_approval", action_types: ["payout.create"], approvers: ["key:ops-lead"] }] });
  const noApproval = rcpt({ intent: { action_type: "payout.create" }, ts: "2026-09-12T12:00:00Z", intent_hash: "abc" });
  assert.equal(violates(policy, [], noApproval).violated, true);

  const approved = rcpt({ intent: { action_type: "payout.create" }, ts: "2026-09-12T12:00:00Z", intent_hash: "abc", approval: { approver: "key:ops-lead", intent_hash: "abc" } });
  assert.equal(violates(policy, [], approved).violated, false);
});

test("covered row 6: sequence violation (pay within forbidden window of a beneficiary change)", () => {
  const policy = valid({ clauses: [{ id: "seq", type: "sequence", mode: "monitor", first_action_types: ["beneficiary.update"], then_action_types: ["payout.create"], forbidden_within: "PT30M" }] });
  const receipts = [rcpt({ intent: { action_type: "beneficiary.update" }, ts: "2026-09-12T12:00:00Z" })];
  const soon = rcpt({ intent: { action_type: "payout.create" }, ts: "2026-09-12T12:10:00Z" });
  assert.equal(violates(policy, receipts, soon).violated, true);
  const later = rcpt({ intent: { action_type: "payout.create" }, ts: "2026-09-12T12:45:00Z" });
  assert.equal(violates(policy, receipts, later).violated, false);
});

test("global scope with an incomplete gateway set is undetermined, not violated", () => {
  const policy = valid({ clauses: [{ id: "g", type: "spend_limit", mode: "monitor", asset: "USDC", max_per_window: 5000000, window: "P1D", scope: "global" }] });
  const v = violates(policy, [spend(3000000, "2026-09-12T10:00:00Z")], spend(3000000, "2026-09-12T12:00:00Z"), { gatewaysComplete: false });
  assert.equal(v.violated, false);
  assert.equal(v.undetermined, true);
});

test("inputs_hash is a stable 64-char hex over identical inputs", () => {
  const policy = valid({ clauses: [{ id: "tx-cap", type: "spend_limit", asset: "USDC", max_per_action: 1000000 }] });
  const claimed = spend(500000, "2026-09-12T12:00:00Z");
  const a = violates(policy, [], claimed).inputs_hash;
  const b = violates(policy, [], claimed).inputs_hash;
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, b);
});

test("policy and action validation reject incomplete or non-finite inputs", () => {
  assert.equal(validatePolicy({ clauses: [] }).valid, false);
  assert.equal(validatePolicy(valid({ clauses: [] })).valid, false);
  assert.equal(validateIntent({ action_type: "transfer", amount: "100" }).valid, false);
  assert.equal(validateIntent({ action_type: "transfer", params: { amount: Number.NaN } }).valid, false);
  assert.equal(validatePolicy(valid({ clauses: [{
    id: "approval", type: "require_approval", action_types: ["transfer"],
    approvers: ["key:a", "key:b"], min_approvals: 2,
  }] })).valid, false);
});

test("verifier selects enforce over an earlier monitor violation", () => {
  const policy = valid({ clauses: [
    { id: "monitor", type: "spend_limit", mode: "monitor", asset: "USDC", max_per_action: 10 },
    { id: "enforce", type: "spend_limit", mode: "enforce", asset: "USDC", max_per_action: 20 },
  ] });
  const result = violates(policy, [], spend(30, "2026-09-12T12:00:00Z"));
  assert.equal(result.violated, true);
  assert.equal(result.clause_id, "enforce");
});

test("action allowlists reject unlisted actions and nonnumeric bounded values", () => {
  const policy = valid({ clauses: [{
    id: "actions", type: "action_allowlist", mode: "enforce", action_types: ["transfer"],
    param_bounds: { amount: { min: 0, max: 100 } },
  }] });
  let result = violates(policy, [], rcpt({ intent: { action_type: "unknown", params: { amount: 1 } }, ts: "2026-09-12T12:00:00Z" }));
  assert.equal(result.violated, true);
  assert.match(result.explanation, /not allowlisted/);
  result = violates(policy, [], rcpt({ intent: { action_type: "transfer", params: { amount: "50" } }, ts: "2026-09-12T12:00:00Z" }));
  assert.equal(result.violated, true);
  assert.match(result.explanation, /finite number/);
});

test("array param bounds validate, and malformed shapes are rejected", () => {
  const withBound = (pb) => valid({ clauses: [{
    id: "p", type: "action_allowlist", mode: "enforce", action_types: ["pr.merge"], param_bounds: { paths: pb },
  }] });
  assert.equal(validatePolicy(withBound({ items: { pattern: "^x" }, match: "all" })).valid, true);
  assert.equal(validatePolicy(withBound({ items: { pattern: "^x" } })).valid, true, "match is optional");
  assert.equal(validatePolicy(withBound({ items: { enum: ["a", "b"] }, match: "any" })).valid, true);
  assert.equal(validatePolicy(withBound({ match: "all" })).valid, false, "match without items");
  assert.equal(validatePolicy(withBound({ items: { pattern: "^x" }, match: "some" })).valid, false, "unknown match");
  assert.equal(validatePolicy(withBound({ items: { pattern: "^x" }, min: 0 })).valid, false, "items and scalar are mutually exclusive");
  assert.equal(validatePolicy(withBound({ items: { items: { pattern: "^x" } } })).valid, false, "no nested items");
});

test("an action that no supported policy clause addresses fails closed", () => {
  const policy = valid({ clauses: [{
    id: "spend", type: "spend_limit", mode: "enforce", asset: "USDC", max_per_action: 100,
  }] });
  const result = violates(policy, [], rcpt({ intent: { action_type: "data.read" }, ts: "2026-09-12T12:00:00Z" }));
  assert.equal(result.violated, true);
  assert.equal(result.clause_id, null);
  assert.match(result.explanation, /not covered/);
});
