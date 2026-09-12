// @scopebond/verify — the deterministic verdict library.
//
// violates(policy, receipts, claimed, opts) → Verdict  (POLICY_VOCABULARY.md §7)
//
// Invariants:
//   - Pure & deterministic: no network, no wall-clock. The evaluation timestamp
//     is an input (opts.at, default = claimed.timestamp).
//   - Only EXECUTED actions can be violations; denied/not-executed actions never
//     count toward window totals. This is what makes a prevented action (enforce,
//     denied, not executed) a non-violation and a monitored over-limit action
//     (executed) a covered violation — the coverage buckets of §4/§5 fall out.
//   - Ambiguity resolves for the operator (limits compared with strict `>`; exactly
//     at the limit is allowed).
//   - `global`-scope clauses need every gateway's receipts; if the caller signals
//     the set is incomplete, the verdict is `undetermined`, not `violated`.
//
// This is a first faithful slice: spend_limit, rate_limit, require_approval,
// sequence, and time_window. Allowlist/denylist, contract, oracle, and key_policy
// clauses are [PLANNED]. See README.

import { createHash } from "node:crypto";

export type Mode = "enforce" | "monitor" | "require_approval";

export interface Clause {
  id: string;
  type: string;
  mode?: Mode;
  description?: string;
  [key: string]: unknown;
}

export interface Policy {
  clauses?: Clause[];
  [key: string]: unknown;
}

export interface Intent {
  action_type?: string;
  asset?: string;
  amount?: number;
  params?: Record<string, unknown>;
}

export interface Approval {
  approver?: string;
  intent_hash?: string;
}

export interface Receipt {
  intent?: Intent;
  executed?: boolean;
  realtime_result?: string;
  approval?: Approval;
  intent_hash?: string;
  timestamp?: string;
  attester?: { kind?: string; kid?: string };
  /** ACTA envelope: a receipt may be wrapped as { payload, signature }. */
  payload?: Receipt;
  [key: string]: unknown;
}

export interface Verdict {
  violated: boolean;
  clause_id: string | null;
  explanation: string;
  inputs_hash: string;
  undetermined?: boolean;
}

export interface Options {
  /** Evaluation timestamp (ISO). Defaults to the claimed receipt's timestamp. */
  at?: string;
  /** For `global`-scope clauses: whether every gateway's receipts are present. */
  gatewaysComplete?: boolean;
}

type AnyClause = Clause & Record<string, any>;

const norm = (r: unknown): Receipt => {
  const rec = r as Receipt | undefined;
  return (rec && rec.payload ? rec.payload : rec) || {};
};
const ms = (isoTs: string | undefined): number => Date.parse(isoTs ?? "");

// Minimal ISO-8601 duration → milliseconds (days/hours/minutes/seconds).
export function durationToMs(d: string): number {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(d || "");
  if (!m) throw new Error(`unsupported duration: ${d}`);
  const [, dd, hh, mm, ss] = m.map((x) => (x ? Number(x) : 0)) as number[];
  return ((dd * 24 + hh) * 60 + mm) * 60 * 1000 + ss * 1000;
}

// Stable JSON for the inputs hash. (RFC 8785 JCS is the exact target; this is a
// deterministic sorted-key serialization sufficient for reproducibility here.)
function canonical(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object") {
    const obj = v as Record<string, unknown>;
    return "{" + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ":" + canonical(obj[k])).join(",") + "}";
  }
  return JSON.stringify(v);
}
function inputsHash(policy: Policy, receipts: Receipt[], claimed: Receipt, at: string | undefined): string {
  return createHash("sha256").update(canonical({ policy, receipts, claimed, at })).digest("hex");
}

function verdict(
  violated: boolean, clause_id: string | null, explanation: string,
  hash: string, extra: Partial<Verdict> = {},
): Verdict {
  return { violated, clause_id, explanation, inputs_hash: hash, ...extra };
}

export function violates(
  policy: Policy, receipts: Receipt[] | undefined, claimed: Receipt, opts: Options = {},
): Verdict {
  const c = norm(claimed);
  const rs = (receipts ?? []).map(norm);
  const at = opts.at ? ms(opts.at) : ms(c.timestamp);
  const hash = inputsHash(policy, rs, c, opts.at ?? c.timestamp);

  // Nothing executed → nothing happened → no violation.
  if (c.executed !== true) return verdict(false, null, "claimed action was not executed", hash);

  // Executed receipts in the window ending at `at`, deduped by intent_hash.
  const executed = [...rs, c].filter((r) => r.executed === true);
  const dedup = new Map<string, Receipt>();
  for (const r of executed) dedup.set(r.intent_hash ?? JSON.stringify(r.intent) + r.timestamp, r);
  const executedUnique = [...dedup.values()];
  const inWindow = (r: Receipt, windowMs: number): boolean => { const t = ms(r.timestamp); return t <= at && t > at - windowMs; };

  let undetermined: string | null = null;

  for (const clause of (policy.clauses ?? []) as AnyClause[]) {
    const t = clause.type;

    if (t === "spend_limit") {
      const asset = clause.asset;
      const amt = c.intent?.asset === asset ? (c.intent?.amount ?? 0) : 0;
      if (clause.max_per_action != null && amt > clause.max_per_action) {
        return verdict(true, clause.id, `per-action ${amt} exceeds max_per_action ${clause.max_per_action}`, hash);
      }
      if (clause.max_per_window != null) {
        if (clause.scope === "global" && opts.gatewaysComplete === false) {
          undetermined = clause.id; continue;
        }
        const w = durationToMs(clause.window);
        const sum = executedUnique
          .filter((r) => r.intent?.asset === asset && inWindow(r, w))
          .reduce((s, r) => s + (r.intent?.amount ?? 0), 0);
        if (sum > clause.max_per_window) {
          return verdict(true, clause.id, `windowed total ${sum} exceeds max_per_window ${clause.max_per_window}`, hash);
        }
      }
    }

    else if (t === "rate_limit") {
      if (clause.scope === "global" && opts.gatewaysComplete === false) { undetermined = clause.id; continue; }
      const w = durationToMs(clause.window);
      const count = executedUnique.filter(
        (r) => clause.action_types.includes(r.intent?.action_type) && inWindow(r, w),
      ).length;
      if (count > clause.max_count) {
        return verdict(true, clause.id, `count ${count} exceeds max_count ${clause.max_count}`, hash);
      }
    }

    else if (t === "require_approval") {
      if (clause.action_types.includes(c.intent?.action_type)) {
        const a = c.approval;
        const ok = a && clause.approvers.includes(a.approver) && a.intent_hash === c.intent_hash;
        if (!ok) return verdict(true, clause.id, "executed without a valid approval record", hash);
      }
    }

    else if (t === "sequence") {
      if (clause.then_action_types.includes(c.intent?.action_type) && clause.forbidden_within) {
        const gap = durationToMs(clause.forbidden_within);
        const prior = executedUnique.find(
          (r) => r !== c && clause.first_action_types.includes(r.intent?.action_type) &&
                 at - ms(r.timestamp) < gap && ms(r.timestamp) <= at,
        );
        if (prior) return verdict(true, clause.id, `then-action within ${clause.forbidden_within} of a first-action`, hash);
      }
    }

    else if (t === "time_window") {
      const d = new Date(at);
      const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()];
      const hhmm = d.toISOString().slice(11, 16);
      const dayOk = !clause.days || clause.days.length === 0 || clause.days.includes(day);
      const timeOk = hhmm >= clause.start && hhmm <= clause.end;
      if (!(dayOk && timeOk)) return verdict(true, clause.id, `executed outside allowed window (${hhmm} UTC)`, hash);
    }
    // else: clause type not yet implemented in this slice; skipped.
  }

  if (undetermined) {
    return verdict(false, undetermined, "global-scope clause needs all gateways' receipts; set incomplete", hash, { undetermined: true });
  }
  return verdict(false, null, "no clause violated", hash);
}
