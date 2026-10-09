// Load a policy exported from a Scopebond Cloud workspace, and say honestly what happened.
//
// An export is a reviewed policy in a file. Nothing is enforcing it until a hook loads it, and
// the workspace shows it as "pending" until a signed acknowledgement echoes exactly what the
// export said: its policy digest, its policy id and version, its scope digest and the export
// id. This module checks an export and, when asked, installs it as the active policy; the
// caller then queues the acknowledgement (`ObservationEmitter.policyAck`).
//
// What is checked, and what is not:
//   - the export's own integrity: its `policy_hash` must be the SHA-256 of the canonical policy
//     it carries, and its `scope.scope_digest` must be the SHA-256 of
//     `scopebond:policy-scope/v1\n` + the canonical `{agent_id, environment_id, export_id}`;
//   - that it is for this workspace environment (when this machine is connected);
//   - that the gateway can build a runtime from it.
// An export carries no signature of its own, so this cannot prove who wrote it: get the file
// from your workspace, over the workspace's own page or API.
//
// Loading replaces the active policy. The previous file is kept beside it, and the write is
// atomic (a temp file in the same directory, then a rename), so an interrupted load leaves the
// old policy in place. Nothing here touches an agent's settings.

import { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { canonical } from "@scopebond/policy-schema/canonical";
import { scaffold } from "./init.js";
import { createHookRuntime } from "./runtime.js";
import { digestPolicy, type PolicyAckInput, type PolicyLoadError } from "./observation.js";
import { errorCode, readBounded } from "./safe-fs.js";

export const POLICY_SCOPE_DOMAIN = "scopebond:policy-scope/v1\n";
export const MAX_EXPORT_BYTES = 1024 * 1024;
export const LOADED_POLICY_FILE = "loaded-policy.json";
export const PREVIOUS_POLICY_FILE = "policy.previous.json";

/** SHA-256 of the domain plus the canonical scope an export was made for. */
export const policyScopeDigest = (scope: { export_id: string; agent_id: string; environment_id: string }): string =>
  createHash("sha256").update(POLICY_SCOPE_DOMAIN + canonical({ agent_id: scope.agent_id, environment_id: scope.environment_id, export_id: scope.export_id } as never), "utf8").digest("hex");

const HEX64 = /^[0-9a-f]{64}$/;
const OPAQUE = /^[\x21-\x7e]{1,200}$/;

export interface ExportFacts {
  exportId: string;
  policyId: string;
  policyVersion: number;
  policyDigest: string;
  scopeDigest: string;
  agentId: string;
  environmentId: string;
  policy: Record<string, unknown>;
}

export type Inspection =
  | { ok: true; facts: ExportFacts }
  /** `ack` is set when the export names enough to echo in a rejection; otherwise nothing is acknowledged. */
  | { ok: false; error: PolicyLoadError; message: string; ack?: Omit<PolicyAckInput, "error"> };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Accept the export itself, or the workspace's `{ id, configuration }` answer around it. */
export function unwrapExport(raw: unknown): Record<string, unknown> | null {
  if (!isObject(raw)) return null;
  if (raw.type === undefined && isObject(raw.configuration)) return raw.configuration;
  return raw;
}

/** Check an export without reading or changing anything on disk. Pure. */
export function inspectExport(raw: unknown, context: { environmentId?: string } = {}): Inspection {
  const exp = unwrapExport(raw);
  if (!exp || exp.type !== "scopebond:reviewed-policy-export") return { ok: false, error: "schema_invalid", message: "this is not a Scopebond policy export" };
  if (exp.version !== 1) return { ok: false, error: "unsupported", message: `unsupported export version ${String(exp.version)}` };
  const scope = exp.scope;
  const policy = exp.policy;
  if (!isObject(scope) || !isObject(policy) || typeof exp.policy_hash !== "string" || !HEX64.test(exp.policy_hash)) {
    return { ok: false, error: "schema_invalid", message: "the export lacks a policy, a policy hash or a scope block (an export made before scope blocks existed cannot be acknowledged; export it again from the workspace)" };
  }
  const { export_id: exportId, policy_id: policyId, policy_version: policyVersion, agent_id: agentId, environment_id: environmentId, scope_digest: scopeDigest } = scope;
  if (typeof exportId !== "string" || !OPAQUE.test(exportId) || typeof policyId !== "string" || !OPAQUE.test(policyId)
    || !Number.isInteger(policyVersion) || (policyVersion as number) < 1 || (policyVersion as number) > 2_147_483_647
    || typeof agentId !== "string" || !OPAQUE.test(agentId) || typeof environmentId !== "string" || !OPAQUE.test(environmentId)
    || typeof scopeDigest !== "string" || !HEX64.test(scopeDigest)) {
    return { ok: false, error: "schema_invalid", message: "the export's scope block is incomplete or malformed" };
  }
  // The values below are echoed exactly as the export states them, so a rejection still names the export.
  const echo = { exportId, policyId, policyVersion: policyVersion as number, policyDigest: exp.policy_hash, scopeDigest };
  if (digestPolicy(policy) !== exp.policy_hash) {
    return { ok: false, error: "signature_invalid", message: "the policy does not match the export's policy hash; the file was changed or damaged", ack: echo };
  }
  if (policyScopeDigest({ export_id: exportId, agent_id: agentId, environment_id: environmentId }) !== scopeDigest) {
    return { ok: false, error: "scope_mismatch", message: "the export's scope digest does not match its export, agent and environment", ack: echo };
  }
  if (context.environmentId !== undefined && context.environmentId !== environmentId) {
    return { ok: false, error: "scope_mismatch", message: "this export is for a different environment than this machine is connected to", ack: echo };
  }
  return { ok: true, facts: { ...echo, agentId, environmentId, policy } };
}

/** Whether the gateway can build a runtime from this policy, in a throwaway home. Never touches a real one. */
export function policyBuilds(policy: Record<string, unknown>): boolean {
  const dir = mkdtempSync(join(tmpdir(), "scopebond-policy-check-"));
  let runtime: ReturnType<typeof createHookRuntime> | undefined;
  try {
    scaffold(dir);
    writeFileSync(join(dir, "policy.json"), `${JSON.stringify(policy)}\n`);
    runtime = createHookRuntime({ policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"), attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db") });
    return true;
  } catch { return false; }
  finally {
    try { runtime?.close(); } catch { /* removed next */ }
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* the OS temp dir is cleaned later */ }
  }
}

export type LoadOutcome =
  | { state: "loaded"; facts: ExportFacts; policyPath: string; previous: string | null }
  | { state: "would_load"; facts: ExportFacts }
  | { state: "rejected"; error: PolicyLoadError; message: string; ack?: Omit<PolicyAckInput, "error"> };

/** Write a file atomically: a temp file in the same directory, then a rename. */
function writeAtomic(file: string, text: string): void {
  const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try { writeFileSync(temp, text, { mode: 0o600 }); renameSync(temp, file); }
  catch (error) { try { rmSync(temp, { force: true }); } catch { /* nothing to remove */ } throw error; }
}

/** Read an export file, check it, and (with `apply`) install it as the active policy in `dir`. */
export function loadPolicyExport(dir: string, file: string, options: { apply: boolean; environmentId?: string }): LoadOutcome {
  let raw: unknown;
  try {
    const text = readBounded(file, MAX_EXPORT_BYTES);
    if (text === null) return { state: "rejected", error: "schema_invalid", message: "the export file is larger than 1 MiB" };
    raw = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (error) {
    return { state: "rejected", error: "schema_invalid", message: `the export could not be read as JSON (${(error as Error).name})` };
  }
  const inspected = inspectExport(raw, { environmentId: options.environmentId });
  if (!inspected.ok) return { state: "rejected", error: inspected.error, message: inspected.message, ...(inspected.ack ? { ack: inspected.ack } : {}) };
  const { facts } = inspected;
  if (!policyBuilds(facts.policy)) {
    return { state: "rejected", error: "unsupported", message: "this gateway cannot load that policy", ack: { exportId: facts.exportId, policyId: facts.policyId, policyVersion: facts.policyVersion, policyDigest: facts.policyDigest, scopeDigest: facts.scopeDigest } };
  }
  if (!options.apply) return { state: "would_load", facts };
  mkdirSync(dir, { recursive: true });
  const policyPath = join(dir, "policy.json");
  let previous: string | null = null;
  try { copyFileSync(policyPath, join(dir, PREVIOUS_POLICY_FILE)); previous = join(dir, PREVIOUS_POLICY_FILE); }
  catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
  writeAtomic(policyPath, `${JSON.stringify(facts.policy, null, 2)}\n`);
  writeAtomic(join(dir, LOADED_POLICY_FILE), `${JSON.stringify({
    export_id: facts.exportId, policy_id: facts.policyId, policy_version: facts.policyVersion, policy_digest: facts.policyDigest,
    scope_digest: facts.scopeDigest, environment_id: facts.environmentId, agent_id: facts.agentId, loaded_at: new Date().toISOString(),
  }, null, 2)}\n`);
  return { state: "loaded", facts, policyPath, previous };
}
