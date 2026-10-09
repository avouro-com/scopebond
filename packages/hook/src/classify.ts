// Catalog classification of one mapped intent, from the same typed data the compiled
// policy is built from (the rule set), so the two cannot drift.
//
// Detector ids follow the monitoring catalog: I03 ordinary read, I04 ordinary write,
// I05 shell inventory; H01 protected push, H02 credential read, H03 CI write,
// H04 destructive shell, H05 root-escape mutation; C01 protected history rewrite,
// C02 guardrail modification. `compile()` decides enforcement from the rule set;
// `classifyIntent()` names what an intent is. `test/vectors.test.mjs` asserts that an
// intent is classified high/critical exactly when the compiled policy denies it.
//
// Unknown is not clean: an intent whose destination, program or path could not be
// resolved is returned in `unknown`, never as an ordinary I-class match.

import type { NormalizedIntent } from "./map.js";
import { UNKNOWN_REF } from "./shell.js";
import { isDestructiveProgram, isProtectedBranch, pathRuleMatches, type RuleSet } from "./rules.js";

export type CatalogId = "I03" | "I04" | "I05" | "H01" | "H02" | "H03" | "H04" | "H05" | "C01" | "C02";

export interface Classification {
  ids: CatalogId[];
  /** Why the intent could not be classified (an unresolved ref, program or path). */
  unknown: string[];
  /** Set for H04: the classification is from the program name only, not a typed target. */
  coverage?: "program_only";
}

/** The CI locations: a write to one is H03; any other protected write is C02. */
const CI_LOCATION = /github\/(?:workflows|actions)|gitlab-ci|circleci|azure-pipelines|jenkinsfile|bitbucket-pipelines|travis|drone|cloudbuild|buildkite/i;

/** Ids whose match the default policy blocks. I-classes are inventory only. */
export const BLOCKING: readonly CatalogId[] = ["H01", "H02", "H03", "H04", "H05", "C01", "C02"];

export function classifyIntent(intent: NormalizedIntent, rules: RuleSet): Classification {
  const ids: CatalogId[] = [];
  const unknown: string[] = [];
  const params = intent.params;
  let coverage: Classification["coverage"];
  const path = typeof params.path === "string" ? params.path : "";

  if (intent.action_type === "git.push") {
    const ref = typeof params.ref === "string" ? params.ref : undefined;
    const rewrite = params.force === true || params.delete === true || params.all === true;
    if (ref === undefined || ref === UNKNOWN_REF) unknown.push("push destination not resolved");
    else if (ref === "--all" || ref === "--mirror" || ref === "--branches") ids.push("C01");
    else if (isProtectedBranch(rules, ref)) ids.push(rewrite ? "C01" : "H01");
  } else if (intent.action_type === "file.read") {
    if (path === "") unknown.push("read path not resolved");
    else ids.push(rules.protected_read.some((r) => pathRuleMatches(r, path)) ? "H02" : "I03");
  } else if (intent.action_type === "file.write") {
    if (path === "") unknown.push("write target not resolved");
    else {
      const scope = params.root_scope;
      if (scope === "outside") ids.push("H05");
      else if (scope === "unresolved") { ids.push("H05"); unknown.push("write target could not be resolved"); }
      const hit = rules.protected_write.find((r) => pathRuleMatches(r, path));
      if (hit) ids.push(CI_LOCATION.test(hit.kind === "raw" ? hit.pattern : hit.value) ? "H03" : "C02");
      else if (ids.length === 0) ids.push("I04");
    }
  } else if (intent.action_type === "shell.exec") {
    const program = typeof params.program === "string" ? params.program : "";
    if (program === "") unknown.push("program not resolved");
    else {
      ids.push("I05");
      if (isDestructiveProgram(rules, program)) { ids.push("H04"); coverage = "program_only"; }
    }
  }
  return { ids, unknown, ...(coverage ? { coverage } : {}) };
}

/** Whether the compiled default policy denies an intent with this classification. Used
 *  by the parity test and the proof runner. */
export function classificationBlocks(c: Classification): boolean {
  return c.unknown.length > 0 || c.ids.some((id) => BLOCKING.includes(id));
}
