// Emit a signed boundary receipt for a decided pull request. The receipt attests
// what the gate allowed or blocked against the pinned policy at the PR head; it
// never claims the agent's sandbox action was prevented or that the agent signed
// anything (evidence_class: "boundary"). Signed with the customer's own key in
// their Actions runner — Scopebond holds no key.

import { buildBoundaryReceipt, attesterFromPrivateKeyPem } from "@scopebond/gateway";
import type { SignedReceipt } from "@scopebond/gateway";
import { mapPullRequest } from "./pr.js";
import type { PullRequestContext, PrDecision, EvaluateOptions } from "./pr.js";

/** Build a signed boundary receipt for a governed-agent PR decision (allow/deny).
 * A `not_evaluated` PR (human author / non-PR event) emits no receipt. */
export async function buildPullRequestReceipt(
  ctx: PullRequestContext,
  policy: unknown,
  decision: PrDecision,
  attesterKeyPem: string,
  opts: EvaluateOptions = {},
): Promise<SignedReceipt> {
  if (!decision.attribution) throw new Error("a boundary receipt requires a governed-agent attribution");
  if (decision.decision === "not_evaluated") throw new Error("not_evaluated pull requests emit no receipt");
  const attester = attesterFromPrivateKeyPem(attesterKeyPem);
  const intent = mapPullRequest(ctx, opts);
  const gate = (opts.gate ?? "merge") === "deploy" ? "deploy" : "merge";
  return buildBoundaryReceipt({
    intent,
    policy: policy as never,
    gate,
    outcomeRef: ctx.headSha,
    attribution: decision.attribution,
    realtimeResult: decision.decision === "deny" ? "deny" : "allow",
  }, attester);
}
