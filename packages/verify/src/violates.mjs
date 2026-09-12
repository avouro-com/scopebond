// @scopebond/verify — the deterministic verdict library.
//
// violates(policy, receipts, claimed, opts) → { violated, clause_id, explanation,
//   inputs_hash, undetermined? }  (POLICY_VOCABULARY.md §7)
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

const norm = (r) => (r && r.payload ? r.payload : r) || {};
const ms = (isoTs) => Date.parse(isoTs);

// Minimal ISO-8601 duration → milliseconds (days/hours/minutes/seconds).
export function durationToMs(d) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(d || "");
  if (!m) throw new Error(`unsupported duration: ${d}`);
  const [, dd, hh, mm, ss] = m.map((x) => (x ? Number(x) : 0));
  return ((dd * 24 + hh) * 60 + mm) * 60 * 1000 + ss * 1000;
}

// Stable JSON for the inputs hash. (RFC 8785 JCS is the exact target; this is a
// deterministic sorted-key serialization sufficient for reproducibility here.)
function canonical(v) {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object") {
    return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
  }
  return JSON.stringify(v);
}
function inputsHash(policy, receipts, claimed, at) {
  return createHash("sha256").update(canonical({ policy, receipts, claimed, at })).digest("hex");
}

function verdict(violated, clause_id, explanation, hash, extra = {}) {
  return { violated, clause_id, explanation, inputs_hash: hash, ...extra };
}

export function violates(policy, receipts, claimed, opts = {}) {
  const c = norm(claimed);
  const rs = (receipts || []).map(norm);
  const at = opts.at ? ms(opts.at) : ms(c.timestamp);
  const hash = inputsHash(policy, rs, c, opts.at ?? c.timestamp);

  // Nothing executed → nothing happened → no violation.
  if (c.executed !== true) return verdict(false, null, "claimed action was not executed", hash);

  // Executed receipts in the window ending at `at`, deduped by intent_hash.
  const executed = [...rs, c].filter((r) => r.executed === true);
  const dedup = new Map();
  for (const r of executed) dedup.set(r.intent_hash ?? JSON.stringify(r.intent) + r.timestamp, r);
  const executedUnique = [...dedup.values()];
  const inWindow = (r, windowMs) => { const t = ms(r.timestamp); return t <= at && t > at - windowMs; };

  let undetermined = null;

  for (const clause of policy.clauses || []) {
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
        (r) => clause.action_types.includes(r.intent?.action_type) && inWindow(r, w)
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
                 at - ms(r.timestamp) < gap && ms(r.timestamp) <= at
        );
        if (prior) return verdict(true, clause.id, `then-action within ${clause.forbidden_within} of a first-action`, hash);
      }
    }

    else if (t === "time_window") {
      const d = new Date(at);
      const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCHours() >= 0 ? d.getUTCDay() : d.getUTCDay()];
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
