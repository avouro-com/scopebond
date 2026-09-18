// @scopebond/github-action — the boundary-lane GitHub connector's evaluation
// runner. The library surface is the deterministic mapper and evaluator; the
// `scopebond-verify-pr` bin (and action.yml) wrap it for a required status check
// in the customer's Actions runner. Signed boundary-receipt emission is added in
// a following increment.

export {
  mapPullRequest, evaluatePullRequest, isAgentActor, KNOWN_AGENT_ACTORS,
} from "./pr.js";
export type { PullRequestContext, EvaluateOptions, PrDecision } from "./pr.js";
export { buildPullRequestReceipt } from "./receipt.js";
