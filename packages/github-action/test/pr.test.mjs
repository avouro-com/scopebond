import { test } from "node:test";
import assert from "node:assert/strict";
import { mapPullRequest, evaluatePullRequest, isAgentActor } from "../dist/index.js";

const base = {
  event: "pull_request", repo: "acme/app", base: "main", head: "agent/patch",
  headSha: "0f1e2d3c4b5a6978", filesChanged: 1, additions: 10, deletions: 2,
  actor: "copilot-swe-agent[bot]",
};
const noProdPaths = {
  vocabulary_version: "1.0", policy_id: "gh", version: 1,
  clauses: [{
    id: "no-prod", type: "action_allowlist", mode: "enforce", action_types: ["pr.merge"],
    param_bounds: { paths: { items: { pattern: "^(?!infra/prod/).*" }, match: "all" } },
  }],
};

test("mapPullRequest normalizes to the gated pr.merge action", () => {
  const a = mapPullRequest({ ...base, paths: ["src/a.ts"] });
  assert.equal(a.action_type, "pr.merge");
  assert.deepEqual(a.params.paths, ["src/a.ts"]);
  assert.equal(a.params.repo, "acme/app");
});

test("isAgentActor recognizes known coding-agent bots and rejects humans", () => {
  assert.equal(isAgentActor("copilot-swe-agent[bot]"), true);
  assert.equal(isAgentActor("devin-ai-integration[bot]"), true);
  assert.equal(isAgentActor("a-human-dev"), false);
});

test("a governed-agent PR within policy is allowed", () => {
  const d = evaluatePullRequest({ ...base, paths: ["src/checkout.ts", "docs/x.md"] }, noProdPaths);
  assert.equal(d.decision, "allow");
  assert.equal(d.actionType, "pr.merge");
  assert.deepEqual(d.attribution, { kind: "asserted", actor: "copilot-swe-agent[bot]" });
  assert.equal(d.outcomeRef, "0f1e2d3c4b5a6978");
});

test("a governed-agent PR touching a production path is denied", () => {
  const d = evaluatePullRequest({ ...base, paths: ["src/checkout.ts", "infra/prod/main.tf"] }, noProdPaths);
  assert.equal(d.decision, "deny");
  assert.deepEqual(d.ruleIds, ["no-prod"]);
});

test("options can extend the governed-agent actor set", () => {
  const d = evaluatePullRequest({ ...base, actor: "our-internal-agent[bot]", paths: ["infra/prod/x.tf"] },
    noProdPaths, { agentActors: ["our-internal-agent[bot]"] });
  assert.equal(d.decision, "deny");
});

test("claude[bot] and github-actions[bot] are governed coding-agent actors (SB68)", () => {
  assert.equal(isAgentActor("claude[bot]"), true);
  assert.equal(isAgentActor("github-actions[bot]"), true);
  const d = evaluatePullRequest({ ...base, actor: "claude[bot]", paths: ["infra/prod/main.tf"] }, noProdPaths);
  assert.equal(d.decision, "deny", "an out-of-policy claude[bot] PR is denied");
  assert.deepEqual(d.attribution, { kind: "asserted", actor: "claude[bot]" });
});

test("time_window binds because evaluation uses a real timestamp, not epoch 0 (SB68)", () => {
  const businessHours = {
    vocabulary_version: "1.0", policy_id: "gh-tw", version: 1,
    clauses: [
      { id: "merge", type: "action_allowlist", mode: "enforce", action_types: ["pr.merge"] },
      { id: "hours", type: "time_window", mode: "enforce", start: "13:00", end: "21:00" },
    ],
  };
  // 15:00 UTC is inside the window → allowed.
  const inHours = evaluatePullRequest({ ...base, paths: ["src/a.ts"] }, businessHours, { now: () => "2026-09-21T15:00:00Z" });
  assert.equal(inHours.decision, "allow", inHours.reason);
  // 03:00 UTC is outside the window → denied (epoch 0 would have made this meaningless).
  const offHours = evaluatePullRequest({ ...base, paths: ["src/a.ts"] }, businessHours, { now: () => "2026-09-21T03:00:00Z" });
  assert.equal(offHours.decision, "deny", "an out-of-hours merge is denied");
});
