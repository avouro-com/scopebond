// The rules of the rule packs in force, joined to the policy this computer enforces.
//
// A pack carries policy clauses (`action_allowlist`, the existing rule language) for the actions its grammars and MCP profiles
// derive. They are not written into policy.json: the policy file holds this computer's own rules or its workspace's, and the
// packs in force (pack-store.ts, verified on every call) add their rules when the policy is loaded, so a pack that arrives,
// changes or expires changes what is enforced on the next call without the policy being compiled again.
//
// The rules this module keeps:
//   - A target rule the workspace switched Off allows its action types with no bounds: they stay covered, nothing matches.
//   - A pack's rule records (monitor) until a person or the workspace turns it on. Only a target rule (target-rules.ts) with
//     bounds can be turned on: a rule without bounds would block every action of its types, so it always records.
//   - A clause the policy already carries is kept as it is (a policy compiled by an earlier version, which had the rule built in).
//   - Among packs, the first by id that defines a rule id wins.
//   - The packs' rules come after the starter rules and before the clauses that follow them (the allowed folders, the
//     remote-database guard, a workspace's allowed sites and blocked services, the key policy), as the built-in rules did.

import type { Pack } from "@scopebond/policy-schema/pack";
import { activePacks } from "./packs.js";
import { TARGET_RULES } from "./target-rules.js";

type Clause = Record<string, unknown> & { id: string };

const switchable = (rule: Record<string, unknown>): boolean =>
  (TARGET_RULES as readonly string[]).includes(String(rule.id))
  && typeof rule.param_bounds === "object" && rule.param_bounds !== null && Object.keys(rule.param_bounds).length > 0;

/** What a workspace changes in the packs' rules (managed.ts `packRuleAdjustments`): the target rules it switched Off, and
 *  exceptions (rule-exceptions.ts) a rule's clause takes beside its own. */
export interface PackRuleSettings { off?: ReadonlySet<string>; exceptions?: Readonly<Record<string, readonly Record<string, unknown>[]>> }

/** A target rule switched Off: an allow clause with no bounds for its action types, so they stay covered and nothing matches. */
const offClause = (rule: Record<string, unknown>, id: string): Clause => ({
  id, type: "action_allowlist", mode: "monitor", action_types: rule.action_types,
  description: "These actions are allowed and are not recorded as matches: your workspace switched this rule off.",
});

/** The clauses the packs define, each on enforce when it can be switched and `enforced` names it, else on monitor; a target
 *  rule `settings.off` names is switched off. */
export function packRuleClauses(enforced: ReadonlySet<string>, packs: readonly Pack[] = activePacks(), settings: PackRuleSettings = {}): Clause[] {
  const seen = new Set<string>();
  const out: Clause[] = [];
  for (const pack of packs) {
    for (const rule of pack.rules) {
      const id = String(rule.id);
      if (seen.has(id)) continue;
      seen.add(id);
      if (settings.off?.has(id) && switchable(rule) && rule.type === "action_allowlist" && Array.isArray(rule.action_types)) { out.push(offClause(rule, id)); continue; }
      const extra = switchable(rule) && rule.type === "action_allowlist" ? settings.exceptions?.[id] ?? [] : [];
      const own = Array.isArray(rule.exceptions) ? rule.exceptions : [];
      out.push({ ...rule, id, mode: switchable(rule) && enforced.has(id) ? "enforce" : "monitor", ...(extra.length ? { exceptions: [...own, ...extra] } : {}) });
    }
  }
  return out;
}

/** The ids of the rules the packs in force define that a person or a workspace can turn on. */
export function switchablePackRules(packs: readonly Pack[] = activePacks()): string[] {
  const ids = new Set<string>();
  for (const pack of packs) for (const rule of pack.rules) if (switchable(rule)) ids.add(String(rule.id));
  return TARGET_RULES.filter((id) => ids.has(id));
}

/** `policy` with the rules of the packs in force that it does not carry yet. The same object when there are none to add. */
export function withPackRules<T>(policy: T, enforced: ReadonlySet<string>, packs: readonly Pack[] = activePacks(), settings: PackRuleSettings = {}): T {
  const clauses = (policy as { clauses?: unknown } | null)?.clauses;
  if (!Array.isArray(clauses) || packs.length === 0) return policy;
  const have = new Set(clauses.map((c) => String((c as { id?: unknown })?.id)));
  const add = packRuleClauses(enforced, packs, settings).filter((c) => !have.has(c.id));
  if (add.length === 0) return policy;
  const ids = clauses.map((c) => String((c as { id?: unknown })?.id));
  const after = ids.indexOf("observe-net-mcp");
  const keys = ids.indexOf("keys");
  const at = after >= 0 ? after + 1 : keys >= 0 ? keys : clauses.length;
  return { ...(policy as object), clauses: [...clauses.slice(0, at), ...add, ...clauses.slice(at)] } as T;
}
