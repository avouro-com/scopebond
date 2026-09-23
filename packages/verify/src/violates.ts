// @scopebond/verify — the deterministic verdict library.
//
// violates(policy, receipts, claimed, opts) → Verdict  (POLICY_VOCABULARY.md §7)
//
// Invariants:
//   - Pure & deterministic: no network, no wall-clock. The evaluation timestamp
//     is an input (opts.at, default = claimed.timestamp).
//   - Only EXECUTED actions can be violations; denied/not-executed actions never
//     count toward window totals. Prevented actions (enforce, denied, not
//     executed) are non-violations; monitored actions that executed out of policy
//     are covered violations — the coverage buckets of §4/§5 fall out of this.
//   - Ambiguity resolves for the operator (limits compared with strict `>`; exactly
//     at the limit is allowed).
//   - `global`-scope clauses need every gateway's receipts; if the caller signals
//     the set is incomplete, the verdict is `undetermined`, not `violated`.
//
// Intent shape conventions used here (finalized alongside the gateway/SDK):
//   - amount actions:  intent.asset, intent.amount
//   - HTTP actions:    intent.params.host, .path, .method
//   - on-chain:        intent.params.to, .chain_id, .contract, .selector
//   - signing key:     intent.signer (the agent key id)
//
// Implemented: spend_limit, rate_limit, require_approval, sequence, time_window,
// endpoint_allowlist/denylist, address_allowlist/denylist, contract_allowlist,
// action_allowlist (param_bounds), key_policy. `oracle_condition` is [PLANNED]
// (best-effort external data; not yet evaluated).

import { createHash } from "node:crypto";
import { canonical } from "@scopebond/policy-schema/canonical";
export { canonical } from "@scopebond/policy-schema/canonical";
import { validateAction, validatePolicyShape } from "./validate.js";
import type { ValidationResult } from "./validate.js";
export type { ValidationResult } from "./validate.js";

export type Mode = "enforce" | "monitor" | "require_approval";

export interface Clause {
  id: string;
  type: string;
  mode?: Mode;
  description?: string;
  [key: string]: unknown;
}

export interface Policy {
  vocabulary_version?: string;
  policy_id?: string;
  version?: number;
  clauses?: Clause[];
  [key: string]: unknown;
}

export interface Intent {
  action_type?: string;
  asset?: string;
  amount?: number;
  signer?: string;
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
  action_id?: string;
  action_ref?: { action_id?: string };
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

/** Validate the complete policy boundary, including semantic constraints that
 * JSON Schema cannot express clearly (unique clause ids and coherent bounds). */
export function validatePolicy(value: unknown): ValidationResult {
  const shape = validatePolicyShape(value);
  const errors = [...shape.errors];
  if (shape.valid) {
    const policy = value as Policy;
    const ids = new Set<string>();
    for (const clause of policy.clauses ?? []) {
      if (ids.has(clause.id)) errors.push(`/clauses duplicate id ${JSON.stringify(clause.id)}`);
      ids.add(clause.id);
      if (clause.type === "require_approval" && (clause as Record<string, unknown>).min_approvals != null &&
          (clause as Record<string, unknown>).min_approvals !== 1) {
        errors.push(`/clauses/${clause.id}/min_approvals only one approval is supported before DEV10`);
      }
      if (clause.type === "action_allowlist" && clause.param_bounds) {
        for (const [field, raw] of Object.entries(clause.param_bounds as Record<string, any>)) {
          const bound = raw as Record<string, unknown>;
          if (typeof bound.min === "number" && typeof bound.max === "number" && bound.min > bound.max) {
            errors.push(`/clauses/${clause.id}/param_bounds/${field} min exceeds max`);
          }
          if (typeof bound.pattern === "string") {
            try { new RegExp(bound.pattern); } catch { errors.push(`/clauses/${clause.id}/param_bounds/${field} has an invalid pattern`); }
          }
        }
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

/** Validate an action as closed, finite JSON before hashing or evaluation. */
export function validateIntent(value: unknown): ValidationResult {
  return validateAction(value);
}

type AnyClause = Clause & Record<string, any>;

const norm = (r: unknown): Receipt => {
  const rec = r as Receipt | undefined;
  return (rec && rec.payload ? rec.payload : rec) || {};
};
const ms = (isoTs: string | undefined): number => Date.parse(isoTs ?? "");
const paramsOf = (r: Receipt): Record<string, any> => (r.intent?.params ?? {}) as Record<string, any>;

// Whether a single value satisfies a scalar bound (enum / min / max / pattern).
// Used for array-element bounds (`items`); the top-level scalar checks below keep
// their own precise messages.
function elementSatisfiesBound(el: unknown, b: any): boolean {
  if (b.enum && !b.enum.includes(el)) return false;
  if (b.min != null || b.max != null) {
    if (typeof el !== "number" || !Number.isFinite(el)) return false;
    if (b.min != null && el < b.min) return false;
    if (b.max != null && el > b.max) return false;
  }
  if (b.pattern && (typeof el !== "string" || !new RegExp(b.pattern).test(el))) return false;
  return true;
}

// Minimal ISO-8601 duration → milliseconds (days/hours/minutes/seconds).
export function durationToMs(d: string): number {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(d || "");
  if (!m) throw new Error(`unsupported duration: ${d}`);
  const [, dd, hh, mm, ss] = m.map((x) => (x ? Number(x) : 0)) as number[];
  return ((dd * 24 + hh) * 60 + mm) * 60 * 1000 + ss * 1000;
}

// Glob match for endpoint paths: `*` within a segment, `**` across segments.
function globMatch(glob: string, s: string): boolean {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") { if (glob[i + 1] === "*") { re += ".*"; i++; } else re += "[^/]*"; }
    else if (".+?^${}()|[]\\".includes(ch)) re += "\\" + ch;
    else re += ch;
  }
  return new RegExp("^" + re + "$").test(s);
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
  let hash: string;
  try { hash = inputsHash(policy, rs, c, opts.at ?? c.timestamp); }
  catch { hash = createHash("sha256").update("invalid non-JSON policy or action input").digest("hex"); }

  const policyValidation = validatePolicy(policy);
  if (!policyValidation.valid) {
    return verdict(true, null, `invalid policy: ${policyValidation.errors.join("; ")}`, hash);
  }
  const intentValidation = validateIntent(c.intent);
  if (!intentValidation.valid) {
    return verdict(true, null, `invalid action: ${intentValidation.errors.join("; ")}`, hash);
  }
  if (!Number.isFinite(at)) return verdict(true, null, "invalid evaluation timestamp", hash);
  for (const prior of rs) {
    if (prior.executed !== true) continue;
    const priorValidation = validateIntent(prior.intent);
    if (!priorValidation.valid || !Number.isFinite(ms(prior.timestamp))) {
      return verdict(true, null, "invalid executed receipt in policy input", hash);
    }
  }

  // Nothing executed → nothing happened → no violation.
  if (c.executed !== true) return verdict(false, null, "claimed action was not executed", hash);

  // Executed receipts in the window ending at `at`, deduped by intent_hash.
  const executed = [...rs, c].filter((r) => r.executed === true);
  // Modern receipts carry a stable action id. The hash/timestamp fallback is only
  // for legacy evidence that predates action ids.
  const dedup = new Map<string, Receipt>();
  for (const r of executed) {
    const actionId = r.action_id ?? r.action_ref?.action_id;
    const occurrence = actionId ?? (r.intent_hash ?? JSON.stringify(r.intent)) + "@" + (r.timestamp ?? "");
    dedup.set(occurrence, r);
  }
  const executedUnique = [...dedup.values()];
  const inWindow = (r: Receipt, windowMs: number): boolean => { const t = ms(r.timestamp); return t <= at && t > at - windowMs; };

  const p = paramsOf(c);
  let undetermined: string | null = null;
  const found: Array<{ verdict: Verdict; mode: Mode; order: number }> = [];
  let order = 0;
  const record = (clause: AnyClause, explanation: string): void => {
    found.push({
      verdict: verdict(true, clause.id, explanation, hash),
      mode: (clause.type === "require_approval" ? "require_approval" : (clause.mode ?? "enforce")) as Mode,
      order: order++,
    });
  };

  // An action allowlist is a union: the action must appear in at least one such
  // clause, and matching clauses then constrain its parameters. This closes the
  // prior path where an unlisted action silently skipped the allowlist.
  const actionAllowlists = ((policy.clauses ?? []) as AnyClause[]).filter((clause) => clause.type === "action_allowlist");
  if (actionAllowlists.length > 0 && !actionAllowlists.some((clause) => clause.action_types.includes(c.intent?.action_type))) {
    for (const clause of actionAllowlists) record(clause, `action type ${c.intent?.action_type} is not allowlisted`);
  }
  const actionCovered = ((policy.clauses ?? []) as AnyClause[]).some((clause) => {
    switch (clause.type) {
      case "action_allowlist": return clause.action_types.includes(c.intent?.action_type);
      case "spend_limit": return c.intent?.asset === clause.asset;
      case "rate_limit":
      case "require_approval": return clause.action_types.includes(c.intent?.action_type);
      case "sequence": return clause.first_action_types.includes(c.intent?.action_type) || clause.then_action_types.includes(c.intent?.action_type);
      case "endpoint_allowlist":
      case "endpoint_denylist": return c.intent?.action_type === "http.call" && typeof p.host === "string";
      case "address_allowlist":
      case "address_denylist": return typeof p.to === "string";
      case "contract_allowlist": return typeof p.contract === "string";
      case "time_window": return true;
      case "key_policy": return typeof c.intent?.signer === "string";
      case "force_push_guard": return c.intent?.action_type === "git.push";
      default: return false;
    }
  });
  if (!actionCovered) {
    found.push({
      verdict: verdict(true, null, `action type ${c.intent?.action_type} is not covered by a supported policy clause`, hash),
      mode: "enforce",
      order: order++,
    });
  }

  clauses: for (const clause of (policy.clauses ?? []) as AnyClause[]) {
    const t = clause.type;

    if (t === "spend_limit") {
      const asset = clause.asset;
      if (c.intent?.asset === asset && !Number.isSafeInteger(c.intent?.amount)) {
        record(clause, `amount for asset ${asset} must be a nonnegative safe integer`);
        continue;
      }
      const amt = c.intent?.asset === asset ? (c.intent?.amount ?? 0) : 0;
      if (clause.max_per_action != null && amt > clause.max_per_action) {
        record(clause, `per-action ${amt} exceeds max_per_action ${clause.max_per_action}`);
        continue;
      }
      if (clause.max_per_window != null) {
        if (clause.scope === "global" && opts.gatewaysComplete === false) { undetermined = clause.id; continue; }
        const w = durationToMs(clause.window);
        const relevant = executedUnique.filter((r) => r.intent?.asset === asset && inWindow(r, w));
        if (relevant.some((r) => !Number.isSafeInteger(r.intent?.amount))) {
          record(clause, `window for asset ${asset} contains an invalid amount`);
          continue;
        }
        const sum = relevant
          .reduce((s, r) => s + (r.intent?.amount ?? 0), 0);
        if (sum > clause.max_per_window) {
          record(clause, `windowed total ${sum} exceeds max_per_window ${clause.max_per_window}`);
          continue;
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
        record(clause, `count ${count} exceeds max_count ${clause.max_count}`);
        continue;
      }
    }

    else if (t === "require_approval") {
      if (clause.action_types.includes(c.intent?.action_type)) {
        const a = c.approval;
        const ok = a && clause.approvers.includes(a.approver) && a.intent_hash === c.intent_hash;
        if (!ok) { record(clause, "executed without a valid approval record"); continue; }
      }
    }

    else if (t === "sequence") {
      if (clause.then_action_types.includes(c.intent?.action_type) && (clause.min_gap || clause.forbidden_within)) {
        const gap = Math.max(
          clause.min_gap ? durationToMs(clause.min_gap) : 0,
          clause.forbidden_within ? durationToMs(clause.forbidden_within) : 0,
        );
        const prior = executedUnique.find(
          (r) => r !== c && clause.first_action_types.includes(r.intent?.action_type) &&
                 at - ms(r.timestamp) < gap && ms(r.timestamp) <= at,
        );
        if (prior) { record(clause, `then-action occurred before the required sequence gap`); continue; }
      }
    }

    else if (t === "time_window") {
      const d = new Date(at);
      const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()];
      const hhmm = d.toISOString().slice(11, 16);
      const dayOk = !clause.days || clause.days.length === 0 || clause.days.includes(day);
      const timeOk = clause.start <= clause.end
        ? hhmm >= clause.start && hhmm <= clause.end
        : hhmm >= clause.start || hhmm <= clause.end;
      if (!(dayOk && timeOk)) { record(clause, `executed outside allowed window (${hhmm} UTC)`); continue; }
    }

    else if (t === "endpoint_allowlist") {
      if (p.host != null) {
        const hostOk = clause.hosts.includes(p.host);
        const pathOk = !clause.paths || clause.paths.length === 0 || clause.paths.some((g: string) => globMatch(g, p.path ?? ""));
        const methodOk = !clause.methods || clause.methods.length === 0 || clause.methods.includes(p.method);
        if (!(hostOk && pathOk && methodOk)) { record(clause, `HTTP ${p.method ?? ""} ${p.host}${p.path ?? ""} not allowlisted`); continue; }
      }
    }

    else if (t === "endpoint_denylist") {
      if (p.host != null && clause.hosts.includes(p.host)) {
        const pathHit = !clause.paths || clause.paths.length === 0 || clause.paths.some((g: string) => globMatch(g, p.path ?? ""));
        const methodHit = !clause.methods || clause.methods.length === 0 || clause.methods.includes(p.method);
        if (pathHit && methodHit) { record(clause, `HTTP ${p.host}${p.path ?? ""} is denied`); continue; }
      }
    }

    else if (t === "address_allowlist") {
      if (p.to != null) {
        const chainOk = !clause.chain_ids || clause.chain_ids.length === 0 || clause.chain_ids.includes(p.chain_id);
        if (chainOk && !clause.addresses.includes(p.to)) { record(clause, `destination ${p.to} not allowlisted`); continue; }
      }
    }

    else if (t === "address_denylist") {
      if (p.to != null && clause.addresses.includes(p.to)) {
        const chainOk = !clause.chain_ids || clause.chain_ids.length === 0 || clause.chain_ids.includes(p.chain_id);
        if (chainOk) { record(clause, `destination ${p.to} is denied`); continue; }
      }
    }

    else if (t === "contract_allowlist") {
      if (p.contract != null) {
        const chainOk = !clause.chain_ids || clause.chain_ids.length === 0 || clause.chain_ids.includes(p.chain_id);
        if (chainOk) {
          const contractOk = clause.contracts.includes(p.contract);
          const selOk = !clause.selectors || clause.selectors.length === 0 || (p.selector != null && clause.selectors.includes(p.selector));
          if (!(contractOk && selOk)) { record(clause, `contract ${p.contract} ${p.selector ?? ""} not allowlisted`); continue; }
        }
      }
    }

    else if (t === "action_allowlist") {
      if (clause.action_types.includes(c.intent?.action_type) && clause.param_bounds) {
        for (const [field, b] of Object.entries(clause.param_bounds as Record<string, any>)) {
          const val = p[field];
          if (b.items) {
            // Array-element bound: every (match:"all", default) or at least one
            // (match:"any") element must satisfy the item bound. A bounded array
            // that is absent or not an array denies (fail closed).
            const match = b.match === "any" ? "any" : "all";
            if (!Array.isArray(val)) { record(clause, `param ${field} must be an array`); continue clauses; }
            const ok = match === "any"
              ? val.some((el) => elementSatisfiesBound(el, b.items))
              : val.every((el) => elementSatisfiesBound(el, b.items));
            if (!ok) { record(clause, `param ${field} array fails ${match}-match bound`); continue clauses; }
            continue; // this field is handled by its array bound
          }
          if (b.enum && !b.enum.includes(val)) { record(clause, `param ${field}=${val} not in enum`); continue clauses; }
          if ((b.min != null || b.max != null) && (typeof val !== "number" || !Number.isFinite(val))) {
            record(clause, `param ${field} must be a finite number`); continue clauses;
          }
          if (b.min != null && val < b.min) { record(clause, `param ${field}=${val} below min ${b.min}`); continue clauses; }
          if (b.max != null && val > b.max) { record(clause, `param ${field}=${val} above max ${b.max}`); continue clauses; }
          if (b.pattern && (typeof val !== "string" || !new RegExp(b.pattern).test(val))) {
            record(clause, `param ${field} fails pattern`); continue clauses;
          }
        }
      }
    }

    else if (t === "key_policy") {
      const signer = c.intent?.signer;
      if (signer != null && !clause.active_keys.includes(signer)) {
        record(clause, `signed by key ${signer} outside the active key set`);
        continue;
      }
    }

    else if (t === "force_push_guard") {
      // Deny a force-push to a protected branch while still allowing ordinary
      // pushes to those branches and force-pushes to feature branches — the one
      // predicate a per-field action_allowlist bound cannot express (it cannot
      // AND `force` with a protected-ref set). A force-push whose target ref
      // cannot be resolved is denied (fail closed): it cannot be shown to avoid
      // the protected set.
      if (c.intent?.action_type === "git.push" && p.force === true) {
        const refs: string[] = Array.isArray(clause.protected_refs) && clause.protected_refs.length > 0
          ? clause.protected_refs
          : ["main", "master", "release/*"];
        const ref = typeof p.ref === "string" ? p.ref : undefined;
        if (ref === undefined || refs.some((g) => globMatch(g, ref))) {
          record(clause, ref === undefined
            ? "force-push with an unresolved target ref is denied"
            : `force-push to protected ref ${ref} is denied`);
          continue;
        }
      }
    }

    // oracle_condition: [PLANNED] — best-effort external data, not yet evaluated.
    // Unknown/unimplemented clause types are skipped (no violation).
  }

  if (found.length > 0) {
    const priority: Record<Mode, number> = { enforce: 3, require_approval: 2, monitor: 1 };
    found.sort((a, b) => priority[b.mode] - priority[a.mode] || a.order - b.order);
    return found[0].verdict;
  }
  if (undetermined) {
    return verdict(false, undetermined, "global-scope clause needs all gateways' receipts; set incomplete", hash, { undetermined: true });
  }
  return verdict(false, null, "no clause violated", hash);
}
