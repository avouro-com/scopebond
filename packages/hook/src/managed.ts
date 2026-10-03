// Rules managed from a Scopebond Cloud workspace.
//
// A connected computer keeps its own rules (`rules.json` compiled into `policy.json`) until the workspace sets rules for it.
// From then on the workspace decides, rule by rule, whether a matching action is blocked or only recorded, and may add entries
// to the computer's own lists (protected branches, programs, allowed sites). It never sends a pattern: this module compiles the
// workspace's choices with the same compiler `rules apply` uses, so what decides a block lives in one place.
//
// A workspace may also name exact targets one rule skips: paths for the secret-read and CI-configuration rules, branches for the
// push rule. An exclusion matches exactly (same case; a trailing `/**` covers a folder), so it is never broader than what was typed,
// and an exclusion that would touch the always-on protection of the hook's own settings is dropped when the policy is compiled.
//
// What a workspace cannot change: the protection of the hook's own settings (and the settings of the agents it guards), the
// machine key policy, fail-closed handling of anything unparseable, and the computer's own opt-in extras (`allowed_roots`,
// `protect_remote_database`). A rule set to Monitor is still covered by an allow clause, so the action is recorded and passes;
// leaving it out would block the whole action type, because the verifier denies an action no clause covers.
//
// Loading is checked and atomic: the document must be well formed, name this computer, carry a matching digest and be newer
// than the one in force; the merged policy must build; policy.json is written through a temp file and a rename, the previous
// one kept. Disconnecting, or a workspace that stops managing this computer, restores the computer's own rules.

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { canonical } from "@scopebond/policy-schema/canonical";
import { GUARDRAIL_LOOKAHEADS, GUARDRAIL_WRITE_PATTERN, ci } from "./runtime.js";
import { compile, defaultRules, loadRules, type RuleSet } from "./rules.js";

export const MANAGED_DOC_FILE = "managed-rules.json";
export const MANAGED_META_FILE = "managed-meta.json";
export const PREVIOUS_POLICY_FILE = "policy.previous.json";

export const MANAGED_RULE_IDS = ["force-push-protected", "push-protected", "destructive-shell", "secret-read", "ci-config-write", "network-egress"] as const;
export type ManagedRuleId = (typeof MANAGED_RULE_IDS)[number];
type ListKey = "protected_branches" | "destructive_programs" | "allowed_hosts";
type ExclusionKey = "excluded_paths" | "excluded_branches";
const LIST_OF: Partial<Record<ManagedRuleId, ListKey>> = {
  "force-push-protected": "protected_branches", "push-protected": "protected_branches",
  "destructive-shell": "destructive_programs", "network-egress": "allowed_hosts",
};
const LIST_PATTERN: Record<ListKey, RegExp> = {
  protected_branches: /^[A-Za-z0-9._/*-]{1,100}$/,
  destructive_programs: /^[a-z0-9][a-z0-9._-]{0,63}$/,
  allowed_hosts: /^(?=.{1,253}$)(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
};
/** The exact targets a rule may skip, and the one list each rule accepts. */
const EXCLUSIONS_OF: Partial<Record<ManagedRuleId, ExclusionKey>> = {
  "secret-read": "excluded_paths", "ci-config-write": "excluded_paths", "push-protected": "excluded_branches",
};
const EXCLUSION_PATTERN: Record<ExclusionKey, RegExp> = {
  // A relative path with forward slashes: no empty, "." or ".." segment, optionally ending in /** for a folder.
  excluded_paths: /^(?!\/)(?!.*\/\/)(?!(?:.*\/)?\.{1,2}(?:\/|$))[A-Za-z0-9._@+-][A-Za-z0-9._@+/-]{0,199}?(?:\/\*\*)?$/,
  // One exact branch name; it starts with a letter or digit, so it can never be a push flag such as --all.
  excluded_branches: /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/,
};
const HEX64 = /^[0-9a-f]{64}$/;
const OPAQUE = /^[A-Za-z0-9._:-]{1,128}$/;

export type ManagedRule = { mode: "monitor" | "block" } & Partial<Record<ListKey | ExclusionKey, string[]>>;
export interface ManagedDocument {
  type: "scopebond:managed-rules";
  version: 1;
  revision: number;
  export_id: string;
  environment_id: string;
  agent_id: string;
  installation_id: string;
  rules: Record<ManagedRuleId, ManagedRule>;
  rules_digest: string;
}

export type RefusalReason = "invalid_document" | "stale_revision" | "wrong_computer" | "unsupported" | "write_failed";
export type Inspection = { ok: true; doc: ManagedDocument } | { ok: false; reason: RefusalReason; message: string };

export const digestRules = (rules: unknown): string => createHash("sha256").update(canonical(rules)).digest("hex");

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Check a document from the workspace without touching disk. Pure. */
export function inspectManaged(raw: unknown, context: { installationId: string; currentRevision: number | null; currentDigest?: string | null }): Inspection {
  const bad = (message: string): Inspection => ({ ok: false, reason: "invalid_document", message });
  if (!isObject(raw) || raw.type !== "scopebond:managed-rules") return bad("this is not a Scopebond workspace rules document");
  if (raw.version !== 1) return { ok: false, reason: "unsupported", message: `unsupported rules document version ${String(raw.version)}` };
  const { revision, export_id: exportId, environment_id: environmentId, agent_id: agentId, installation_id: installationId, rules, rules_digest: rulesDigest } = raw;
  if (!Number.isInteger(revision) || (revision as number) < 1 || (revision as number) > 2_147_483_647
    || typeof exportId !== "string" || typeof environmentId !== "string" || !OPAQUE.test(environmentId)
    || typeof agentId !== "string" || !OPAQUE.test(agentId) || typeof installationId !== "string" || !OPAQUE.test(installationId)
    || typeof rulesDigest !== "string" || !HEX64.test(rulesDigest) || !isObject(rules)) {
    return bad("the rules document is incomplete or malformed");
  }
  if (installationId !== context.installationId || exportId !== `rev-${revision}-${installationId}`) {
    return { ok: false, reason: "wrong_computer", message: "these rules were issued for a different computer" };
  }
  const keys = Object.keys(rules);
  if (keys.length !== MANAGED_RULE_IDS.length || !MANAGED_RULE_IDS.every((id) => keys.includes(id))) {
    return { ok: false, reason: "unsupported", message: "the rules document names rules this version does not know; update Scopebond" };
  }
  for (const id of MANAGED_RULE_IDS) {
    const rule = rules[id];
    if (!isObject(rule) || (rule.mode !== "monitor" && rule.mode !== "block")) return bad(`rule ${id} has no valid mode`);
    for (const key of Object.keys(rule)) {
      if (key === "mode") continue;
      const listKey = LIST_OF[id];
      const exclusionKey = EXCLUSIONS_OF[id];
      const pattern = key === listKey ? LIST_PATTERN[listKey] : key === exclusionKey ? EXCLUSION_PATTERN[exclusionKey] : null;
      if (!pattern) return bad(`rule ${id} has an unknown setting`);
      const list = rule[key];
      if (!Array.isArray(list) || list.length > 50 || !list.every((v) => typeof v === "string" && pattern.test(v) && !v.includes(".."))) {
        return bad(`rule ${id} has an invalid list`);
      }
    }
  }
  const network = rules["network-egress"] as ManagedRule;
  if (network.mode === "block" && !(network.allowed_hosts?.length)) return bad("network blocking needs at least one allowed site");
  if (digestRules(rules) !== rulesDigest) return bad("the rules do not match their digest; the document was changed or damaged");
  // The same version with different rules is a newer document too: the workspace can change what reaches this computer without a new
  // version (an agent moved to another team, or this hook started reading a setting it did not read before). The export id binds it here.
  const sameVersionChanged = context.currentRevision !== null && revision === context.currentRevision && !!context.currentDigest && rulesDigest !== context.currentDigest;
  if (context.currentRevision !== null && (revision as number) <= context.currentRevision && !sameVersionChanged) {
    return { ok: false, reason: "stale_revision", message: `version ${String(revision)} is not newer than the version in force (${context.currentRevision})` };
  }
  return { ok: true, doc: raw as unknown as ManagedDocument };
}

const union = (a: readonly string[], b: readonly string[] | undefined): string[] => [...new Set([...a, ...(b ?? [])])];
const branchGlob = (b: string): string => (b.endsWith("/*") ? `${b.slice(0, -1)}**` : b);
const hostPattern = (hosts: readonly string[]): string =>
  `^(?:${hosts.map((h) => (h.startsWith("*.") ? `(?:[^.]+\\.)+${ci(h.slice(2).replace(/\./g, "\\."))}` : ci(h.replace(/\./g, "\\.")))).join("|")})$`;

type Clause = Record<string, unknown> & { id: string };

const escapeRegex = (text: string): string => text.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
/** Exclusions that passed validation (the document check refuses the rest; this is a second line of defence). */
const safeExclusions = (paths: readonly string[] | undefined): string[] => (paths ?? []).filter((path) => EXCLUSION_PATTERN.excluded_paths.test(path) && !path.includes(".."));
/** An allow pattern that also allows exactly these paths (a trailing /** allows everything under the folder). The added alternative
 *  carries the always-on floor and refuses any path with a "." or ".." segment, so no exclusion — however it is written — can reach
 *  Scopebond's own settings or the agents' hook settings, or climb out of the folder it names. */
const withPathExclusions = (pattern: string, paths: readonly string[]): string => paths.length === 0 ? pattern
  : `^(?!(?:.*/)?\\.{1,2}(?:/|$))${GUARDRAIL_LOOKAHEADS}(?:${paths.map((p) => p.endsWith("/**") ? `${escapeRegex(p.slice(0, -3))}/.+` : escapeRegex(p)).join("|")})$|${pattern}`;
/** An allow pattern for pushes that also allows exactly these branches. */
const withBranchExclusions = (pattern: string, branches: readonly string[]): string => branches.length === 0 ? pattern
  : `^(?:refs/heads/)?(?:${branches.map(escapeRegex).join("|")})$|${pattern}`;
const boundPattern = (clause: Clause, key: string): string => String(((clause.param_bounds as Record<string, { pattern: string }> | undefined)?.[key])?.pattern ?? "");
const withBound = (clause: Clause, key: string, pattern: string): Clause => ({ ...clause, param_bounds: { ...(clause.param_bounds as Record<string, unknown>), [key]: { pattern } } });

/** The policy this computer enforces under workspace rules: its own compiled rules, adjusted rule by rule. Pure. */
export function compileManaged(local: RuleSet, doc: ManagedDocument, agentKid: string): Record<string, unknown> {
  const r = doc.rules;
  const rules: RuleSet = {
    ...local,
    protected_branches: union(local.protected_branches, [...(r["push-protected"].protected_branches ?? []), ...(r["force-push-protected"].protected_branches ?? [])]),
    destructive_programs: union(local.destructive_programs, r["destructive-shell"].destructive_programs),
  };
  const policy = compile(rules, agentKid) as { clauses: Clause[] } & Record<string, unknown>;
  const allowAll = (clause: Clause): Clause => { const { param_bounds: _dropped, ...rest } = clause; return { ...rest, mode: "enforce", description: `${String(clause.description ?? "").split(".")[0]}. Recorded, not blocked: set by your workspace.` }; };
  const clauses: Clause[] = [];
  for (const clause of policy.clauses) {
    if (clause.id === "protect-branches" && r["push-protected"].mode === "monitor") {
      clauses.push(allowAll(clause));
      if (r["force-push-protected"].mode === "block") {
        clauses.push({ id: "protect-branch-history", type: "force_push_guard", mode: "enforce", protected_refs: rules.protected_branches.map(branchGlob),
          description: "Deny force-pushes, deletions and mirror pushes that reach a protected branch; ordinary pushes are allowed. Set by your workspace." });
      }
    } else if (clause.id === "safe-shell" && r["destructive-shell"].mode === "monitor") clauses.push(allowAll(clause));
    else if (clause.id === "protect-read" && r["secret-read"].mode === "monitor") clauses.push(allowAll(clause));
    else if (clause.id === "protect-write" && r["ci-config-write"].mode === "monitor") {
      clauses.push({ ...clause, param_bounds: { path: { pattern: GUARDRAIL_WRITE_PATTERN } },
        description: "Allow workspace writes, but never to Scopebond's own settings or the agents' hook settings (always on). Other protected files are recorded, not blocked: set by your workspace." });
    } else if (clause.id === "protect-read" && r["secret-read"].excluded_paths?.length) {
      clauses.push(withBound(clause, "path", withPathExclusions(boundPattern(clause, "path"), safeExclusions(r["secret-read"].excluded_paths))));
    } else if (clause.id === "protect-write" && r["ci-config-write"].excluded_paths?.length) {
      clauses.push(withBound(clause, "path", withPathExclusions(boundPattern(clause, "path"), safeExclusions(r["ci-config-write"].excluded_paths))));
    } else if (clause.id === "protect-branches" && r["push-protected"].excluded_branches?.length) {
      clauses.push(withBound(clause, "ref", withBranchExclusions(boundPattern(clause, "ref"), r["push-protected"].excluded_branches)));
      // Skipping ordinary pushes to a branch never skips history protection: force-pushes, deletions and mirror pushes stay stopped.
      if (r["force-push-protected"].mode === "block") {
        clauses.push({ id: "protect-branch-history", type: "force_push_guard", mode: "enforce", protected_refs: rules.protected_branches.map(branchGlob),
          description: "Deny force-pushes, deletions and mirror pushes that reach a protected branch. Set by your workspace." });
      }
    } else clauses.push(clause);
  }
  if (r["network-egress"].mode === "block") {
    const keysAt = clauses.findIndex((c) => c.id === "keys");
    clauses.splice(keysAt < 0 ? clauses.length : keysAt, 0, {
      id: "allowed-sites", type: "action_allowlist", mode: "enforce", action_types: ["net.fetch"],
      param_bounds: { host: { pattern: hostPattern(r["network-egress"].allowed_hosts ?? []) } },
      description: `Deny web requests to sites other than ${r["network-egress"].allowed_hosts!.join(", ")}. Set by your workspace.`,
    });
  }
  return { ...policy, policy_id: "coding-agent", version: doc.revision, clauses };
}

// --- on disk ---------------------------------------------------------------------------------------------------------------------

export interface ManagedMeta {
  revision: number | null;
  rules_digest: string | null;
  export_id: string | null;
  etag: string | null;
  checked_at: string | null;
  last_ack: { revision: number; result: "loaded" | "rejected"; at: string } | null;
  last_error: string | null;
}
const EMPTY_META: ManagedMeta = { revision: null, rules_digest: null, export_id: null, etag: null, checked_at: null, last_ack: null, last_error: null };

export function readMeta(dir: string): ManagedMeta {
  try { return { ...EMPTY_META, ...(JSON.parse(readFileSync(join(dir, MANAGED_META_FILE), "utf8")) as Partial<ManagedMeta>) }; } catch { return { ...EMPTY_META }; }
}
export function writeMeta(dir: string, meta: ManagedMeta): void { writeAtomic(join(dir, MANAGED_META_FILE), `${JSON.stringify(meta, null, 2)}\n`); }

/** Whether a workspace currently manages the rules on this computer. */
export const isManaged = (dir: string): boolean => existsSync(join(dir, MANAGED_DOC_FILE));

export function writeAtomic(file: string, text: string): void {
  const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try { writeFileSync(temp, text, { mode: 0o600 }); renameSync(temp, file); }
  catch (error) { try { rmSync(temp, { force: true }); } catch { /* nothing to remove */ } throw error; }
}

/** Install a checked document: write the merged policy (previous kept) and the document. `policyBuilds` is the caller's check
 *  that the gateway can load the result. */
export function installManaged(dir: string, doc: ManagedDocument, agentKid: string, policyBuilds: (policy: Record<string, unknown>) => boolean): { ok: true } | { ok: false; reason: RefusalReason; message: string } {
  const local = loadRules(dir) ?? defaultRules();
  const policy = compileManaged(local, doc, agentKid);
  if (!policyBuilds(policy)) return { ok: false, reason: "unsupported", message: "this version of Scopebond cannot load the workspace rules; update it" };
  try {
    mkdirSync(dir, { recursive: true });
    const policyPath = join(dir, "policy.json");
    if (existsSync(policyPath)) copyFileSync(policyPath, join(dir, PREVIOUS_POLICY_FILE));
    writeAtomic(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
    writeAtomic(join(dir, MANAGED_DOC_FILE), `${JSON.stringify(doc, null, 2)}\n`);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: "write_failed", message: `could not write the rules (${(error as Error).name})` };
  }
}

/** Go back to this computer's own rules: recompile policy.json from rules.json and forget the workspace document. */
export function restoreLocal(dir: string, agentKid: string): void {
  const local = loadRules(dir) ?? defaultRules();
  const policyPath = join(dir, "policy.json");
  if (existsSync(policyPath)) copyFileSync(policyPath, join(dir, PREVIOUS_POLICY_FILE));
  writeAtomic(policyPath, `${JSON.stringify(compile(local, agentKid), null, 2)}\n`);
  rmSync(join(dir, MANAGED_DOC_FILE), { force: true });
}
