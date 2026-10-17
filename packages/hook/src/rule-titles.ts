// The names a person reads for the rule behind a block, in the tray, the Scopebond window and the hook's own messages. They
// are the workspace's rule names, so a block reads the same on this computer as in the workspace. A block whose rule has no
// name here still gets one: a blocked service, or a plain "A Scopebond rule", never an empty line or a rule id.
import { RULE_OF_CLAUSE, type AnyManagedRuleId } from "./managed.js";
import { blockedServiceKindOf } from "./service-rules.js";

/** Rules the workspace names that this hook has no setting for (it reports what they cover, or protects it always). */
type WorkspaceRuleId = "branch-delete" | "file-delete" | "guardrail-config-write" | "package-install" | "routine-commits";

const RULE_TITLE: Readonly<Record<AnyManagedRuleId | WorkspaceRuleId, string>> = {
  "force-push-protected": "Rewrite history on a protected branch",
  "push-protected": "Push straight to a protected branch",
  "branch-delete": "Delete a branch",
  "destructive-shell": "Run a command that deletes data or shuts down the computer",
  "file-delete": "Delete files",
  "secret-read": "Read passwords, keys or secrets",
  "ci-config-write": "Change build and release settings",
  "guardrail-config-write": "Change Scopebond's or the agent's safety settings",
  "package-install": "Install software packages",
  "network-egress": "Contact websites and online services",
  "routine-commits": "Everyday file reads and saves",
  "cloud-destructive": "Delete cloud resources or Kubernetes objects",
  "production-deploy": "Deploy to production",
  "secret-write": "Store or change a secret",
  "iam-change": "Change who can access what",
  "database-migrate": "Undo or reset a database migration",
};

/** The name for a block whose rule this hook cannot name. */
export const GENERIC_RULE_TITLE = "A Scopebond rule";
/** The name for a block by a service the workspace blocks (an MCP server, a site, a program or a package). */
const BLOCKED_SERVICE_TITLE = "Blocked service";

/** Scopebond's own protection, as the workspace names what it covers: changing its folder or the agents' hook settings is
 *  "Change Scopebond's or the agent's safety settings", and reading its folder (this computer's key) is reading a secret. */
const PROTECTION_RULE_OF_CLAUSE: Readonly<Record<string, WorkspaceRuleId | AnyManagedRuleId>> = {
  "protect-scopebond-write": "guardrail-config-write",
  "protect-scopebond-read": "secret-read",
};

/** The workspace rule's name as a person reads it, or null for a rule this hook does not name. */
export function ruleTitle(rule: string | null | undefined): string | null {
  return rule && Object.prototype.hasOwnProperty.call(RULE_TITLE, rule) ? RULE_TITLE[rule as AnyManagedRuleId] : null;
}

/** The workspace rule's name, or "A Scopebond rule": never empty, never a rule id. */
export const ruleName = (rule: string | null | undefined): string => ruleTitle(rule) ?? GENERIC_RULE_TITLE;

/** The workspace rule a denying clause carries, or null when it carries none (a local rule, a blocked service). */
export function ruleOfClause(clause: string | null | undefined): string | null {
  if (!clause) return null;
  if (Object.prototype.hasOwnProperty.call(RULE_OF_CLAUSE, clause)) return RULE_OF_CLAUSE[clause];
  if (Object.prototype.hasOwnProperty.call(PROTECTION_RULE_OF_CLAUSE, clause)) return PROTECTION_RULE_OF_CLAUSE[clause];
  return null;
}

/** The name of the rule behind a block, from the rule when it is known, else from the clause that denied it. */
export function blockTitle(rule: string | null | undefined, clause?: string | null): string {
  return ruleTitle(rule) ?? ruleTitle(ruleOfClause(clause)) ?? (blockedServiceKindOf(clause) ? BLOCKED_SERVICE_TITLE : GENERIC_RULE_TITLE);
}
