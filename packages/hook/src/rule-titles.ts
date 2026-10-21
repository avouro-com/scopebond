// The names a person reads for the rule behind a block, in the tray, the Scopebond window and the hook's own messages. They
// are the workspace's rule names, so a block reads the same on this computer as in the workspace. Every rule and clause the
// hook ships has its own name: a workspace rule's, else the clause's own (Scopebond's checks, the starter rules a workspace
// does not name, blocked services), else a rule pack's (its rule's title or description, else what its action types do).
// Only a block nothing names reads "A Scopebond rule", never an empty line or a rule id.
import { trimChars } from "./text.js";
import type { Pack } from "@scopebond/policy-schema/pack";
import { RULE_OF_CLAUSE, type AnyManagedRuleId } from "./managed.js";
import { activePacks } from "./packs.js";
import { blockedServiceKindOf, type BlockedServiceKind } from "./service-rules.js";

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

/** The ids a block note records for the checks that refuse a call without a policy clause, by the decision's `code`. */
const CHECK_OF_CODE: Readonly<Record<string, string>> = {
  install_verdict: "safe-install",
  session_budget: "session-budget",
  dispatch_refused: "dispatch-check",
};

/** The clauses (and checks) that carry no workspace rule, by their own name. */
const CLAUSE_TITLE: Readonly<Record<string, string>> = {
  "observe-net-mcp": "Contact websites or use MCP tools",
  "protect-root": "Change files outside the allowed folders",
  "protect-remote-database": "Run risky SQL on a remote database",
  "keys": "Act without this computer's enrolled key",
  "safe-install": "Install a package Safe Install flagged",
  "session-budget": "Go past this session's limits",
  "dispatch-check": "Act without a needed approval or past an agent's budget",
};

/** A service the workspace blocks, by kind. */
const BLOCKED_SERVICE_TITLE: Readonly<Record<BlockedServiceKind, string>> = {
  mcp_server: "Use a blocked MCP server",
  host: "Contact a blocked site",
  cli: "Run a blocked program",
  package: "Install a blocked package",
};

/** What an action type does, for a pack rule that says nothing about itself. */
const ACTION_TITLE: Readonly<Record<string, string>> = {
  "file.read": "Read a file",
  "file.write": "Change a file",
  "file.delete": "Delete files or folders",
  "git.push": "Push to a repository",
  "shell.exec": "Run a command",
  "net.fetch": "Contact a website",
  "mcp.tool.call": "Use an MCP tool",
  "package.install": "Install a package",
  "db.exec": "Run SQL on a database",
  "db.migrate": "Change a database's structure",
  "cloud.resource.create": "Create cloud resources",
  "cloud.resource.modify": "Change cloud resources",
  "cloud.resource.delete": "Delete cloud resources",
  "k8s.delete": "Delete Kubernetes objects",
  "k8s.exec": "Run a command inside a Kubernetes container",
  "deploy.release": "Deploy a release",
  "secret.read": "Read a secret",
  "secret.write": "Store or change a secret",
  "iam.change": "Change who can access what",
};

/** Scopebond's own protection, as the workspace names what it covers: changing its folder or the agents' hook settings is
 *  "Change Scopebond's or the agent's safety settings", and reading its folder (this computer's key) is reading a secret. */
const PROTECTION_RULE_OF_CLAUSE: Readonly<Record<string, WorkspaceRuleId | AnyManagedRuleId>> = {
  "protect-scopebond-write": "guardrail-config-write",
  "protect-scopebond-read": "secret-read",
};

const own = (map: object, key: string | null | undefined): boolean => !!key && Object.prototype.hasOwnProperty.call(map, key);
const TITLE_MAX = 60;

/** The workspace rule's name as a person reads it, or null for a rule this hook does not name. */
export function ruleTitle(rule: string | null | undefined): string | null {
  return own(RULE_TITLE, rule) ? RULE_TITLE[rule as AnyManagedRuleId] : null;
}

/** The workspace rule's name, or "A Scopebond rule": never empty, never a rule id. */
export const ruleName = (rule: string | null | undefined): string => ruleTitle(rule) ?? GENERIC_RULE_TITLE;

/** The workspace rule a denying clause carries, or null when it carries none (a local rule, a blocked service). */
export function ruleOfClause(clause: string | null | undefined): string | null {
  if (!clause) return null;
  if (own(RULE_OF_CLAUSE, clause)) return RULE_OF_CLAUSE[clause];
  if (own(PROTECTION_RULE_OF_CLAUSE, clause)) return PROTECTION_RULE_OF_CLAUSE[clause];
  return null;
}

/** The id a block note records for a call a check refused without a clause (Safe Install, a session budget, the dispatch
 *  check), from the decision's `code`; null for any other. */
export const checkOfCode = (code: string | null | undefined): string | null => (own(CHECK_OF_CODE, code) ? CHECK_OF_CODE[code as string] : null);

/** A title from a rule's description: its first sentence, without a leading "Record", "Deny" or "Block", in sentence case and
 *  at most 60 characters (cut at a word). Null when nothing is left. */
function titleOfDescription(text: string): string | null {
  let s = text.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s/)[0];
  s = trimChars(s, ".!? ");
  s = s.replace(/^(?:record|deny|block|refuse|stop|never)\s+/i, "");
  if (!s) return null;
  s = s[0].toUpperCase() + s.slice(1);
  if (s.length <= TITLE_MAX) return s;
  const cut = s.slice(0, TITLE_MAX - 3);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 20 ? cut.lastIndexOf(" ") : cut.length).replace(/[\s,;:]+$/, "")}...`;
}

/** The title of a rule a pack in force defines: the rule's `title` when it has one, else its description's first sentence,
 *  else what its first action type does, else the pack's own title. Null when no pack in force defines `clause`. */
export function packRuleTitle(clause: string | null | undefined, packs: readonly Pack[] = activePacks()): string | null {
  if (!clause) return null;
  for (const pack of packs) {
    const rule = pack.rules.find((r) => String(r.id) === clause);
    if (!rule) continue;
    const named = typeof rule.title === "string" ? titleOfDescription(rule.title) : null;
    const described = typeof rule.description === "string" ? titleOfDescription(rule.description) : null;
    const types = Array.isArray(rule.action_types) ? (rule.action_types as unknown[]).map(String) : [];
    const acted = types.map((t) => (own(ACTION_TITLE, t) ? ACTION_TITLE[t] : null)).find((t) => t !== null) ?? null;
    return named ?? described ?? acted ?? titleOfDescription(`An action the ${pack.title ?? pack.id} rules cover`) ?? pack.id;
  }
  return null;
}

/** The name of the rule behind a block, from the rule when it is known, else from the clause (or check) that denied it, else
 *  from the rule packs in force. "A Scopebond rule" only when none of them names it. */
export function blockTitle(rule: string | null | undefined, clause?: string | null, packs?: readonly Pack[]): string {
  const service = blockedServiceKindOf(clause);
  return ruleTitle(rule) ?? ruleTitle(ruleOfClause(clause)) ?? (service ? BLOCKED_SERVICE_TITLE[service] : null)
    ?? (own(CLAUSE_TITLE, clause) ? CLAUSE_TITLE[clause as string] : null) ?? packRuleTitle(clause, packs) ?? GENERIC_RULE_TITLE;
}
