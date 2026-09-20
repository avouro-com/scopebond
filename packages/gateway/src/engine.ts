// The policy engine: run scopebond-verify over the proposed action + prior
// executed receipts, then map the verdict to a real-time decision by the violated
// clause's mode. enforce → deny (not executed); monitor → allow but flag (covered);
// require_approval → hold. No violation → allow.

import { violates } from "@scopebond/verify";
import type { Policy, Receipt, Verdict, Intent, Approval } from "@scopebond/verify";
import type { RealtimeResult } from "./receipts.js";

export interface Decision {
  allow: boolean;
  realtime_result: RealtimeResult;
  verdict: Verdict;
  clause_mode: string | null;
}

// In cooperative (check_only) enforcement the gateway decides but does not act;
// an allowed action is recorded as `cooperative_allow` with executed:false, because
// only the agent knows it truly ran. For a windowed clause (rate_limit, spend_limit,
// sequence) to work in that mode, a prior cooperative allow must still count as
// something that happened — otherwise every action looks like the first. This
// coerces such priors to executed for the live decision only; stored receipts keep
// executed:false and claim-time `violates()` is unaffected.
function countCooperative(r: Receipt): Receipt {
  const state = (r as { execution?: { state?: string } }).execution?.state;
  return r.executed !== true && state === "cooperative_allow" ? { ...r, executed: true } : r;
}

export function evaluate(
  policy: Policy,
  priorExecuted: Receipt[],
  req: { intent: Intent; approval?: Approval; intent_hash: string },
  at: string,
  opts: { gatewaysComplete?: boolean; cooperative?: boolean } = {},
): Decision {
  const prior = opts.cooperative ? priorExecuted.map(countCooperative) : priorExecuted;
  const candidate: Receipt = {
    intent: req.intent,
    executed: true, // hypothetical: would executing this violate policy?
    timestamp: at,
    intent_hash: req.intent_hash,
    approval: req.approval,
  };
  const verdict = violates(policy, prior, candidate, { at, gatewaysComplete: opts.gatewaysComplete });
  if (verdict.undetermined) {
    return { allow: false, realtime_result: "deny", verdict, clause_mode: "enforce" };
  }
  if (!verdict.violated) {
    const approvalApplied = !!req.approval && (policy.clauses ?? []).some((clause) =>
      clause.type === "require_approval" &&
      Array.isArray(clause.action_types) && clause.action_types.includes(req.intent.action_type) &&
      Array.isArray(clause.approvers) && clause.approvers.includes(req.approval?.approver),
    );
    return {
      allow: true,
      realtime_result: approvalApplied ? "approved" : "allow",
      verdict,
      clause_mode: approvalApplied ? "require_approval" : null,
    };
  }

  const clause = (policy.clauses ?? []).find((c) => c.id === verdict.clause_id);
  const mode = clause?.type === "require_approval" ? "require_approval" : ((clause?.mode as string) ?? "enforce");

  // monitor: let it through but sign+log; the violation is covered at claim time.
  if (mode === "monitor") return { allow: true, realtime_result: "deny", verdict, clause_mode: mode };
  // require_approval: hold (a valid approval would have cleared the verdict).
  if (mode === "require_approval") return { allow: false, realtime_result: "timeout", verdict, clause_mode: mode };
  // enforce (default): block in real time.
  return { allow: false, realtime_result: "deny", verdict, clause_mode: mode };
}
