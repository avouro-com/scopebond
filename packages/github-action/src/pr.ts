// The GitHub connector's evaluation core: map a pull request to a normalized
// taxonomy action and decide it against policy with @scopebond/verify. Pure and
// deterministic, so the conformance vector runs against it directly. Enforcement
// is the required status check in the customer's own Actions runner (ADR-011 §2,
// D33) — no Scopebond-held credential and no GitHub SDK.

import { violates } from "@scopebond/verify";

export interface PullRequestContext {
  /** The GitHub event name (GITHUB_EVENT_NAME), e.g. "pull_request". */
  event: string;
  repo: string;        // owner/name
  base: string;        // base branch ref
  head: string;        // head branch ref
  headSha: string;     // the outcome reference for the receipt (per PR head)
  paths: string[];     // changed file paths
  filesChanged: number;
  additions: number;
  deletions: number;
  actor: string;       // the PR author login (e.g. copilot-swe-agent[bot])
}

// Known coding-agent bot actors on GitHub; attribution is asserted from the login.
// Extend via options; behavioral-fingerprint (inferred) attribution is a Cloud
// feature, out of this runner.
export const KNOWN_AGENT_ACTORS: readonly string[] = [
  "copilot-swe-agent[bot]", "copilot[bot]",
  "devin-ai-integration[bot]", "google-labs-jules[bot]",
  "chatgpt-codex-connector[bot]", "codex[bot]", "cursor[bot]",
  // Claude's GitHub app, and the generic Actions bot that authors PRs when a
  // coding agent runs inside a workflow. Governing github-actions[bot] can also
  // reach release/changeset PRs it authors; a policy that allows their paths is
  // unaffected, and a repo can narrow the set via `agentActors`.
  "claude[bot]", "github-actions[bot]",
];

export interface EvaluateOptions {
  /** Override or extend the governed-agent actor set. */
  agentActors?: readonly string[];
  /** The gate being evaluated; "merge" (default) maps to pr.merge. */
  gate?: "merge" | "deploy";
  /** Evaluation clock (ISO 8601). Defaults to now; injectable for tests. Used as
   *  the receipt timestamp and the evaluation instant, so time_window clauses bind. */
  now?: () => string;
}

export interface PrDecision {
  decision: "allow" | "deny" | "not_evaluated";
  reason: string;
  actionType: string;
  verdict?: unknown;
  ruleIds: string[];
  attribution: { kind: "asserted" | "inferred"; actor: string } | null;
  /** The PR head SHA — the boundary receipt's outcome_ref (Increment 2). */
  outcomeRef: string;
}

export function isAgentActor(actor: string, opts: EvaluateOptions = {}): boolean {
  return (opts.agentActors ?? KNOWN_AGENT_ACTORS).includes(actor);
}

/** Normalize the pull request to the taxonomy action being gated. */
export function mapPullRequest(ctx: PullRequestContext, opts: EvaluateOptions = {}): { action_type: string; params: Record<string, unknown> } {
  const action_type = (opts.gate ?? "merge") === "deploy" ? "deploy.release" : "pr.merge";
  return {
    action_type,
    params: {
      repo: ctx.repo, base: ctx.base, head: ctx.head,
      paths: ctx.paths, files_changed: ctx.filesChanged,
      additions: ctx.additions, deletions: ctx.deletions,
    },
  };
}

const isPullRequestEvent = (event: string) => event === "pull_request" || event === "pull_request_target";

/** Decide whether a pull request may merge under policy. Human (non-governed)
 * authors and non-PR events are `not_evaluated` (never blocked); a governed
 * agent's PR is evaluated, and an out-of-policy PR is `deny`. */
export function evaluatePullRequest(ctx: PullRequestContext, policy: unknown, opts: EvaluateOptions = {}): PrDecision {
  const outcomeRef = ctx.headSha;
  if (!isPullRequestEvent(ctx.event)) {
    return { decision: "not_evaluated", reason: `event "${ctx.event}" is not a pull request`, actionType: `tool.${ctx.event}`, ruleIds: [], attribution: null, outcomeRef };
  }
  if (!isAgentActor(ctx.actor, opts)) {
    return { decision: "not_evaluated", reason: `"${ctx.actor}" is not a governed agent`, actionType: "pr.merge", ruleIds: [], attribution: null, outcomeRef };
  }
  const intent = mapPullRequest(ctx, opts);
  const timestamp = opts.now?.() ?? new Date().toISOString();
  const claimed = { intent, executed: true, timestamp, intent_hash: outcomeRef };
  const verdict = violates(policy as never, [], claimed as never, { at: timestamp });
  const attribution = { kind: "asserted" as const, actor: ctx.actor };
  if (verdict.violated) {
    return {
      decision: "deny", reason: verdict.explanation || "the pull request is out of policy",
      actionType: intent.action_type, verdict, ruleIds: verdict.clause_id ? [verdict.clause_id] : [], attribution, outcomeRef,
    };
  }
  return { decision: "allow", reason: "the pull request is within policy", actionType: intent.action_type, verdict, ruleIds: [], attribution, outcomeRef };
}
