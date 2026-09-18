// GitHub connector (boundary lane): decide whether an agent's pull request may
// merge, as a required status check would in your own Actions runner. Pure and
// deterministic — no GitHub credential, no network. A governed agent's PR is
// evaluated against policy; a human's PR is never blocked.
// Run: `pnpm -r build && node examples/github-pr-gate.mjs`
import { evaluatePullRequest } from "@scopebond/github-action";

// Policy: an agent PR may merge only if *every* changed path stays out of
// infra/prod/** (the D67 element-wise array bound, match "all").
const policy = {
  vocabulary_version: "1.0", policy_id: "pr-gate", version: 1,
  clauses: [{
    id: "no-prod-paths", type: "action_allowlist", mode: "enforce", action_types: ["pr.merge"],
    param_bounds: { paths: { items: { pattern: "^(?!infra/prod/).*" }, match: "all" } },
    description: "No agent changes to infra/prod/**.",
  }],
};

// A base pull-request context; each case overrides the actor and changed paths.
const base = {
  event: "pull_request", repo: "acme/app", base: "main", head: "agent/x",
  headSha: "abc123def456abc1", filesChanged: 1, additions: 10, deletions: 0,
};

function gate(label, over) {
  const ctx = { ...base, ...over, filesChanged: (over.paths ?? []).length || base.filesChanged };
  const d = evaluatePullRequest(ctx, policy);
  console.log(`\n${label}`);
  console.log(`  actor = ${ctx.actor}  paths = ${JSON.stringify(ctx.paths)}`);
  console.log(`  decision = ${d.decision}  ·  ${d.reason}`);
  console.log(`  action_type = ${d.actionType}  attribution = ${d.attribution ? `${d.attribution.kind}:${d.attribution.actor}` : "none"}  outcome_ref = ${d.outcomeRef}`);
}

gate("human PR touching a production path (not a governed agent → never blocked)",
  { actor: "a-human-dev", paths: ["infra/prod/db.tf"] });
gate("agent PR touching only application code (all paths in policy → allow)",
  { actor: "copilot-swe-agent[bot]", paths: ["src/app.ts", "src/util.ts"] });
gate("agent PR touching a production path (out of policy → deny, cannot merge)",
  { actor: "copilot-swe-agent[bot]", paths: ["src/app.ts", "infra/prod/db.tf"] });
