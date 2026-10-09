// @scopebond/verify — the deterministic verdict library.
//
// violates(policy, receipts, claimed, opts) → Verdict  (POLICY_VOCABULARY.md §7)
//
// `VERIFIER_VERSION` is the string receipts carry as `verifier_version`, which SPEC.md
// defines as "the violates() verifier version that produced the verdict". It lives here,
// next to `violates()`, rather than as a literal in the gateway: it was hardcoded there as
// `scopebond-verify@0.1.1` and stayed that way through 0.2, 0.3 and 0.4, so every receipt
// named a verifier version that had not produced its verdict for three releases.
// `version.test.mjs` asserts this matches package.json, so it cannot drift again.
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
import { jsonText } from "./text.js";
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
        for (const [field, bound] of Object.entries(clause.param_bounds as Record<string, ParamBound>)) {
          if (typeof bound.min === "number" && typeof bound.max === "number" && bound.min > bound.max) {
            errors.push(`/clauses/${clause.id}/param_bounds/${field} min exceeds max`);
          }
          // An array bound's `items` pattern is compiled by violates() just like a
          // top-level one, so it is checked here too: an invalid one made violates()
          // throw instead of returning an "invalid policy" verdict.
          for (const pattern of [bound.pattern, bound.items?.pattern]) {
            if (typeof pattern !== "string") continue;
            // eslint-disable-next-line security/detect-non-literal-regexp -- compiles the policy author's own param_bounds pattern only to check that it is a valid regular expression
            try { new RegExp(pattern); } catch { errors.push(`/clauses/${clause.id}/param_bounds/${field} has an invalid pattern`); }
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

/** A scalar `param_bounds` entry (policy.schema.json): min / max / enum / pattern. */
interface ScalarBound {
  min?: number;
  max?: number;
  enum?: unknown[];
  pattern?: string;
}

/** A `param_bounds` entry: a scalar bound, or an array bound (`items` + `match`). */
interface ParamBound extends ScalarBound {
  items?: ScalarBound;
  match?: "all" | "any";
}

/** A clause as the evaluator reads it. `violates()` and `historyNeed()` evaluate only a
 *  policy `validatePolicy()` accepted, and each clause-type branch reads only the fields
 *  that type's validator requires (or checks for before use), so they are typed as present. */
interface EvalClause extends Clause {
  scope?: string;
  // spend_limit (`window` is read only when `max_per_window` is set, which requires it)
  asset: string;
  max_per_action?: number;
  max_per_window?: number;
  window: string;
  // rate_limit, require_approval, action_allowlist
  action_types: string[];
  max_count: number;
  approvers: string[];
  param_bounds?: Record<string, ParamBound>;
  // sequence
  first_action_types: string[];
  then_action_types: string[];
  min_gap?: string;
  forbidden_within?: string;
  // time_window
  days?: string[];
  start: string;
  end: string;
  // endpoint_allowlist / endpoint_denylist
  hosts: string[];
  paths?: string[];
  methods?: string[];
  // address_allowlist / address_denylist / contract_allowlist
  addresses: string[];
  chain_ids?: number[];
  contracts: string[];
  selectors?: string[];
  // key_policy, force_push_guard
  active_keys: string[];
  protected_refs?: string[];
}

const norm = (r: unknown): Receipt => {
  const rec = r as Receipt | undefined;
  return (rec && rec.payload ? rec.payload : rec) || {};
};
const ms = (isoTs: string | undefined): number => Date.parse(isoTs ?? "");
const paramsOf = (r: Receipt): Record<string, unknown> => r.intent?.params ?? {};
// `list.includes(value)` for a value of any type (an action's params are arbitrary JSON).
const listHas = (list: readonly unknown[], value: unknown): boolean => list.includes(value);
// An action param value as an explanation shows it. Params are agent-supplied JSON: a template
// literal threw on an object with its own "toString" key, which made violates() throw.
const shown = jsonText;

// Whether a single value satisfies a scalar bound (enum / min / max / pattern).
// Used for array-element bounds (`items`); the top-level scalar checks below keep
// their own precise messages.
function elementSatisfiesBound(el: unknown, b: ScalarBound): boolean {
  if (b.enum && !b.enum.includes(el)) return false;
  if (b.min != null || b.max != null) {
    if (typeof el !== "number" || !Number.isFinite(el)) return false;
    if (b.min != null && el < b.min) return false;
    if (b.max != null && el > b.max) return false;
  }
  // eslint-disable-next-line security/detect-non-literal-regexp -- the policy author's own param_bounds pattern, already compiled once by validatePolicy(); never built from action text
  if (b.pattern && (typeof el !== "string" || !new RegExp(b.pattern).test(el))) return false;
  return true;
}

// Minimal ISO-8601 duration → milliseconds (days/hours/minutes/seconds).
export function durationToMs(d: string): number {
  // eslint-disable-next-line security/detect-unsafe-regex -- linear: each optional group is digits closed by its own distinct letter (D/H/M/S), so there is one way to match; a test runs it on a 50k-character input
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(d || "");
  if (!m) throw new Error(`unsupported duration: ${d}`);
  const [, dd, hh, mm, ss] = m.map<number>((x) => (x ? Number(x) : 0));
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
  // eslint-disable-next-line security/detect-non-literal-regexp -- built from a policy author's glob with every regex metacharacter escaped above; the only operators added are `[^/]*` and `.*`
  return new RegExp("^" + re + "$").test(s);
}

/** An HTTP host as a policy compares it: lowercase, without one trailing dot. Null when it is not a bare host name or address
 *  with an optional port (userinfo, a path, a backslash or spaces), which no list can safely match. */
export function bareHost(host: unknown): string | null {
  if (typeof host !== "string") return null;
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  if (!h || h.length > 260) return null;
  // eslint-disable-next-line security/detect-unsafe-regex -- linear (no nested repetition) and run only on the at most 260 characters checked above
  if (/^\[[0-9a-f:.]+\](?::\d{1,5})?$/.test(h)) return h;
  // eslint-disable-next-line security/detect-unsafe-regex -- linear: each repeated label must end in "." which the label class excludes, so there is one way to split; input is at most 260 characters
  return /^(?:[a-z0-9_-]+\.)*[a-z0-9_-]+(?::\d{1,5})?$/.test(h) ? h : null;
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

/** How much prior history a policy's verdict can depend on.
 *  - `none`: no clause reads prior receipts; the verdict is the same for any prior set.
 *  - `window`: no clause reads a prior receipt timestamped at or before `at - ms`.
 *  - `all`: the policy needs the whole history (or could not be analysed). */
export type HistoryNeed = { kind: "none" } | { kind: "window"; ms: number } | { kind: "all" };

// Clause types whose evaluation reads only the claimed action. Any type not listed
// here and not handled in `historyNeed` (including a future stateful one, and the
// unevaluated `oracle_condition`) is treated as needing all history, so a new clause
// cannot be silently starved of the receipts it reads.
const STATELESS_CLAUSES = new Set([
  "action_allowlist", "require_approval", "time_window", "endpoint_allowlist", "endpoint_denylist",
  "address_allowlist", "address_denylist", "contract_allowlist", "key_policy", "force_push_guard",
]);

/** The history `violates()` reads for this policy: the longest `window` of a windowed
 *  spend_limit or rate_limit, and the longest sequence gap. Global scope does not
 *  widen it — a global clause is still windowed; scope only decides `undetermined`. */
export function historyNeed(policy: Policy): HistoryNeed {
  if (!validatePolicy(policy).valid) return { kind: "all" };
  let horizon = 0;
  try {
    for (const clause of (policy.clauses ?? []) as EvalClause[]) {
      const t = clause.type;
      if (t === "rate_limit") horizon = Math.max(horizon, durationToMs(clause.window));
      else if (t === "spend_limit") {
        if (clause.max_per_window != null) horizon = Math.max(horizon, durationToMs(clause.window));
      } else if (t === "sequence") {
        if (clause.min_gap || clause.forbidden_within) {
          horizon = Math.max(horizon,
            clause.min_gap ? durationToMs(clause.min_gap) : 0,
            clause.forbidden_within ? durationToMs(clause.forbidden_within) : 0);
        }
      } else if (!STATELESS_CLAUSES.has(t)) return { kind: "all" };
    }
  } catch { return { kind: "all" }; }
  if (!Number.isSafeInteger(horizon)) return { kind: "all" };
  return horizon > 0 ? { kind: "window", ms: horizon } : { kind: "none" };
}

/** The prior set a bounded evaluation passes to `violates()`: for `none`, no receipts;
 *  for `window`, every receipt except those whose timestamp parses to at or before
 *  `at - ms` (an unparseable timestamp is kept, so the invalid-receipt check still sees
 *  it); for `all`, every receipt. Order is preserved. `violates(policy, boundPrior(
 *  historyNeed(policy), prior, at), claimed, { at })` reaches the same decision as the
 *  unbounded call; `inputs_hash` commits to this bounded set. */
export function boundPrior<T>(need: HistoryNeed, receipts: T[], at: string): T[] {
  if (need.kind === "none") return [];
  const atMs = ms(at);
  if (need.kind === "all" || !Number.isFinite(atMs)) return receipts.slice();
  const from = atMs - need.ms;
  return receipts.filter((r) => !(ms(norm(r).timestamp) <= from));
}

/** The value receipts carry as `verifier_version`. Kept as a source constant rather than
 *  read from package.json at runtime, because this code runs in a Worker bundle where
 *  there is no package.json to read; `version.test.mjs` pins it to the published version. */
export const VERIFIER_VERSION = "scopebond-verify@0.6.1";

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
  const record = (clause: EvalClause, explanation: string): void => {
    found.push({
      verdict: verdict(true, clause.id, explanation, hash),
      mode: (clause.type === "require_approval" ? "require_approval" : (clause.mode ?? "enforce")),
      order: order++,
    });
  };

  // An action allowlist is a union: the action must appear in at least one such
  // clause, and matching clauses then constrain its parameters. This closes the
  // prior path where an unlisted action silently skipped the allowlist.
  const actionAllowlists = ((policy.clauses ?? []) as EvalClause[]).filter((clause) => clause.type === "action_allowlist");
  if (actionAllowlists.length > 0 && !actionAllowlists.some((clause) => listHas(clause.action_types, c.intent?.action_type))) {
    for (const clause of actionAllowlists) record(clause, `action type ${c.intent?.action_type} is not allowlisted`);
  }
  const actionCovered = ((policy.clauses ?? []) as EvalClause[]).some((clause) => {
    switch (clause.type) {
      case "action_allowlist": return listHas(clause.action_types, c.intent?.action_type);
      case "spend_limit": return c.intent?.asset === clause.asset;
      case "rate_limit":
      case "require_approval": return listHas(clause.action_types, c.intent?.action_type);
      case "sequence": return listHas(clause.first_action_types, c.intent?.action_type) || listHas(clause.then_action_types, c.intent?.action_type);
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

  clauses: for (const clause of (policy.clauses ?? []) as EvalClause[]) {
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
        (r) => listHas(clause.action_types, r.intent?.action_type) && inWindow(r, w),
      ).length;
      if (count > clause.max_count) {
        record(clause, `count ${count} exceeds max_count ${clause.max_count}`);
        continue;
      }
    }

    else if (t === "require_approval") {
      if (listHas(clause.action_types, c.intent?.action_type)) {
        const a = c.approval;
        const ok = a && listHas(clause.approvers, a.approver) && a.intent_hash === c.intent_hash;
        if (!ok) { record(clause, "executed without a valid approval record"); continue; }
      }
    }

    else if (t === "sequence") {
      if (listHas(clause.then_action_types, c.intent?.action_type) && (clause.min_gap || clause.forbidden_within)) {
        const gap = Math.max(
          clause.min_gap ? durationToMs(clause.min_gap) : 0,
          clause.forbidden_within ? durationToMs(clause.forbidden_within) : 0,
        );
        const prior = executedUnique.find(
          (r) => r !== c && listHas(clause.first_action_types, r.intent?.action_type) &&
                 at - ms(r.timestamp) < gap && ms(r.timestamp) <= at,
        );
        if (prior) { record(clause, `then-action occurred before the required sequence gap`); continue; }
      }
    }

    else if (t === "time_window") {
      const d = new Date(at);
      const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()];
      const hhmm = d.toISOString().slice(11, 16);
      const dayOk = !clause.days || clause.days.length === 0 || listHas(clause.days, day);
      const timeOk = clause.start <= clause.end
        ? hhmm >= clause.start && hhmm <= clause.end
        : hhmm >= clause.start || hhmm <= clause.end;
      if (!(dayOk && timeOk)) { record(clause, `executed outside allowed window (${hhmm} UTC)`); continue; }
    }

    else if (t === "endpoint_allowlist") {
      if (p.host != null) {
        // The host is compared as an HTTP client resolves it (case, a trailing dot); one that is not a bare host, or a path
        // that does not start with "/", could be read as another host and is never allowed.
        const host = bareHost(p.host);
        const path = p.path ?? "/";
        const hostOk = host !== null && clause.hosts.some((h: string) => bareHost(h) === host);
        const pathOk = typeof path === "string" && path.startsWith("/")
          && (!clause.paths || clause.paths.length === 0 || clause.paths.some((g: string) => globMatch(g, path)));
        const methodOk = !clause.methods || clause.methods.length === 0 || listHas(clause.methods, p.method);
        if (!(hostOk && pathOk && methodOk)) { record(clause, `HTTP ${shown(p.method ?? "")} ${shown(p.host)}${shown(p.path ?? "")} not allowlisted`); continue; }
      }
    }

    else if (t === "endpoint_denylist") {
      if (p.host != null) {
        const host = bareHost(p.host);
        const path = p.path ?? "/";
        // A host or path that cannot be compared safely is treated as denied: it may name a denied host another way.
        if (host === null || typeof path !== "string" || !path.startsWith("/")) { record(clause, `HTTP ${shown(p.host)}${shown(p.path ?? "")} is not a plain host and path`); continue; }
        if (clause.hosts.some((h: string) => bareHost(h) === host)) {
          const pathHit = !clause.paths || clause.paths.length === 0 || clause.paths.some((g: string) => globMatch(g, path));
          const methodHit = !clause.methods || clause.methods.length === 0 || listHas(clause.methods, p.method);
          if (pathHit && methodHit) { record(clause, `HTTP ${shown(p.host)}${shown(p.path ?? "")} is denied`); continue; }
        }
      }
    }

    else if (t === "address_allowlist") {
      if (p.to != null) {
        const chainOk = !clause.chain_ids || clause.chain_ids.length === 0 || listHas(clause.chain_ids, p.chain_id);
        if (chainOk && !listHas(clause.addresses, p.to)) { record(clause, `destination ${shown(p.to)} not allowlisted`); continue; }
      }
    }

    else if (t === "address_denylist") {
      if (p.to != null && listHas(clause.addresses, p.to)) {
        const chainOk = !clause.chain_ids || clause.chain_ids.length === 0 || listHas(clause.chain_ids, p.chain_id);
        if (chainOk) { record(clause, `destination ${shown(p.to)} is denied`); continue; }
      }
    }

    else if (t === "contract_allowlist") {
      if (p.contract != null) {
        const chainOk = !clause.chain_ids || clause.chain_ids.length === 0 || listHas(clause.chain_ids, p.chain_id);
        if (chainOk) {
          const contractOk = listHas(clause.contracts, p.contract);
          const selOk = !clause.selectors || clause.selectors.length === 0 || (p.selector != null && listHas(clause.selectors, p.selector));
          if (!(contractOk && selOk)) { record(clause, `contract ${shown(p.contract)} ${shown(p.selector ?? "")} not allowlisted`); continue; }
        }
      }
    }

    else if (t === "action_allowlist") {
      if (listHas(clause.action_types, c.intent?.action_type) && clause.param_bounds) {
        for (const [field, b] of Object.entries(clause.param_bounds)) {
          const val = p[field];
          const items = b.items;
          if (items) {
            // Array-element bound: every (match:"all", default) or at least one
            // (match:"any") element must satisfy the item bound. A bounded array
            // that is absent or not an array denies (fail closed).
            const match = b.match === "any" ? "any" : "all";
            if (!Array.isArray(val)) { record(clause, `param ${field} must be an array`); continue clauses; }
            const ok = match === "any"
              ? val.some((el) => elementSatisfiesBound(el, items))
              : val.every((el) => elementSatisfiesBound(el, items));
            if (!ok) { record(clause, `param ${field} array fails ${match}-match bound`); continue clauses; }
            continue; // this field is handled by its array bound
          }
          if (b.enum && !b.enum.includes(val)) { record(clause, `param ${field}=${shown(val)} not in enum`); continue clauses; }
          if (b.min != null || b.max != null) {
            if (typeof val !== "number" || !Number.isFinite(val)) {
              record(clause, `param ${field} must be a finite number`); continue clauses;
            }
            if (b.min != null && val < b.min) { record(clause, `param ${field}=${val} below min ${b.min}`); continue clauses; }
            if (b.max != null && val > b.max) { record(clause, `param ${field}=${val} above max ${b.max}`); continue clauses; }
          }
          // eslint-disable-next-line security/detect-non-literal-regexp -- the policy author's own param_bounds pattern, already compiled once by validatePolicy(); never built from action text
          if (b.pattern && (typeof val !== "string" || !new RegExp(b.pattern).test(val))) {
            record(clause, `param ${field} fails pattern`); continue clauses;
          }
        }
      }
    }

    else if (t === "key_policy") {
      const signer = c.intent?.signer;
      if (signer != null && !listHas(clause.active_keys, signer)) {
        record(clause, `signed by key ${signer} outside the active key set`);
        continue;
      }
    }

    else if (t === "force_push_guard") {
      // Deny a destructive push to a protected branch while still allowing ordinary
      // pushes to those branches and force-pushes to feature branches — the one
      // predicate a per-field action_allowlist bound cannot express (it cannot AND a
      // destructive push with a protected-ref set). Three things are destructive to a
      // protected branch: a force-push (rewrites history), a delete (`:main`,
      // `--delete` — removes the branch, destructive even without `--force`), and an
      // all-branches push under force (`--all --force`, `--mirror` — necessarily
      // reaches every protected ref and, for `--mirror`, prunes). A push whose target
      // ref cannot be resolved is denied (fail closed): it cannot be shown to avoid
      // the protected set. The default `release/**` protects nested release branches
      // (`release/1.0/hotfix`), which `release/*` would miss.
      if (c.intent?.action_type === "git.push") {
        const refs: string[] = Array.isArray(clause.protected_refs) && clause.protected_refs.length > 0
          ? clause.protected_refs
          : ["main", "master", "release/**"];
        const ref = typeof p.ref === "string" ? p.ref : undefined;
        const hitsProtected = ref === undefined || refs.some((g) => globMatch(g, ref));
        // `--all`/`--mirror` under force reach every branch: they hit the protected set
        // whatever its members are.
        if (p.all === true && p.force === true) {
          record(clause, "force-push to all branches (--all/--mirror) reaches protected refs and is denied");
          continue;
        }
        if (p.delete === true && hitsProtected) {
          record(clause, ref === undefined
            ? "delete of an unresolved target ref is denied"
            : `delete of protected ref ${ref} is denied`);
          continue;
        }
        if (p.force === true && hitsProtected) {
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
