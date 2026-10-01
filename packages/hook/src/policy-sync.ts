// Keep a connected computer's rules in step with its Scopebond Cloud workspace.
//
// `syncPolicy` asks the workspace for this computer's rules (`GET /v1/policy`), installs a newer version when there is one, and
// tells the workspace exactly what it loaded or why it could not (`POST /v1/policy/ack`). It never runs on an agent's critical
// path: a tool call only checks two small files and, at most every five minutes, starts `policy sync` as a detached background
// process (`maybeStartPolicySync`). A change made in the workspace therefore applies within a few minutes of the agent's next
// action. Any failure keeps the rules already in force.
//
// Answers from the workspace:
//   204  the workspace does not set rules for this computer: use (or go back to) its own rules
//   304  nothing changed since the last check
//   200  a rules document: checked, installed if newer, confirmed
//   401  the connection is no longer valid (revoked, expired, removed): go back to this computer's own rules

import { closeSync, existsSync, openSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { connectionPath, loadConnection } from "./cloud.js";
import {
  inspectManaged, installManaged, isManaged, readMeta, restoreLocal, writeMeta, type ManagedMeta, type RefusalReason,
} from "./managed.js";

export const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const LOCK_FILE = "managed-sync.lock";
const LOCK_STALE_MS = 2 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5_000;
const UNMANAGED_DIGEST = "0".repeat(64);

export type SyncOutcome =
  | { state: "not_connected" }
  | { state: "own_rules"; changed: boolean }
  | { state: "unchanged"; revision: number }
  | { state: "applied"; revision: number }
  | { state: "refused"; revision: number | null; reason: RefusalReason; message: string }
  | { state: "disconnected" }
  | { state: "unavailable"; message: string };

export interface SyncOptions {
  agentKid: string;
  hookVersion: string;
  policyBuilds: (policy: Record<string, unknown>) => boolean;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Recompute a project's trust pin after its policy.json changed (the same step `rules apply` takes). */
  afterPolicyWrite?: (dir: string) => void;
}

export async function syncPolicy(dir: string, options: SyncOptions): Promise<SyncOutcome> {
  const connection = loadConnection(dir);
  if (!connection) return { state: "not_connected" };
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = (options.now ?? (() => new Date()))();
  const installationId = (connection as { installation_id?: string }).installation_id ?? connection.gateway_id;
  const base = connection.url.replace(/\/+$/, "");
  const auth = { authorization: `Bearer ${connection.credential}` };
  const meta = readMeta(dir);
  const save = (patch: Partial<ManagedMeta>) => writeMeta(dir, { ...meta, ...patch, checked_at: now.toISOString() });

  const ack = async (body: { export_id: string; revision: number; rules_digest: string; result: "loaded" | "rejected"; reason?: RefusalReason }): Promise<ManagedMeta["last_ack"]> => {
    try {
      const res = await fetchImpl(`${base}/v1/policy/ack`, {
        method: "POST", headers: { ...auth, "content-type": "application/json" }, redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        body: JSON.stringify({ ...body, reason: body.reason ?? null, hook_version: options.hookVersion }),
      });
      return res.ok ? { revision: body.revision, result: body.result, at: now.toISOString() } : meta.last_ack;
    } catch { return meta.last_ack; }
  };
  const backToOwnRules = (): boolean => {
    if (!isManaged(dir)) return false;
    restoreLocal(dir, options.agentKid);
    options.afterPolicyWrite?.(dir);
    return true;
  };

  let res: Response;
  try {
    res = await fetchImpl(`${base}/v1/policy`, {
      headers: { ...auth, ...(isManaged(dir) && meta.etag ? { "if-none-match": meta.etag } : {}) },
      redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    save({ last_error: `could not reach the workspace (${(error as Error).name}); the rules in force stay` });
    return { state: "unavailable", message: "could not reach the workspace" };
  }

  if (res.status === 401) {
    backToOwnRules();
    save({ revision: null, rules_digest: null, export_id: null, etag: null, last_error: "the workspace connection is no longer valid; this computer uses its own rules" });
    return { state: "disconnected" };
  }
  if (res.status === 204) {
    const changed = backToOwnRules();
    const last = meta.last_ack;
    const confirmed = changed || !last || last.revision !== 0
      ? await ack({ export_id: `rev-0-${installationId}`, revision: 0, rules_digest: UNMANAGED_DIGEST, result: "loaded" }) : last;
    save({ revision: null, rules_digest: null, export_id: null, etag: null, last_ack: confirmed, last_error: null });
    return { state: "own_rules", changed };
  }
  if (res.status === 304 && isManaged(dir) && meta.revision !== null) {
    const confirmed = meta.last_ack?.revision === meta.revision && meta.last_ack.result === "loaded" ? meta.last_ack
      : await ack({ export_id: meta.export_id!, revision: meta.revision, rules_digest: meta.rules_digest!, result: "loaded" });
    save({ last_ack: confirmed, last_error: null });
    return { state: "unchanged", revision: meta.revision };
  }
  if (res.status !== 200) {
    save({ last_error: `the workspace answered ${res.status}; the rules in force stay` });
    return { state: "unavailable", message: `the workspace answered ${res.status}` };
  }

  let raw: unknown;
  try { raw = await res.json(); } catch { raw = null; }
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const etag = res.headers.get("etag");
  // The same version already in force: confirm it again if the last confirmation did not land.
  if (isManaged(dir) && r.revision === meta.revision && r.rules_digest === meta.rules_digest && meta.revision !== null) {
    const confirmed = meta.last_ack?.revision === meta.revision ? meta.last_ack
      : await ack({ export_id: meta.export_id!, revision: meta.revision, rules_digest: meta.rules_digest!, result: "loaded" });
    save({ etag, last_ack: confirmed, last_error: null });
    return { state: "unchanged", revision: meta.revision };
  }
  const inspected = inspectManaged(raw, { installationId, currentRevision: isManaged(dir) ? meta.revision : null });
  const echo = typeof r.export_id === "string" && Number.isInteger(r.revision) && typeof r.rules_digest === "string" && /^[0-9a-f]{64}$/.test(r.rules_digest)
    ? { export_id: r.export_id, revision: r.revision as number, rules_digest: r.rules_digest } : null;
  if (!inspected.ok) {
    const confirmed = echo ? await ack({ ...echo, result: "rejected", reason: inspected.reason }) : meta.last_ack;
    save({ last_ack: confirmed, last_error: inspected.message });
    return { state: "refused", revision: echo?.revision ?? null, reason: inspected.reason, message: inspected.message };
  }
  const doc = inspected.doc;
  const installed = installManaged(dir, doc, options.agentKid, options.policyBuilds);
  if (!installed.ok) {
    const confirmed = await ack({ export_id: doc.export_id, revision: doc.revision, rules_digest: doc.rules_digest, result: "rejected", reason: installed.reason });
    save({ last_ack: confirmed, last_error: installed.message });
    return { state: "refused", revision: doc.revision, reason: installed.reason, message: installed.message };
  }
  options.afterPolicyWrite?.(dir);
  const confirmed = await ack({ export_id: doc.export_id, revision: doc.revision, rules_digest: doc.rules_digest, result: "loaded" });
  save({ revision: doc.revision, rules_digest: doc.rules_digest, export_id: doc.export_id, etag, last_ack: confirmed, last_error: null });
  return { state: "applied", revision: doc.revision };
}

/** Called on every tool call, after the decision: start a background sync when this computer is connected and has not checked in
 *  five minutes. Two file checks and, rarely, one detached process; it never waits and never throws. */
export function maybeStartPolicySync(dir: string, now = Date.now()): boolean {
  try {
    if (process.env.SCOPEBOND_POLICY_SYNC === "off") return false;
    if (!existsSync(connectionPath(dir))) return false;
    const checked = readMeta(dir).checked_at;
    if (checked && now - Date.parse(checked) < SYNC_INTERVAL_MS) return false;
    const lock = join(dir, LOCK_FILE);
    if (existsSync(lock)) {
      if (now - statSync(lock).mtimeMs < LOCK_STALE_MS) return false;
      rmSync(lock, { force: true });
    }
    const fd = openSync(lock, "wx");
    writeSync(fd, String(process.pid));
    closeSync(fd);
    const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
    const child = spawn(process.execPath, [cli, "policy", "sync", "--background"], {
      detached: true, stdio: "ignore", windowsHide: true, env: { ...process.env, SCOPEBOND_HOOK_DIR: dir },
    });
    child.on("error", () => { try { rmSync(lock, { force: true }); } catch { /* the stale lock expires */ } });
    child.unref();
    return true;
  } catch { return false; }
}

export function releaseSyncLock(dir: string): void {
  try { rmSync(join(dir, LOCK_FILE), { force: true }); } catch { /* expires on its own */ }
}
