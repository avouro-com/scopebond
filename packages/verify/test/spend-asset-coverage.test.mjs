// A spend limit reads an action's asset and amount. An asset spelled another way (case, width, surrounding space)
// is the same asset, an amount without an asset cannot be checked, and a clause that names its money actions by
// type denies one of them that carries no asset, an asset the policy does not limit for it, or no amount: none of
// these may pass as spending nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { validatePolicy } from "../dist/violates.js";
import { violatesBoth as violates } from "./bounded.mjs";

const AT = "2026-10-26T12:00:00Z";
const action = (intent, ts = AT, id = "a1") => ({ intent, executed: true, realtime_result: "allow", intent_hash: id, action_id: id, timestamp: ts, attester: { kind: "gateway", kid: "g1" } });
const policy = (clauses) => ({ vocabulary_version: "1.0", policy_id: "spend", version: 1, clauses });
const ALLOW = { id: "pay", type: "action_allowlist", mode: "enforce", action_types: ["payment.send"] };

test("an asset in another case or width is limited as the clause's asset", () => {
  const p = policy([ALLOW, { id: "cap", type: "spend_limit", mode: "enforce", asset: "USDC", max_per_action: 100 }]);
  for (const asset of ["usdc", "Usdc", "ＵＳＤＣ", " USDC "]) {
    const v = violates(p, [], action({ action_type: "payment.send", asset, amount: 1000 }));
    assert.equal(v.violated, true, asset);
    assert.equal(v.clause_id, "cap", asset);
    assert.equal(v.failed_bound, "amount:max_per_action", asset);
  }
  assert.equal(violates(p, [], action({ action_type: "payment.send", asset: "usdc", amount: 50 })).violated, false, "within the cap");
});

test("a windowed total counts earlier actions in any spelling of the asset", () => {
  const p = policy([ALLOW, { id: "day", type: "spend_limit", mode: "enforce", asset: "USDC", max_per_window: 100, window: "P1D" }]);
  const prior = [action({ action_type: "payment.send", asset: "usdc", amount: 90 }, "2026-10-26T10:00:00Z", "p1")];
  const v = violates(p, prior, action({ action_type: "payment.send", asset: "USDC", amount: 20 }));
  assert.equal(v.violated, true);
  assert.equal(v.failed_bound, "amount:max_per_window");
});

test("an amount without an asset is denied under a spend limit", () => {
  const p = policy([ALLOW, { id: "cap", type: "spend_limit", mode: "enforce", asset: "USDC", max_per_action: 100 }]);
  const v = violates(p, [], action({ action_type: "payment.send", amount: 1000 }));
  assert.equal(v.violated, true);
  assert.equal(v.failed_bound, "asset:type");
});

test("a clause naming its money actions by type denies a covered action with no asset, an unlimited asset, or no amount", () => {
  const p = policy([ALLOW, { id: "cap", type: "spend_limit", mode: "enforce", asset: "USDC", action_types: ["payment.send"], max_per_action: 100 }]);
  assert.equal(validatePolicy(p).valid, true, JSON.stringify(validatePolicy(p)));
  const cases = [
    [{ action_type: "payment.send" }, "asset:type"],
    [{ action_type: "payment.send", amount: 1000 }, "asset:type"],
    [{ action_type: "payment.send", asset: "USD-C", amount: 1000 }, "asset:asset"],
    [{ action_type: "payment.send", asset: "usdc" }, "amount:type"],
    [{ action_type: "payment.send", asset: "usdc", amount: 1000 }, "amount:max_per_action"],
  ];
  for (const [intent, bound] of cases) {
    const v = violates(p, [], action(intent));
    assert.equal(v.violated, true, JSON.stringify(intent));
    assert.equal(v.clause_id, "cap", JSON.stringify(intent));
    assert.equal(v.failed_bound, bound, JSON.stringify(intent));
  }
  assert.equal(violates(p, [], action({ action_type: "payment.send", asset: "usdc", amount: 100 })).violated, false, "at the cap");
});

test("two typed clauses for one action type each limit their own asset", () => {
  const p = policy([
    ALLOW,
    { id: "usdc", type: "spend_limit", mode: "enforce", asset: "USDC", action_types: ["payment.send"], max_per_action: 100 },
    { id: "eur", type: "spend_limit", mode: "enforce", asset: "EUR", action_types: ["payment.send"], max_per_action: 10 },
  ]);
  assert.equal(violates(p, [], action({ action_type: "payment.send", asset: "eur", amount: 50 })).clause_id, "eur");
  assert.equal(violates(p, [], action({ action_type: "payment.send", asset: "EUR", amount: 5 })).violated, false);
  assert.equal(violates(p, [], action({ action_type: "payment.send", asset: "USDC", amount: 50 })).violated, false);
});

test("a spend clause's action_types must be a nonempty list of strings", () => {
  const bad = (action_types) => policy([{ id: "cap", type: "spend_limit", asset: "USDC", action_types, max_per_action: 1 }]);
  for (const v of [[], "payment.send", [1]]) assert.equal(validatePolicy(bad(v)).valid, false, JSON.stringify(v));
});
