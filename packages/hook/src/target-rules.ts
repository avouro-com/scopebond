// The target rules: what a coding agent reaches through the tools a rule pack describes (packs.ts), as policy clauses. The
// engine knows only their ids and when a policy decides derived actions; each rule's clause (its action types, bounds and
// wording) comes from the rule packs in force (pack-rules.ts). A leaf module (no local imports), so the starter policy
// (runtime.ts), the rules compiler (rules.ts) and the workspace document check (managed.ts), which import each other, all read it.

import { actionRegistry } from "@scopebond/policy-schema/registry";

/** The action types whose presence in a policy opts it into deciding derived actions: every type Action Taxonomy 1.1
 *  introduced, except `db.exec`, which policies named before 1.1 (`protect-remote-database`). A policy that names none of
 *  them was written for the 1.0 vocabulary, and a derived action under it is recorded, never decided (runtime.ts). */
export const TARGET_OPT_IN_TYPES: readonly string[] = actionRegistry.actions
  .filter((a) => a.taxonomy_version !== "1.0" && a.id !== "db.exec").map((a) => a.id);

/** The types the signed taxonomy extension in force marks `target_opt_in` (pack-taxonomy.ts sets them). */
let extensionOptIn: readonly string[] = [];
/** Set the extension types that opt a policy in (an empty list removes them). */
export function setExtensionOptInTypes(types: readonly string[]): void { extensionOptIn = [...types]; }
/** `TARGET_OPT_IN_TYPES`, then the extension types in force that opt in. */
export const targetOptInTypes = (): readonly string[] => (extensionOptIn.length ? [...TARGET_OPT_IN_TYPES, ...extensionOptIn] : TARGET_OPT_IN_TYPES);

/** Whether a policy opts into deciding derived actions: one of its clauses names a type in `targetOptInTypes()`. A pack's
 *  rules do, so a policy with the packs' rules in force opts in; a policy without them (or a workspace policy that carries none
 *  of them) decides every call exactly as it did before derived actions existed. */
export function policyOptsIntoTargets(policy: unknown): boolean {
  const optIn = targetOptInTypes();
  const clauses = (policy as { clauses?: unknown[] } | null)?.clauses;
  for (const clause of Array.isArray(clauses) ? clauses : []) {
    const c = clause as { action_types?: unknown; first_action_types?: unknown; then_action_types?: unknown };
    for (const list of [c.action_types, c.first_action_types, c.then_action_types]) {
      if (Array.isArray(list) && list.some((t) => typeof t === "string" && optIn.includes(t))) return true;
    }
  }
  return false;
}

/** The target rules a person or a workspace can switch between recording and blocking. A rule pack defines each one's clause;
 *  without a pack that defines it, a rule is accepted (a workspace may set it) and does nothing. Each records by default
 *  (monitor) and blocks once a person or the workspace turns it on. */
export const TARGET_RULES = ["cloud-destructive", "production-deploy", "secret-write", "iam-change", "database-migrate"] as const;
export type TargetRule = typeof TARGET_RULES[number];
