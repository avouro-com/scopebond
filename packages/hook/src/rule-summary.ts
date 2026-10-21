// What this computer enforces, counted the way a person reads it ("Protection: On · 9 rules blocking · 4 packs").
//
// `ruleReport` (managed.ts) names the four starter rules only, and its shape is what the rules check sends the workspace and
// what an older Scopebond Agent reads, so it stays as it is. This summary counts every rule in force: the four starter
// rules, the workspace's allowed sites and history protection, the target rules and any other rule the packs in force put
// on Block, and each service the workspace blocks by name. A rule a pack only uses to record what it sees (an observation
// clause, which no one can turn on) is not counted. Scopebond's own protection is always on and is not counted either: it is
// not a rule anyone chose. Reads the files only.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Pack } from "@scopebond/policy-schema/pack";
import { enforcedRuleIds, packRuleAdjustmentsAt, isManaged, MANAGED_DOC_FILE, type ManagedDocument, type RuleSource } from "./managed.js";
import { ENFORCEABLE_RULES, loadRules } from "./rules.js";
import { TARGET_RULES } from "./target-rules.js";
import { packRuleClauses, switchablePackRules, withPackRules } from "./pack-rules.js";
import { loadPacks } from "./pack-store.js";
import { readBlockedServices } from "./service-rules.js";

/** The workspace's own rules that compile to a clause of another name: allowed sites (network-egress) and history
 *  protection (force-push-protected). Present only while they block. */
const WORKSPACE_CLAUSES = ["allowed-sites", "protect-branch-history"] as const;

export interface RuleSummary {
  /** Each counted rule by its clause id: what it does here (enforce = blocks, monitor = records) and who set it. */
  rules: Record<string, [ "enforce" | "monitor", RuleSource ]>;
  /** Rules that block, with each service the workspace blocks by name counted as one. */
  blocking: number;
  /** Rules that only record. */
  monitoring: number;
  /** The rule packs in force, by id and version, with the pack's title (its id when it has none). */
  packs: Array<{ id: string; version: string; title: string }>;
}

/** Count the rules in force on this computer. `packs`: the packs in force (default: the verified packs in its cache). Null
 *  when the compiled rules cannot be read. */
export function ruleSummary(dir: string, packs?: readonly Pack[]): RuleSummary | null {
  try {
    const inForce = packs ?? loadPacks(dir).packs;
    const enforced = enforcedRuleIds(dir);
    const settings = packRuleAdjustmentsAt(dir);
    const policy = withPackRules(JSON.parse(readFileSync(join(dir, "policy.json"), "utf8")) as { clauses?: Array<{ id?: unknown; mode?: unknown }> }, enforced, inForce, settings);
    const managed = isManaged(dir);
    const doc = managed ? JSON.parse(readFileSync(join(dir, MANAGED_DOC_FILE), "utf8")) as ManagedDocument : null;
    const overrides = (loadRules(dir)?.local_overrides ?? {}) as Record<string, string>;
    const source = (id: string): RuleSource => (!managed ? "computer" : doc?.local_changes === true && overrides[id] ? "computer" : "workspace");
    // The rules a person or a workspace can turn on: the starter rules, the workspace's own, the target rules, and any pack
    // rule that blocks (a pack rule that only records counts when it is one that can be turned on).
    const counted = new Set<string>([...ENFORCEABLE_RULES, ...WORKSPACE_CLAUSES, ...TARGET_RULES, ...switchablePackRules(inForce),
      ...packRuleClauses(enforced, inForce, settings).filter((c) => c.mode === "enforce").map((c) => c.id)]);
    const rules: RuleSummary["rules"] = {};
    for (const clause of policy.clauses ?? []) {
      const id = typeof clause?.id === "string" ? clause.id : "";
      if (!counted.has(id) || rules[id]) continue;
      rules[id] = [clause.mode === "monitor" ? "monitor" : "enforce", source(id)];
    }
    const modes = Object.values(rules).map(([mode]) => mode);
    const services = managed ? readBlockedServices(dir).length : 0;
    return {
      rules,
      blocking: modes.filter((m) => m === "enforce").length + services,
      monitoring: modes.filter((m) => m === "monitor").length,
      packs: inForce.map((p) => ({ id: p.id, version: p.version, title: typeof p.title === "string" && p.title ? p.title : p.id })),
    };
  } catch { return null; }
}
