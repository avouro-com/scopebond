// Shared by the verdict suites: run each verdict twice, over the full prior set and over
// the bounded set a live gateway evaluates (`boundPrior(historyNeed(policy), …)`), and
// fail unless both reach the same decision. The full-set verdict is returned, so every
// existing expectation still checks the reference behaviour.

import assert from "node:assert/strict";
import { violates, historyNeed, boundPrior } from "../dist/violates.js";

const decision = (v) => ({
  violated: v.violated, clause_id: v.clause_id, explanation: v.explanation, undetermined: !!v.undetermined,
});

export function violatesBoth(policy, receipts, claimed, opts = {}) {
  const full = violates(policy, receipts, claimed, opts);
  const at = opts.at ?? (claimed?.payload ?? claimed)?.timestamp ?? "";
  const bounded = violates(policy, boundPrior(historyNeed(policy), receipts ?? [], at), claimed, opts);
  assert.deepEqual(decision(bounded), decision(full), "bounded prior history changed the decision");
  return full;
}
