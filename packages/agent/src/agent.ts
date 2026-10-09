// The Scopebond Agent's work, one cycle at a time. The hook still decides every action on its
// own (enforcement never depends on the agent); the agent keeps everything around it working:
// it delivers what the hook queued, keeps the workspace rules and the connection current, and
// knows when the agent settings lost their hook entry. Every step is best-effort and bounded;
// a cycle never throws.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createCloudExporter } from "@scopebond/gateway";
import { CHAIN_HEADS_FILE, SqliteCloudOutbox, chainHeadRecorder } from "@scopebond/gateway/node";
import { createSigner } from "@scopebond/sdk";
import {
  LOSSLESS_OUTBOX, OUTBOX_FILE, buildStatusJson, cursorDetected, codexDetected, hookVersion, ingestUrl,
  isHarnessConfigured, loadConnection, policyBuilds, recordDeliveryAttempt, repairDeliveryAt, sequenceProofFor, summaryOptions, syncPolicy, userHarnessFile,
  type Harness, type StatusJson, type SyncOutcome,
} from "@scopebond/hook";

export interface CycleOptions {
  /** The Scopebond home this agent serves (the user's ~/.scopebond by default). */
  dir: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Per-request timeout for the workspace's rules check, in milliseconds. */
  timeoutMs?: number;
  /** How long one cycle sends before it moves on to the rules check (default one minute); the rest is sent next cycle. */
  deliveryMs?: number;
  /** Per-request timeout for each delivery request, its answer included (default 30 s). */
  deliveryTimeoutMs?: number;
}

/** One cycle sends for at most this long, so a long queue never holds up the rules check and the credential renewal. */
export const CYCLE_DELIVERY_MS = 60_000;

export interface CycleResult {
  at: number;
  connected: boolean;
  delivered: number;
  pending: number;
  deliveryError: string | null;
  rules: SyncOutcome["state"] | "skipped";
  missingHookEntries: Harness[];
  /** A request from the workspace's computer page, carried on this cycle's rules check. */
  requested: "flush" | "self_check" | null;
  /** Records still waiting because this cycle's sending time ran out (not because the workspace refused them). */
  more: boolean;
}

/** The agents on this computer whose user-level settings should hold the Scopebond hook. */
export function expectedHarnesses(): Harness[] {
  return ["claude", ...(cursorDetected() ? ["cursor" as const] : []), ...(codexDetected() ? ["codex" as const] : [])];
}

/** Agent settings that lost their Scopebond hook entry (an update or a reset can remove it). */
export function missingHookEntries(harnesses: Harness[] = expectedHarnesses()): Harness[] {
  return harnesses.filter((h) => existsSync(userHarnessFile(h)) && !isHarnessConfigured(userHarnessFile(h)));
}

export async function runCycle(options: CycleOptions): Promise<CycleResult> {
  const now = options.now ?? Date.now;
  const dir = options.dir;
  const result: CycleResult = { at: now(), connected: false, delivered: 0, pending: 0, deliveryError: null, rules: "skipped", missingHookEntries: [], requested: null, more: false };
  try { result.missingHookEntries = missingHookEntries(); } catch { /* reported as none */ }
  const connection = loadConnection(dir);
  if (!connection) return result;
  result.connected = true;

  // 1. Deliver everything the hook queued, in batches, until the queue is empty or the workspace refuses.
  try {
    const outbox = new SqliteCloudOutbox(join(dir, OUTBOX_FILE), LOSSLESS_OUTBOX);
    // First, what the queue never got: evaluations a hook process was stopped in the middle of (closed as outcome-unknown
    // records) and receipts whose queue write failed. Best effort; never stops delivery.
    await repairDeliveryAt(dir, outbox, now());
    const before = outbox.status().pending;
    // The record numbers are signed with the same enrolled key that signs the receipts and summaries.
    const summaries = summaryOptions(dir);
    const sequenceProof = sequenceProofFor(connection, summaries?.attester);
    const exporter = createCloudExporter({
      url: ingestUrl(connection), credential: connection.credential, outbox,
      flushMs: 24 * 60 * 60 * 1000, fetch: options.fetchImpl, now, summaries, requestTimeoutMs: options.deliveryTimeoutMs ?? 30_000,
      ...(sequenceProof ? { sequenceProof } : {}),
      // The chain head each answer carries is kept beside the hook's receipts (chain-heads.json).
      onChainHead: chainHeadRecorder(join(dir, CHAIN_HEADS_FILE)),
    });
    try {
      const lastSuccess = exporter.status().lastSuccessAt;
      const started = Date.now();
      const deliveryMs = options.deliveryMs ?? CYCLE_DELIVERY_MS;
      await exporter.flush({ maxMs: deliveryMs });
      const status = exporter.status();
      result.more = status.pending > 0 && status.lastError === null && Date.now() - started >= deliveryMs;
      recordDeliveryAttempt(dir, status, now(), lastSuccess);
      result.pending = status.pending;
      result.delivered = Math.max(0, before - status.pending);
      result.deliveryError = status.lastError;
    } finally { exporter.stop(); }
  } catch (error) {
    result.deliveryError = (error as Error).message;
  }

  // 2. The rules check: the workspace's rules, the queue report, and credential renewal when due.
  try {
    const keyFile = join(dir, "agent.key");
    if (existsSync(keyFile)) {
      const agentKid = createSigner({ privateKeyPem: readFileSync(keyFile, "utf8") }).kid;
      const outcome = await syncPolicy(dir, { agentKid, hookVersion: hookVersion(), policyBuilds, fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs ?? 10_000, onRequest: (kind) => { result.requested = kind; } });
      result.rules = outcome.state;
    }
  } catch { result.rules = "unavailable"; }
  return result;
}

/** The machine-readable status (scopebond.status.v1) for this computer, as the hook reports it. */
export function computerStatus(dir: string, now?: number): StatusJson {
  const expected = expectedHarnesses();
  const configured = (h: Harness) => expected.includes(h) && existsSync(userHarnessFile(h)) && isHarnessConfigured(userHarnessFile(h));
  return buildStatusJson({
    version: hookVersion(), activeDir: dir, candidateDirs: [dir], hasPolicy: existsSync(join(dir, "policy.json")),
    agents: { claude: configured("claude"), cursor: configured("cursor"), codex: configured("codex") }, now,
  });
}
