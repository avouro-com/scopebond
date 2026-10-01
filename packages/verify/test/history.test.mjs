// historyNeed / boundPrior: the history a policy can read, and the proof that reading
// only that much never changes a decision.

import { test } from "node:test";
import assert from "node:assert/strict";
import { historyNeed, boundPrior } from "../dist/violates.js";
import { violatesBoth } from "./bounded.mjs";

const valid = (clauses) => ({ vocabulary_version: "1.0", policy_id: "h", version: 1, clauses });
const HOUR = 3_600_000;

test("historyNeed: stateless policies (the coding-agent starter shape) need none", () => {
  assert.deepEqual(historyNeed(valid([
    { id: "a", type: "action_allowlist", mode: "enforce", action_types: ["fs.read", "git.push"] },
    { id: "m", type: "action_allowlist", mode: "monitor", action_types: ["net.fetch"] },
    { id: "f", type: "force_push_guard", mode: "enforce" },
    { id: "k", type: "key_policy", active_keys: ["kid1"] },
  ])), { kind: "none" });
});

test("historyNeed: the window is the longest rate/spend window or sequence gap", () => {
  assert.deepEqual(historyNeed(valid([
    { id: "r", type: "rate_limit", action_types: ["x"], max_count: 1, window: "PT1H" },
    { id: "s", type: "spend_limit", asset: "USDC", max_per_window: 5, window: "P1D", scope: "global" },
    { id: "q", type: "sequence", first_action_types: ["a"], then_action_types: ["b"], min_gap: "PT2H", forbidden_within: "PT3H" },
  ])), { kind: "window", ms: 24 * HOUR });
  assert.deepEqual(historyNeed(valid([
    { id: "q", type: "sequence", first_action_types: ["a"], then_action_types: ["b"], forbidden_within: "PT3H" },
  ])), { kind: "window", ms: 3 * HOUR });
});

test("historyNeed: a per-action-only spend limit reads no history", () => {
  assert.deepEqual(historyNeed(valid([
    { id: "s", type: "spend_limit", asset: "USDC", max_per_action: 5 },
  ])), { kind: "none" });
});

test("historyNeed: unanalysed clause types and invalid policies need everything", () => {
  assert.deepEqual(historyNeed(valid([
    { id: "a", type: "action_allowlist", action_types: ["x"] },
    { id: "o", type: "oracle_condition", oracle_id: "feed", predicate: "price > 1", best_effort: true },
  ])), { kind: "all" });
  assert.deepEqual(historyNeed({ clauses: "nope" }), { kind: "all" });
});

test("boundPrior: drops only receipts at or before at - window; keeps unparseable timestamps", () => {
  const at = "2026-09-12T12:00:00.000Z";
  const r = (ts) => ({ intent: { action_type: "x" }, executed: true, timestamp: ts });
  const edge = r("2026-09-12T11:00:00.000Z"); // exactly at - 1h: outside (window is (at-w, at])
  const inside = r("2026-09-12T11:00:00.001Z");
  const future = r("2026-09-12T13:00:00.000Z");
  const bad = r("not a time");
  const wrapped = { payload: r("2026-09-12T11:30:00.000Z"), signature: {} };
  const out = boundPrior({ kind: "window", ms: HOUR }, [edge, inside, future, bad, wrapped], at);
  assert.deepEqual(out, [inside, future, bad, wrapped]);
  assert.deepEqual(boundPrior({ kind: "none" }, [inside], at), []);
  assert.deepEqual(boundPrior({ kind: "all" }, [edge], at), [edge]);
});

test("window edges: a receipt exactly one window old neither counts nor matters", () => {
  const policy = valid([
    { id: "rl", type: "rate_limit", action_types: ["x"], max_count: 1, window: "PT1H" },
    { id: "seq", type: "sequence", first_action_types: ["a"], then_action_types: ["x"], min_gap: "PT1H" },
  ]);
  const at = "2026-09-12T12:00:00.000Z";
  const prior = [
    { intent: { action_type: "x" }, executed: true, timestamp: "2026-09-12T11:00:00.000Z", action_id: "p1" },
    { intent: { action_type: "a" }, executed: true, timestamp: "2026-09-12T11:00:00.000Z", action_id: "p2" },
    { intent: { action_type: "x" }, executed: true, timestamp: "2026-09-12T11:00:00.001Z", action_id: "p3" },
  ];
  const claimed = { intent: { action_type: "x" }, executed: true, timestamp: at, action_id: "c" };
  assert.equal(violatesBoth(policy, prior, claimed).clause_id, "rl");
  assert.equal(violatesBoth(policy, prior.slice(0, 2), claimed).violated, false);
});

// Deterministic pseudo-random histories across rate, spend (principal and global),
// sequence and a stateless allowlist, compared bounded vs. unbounded at every step.
test("randomized histories: bounded and unbounded decisions agree", () => {
  let seed = 0x5eed;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  const policies = [
    valid([{ id: "rl", type: "rate_limit", mode: "enforce", action_types: ["pay", "x"], max_count: 3, window: "PT2H" }]),
    valid([{ id: "sp", type: "spend_limit", mode: "monitor", asset: "USDC", max_per_window: 100, window: "PT6H", scope: "principal" }]),
    valid([{ id: "sg", type: "spend_limit", mode: "enforce", asset: "USDC", max_per_action: 80, max_per_window: 150, window: "P1D", scope: "global" }]),
    valid([{ id: "sq", type: "sequence", mode: "enforce", first_action_types: ["a"], then_action_types: ["pay"], min_gap: "PT30M", forbidden_within: "PT90M" }]),
    valid([
      { id: "al", type: "action_allowlist", mode: "enforce", action_types: ["pay", "x", "a"] },
      { id: "rl", type: "rate_limit", mode: "monitor", action_types: ["x"], max_count: 2, window: "PT45M" },
      { id: "sq", type: "sequence", mode: "enforce", first_action_types: ["x"], then_action_types: ["a"], min_gap: "PT10M" },
    ]),
  ];
  const base = Date.parse("2026-09-01T00:00:00.000Z");
  let checked = 0;
  for (const policy of policies) {
    for (const gatewaysComplete of [true, false]) {
      const history = [];
      let t = base;
      for (let i = 0; i < 300; i++) {
        t += Math.floor(rand() * 40 * 60_000);
        const type = pick(["pay", "x", "a"]);
        const r = {
          intent: { action_type: type, ...(type === "pay" ? { asset: "USDC", amount: Math.floor(rand() * 60) } : {}) },
          executed: rand() < 0.8,
          timestamp: new Date(t).toISOString(),
          action_id: `act-${i}`,
        };
        // Occasionally re-record the same action (a reconciled outcome) — same id, same time.
        if (i > 0 && rand() < 0.05) history.push({ ...history[history.length - 1], executed: !history[history.length - 1].executed });
        violatesBoth(policy, history, { ...r, executed: true }, { gatewaysComplete });
        checked++;
        history.push(r);
      }
    }
  }
  assert.equal(checked, policies.length * 2 * 300);
});
