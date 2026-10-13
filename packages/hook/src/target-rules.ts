// The target rules: what a coding agent reaches through cloud, Kubernetes, database, deployment and secret tools
// (typed-targets.ts, mcp-profiles.ts), as policy clauses. A leaf module (no local imports), so the starter policy (runtime.ts)
// and the rules compiler (rules.ts), which import each other, both read it.

import { actionRegistry } from "@scopebond/policy-schema/registry";

/** The action types whose presence in a policy opts it into deciding derived actions: every type Action Taxonomy 1.1
 *  introduced, except `db.exec`, which policies named before 1.1 (`protect-remote-database`). A policy that names none of
 *  them was written for the 1.0 vocabulary, and a derived action under it is recorded, never decided (runtime.ts). */
export const TARGET_OPT_IN_TYPES: readonly string[] = actionRegistry.actions
  .filter((a) => a.taxonomy_version !== "1.0" && a.id !== "db.exec").map((a) => a.id);

/** Whether a policy opts into deciding derived actions: one of its clauses names a type in `TARGET_OPT_IN_TYPES`. The
 *  shipped target clauses below all do, so every policy this version compiles opts in; a policy compiled before them (or a
 *  workspace policy that carries none of them) decides every call exactly as it did before derived actions existed. */
export function policyOptsIntoTargets(policy: unknown): boolean {
  const clauses = (policy as { clauses?: unknown[] } | null)?.clauses;
  for (const clause of Array.isArray(clauses) ? clauses : []) {
    const c = clause as { action_types?: unknown; first_action_types?: unknown; then_action_types?: unknown };
    for (const list of [c.action_types, c.first_action_types, c.then_action_types]) {
      if (Array.isArray(list) && list.some((t) => typeof t === "string" && TARGET_OPT_IN_TYPES.includes(t))) return true;
    }
  }
  return false;
}

/** The rules for what a coding agent reaches through cloud, Kubernetes, database, deployment and secret tools (typed-targets.ts,
 *  mcp-profiles.ts). Each records by default (monitor) and blocks once a person or the workspace turns it on. */
export const TARGET_RULES = ["cloud-destructive", "production-deploy", "secret-write", "iam-change", "database-migrate"] as const;
export type TargetRule = typeof TARGET_RULES[number];

/** The action types the target rules record without bounds: changes that are worth a record and that no shipped rule blocks. */
export const OBSERVED_TARGET_TYPES = ["cloud.resource.create", "cloud.resource.modify", "k8s.apply", "db.exec", "communication.send", "work.item.create", "work.item.update", "pr.open", "pr.merge"];

/** The target rules' clauses, shared by the starter policy and the rules compiler so the two cannot drift. Each blocking rule
 *  bounds a parameter every derived intent carries (`risk_class`, or a deployment's `environment`), so it blocks exactly what
 *  its catalog class names (classify.ts, H06–H10). */
export function targetRuleClauses(mode: (id: TargetRule) => "enforce" | "monitor"): Array<Record<string, unknown>> {
  const where = "Change this in .scopebond/rules.json (rules enforce|monitor <rule>) or in your workspace.";
  return [
    {
      id: "cloud-destructive", type: "action_allowlist", mode: mode("cloud-destructive"), action_types: ["cloud.resource.delete", "cloud.resource.modify", "k8s.delete", "k8s.exec"],
      param_bounds: { risk_class: { pattern: "^(?!destructive$).+" } },
      description: `Deny deleting cloud resources and Kubernetes objects, running commands inside containers, and applying a saved infrastructure plan whose changes the command does not show, through a known command-line tool (aws, gcloud, az, terraform destroy, wrangler, vercel, fly, gh repo delete, kubectl, helm). ${where}`,
    },
    {
      id: "production-deploy", type: "action_allowlist", mode: mode("production-deploy"), action_types: ["deploy.release"],
      param_bounds: { environment: { pattern: "^(?!(?:production|unknown)$).+" } },
      description: `Deny deployments to production, and deployments whose environment the command does not show (wrangler deploy, vercel --prod, fly deploy, gcloud run deploy, aws cloudformation deploy, az webapp deploy, eb deploy, serverless deploy). ${where}`,
    },
    {
      id: "secret-write", type: "action_allowlist", mode: mode("secret-write"), action_types: ["secret.write"],
      param_bounds: { risk_class: { pattern: "^(?!sensitive$).+" } },
      description: `Deny storing or changing secrets in a secret store (gh secret set, wrangler secret put, vercel env add, fly secrets set, aws ssm put-parameter, Secrets Manager, Secret Manager, Key Vault, Vault, Doppler, 1Password). The value is never read. ${where}`,
    },
    {
      id: "iam-change", type: "action_allowlist", mode: mode("iam-change"), action_types: ["iam.change"],
      param_bounds: { risk_class: { pattern: "^(?!identity$).+" } },
      description: `Deny identity and access changes: roles, policies, users, groups and keys (aws iam, gcloud iam and IAM policy bindings, az role and ad). ${where}`,
    },
    {
      id: "database-migrate", type: "action_allowlist", mode: mode("database-migrate"), action_types: ["db.migrate"],
      param_bounds: { risk_class: { pattern: "^(?!destructive$).+" } },
      description: `Deny database migrations that go down, lose data or reset (prisma migrate reset, rails db:rollback or db:reset, alembic downgrade, flyway clean or undo, knex and sequelize rollbacks), except against a development database the command names; migrations that go up are recorded. ${where}`,
    },
    {
      id: "observe-targets", type: "action_allowlist", mode: "monitor", action_types: OBSERVED_TARGET_TYPES,
      description: `Observe cloud resources created or changed, Kubernetes changes, SQL run through a database tool, messages, work items and pull requests reached through a known tool (recorded, not blocked). Change this in .scopebond/rules.json.`,
    },
  ];
}
