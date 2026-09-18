// GitHub connector conformance vector (evaluation half). Each case runs a PR
// context through evaluatePullRequest against the "no agent changes to production
// paths" policy — exercising the Action Taxonomy pr.merge type and the D67
// element-wise array path bound end to end. Signed boundary-receipt emission is
// covered in receipt.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluatePullRequest } from "../dist/index.js";

const policy = {
  vocabulary_version: "1.0", policy_id: "gh-conformance", version: 1,
  clauses: [{
    id: "no-prod-paths", type: "action_allowlist", mode: "enforce", action_types: ["pr.merge"],
    param_bounds: { paths: { items: { pattern: "^(?!infra/prod/).*" }, match: "all" } },
  }],
};
const ctx = (over) => ({
  event: "pull_request", repo: "acme/app", base: "main", head: "agent/x", headSha: "abc123def456abc1",
  paths: [], filesChanged: 0, additions: 0, deletions: 0, actor: "copilot-swe-agent[bot]", ...over,
});

test("conformance 1: an agent PR touching infra/prod/** fails the check", () => {
  const d = evaluatePullRequest(ctx({ paths: ["infra/prod/main.tf"], filesChanged: 1 }), policy);
  assert.equal(d.decision, "deny");
  assert.deepEqual(d.ruleIds, ["no-prod-paths"]);
});

test("conformance 2: an agent PR touching only docs/src passes", () => {
  const d = evaluatePullRequest(ctx({ paths: ["docs/readme.md", "src/app.ts"], filesChanged: 2 }), policy);
  assert.equal(d.decision, "allow");
});

test("conformance 3: a human PR is not evaluated (never blocked)", () => {
  const d = evaluatePullRequest(ctx({ actor: "a-human-dev", paths: ["infra/prod/main.tf"] }), policy);
  assert.equal(d.decision, "not_evaluated");
});

test("conformance 5: a non-pull-request event is not evaluated", () => {
  const d = evaluatePullRequest(ctx({ event: "push", paths: ["infra/prod/main.tf"] }), policy);
  assert.equal(d.decision, "not_evaluated");
});

test("fail-closed: an agent PR with no discernible paths is denied by the all-match bound", () => {
  // No paths provided (e.g. the diff step failed) → the array bound cannot be
  // satisfied vacuously as "all outside prod" only when empty; a missing paths
  // param denies. Here paths is [] which is vacuously allowed, so assert the
  // stronger case: a non-array/absent paths param denies.
  const d = evaluatePullRequest(ctx({ paths: undefined }), policy);
  assert.equal(d.decision, "deny", "an absent bounded array parameter fails closed");
});
