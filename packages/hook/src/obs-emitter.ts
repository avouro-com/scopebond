// Observation emitters: when the hook may emit, and what it emits.
//
// Emission is opt-in through the workspace enrollment. It is on only when the connection
// (`cloud.json`) carries the `observations:write` scope AND the enrollment handoff gave an
// installation id and generation AND the agent key's id matches the one the workspace
// enrolled. Otherwise it is silently off (with a status line) or reported unsupported;
// nothing is guessed. None of it can change a policy decision: every failure here is
// swallowed by the caller and the local receipt path is untouched.
//
// Kinds emitted (an agent-adapter key may emit these and no others):
//   session      start / stop, from Claude Code's SessionStart and SessionEnd hooks
//   health       heartbeat (every five minutes while a session is explicitly active, saying so), queue telemetry
//   capability   proof, from the `capabilities --prove` runner
//   policy_ack   loaded / rejected, from `policy load` once an exported policy is verified or refused
//   tool_intent  the request binding of each dispatched action, linked to its receipt
//   tool_outcome the after-action result, echoing the stored binding (Claude Code)
//
// There is no always-on process. Heartbeats come from one short helper per active session,
// claimed under a lease so hook calls cannot multiply it; it ends when the session ends,
// after ten minutes without hook activity (it then releases the lease with a final
// `lease_active: false` heartbeat), or when the host clock jumps (the host slept: it records
// a stop with reason `sleep` and emits nothing for the gap).

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn, execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ingestUrl, loadConnection, type HookConnection } from "./cloud.js";
import {
  operationsForCall, capabilityProofData, digestPolicy, heartbeatData, intentData, loadOrCreateBindingKey, observationSigner,
  outcomeData, policyAckData, queueData, sessionStartData, sessionStopData, sourceReceiptHash,
  type BindingKey, type CallRequest, type ExitCategory, type ObservationSigner, type PolicyAckInput, type SessionStopReason, type CapabilityProofInput,
} from "./observation.js";
import { openApprovalBinder } from "@scopebond/gateway/node";
import { OBSERVATION_DB, ObservationStore, type EnqueueResult } from "./obs-store.js";
import type { GitProbe } from "./typed-ops.js";
import { isProtectedBranch, loadRules } from "./rules.js";
import { uploadPending, type UploadOutcome } from "./obs-upload.js";

export const OBSERVATIONS_SCOPE = "observations:write";
/** Every five minutes, said in each heartbeat (`interval_s`): a workspace waits three of these before calling a computer lost.
 *  It was 60 s, which made a busy workspace's computers send hundreds of thousands of heartbeats a day. */
export const HEARTBEAT_INTERVAL_MS = 300_000;
/** A loop that finds the clock moved by more than this since its last tick treats the host as slept. */
export const SLEEP_GAP_MS = 3 * HEARTBEAT_INTERVAL_MS;
/** Heartbeats continue this long after the last hook activity, then the lease is released. */
export const IDLE_LIMIT_MS = 15 * 60_000;
export const HEARTBEAT_LEASE_MS = 2.5 * HEARTBEAT_INTERVAL_MS;
export const QUEUE_TELEMETRY_INTERVAL_MS = 5 * 60_000;
/** At most this many typed operations are recorded per tool call; the rest are counted. */
export const MAX_INTENTS_PER_CALL = 10;

export type ObservationStatus =
  | { state: "off"; reason: string }
  | { state: "unsupported"; reason: string }
  | { state: "on" };

/** The installation id is the enrollment's `installation_id`, or its `gateway_id` (the same
 *  identifier, which is what an enrollment answer carries today). The generation has no such
 *  fallback: only the workspace can say what it is. */
export function withInstallationId(connection: HookConnection): HookConnection {
  return connection.installation_id === undefined && typeof connection.gateway_id === "string"
    ? { ...connection, installation_id: connection.gateway_id } : connection;
}

/** Decide from the connection alone whether emission is enabled. Pure; reads nothing. */
export function observationStatus(input: HookConnection | null, keyKid?: string): ObservationStatus {
  if (!input) return { state: "off", reason: "not connected to a workspace" };
  const connection = withInstallationId(input);
  if (!Array.isArray(connection.scopes) || !connection.scopes.includes(OBSERVATIONS_SCOPE)) {
    return { state: "off", reason: `this enrollment does not grant ${OBSERVATIONS_SCOPE}` };
  }
  if (typeof connection.installation_id !== "string" || !/^[\x21-\x7e]{1,200}$/.test(connection.installation_id)) {
    return { state: "unsupported", reason: "the enrollment did not include an installation id; reconnect after the workspace supports observations" };
  }
  if (!Number.isInteger(connection.installation_generation) || (connection.installation_generation as number) < 1 || (connection.installation_generation as number) > 2_147_483_647) {
    return { state: "unsupported", reason: "the enrollment did not include an installation generation; reconnect after the workspace supports observations" };
  }
  if (typeof connection.agent_kid !== "string" || !/^[A-Za-z0-9:._-]{1,200}$/.test(connection.agent_kid)) {
    return { state: "unsupported", reason: "the enrollment did not register the agent signing key" };
  }
  if (keyKid !== undefined && keyKid !== connection.agent_kid) {
    return { state: "unsupported", reason: "the local agent key is not the key the workspace enrolled" };
  }
  return { state: "on" };
}

export interface EmitterOptions {
  fetch?: typeof fetch;
  now?: () => number;
  adapterVersion?: string;
  /** Tests: do not start the heartbeat helper process. */
  spawnHeartbeat?: boolean;
  /** Bound on one upload attempt from a hook call. */
  flushTimeoutMs?: number;
}

export interface OpenResult {
  status: ObservationStatus;
  emitter?: ObservationEmitter;
}

/** Open the emitter for a hook config dir, or explain why not. Never throws: an
 *  unreadable key or store simply leaves observations off. */
export function openObservations(dir: string, options: EmitterOptions = {}): OpenResult {
  const loaded = loadConnection(dir);
  const early = observationStatus(loaded);
  if (early.state !== "on" || !loaded) return { status: early };
  const connection = withInstallationId(loaded);
  let store: ObservationStore | undefined;
  try {
    const keyPem = readFileSync(join(dir, "agent.key"), "utf8");
    const signer = observationSigner(keyPem, connection.agent_kid as string);
    store = new ObservationStore(join(dir, OBSERVATION_DB), options.now);
    const bound = store.bindGeneration(connection.installation_generation as number);
    if (!bound.ok) { store.close(); return { status: { state: "unsupported", reason: bound.reason } }; }
    const emitter = new ObservationEmitter(dir, connection, store, signer, loadOrCreateBindingKey(dir), options);
    return { status: { state: "on" }, emitter };
  } catch (error) {
    try { store?.close(); } catch { /* nothing to release */ }
    return { status: { state: "unsupported", reason: `observation setup failed: ${(error as Error).message.slice(0, 120)}` } };
  }
}

export class ObservationEmitter {
  constructor(
    readonly dir: string,
    readonly connection: HookConnection,
    readonly store: ObservationStore,
    private readonly signer: ObservationSigner,
    readonly binding: BindingKey,
    private readonly options: EmitterOptions = {},
  ) {}

  private now(): number { return (this.options.now ?? Date.now)(); }
  private get context() {
    return { installationId: this.connection.installation_id as string, generation: this.connection.installation_generation as number };
  }
  private get adapterVersion(): string { return this.options.adapterVersion ?? "unknown"; }

  /** Queue one observation. Any failure is contained: emission never throws to the caller. */
  emit(draft: Parameters<ObservationStore["enqueue"]>[0]): EnqueueResult | null {
    try { return this.store.enqueue(draft, this.context, this.signer); } catch { return null; }
  }

  /** Try to deliver the outbox, bounded. Never throws. */
  async flush(timeoutMs = this.options.flushTimeoutMs ?? 800): Promise<UploadOutcome | null> {
    try {
      return await uploadPending(this.store, {
        url: ingestUrl(this.connection), credential: this.connection.credential,
        fetch: this.options.fetch, now: this.options.now, timeoutMs,
      });
    } catch { return null; }
  }

  close(): void { this.store.close(); }

  // ---- session lifecycle ---------------------------------------------------------------------

  sessionIdOf(harnessSessionId: string): string { return this.binding.sessionId(harnessSessionId); }

  /** A local key for a harness tool call, so the after-action hook finds what the
   *  before-action hook recorded. Keyed, so the raw ids are not written to the local store. */
  private callKey(harnessSessionId: string | undefined, callId: string): string {
    return this.binding.resourceId("call", `${harnessSessionId ?? ""}\u0000${callId}`);
  }

  /** SessionStart: record one start per session and make sure the heartbeat helper runs. */
  sessionStart(harnessSessionId: string, cwd: string): void {
    const sessionId = this.sessionIdOf(harnessSessionId);
    const repositoryId = this.binding.resourceId("repo", cwd);
    if (this.store.activateSession(sessionId, repositoryId)) {
      this.emit({ kind: "session", occurredAt: this.now(), sessionId, data: sessionStartData(repositoryId) });
    }
    this.ensureHeartbeat(sessionId);
  }

  /** SessionEnd: record one stop, with its reason, only for a session that was active. */
  sessionStop(harnessSessionId: string, reason: SessionStopReason): void {
    const sessionId = this.sessionIdOf(harnessSessionId);
    const row = this.store.session(sessionId);
    if (this.store.deactivateSession(sessionId, reason)) {
      this.emit({ kind: "session", occurredAt: this.now(), sessionId, data: sessionStopData(reason, row?.repository_id ?? undefined) });
    }
  }

  /** Hook activity in a session: keeps the lease alive, and resumes a session that was
   *  stopped only because the host slept. A session that was ended, or never started
   *  through the lifecycle hooks, is left alone. */
  activity(harnessSessionId: string, cwd: string): void {
    const sessionId = this.sessionIdOf(harnessSessionId);
    const row = this.store.session(sessionId);
    if (!row) return;
    if (row.state === "stopped" && row.stopped_reason === "sleep") { this.sessionStart(harnessSessionId, cwd); return; }
    if (row.state !== "active") return;
    this.store.touchSession(sessionId);
    this.ensureHeartbeat(sessionId);
  }

  /** Start the single heartbeat helper for a session unless one already holds the lease. */
  ensureHeartbeat(sessionId: string): void {
    // SCOPEBOND_OBSERVATIONS_HEARTBEAT=off keeps session start/stop and tool observations but
    // runs no helper process (tests, or a host where a background process is unwelcome).
    if (this.options.spawnHeartbeat === false || process.env.SCOPEBOND_OBSERVATIONS_HEARTBEAT === "off") return;
    try {
      if (!this.store.claimHeartbeat(sessionId, HEARTBEAT_LEASE_MS)) return;
      const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
      const child = spawn(process.execPath, [cli, "observations", "heartbeat", sessionId], {
        detached: true, stdio: "ignore", windowsHide: true, env: { ...process.env, SCOPEBOND_HOOK_DIR: this.dir },
      });
      child.on("error", () => { /* the lease lapses and the next hook call tries again */ });
      child.unref();
    } catch { /* best effort */ }
  }

  // ---- health --------------------------------------------------------------------------------

  private policyDigest(): string | undefined {
    try { return digestPolicy(JSON.parse(readFileSync(join(this.dir, "policy.json"), "utf8"))); } catch { return undefined; }
  }

  /** Queue oldest-pending-receipt time and count, at most every five minutes, and once more
   *  when a backlog drains. */
  queueTelemetry(): void {
    const at = this.now();
    const last = this.store.getMark("queue_at");
    const backlog = receiptBacklog(this.dir);
    if (!backlog) return;
    const previous = this.store.getMark("queue_pending") ?? 0;
    if (backlog.count === 0 && previous === 0) return;
    if (backlog.count > 0 && last !== null && at - last < QUEUE_TELEMETRY_INTERVAL_MS) return;
    this.emit({ kind: "health", occurredAt: at, data: queueData(backlog.count > 0 ? backlog.oldestAt : at, backlog.count, this.policyDigest()) });
    this.store.mark("queue_at", at);
    this.store.mark("queue_pending", backlog.count);
  }

  /**
   * One heartbeat-loop tick. Returns whether the loop should keep running.
   *   - session no longer active: stop quietly
   *   - the clock moved more than SLEEP_GAP_MS since the last tick: the host slept; record a
   *     stop (reason sleep) at the last known time and emit no heartbeat for the gap
   *   - no hook activity for IDLE_LIMIT_MS: send a final heartbeat that releases the lease
   *   - otherwise: heartbeat with the lease active
   */
  heartbeatTick(sessionId: string, lastTickAt: number): "continue" | "stop" {
    const at = this.now();
    const row = this.store.session(sessionId);
    if (!row || row.state !== "active") { this.store.releaseHeartbeat(sessionId); return "stop"; }
    if (at - lastTickAt > SLEEP_GAP_MS) {
      if (this.store.deactivateSession(sessionId, "sleep")) {
        this.emit({ kind: "session", occurredAt: lastTickAt, sessionId, data: sessionStopData("sleep", row.repository_id ?? undefined) });
      }
      return "stop";
    }
    if (at - row.last_activity_at > IDLE_LIMIT_MS) {
      this.emit({ kind: "health", occurredAt: at, sessionId, data: heartbeatData(false, { policyDigest: this.policyDigest(), intervalS: HEARTBEAT_INTERVAL_MS / 1000 }) });
      this.store.releaseHeartbeat(sessionId);
      return "stop";
    }
    this.emit({ kind: "health", occurredAt: at, sessionId, data: heartbeatData(true, { policyDigest: this.policyDigest(), intervalS: HEARTBEAT_INTERVAL_MS / 1000 }) });
    this.queueTelemetry();
    return this.store.renewHeartbeat(sessionId, HEARTBEAT_LEASE_MS, true) ? "continue" : "stop";
  }

  // ---- actions -------------------------------------------------------------------------------

  /**
   * Record the request binding of each dispatched action, linked to its receipt, and keep
   * the operation so the after-action hook can echo it. `dispatched` is what was actually
   * evaluated: the final intent (after root scoping and grouping) and its receipt.
   */
  toolIntents(input: {
    harnessSessionId?: string; callId?: string; cwd: string;
    dispatched: Array<{ action: { action_type: string; params: Record<string, unknown> }; receipt?: unknown }>;
    /** The tool call as sent, so typed operations read the actual request: a shell tool's raw
     *  command, or an MCP tool's server, name and input. */
    request?: CallRequest;
    probe?: GitProbe;
  }): void {
    const sessionId = input.harnessSessionId ? this.sessionIdOf(input.harnessSessionId) : undefined;
    const repositoryId = this.binding.resourceId("repo", input.cwd);
    const rules = loadRules(this.dir);
    const operations = operationsForCall({ dispatched: input.dispatched, request: input.request }, {
      key: this.binding, cwd: input.cwd, repositoryId,
      ...(input.probe ? { probe: input.probe } : {}), ...(rules ? { isProtectedRef: (ref: string) => isProtectedBranch(rules, ref) } : {}),
      ...(process.env.SCOPEBOND_REQUIRED_CHECK_POLICY_VERSION ? { requiredCheckPolicyVersion: process.env.SCOPEBOND_REQUIRED_CHECK_POLICY_VERSION.slice(0, 200) } : {}),
    });
    // With approvals held in the workspace, an operation carries the hash the dispatch guard asks it to consume, so a consumed approval can be correlated.
    const binder = openApprovalBinder(this.dir);
    let recorded = 0;
    input.dispatched.forEach((item, index) => {
      const receipt = item.receipt as { payload?: { action_ref?: { action_id?: unknown } } } | undefined;
      const actionId = receipt?.payload?.action_ref?.action_id;
      if (typeof actionId !== "string" || actionId === "" || actionId.length > 200) return;
      if (recorded >= MAX_INTENTS_PER_CALL) { this.store.mark("omitted_intents", (this.store.getMark("omitted_intents") ?? 0) + 1); return; }
      const plain = operations[index];
      if (!plain) return;
      const operation = binder ? binder.bind(plain, item.action) : plain;
      const linked = sourceReceiptHash(item.receipt);
      const result = this.emit({ kind: "tool_intent", occurredAt: this.now(), sessionId, parentActionId: actionId, sourceReceiptHash: linked, data: intentData(operation) });
      recorded += 1;
      if (result?.queued && input.callId) {
        try {
          this.store.recordCall({ call_key: `${this.callKey(input.harnessSessionId, input.callId)}:${String(index).padStart(3, "0")}`, parent_action_id: actionId, source_receipt_hash: linked, session_id: sessionId ?? null, operation });
        } catch { /* the outcome is then simply not recorded */ }
      }
    });
  }

  /** After-action result for a call whose intents were recorded. `exit` comes from the
   *  harness's own success/failure event, never from model text. */
  toolOutcomes(harnessSessionId: string | undefined, callId: string, exit: ExitCategory): void {
    let calls;
    try { calls = this.store.takeCalls(`${this.callKey(harnessSessionId, callId)}:`); } catch { return; }
    const at = this.now();
    for (const call of calls) {
      this.emit({
        kind: "tool_outcome", occurredAt: at, sessionId: call.session_id ?? undefined, parentActionId: call.parent_action_id,
        sourceReceiptHash: call.source_receipt_hash,
        data: outcomeData(call.operation, exit, this.adapterVersion, at - call.at),
      });
    }
  }

  // ---- policy acknowledgement and capability proof ------------------------------------------------

  policyAck(input: PolicyAckInput): EnqueueResult | null {
    return this.emit({ kind: "policy_ack", occurredAt: this.now(), data: policyAckData(input) });
  }

  capabilityProofs(proofs: CapabilityProofInput[]): number {
    let queued = 0;
    for (const proof of proofs) if (this.emit({ kind: "capability", occurredAt: this.now(), data: capabilityProofData(proof) })?.queued) queued += 1;
    return queued;
  }
}

// ---- helpers ---------------------------------------------------------------------------------

/** HEAD of the workspace repository, or null when it cannot be read quickly. */
export function gitHead(cwd: string): string | null {
  try {
    const sha = execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).trim();
    return /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(sha) ? sha : null;
  } catch { return null; }
}

/** Count and oldest enqueue time of receipts not yet delivered to the workspace, from the
 *  receipt outbox beside the local receipts. Null when there is no outbox. */
export function receiptBacklog(dir: string): { count: number; oldestAt: number } | null {
  const file = join(dir, "receipts.db.cloud-outbox.db");
  if (!existsSync(file)) return null;
  try {
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (p: string) => { prepare(s: string): { get(): unknown }; close(): void } };
    const db = new DatabaseSync(file);
    try {
      const row = db.prepare("SELECT COUNT(*) AS n, MIN(enqueued_at) AS o FROM cloud_outbox").get() as { n: number; o: number | null };
      return { count: row.n, oldestAt: row.o ?? Date.now() };
    } finally { db.close(); }
  } catch { return null; }
}

/** Claude Code's SessionEnd `reason` mapped to the stop-reason vocabulary. An unlisted or
 *  missing reason is `unknown`, never a guess. */
export function stopReasonFromClaude(reason: unknown): SessionStopReason {
  switch (reason) {
    case "clear": case "prompt_input_exit": return "completed";
    case "logout": return "cancelled";
    default: return "unknown";
  }
}

/** Claude Code's failed-tool event to an exit category. */
export const exitFromClaudeFailure = (interrupted: unknown): ExitCategory => (interrupted === true ? "cancelled" : "error");

/** A one-line, human description for `status`. */
export function describeObservations(dir: string): string[] {
  const connection = loadConnection(dir);
  const status = observationStatus(connection);
  if (status.state === "off") return [`off (${status.reason})`];
  if (status.state === "unsupported") return [`unsupported (${status.reason})`];
  const file = join(dir, OBSERVATION_DB);
  if (!existsSync(file)) return ["on (nothing recorded yet)"];
  let store: ObservationStore | undefined;
  try {
    store = new ObservationStore(file);
    const state = store.state();
    if (!state) return ["on (nothing recorded yet)"];
    const pending = store.pendingSummary();
    const terminal = store.terminalCounts();
    const terminalTotal = Object.values(terminal).reduce((a, b) => a + b, 0);
    const lines: string[] = [];
    const head = state.capability === "active" ? "on" : state.capability === "unsupported" ? "unsupported by this workspace" : "paused";
    lines.push(`${head}${state.reason ? ` (${state.reason})` : ""}; generation ${state.generation}; ${pending.count} pending${pending.oldest_at ? ` since ${new Date(pending.oldest_at).toISOString()}` : ""}`);
    if (terminalTotal > 0) lines.push(`${terminalTotal} refused or unsendable, kept locally: ${Object.entries(terminal).map(([code, n]) => `${code} ${n}`).join(", ")}`);
    if (state.dropped > 0) lines.push(`${state.dropped} not queued (local queue full)`);
    if (state.last_error) lines.push(`last upload problem: ${state.last_error}`);
    return lines;
  } catch (error) {
    return [`on (status unavailable: ${(error as Error).message.slice(0, 80)})`];
  } finally { store?.close(); }
}
