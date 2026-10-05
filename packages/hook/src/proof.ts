// Safe proof fixtures.
//
// For each supported capability cell this runs its tagged vectors end to end against a
// throwaway hook home: a safe action must be allowed and countersigned; a violating one
// must be denied at the hook boundary; every receipt must verify against the
// countersigning key; and every receipt of one tool call must carry one action group.
//
// Nothing here touches a developer's real settings, policy, keys or receipts. Every run
// creates its own directory under the OS temp dir, scaffolds a fresh machine key, policy
// and store there, and deletes it afterwards. No network is used, so a fixture can never
// produce a Cloud acknowledgement: `cloud_ack` is always `not_checked`, and `origin` is
// always `fixture`. A cell therefore cannot reach `verified_reporting` from this runner
// (see capabilities.ts); it can only show `configured_unverified` with a passing
// fixture, or `degraded` with a failing one.
//
// Observation-only cells (Cursor's after-edit event, and monitor-mode fetch and MCP
// calls) are proven with a known successful after-action fixture, labelled
// observation-only. No deny fixture is run for them and none is claimed.

import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCloudExporter, createMemoryCloudOutbox, verifyReceipt, type SignedReceipt } from "@scopebond/gateway";
import { loadOrCreateAttester } from "@scopebond/gateway/node";
import { fillPushBranch } from "./map.js";
import { scaffold } from "./init.js";
import { createHookRuntime } from "./runtime.js";
import { ACTION_GROUP_PARAM } from "./group.js";
import { computeManifest, specForCell, vectorDigest, vectorsForCell, type Adapter, type CapabilityCell, type ProofRecord } from "./capabilities.js";
import { mapVector, type Vector } from "./vectors.js";
import { bindingKeyFromHex, operationsForCall, sourceReceiptHash } from "./observation.js";
import { callRequestOf, fixtureProbe } from "./typed-ops.js";
import { fixtureFiles } from "./typed-infra.js";
import { ingestUrl, type HookConnection } from "./cloud.js";

export const PROOF_FILE = "capability-proof.json";

const receiptActionType = (receipt: unknown): string | undefined =>
  (receipt as { payload?: { intent?: { action_type?: unknown } } } | undefined)?.payload?.intent?.action_type as string | undefined;

/** Options for a fixture run. */
export interface ProofRunOptions {
  /** A real hook config dir whose machine and countersigning keys the fixtures should be
   *  signed with (copied into the temp home, never modified), so the workspace can accept
   *  the fixture receipts and resolve a proof's digests against them. Without it the
   *  fixtures use throwaway keys and produce no digests a workspace could resolve. */
  identityDir?: string;
  /** Receives every fixture receipt produced, once each, for delivery. */
  collect?: unknown[];
}

const receiptParams = (receipt: unknown): Record<string, unknown> => {
  const payload = (receipt as { payload?: { intent?: { params?: Record<string, unknown> } } } | undefined)?.payload;
  return payload?.intent?.params ?? {};
};

interface Outcome { decision: string; receipts: unknown[]; valid: boolean; grouped: boolean; typed?: boolean }

const FIXTURE_KEY = bindingKeyFromHex("00".repeat(32));

/** Whether the adapter derives the typed operation a vector expects, from the same dispatched
 *  actions and raw request the hook uses, against a deterministic fixture repository. */
function typedDerived(vector: Vector, dispatched: Array<{ action: { action_type: string; params: Record<string, unknown> } }> | undefined): boolean {
  if (!vector.typed) return true;
  const request = callRequestOf(vector.input);
  const operations = operationsForCall({ dispatched: dispatched ?? [], request }, { key: FIXTURE_KEY, cwd: "/fixture", repositoryId: "sbr_fixture", probe: fixtureProbe, packageManagerVersion: () => undefined, files: fixtureFiles, env: () => undefined });
  return operations.some((op) => op?.type === vector.typed!.type && (vector.typed!.verb === undefined || op.verb === vector.typed!.verb));
}

async function run(vector: Vector, runtime: ReturnType<typeof createHookRuntime>, attesterPem: string): Promise<Outcome> {
  const decision = await runtime.evaluate(fillPushBranch(mapVector(vector), "feature/work"), { groupKey: `proof:${vector.id}` });
  const receipts = decision.receipts ?? (decision.receipt ? [decision.receipt] : []);
  const valid = receipts.length > 0 && receipts.every((r) => (verifyReceipt(r as Parameters<typeof verifyReceipt>[0], attesterPem) as unknown as { valid: boolean }).valid);
  const groups = new Set(receipts.map((r) => receiptParams(r)[ACTION_GROUP_PARAM]));
  const grouped = receipts.length > 0 && groups.size === 1 && typeof [...groups][0] === "string" && String([...groups][0]) !== "";
  return { decision: decision.decision, receipts, valid, grouped, typed: typedDerived(vector, decision.dispatched) };
}

/** Run one cell's fixtures in a temp hook home. Returns null when the cell has no vectors. */
async function proveCell(adapter: Adapter, actionType: string, phase: "pre_action" | "after_action", observationOnly: boolean, adapterVersion: string, options: ProofRunOptions): Promise<{ proof: Omit<ProofRecord, "cell">; receipts: unknown[] } | null> {
  const vectors = vectorsForCell(adapter, actionType, phase);
  const digest = vectorDigest(vectors);
  if (digest === null) return null;
  const dir = mkdtempSync(join(tmpdir(), "scopebond-proof-"));
  let runtime: ReturnType<typeof createHookRuntime> | undefined;
  try {
    if (options.identityDir) {
      for (const name of ["agent.key", "attester.key"]) {
        const source = join(options.identityDir, name);
        if (existsSync(source)) copyFileSync(source, join(dir, name));
      }
    }
    scaffold(dir);
    const attesterPath = join(dir, "attester.key");
    const { attester } = loadOrCreateAttester({ file: attesterPath });
    runtime = createHookRuntime({ policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"), attesterPath, dbPath: join(dir, "receipts.db") });
    const allow = vectors.filter((v) => v.cell?.role === "allow" || v.cell?.role === "after_action");
    const deny = vectors.filter((v) => v.cell?.role === "deny");
    const allowed: Outcome[] = [];
    for (const v of allow) allowed.push(await run(v, runtime, attester.publicKeyPem));
    const denied: Outcome[] = [];
    if (!observationOnly) for (const v of deny) denied.push(await run(v, runtime, attester.publicKeyPem));
    const all = [...allowed, ...denied];
    const receipts = all.flatMap((o) => o.receipts);
    // Only receipts of the cell's own action type stand as its proof (a compound command can
    // also produce receipts of other types), and each is named by the workspace's projection.
    const proofDigests = [...new Set(receipts.filter((r) => receiptActionType(r) === actionType).map((r) => sourceReceiptHash(r)))];
    return { receipts, proof: {
      ran_at: new Date().toISOString(), adapter_version: adapterVersion, test_vector_digest: digest, origin: "fixture",
      safe_allow: allowed.length > 0 && allowed.every((o) => o.decision !== "deny" && o.receipts.length > 0),
      safe_deny: observationOnly ? "not_applicable" : denied.length > 0 && denied.every((o) => o.decision === "deny"),
      signature: all.length > 0 && all.every((o) => o.valid),
      grouping: all.length > 0 && all.every((o) => o.grouped),
      cloud_ack: "not_checked", observation_only: observationOnly, proof_digests: proofDigests,
      ...(vectors.some((v) => v.typed) ? { typed_operation: all.length > 0 && all.every((o) => o.typed !== false) } : {}),
    } };
  } finally {
    try { runtime?.close(); } catch { /* the temp home is removed next */ }
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* a handle still open on Windows; the OS temp dir is cleaned later */ }
  }
}

/** Run every supported cell's fixtures once per adapter/action/phase, and record the
 *  result under each host variant's key. A fixture exercises the adapter, so it cannot
 *  tell Codex desktop from Codex CLI: both keys get the same fixture proof, and neither
 *  becomes verified (see `cellState`). */
export async function runProofFixtures(adapterVersion: string, options: ProofRunOptions = {}): Promise<Record<string, ProofRecord>> {
  const cells = computeManifest({ adapterVersion, configured: { claude: true, codex: true, cursor: true } }).cells;
  const records: Record<string, ProofRecord> = {};
  const cache = new Map<string, Omit<ProofRecord, "cell"> | null>();
  for (const cell of cells) {
    if (cell.state === "unsupported") continue;
    const spec = specForCell(cell);
    if (!spec) continue;
    const id = `${spec.adapter}/${spec.action_type}/${spec.phase}`;
    if (!cache.has(id)) {
      const run = await proveCell(spec.adapter, spec.action_type, spec.phase, cell.observation_only, adapterVersion, options);
      if (run) options.collect?.push(...run.receipts);
      cache.set(id, run?.proof ?? null);
    }
    const proof = cache.get(id);
    if (proof) records[cell.key] = { cell: cell.key, ...proof };
  }
  return records;
}

export function loadProofs(configDir: string): Record<string, ProofRecord> {
  const file = join(configDir, PROOF_FILE);
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { proofs?: Record<string, ProofRecord> };
    return parsed.proofs && typeof parsed.proofs === "object" ? parsed.proofs : {};
  } catch { return {}; }
}

export function saveProofs(configDir: string, proofs: Record<string, ProofRecord>): string {
  const file = join(configDir, PROOF_FILE);
  writeFileSync(file, `${JSON.stringify({ version: 1, proofs }, null, 2)}\n`);
  return file;
}

/** Whether a cell's fixture proof passed, for a summary line. */
export const proofPassed = (proof: ProofRecord, cell: CapabilityCell): boolean =>
  proof.safe_allow && (cell.observation_only ? proof.safe_deny === "not_applicable" : proof.safe_deny === true) && proof.signature && proof.grouping;

/** Deliver fixture receipts to the workspace's receipt route and report whether every one was
 *  accepted. A proof names these receipts by digest, so it is only worth sending after they
 *  landed; anything short of full delivery leaves the proof unsent, never half-claimed. */
export async function deliverProofReceipts(connection: HookConnection, receipts: unknown[], options: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<boolean> {
  if (receipts.length === 0) return true;
  const exporter = createCloudExporter({
    url: ingestUrl(connection), credential: connection.credential, outbox: createMemoryCloudOutbox({ maxPending: Math.max(1000, receipts.length) }),
    fetch: options.fetch, flushMs: 60_000,
  });
  try {
    for (const receipt of receipts) exporter.enqueue(receipt as SignedReceipt);
    const deadline = Date.now() + (options.timeoutMs ?? 15_000);
    while (exporter.pending() > 0 && Date.now() < deadline) {
      await exporter.flush();
      if (exporter.pending() > 0) {
        if (exporter.status().consecutiveFailures > 0) return false;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    return exporter.pending() === 0;
  } finally { exporter.stop(); }
}
