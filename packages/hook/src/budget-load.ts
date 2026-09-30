// `scopebond budget load <export.json>`: load a reviewed action budget exported from a workspace,
// as the budget this machine enforces, and say honestly what happened.
//
// An export is a reviewed, approved policy in a file. It is pending in the workspace until a signed
// acknowledgement echoes exactly what the export said: its export id, the budget id and version, the
// policy digest and the scope digest. This module checks an export and, when asked, writes it into
// `dispatch.json` as an acknowledged budget policy; the caller then queues the `policy_ack`.
//
// What is checked, and what is not:
//   - the document type and version, and the fail-closed contract it carries (an export that would
//     permit unlimited dispatch on failure is refused);
//   - the policy digest: SHA-256 of the canonical policy with its acknowledgement removed, which is
//     what the workspace hashed when the budget was drafted;
//   - the scope digest, the environment (when this machine is connected), the validity window, and
//     that the policy is one an independent installation can enforce (a limit shared across
//     installations needs a shared in-path gateway, which a hook is not).
// An export carries no signature of its own: get the file from your workspace, over its own page or
// API. Loading replaces an older workspace budget for the same agent; it never replaces a newer one.

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { budgetDigest, type ActionBudgetPolicy } from "@scopebond/gateway";
import { DISPATCH_FILE, readDispatchFile } from "@scopebond/gateway/node";
import { digestPolicy, type PolicyAckInput, type PolicyLoadError } from "./observation.js";
import { policyScopeDigest, MAX_EXPORT_BYTES } from "./policy-load.js";

export const BUDGET_EXPORT_TYPE = "scopebond:action-budget-export";
const HEX64 = /^[0-9a-f]{64}$/;
const OPAQUE = /^[\x21-\x7e]{1,200}$/;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export interface BudgetExportFacts {
  exportId: string;
  budgetId: string;
  budgetVersion: number;
  policyDigest: string;
  scopeDigest: string;
  agentId: string;
  environmentId: string;
  validUntil: number;
  policy: { operation_set: string[]; authority_scope: "installation" | "shared_gateway"; max_dispatch: number; window_seconds: number; mode: "monitor" | "enforce"; version: number };
}

export type BudgetInspection =
  | { ok: true; facts: BudgetExportFacts }
  /** `ack` is set when the export names enough to echo in a rejection; otherwise nothing is acknowledged. */
  | { ok: false; error: PolicyLoadError | "expired"; message: string; ack?: Omit<PolicyAckInput, "error"> };

/** Accept the export itself, or the workspace's `{ version, export }` answer around it. */
export function unwrapBudgetExport(raw: unknown): Record<string, unknown> | null {
  if (!isObject(raw)) return null;
  if (raw.type === undefined && isObject(raw.export)) return raw.export;
  return raw;
}

/** Check an export without reading or changing anything on disk. Pure. */
export function inspectBudgetExport(raw: unknown, context: { environmentId?: string; now?: number } = {}): BudgetInspection {
  const exp = unwrapBudgetExport(raw);
  if (!exp || exp.type !== BUDGET_EXPORT_TYPE) return { ok: false, error: "schema_invalid", message: "this is not a Scopebond action budget export" };
  if (exp.version !== 1) return { ok: false, error: "unsupported", message: `unsupported export version ${String(exp.version)}` };
  const { export_id: exportId, budget_id: budgetId, budget_version: budgetVersion, agent_id: agentId, environment_id: environmentId, valid_until: validUntil } = exp;
  const policy = exp.policy;
  if (typeof exportId !== "string" || !OPAQUE.test(exportId) || typeof budgetId !== "string" || !OPAQUE.test(budgetId) || !Number.isInteger(budgetVersion) || (budgetVersion as number) < 1
    || (budgetVersion as number) > 2_147_483_647 || typeof agentId !== "string" || !OPAQUE.test(agentId) || typeof environmentId !== "string" || !OPAQUE.test(environmentId)
    || typeof validUntil !== "number" || !Number.isFinite(validUntil) || !isObject(policy) || typeof exp.policy_digest !== "string" || !HEX64.test(exp.policy_digest)
    || typeof exp.scope_digest !== "string" || !HEX64.test(exp.scope_digest)) {
    return { ok: false, error: "schema_invalid", message: "the export lacks a budget id, version, policy, digest or validity window, or they are malformed" };
  }
  // Echoed exactly as the export states them, so a rejection still names the export.
  const echo = { exportId, policyId: budgetId, policyVersion: budgetVersion as number, policyDigest: exp.policy_digest, scopeDigest: exp.scope_digest };
  const ops = policy.operation_set;
  if (!Array.isArray(ops) || ops.length < 1 || ops.length > 100 || !ops.every((o) => typeof o === "string" && OPAQUE.test(o))
    || (policy.authority_scope !== "installation" && policy.authority_scope !== "shared_gateway") || (policy.mode !== "monitor" && policy.mode !== "enforce")
    || !Number.isInteger(policy.max_dispatch) || (policy.max_dispatch as number) < 1 || (policy.max_dispatch as number) > 1_000_000_000
    || !Number.isInteger(policy.window_seconds) || (policy.window_seconds as number) < 1 || (policy.window_seconds as number) > 366 * 86_400
    || policy.version !== budgetVersion) {
    return { ok: false, error: "schema_invalid", message: "the export's budget policy is malformed", ack: echo };
  }
  if (digestPolicy({ ...policy, acknowledged: null }) !== exp.policy_digest) {
    return { ok: false, error: "signature_invalid", message: "the policy does not match the export's policy digest; the file was changed or damaged", ack: echo };
  }
  if (policyScopeDigest({ export_id: exportId, agent_id: agentId, environment_id: environmentId }) !== exp.scope_digest) {
    return { ok: false, error: "scope_mismatch", message: "the export's scope digest does not match its export, agent and environment", ack: echo };
  }
  if (context.environmentId !== undefined && context.environmentId !== environmentId) {
    return { ok: false, error: "scope_mismatch", message: "this export is for a different environment than this machine is connected to", ack: echo };
  }
  if (policy.acknowledged === null || policy.acknowledged === undefined) {
    return { ok: false, error: "schema_invalid", message: "the budget was not approved in the workspace (no acknowledgement); only an approved budget can be loaded", ack: echo };
  }
  const enforcement = isObject(exp.enforcement) ? exp.enforcement : null;
  const failClosed = enforcement && isObject(enforcement.fail_closed) ? enforcement.fail_closed : null;
  if (!failClosed || failClosed.unlimited_dispatch_on_failure !== false) {
    return { ok: false, error: "unsupported", message: "the export does not state the fail-closed contract (no unlimited dispatch on failure); it is refused", ack: echo };
  }
  if (policy.mode === "enforce" && (policy.authority_scope !== "installation" || enforcement?.eligible !== true)) {
    return { ok: false, error: "unsupported", message: "this budget cannot be enforced by an independent installation (a limit shared across installations needs a shared in-path gateway)", ack: echo };
  }
  if (validUntil <= (context.now ?? Date.now())) {
    return { ok: false, error: "expired", message: "this export is past its validity window; export the budget again from the workspace" };
  }
  return {
    ok: true,
    facts: {
      exportId, budgetId, budgetVersion: budgetVersion as number, policyDigest: exp.policy_digest, scopeDigest: exp.scope_digest, agentId, environmentId, validUntil,
      policy: policy as unknown as BudgetExportFacts["policy"],
    },
  };
}

/** The budget policy this machine enforces for an export: the reviewed limits, acting as this installation's agent, valid until the export says. */
export function localBudgetOf(facts: BudgetExportFacts, agentKid: string, acknowledgedAt: string): ActionBudgetPolicy & { source_export_id: string } {
  const policy: ActionBudgetPolicy & { source_export_id: string } = {
    budget_id: facts.budgetId, actor: agentKid, operations: [...facts.policy.operation_set], authority_scope: facts.policy.authority_scope, max: facts.policy.max_dispatch,
    window_seconds: facts.policy.window_seconds, mode: facts.policy.mode, version: facts.budgetVersion, expires_at: new Date(facts.validUntil).toISOString(),
    acknowledgement: null, source_export_id: facts.exportId,
  };
  // Loading it is the acknowledgement: the person who ran `budget load --yes` accepts this exact policy.
  policy.acknowledgement = { digest: budgetDigest(policy), acknowledged_at: acknowledgedAt };
  return policy;
}

export type BudgetLoadOutcome =
  | { state: "loaded"; facts: BudgetExportFacts; replaced: string[] }
  | { state: "would_load"; facts: BudgetExportFacts }
  | { state: "rejected"; error: PolicyLoadError | "expired"; message: string; ack?: Omit<PolicyAckInput, "error"> };

/** Read an export file, check it, and (with `apply`) write it into `dispatch.json` as an acknowledged budget. */
export function loadBudgetExport(dir: string, file: string, options: { apply: boolean; agentKid: string; environmentId?: string; now?: number }): BudgetLoadOutcome {
  let raw: unknown;
  try {
    if (statSync(file).size > MAX_EXPORT_BYTES) return { state: "rejected", error: "schema_invalid", message: "the export file is larger than 1 MiB" };
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return { state: "rejected", error: "schema_invalid", message: `the export could not be read as JSON (${(error as Error).name})` };
  }
  const inspected = inspectBudgetExport(raw, { environmentId: options.environmentId, now: options.now });
  if (!inspected.ok) return { state: "rejected", error: inspected.error, message: inspected.message, ...(inspected.ack ? { ack: inspected.ack } : {}) };
  const { facts } = inspected;
  const ack = { exportId: facts.exportId, policyId: facts.budgetId, policyVersion: facts.budgetVersion, policyDigest: facts.policyDigest, scopeDigest: facts.scopeDigest };
  if (!options.agentKid) return { state: "rejected", error: "unsupported", message: "this machine has no agent key to act as; run init first", ack };
  const current = readDispatchFile(dir) ?? {};
  const existing = (current.budgets ?? []) as Array<ActionBudgetPolicy & { source_export_id?: string }>;
  // Workspace budgets are per agent and versioned; a same or newer version is never replaced by an older export.
  const workspace = existing.filter((b) => b.source_export_id !== undefined && b.actor === options.agentKid);
  const newer = workspace.find((b) => b.budget_id !== facts.budgetId && b.version >= facts.budgetVersion);
  if (newer) return { state: "rejected", error: "unsupported", message: `a same or newer workspace budget (version ${newer.version}) is already loaded; an older export cannot replace it`, ack };
  const same = workspace.find((b) => b.budget_id === facts.budgetId);
  if (same && same.version > facts.budgetVersion) return { state: "rejected", error: "unsupported", message: `version ${same.version} of this budget is already loaded`, ack };
  if (!options.apply) return { state: "would_load", facts };
  mkdirSync(dir, { recursive: true });
  const replaced = workspace.filter((b) => b.budget_id !== facts.budgetId).map((b) => b.budget_id);
  const kept = existing.filter((b) => !workspace.includes(b));
  const next = { ...current, budgets: [...kept, localBudgetOf(facts, options.agentKid, new Date(options.now ?? Date.now()).toISOString())] };
  const target = join(dir, DISPATCH_FILE);
  const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  try { writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 }); renameSync(temp, target); }
  catch (error) { try { rmSync(temp, { force: true }); } catch { /* nothing to remove */ } throw error; }
  return { state: "loaded", facts, replaced };
}

