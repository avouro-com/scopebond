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

export function evaluate(
  policy: Policy,
  priorExecuted: Receipt[],
  req: { intent: Intent; approval?: Approval; intent_hash: string },
  at: string,
): Decision {
  const candidate: Receipt = {
    intent: req.intent,
    executed: true, // hypothetical: would executing this violate policy?
    timestamp: at,
    intent_hash: req.intent_hash,
    approval: req.approval,
  };
  const verdict = violates(policy, priorExecuted, candidate, { at });
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
