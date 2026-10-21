// The rules of the rule packs in force, joined to the policy this computer enforces.
//
// A pack carries policy clauses (`action_allowlist`, the existing rule language) for the actions its grammars and MCP profiles
// derive. They are not written into policy.json: the policy file holds this computer's own rules or its workspace's, and the
// packs in force (pack-store.ts, verified on every call) add their rules when the policy is loaded, so a pack that arrives,
// changes or expires changes what is enforced on the next call without the policy being compiled again.
//
// The rules this module keeps:
//   - A rule switched Off allows its action types with no bounds: they stay covered, nothing matches.
//   - A pack's rule records (monitor) until a person or the workspace turns it on, or (level 2) until its `default_mode` says
//     it blocks. Only a rule that may block can be turned on: a level-2 rule says so (`blockable`); a level-1 rule may when it
//     is a target rule (target-rules.ts). Either needs bounds: a rule without bounds would block every action of its types, so
//     it always records.
//   - A rule's mode, in order: Off; the mode a person or the workspace set for it (`PackRuleSettings.modes`: the workspace's
//     `pack_rules`, or its target rules, and a person's own choice where allowed); the rules this computer enforces
//     (`enforced`); else its `default_mode`.
//   - A pack in shadow (its signed list says `shadow: true`) never blocks: its rules record what they would have blocked.
//   - What a person reads about a rule (`title`, `safer_way`) and how far an allowance may reach (`allow_patterns`) stay in the
//     pack: a clause carries only what the policy language defines.
//   - A clause the policy already carries is kept as it is (a policy compiled by an earlier version, which had the rule built in).
//   - Among packs, the first by id that defines a rule id wins.
//   - The packs' rules come after the starter rules and before the clauses that follow them (the allowed folders, the
//     remote-database guard, a workspace's allowed sites and blocked services, the key policy), as the built-in rules did.

import { PACK_LEVEL2_FIELDS, type Pack } from "@scopebond/policy-schema/pack";
import { activePacks, shadowPackIds } from "./packs.js";
import { TARGET_RULES } from "./target-rules.js";

type Clause = Record<string, unknown> & { id: string };
/** A mode a person or the workspace set for a pack rule. */
export type PackRuleMode = "enforce" | "monitor" | "off";

const hasBounds = (rule: Record<string, unknown>): boolean =>
  typeof rule.param_bounds === "object" && rule.param_bounds !== null && Object.keys(rule.param_bounds).length > 0;

/** Whether a pack rule may block: a level-2 rule's own `blockable`, else (a level-1 rule) whether it is a target rule. */
export const switchable = (rule: Record<string, unknown>): boolean =>
  hasBounds(rule) && (typeof rule.blockable === "boolean" ? rule.blockable : (TARGET_RULES as readonly string[]).includes(String(rule.id)));

/** What a workspace changes in the packs' rules (managed.ts `packRuleAdjustments`): the rules it switched Off, the modes it or
 *  a person set, and exceptions (rule-exceptions.ts) a rule's clause takes beside its own. */
export interface PackRuleSettings {
  off?: ReadonlySet<string>;
  modes?: Readonly<Record<string, PackRuleMode>>;
  exceptions?: Readonly<Record<string, readonly Record<string, unknown>[]>>;
}

/** A rule switched Off: an allow clause with no bounds for its action types, so they stay covered and nothing matches. */
const offClause = (rule: Record<string, unknown>, id: string): Clause => ({
  id, type: "action_allowlist", mode: "monitor", action_types: rule.action_types,
  description: "These actions are allowed and are not recorded as matches: your workspace switched this rule off.",
});

/** A pack rule as a policy clause: without the fields only the pack reads (its title, hint and allow patterns). */
function clauseOf(rule: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rule)) if (!(PACK_LEVEL2_FIELDS.rule as readonly string[]).includes(key)) out[key] = value;
  return out;
}

/** Whether a pack rule blocks: it may block, its pack is not in shadow, and its mode (set, enforced, else its default) is on. */
function blocksNow(rule: Record<string, unknown>, id: string, enforced: ReadonlySet<string>, settings: PackRuleSettings, shadow: boolean): boolean {
  if (!switchable(rule) || shadow) return false;
  const set = settings.modes?.[id];
  if (set !== undefined) return set === "enforce";
  return enforced.has(id) || rule.default_mode === "block";
}

/** The clauses the packs define, each on enforce when it blocks now (`blocksNow`), else on monitor; a rule switched Off
 *  (`settings.off`, or an "off" mode) allows its types. */
export function packRuleClauses(enforced: ReadonlySet<string>, packs: readonly Pack[] = activePacks(), settings: PackRuleSettings = {}): Clause[] {
  const seen = new Set<string>();
  const out: Clause[] = [];
  const shadow = shadowPackIds();
  for (const pack of packs) {
    for (const rule of pack.rules) {
      const id = String(rule.id);
      if (seen.has(id)) continue;
      seen.add(id);
      const off = settings.off?.has(id) || settings.modes?.[id] === "off";
      if (off && switchable(rule) && rule.type === "action_allowlist" && Array.isArray(rule.action_types)) { out.push(offClause(rule, id)); continue; }
      const extra = switchable(rule) && rule.type === "action_allowlist" ? settings.exceptions?.[id] ?? [] : [];
      const own = Array.isArray(rule.exceptions) ? rule.exceptions : [];
      out.push({ ...clauseOf(rule), id, mode: blocksNow(rule, id, enforced, settings, shadow.has(pack.id)) ? "enforce" : "monitor", ...(extra.length ? { exceptions: [...own, ...extra] } : {}) });
    }
  }
  return out;
}

/** The ids of the rules the packs in force define that a person or a workspace can turn on: the target rules first, in their
 *  order, then the others by pack and rule order. */
export function switchablePackRules(packs: readonly Pack[] = activePacks()): string[] {
  const ids: string[] = [];
  for (const pack of packs) for (const rule of pack.rules) if (switchable(rule) && !ids.includes(String(rule.id))) ids.push(String(rule.id));
  return [...TARGET_RULES.filter((id) => ids.includes(id)), ...ids.filter((id) => !(TARGET_RULES as readonly string[]).includes(id))];
}

/** The rule a pack in force defines with this id (the first pack by id), or null. */
export function packRuleOf(id: string | null | undefined, packs: readonly Pack[] = activePacks()): Record<string, unknown> | null {
  if (!id) return null;
  for (const pack of packs) {
    const rule = pack.rules.find((r) => String(r.id) === id);
    if (rule) return rule;
  }
  return null;
}

/** The plain hint a pack rule gives the coding agent for a safer way (`safer_way`, level 2), or null. */
export function packRuleSaferWay(id: string | null | undefined, packs: readonly Pack[] = activePacks()): string | null {
  const hint = packRuleOf(id, packs)?.safer_way;
  return typeof hint === "string" && hint.trim() !== "" ? hint.trim() : null;
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
