// Delivery state that outlives the process. The hook runs once per tool call, so the
// exporter's own counters (last success, last error) vanish when it exits; without this
// file `status` could only say "connected" while every upload was being refused. Written
// after each delivery attempt and by policy sync; read by `status` and `doctor`.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CloudExporterStatus } from "@scopebond/gateway";

export const DELIVERY_STATE_FILE = "delivery.json";

export interface DeliveryState {
  /** When this computer last tried to deliver records (ms since epoch). */
  last_attempt_at: number | null;
  /** When the workspace last accepted records from this computer. */
  last_success_at: number | null;
  /** The last delivery failure, in plain words, and its HTTP status when there was one. */
  last_error: string | null;
  last_status: number | null;
  /** Set when the workspace refused this computer's credential (HTTP 401): the connection
   *  was revoked, replaced or removed, and only signing in again fixes it. */
  invalid_since: number | null;
  /** What saw the refusal: record delivery or the rules check. */
  invalid_source: "delivery" | "rules" | null;
  /** When a hook call's bounded delivery was last cut off by its time limit. Kept as history: while records reach the
   *  workspace (the Scopebond Agent is the reliable path), a cut-off call is expected and is not the last problem. */
  last_timeout_at?: number | null;
  /** Who recorded `last_error`, and when: the Scopebond Agent's cause of a failed delivery is kept over a hook call's cut-off
   * , so status, the self-check and the workspace see the real cause. */
  last_error_source?: "agent" | "hook" | null;
  last_error_at?: number | null;
}

/** How long the agent's last delivery error stands over a hook call's cut-off: longer than its longest wait between tries. */
export const AGENT_ERROR_STANDS_MS = 2 * 60 * 60 * 1000;

const EMPTY: DeliveryState = {
  last_attempt_at: null, last_success_at: null, last_error: null, last_status: null, invalid_since: null, invalid_source: null,
};

export function readDeliveryState(dir: string): DeliveryState {
  const file = join(dir, DELIVERY_STATE_FILE);
  if (!existsSync(file)) return { ...EMPTY };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<DeliveryState>;
    return { ...EMPTY, ...parsed };
  } catch { return { ...EMPTY }; }
}

/** Merge and save. Never throws: delivery state is diagnostic and must not affect a decision. */
export function writeDeliveryState(dir: string, patch: Partial<DeliveryState>): DeliveryState {
  const next = { ...readDeliveryState(dir), ...patch };
  try {
    const file = join(dir, DELIVERY_STATE_FILE);
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    renameSync(temp, file);
  } catch { /* best effort */ }
  return next;
}

/** The HTTP status in an exporter error ("ingest failed: HTTP 401"), if any. */
export function httpStatusOf(message: string | null | undefined): number | null {
  const match = /HTTP (\d{3})/.exec(message ?? "");
  return match ? Number(match[1]) : null;
}

/** The error recorded for an attempt the time limit cut off. The trailing `(timeout)` is the
 *  code `status --json` reports. */
/** A cut-off attempt is reported as the last problem only when nothing was delivered for this long. */
export const TIMEOUT_MATTERS_AFTER_MS = 15 * 60 * 1000;

export const timeoutError = (ms: number): string => `delivery did not finish within ${ms} ms, so it was cut off (timeout)`;

/** Record the outcome of one delivery attempt from the exporter's in-process status.
 *  `before` is the exporter's last success time before this attempt, so an attempt with
 *  nothing to send does not count as a delivery. `limitMs` is the time limit of a bounded
 *  attempt: one that ends with records still waiting, no error and nothing accepted was cut
 *  off before the workspace answered, and is recorded as a timeout rather than as nothing. */
export function recordDeliveryAttempt(dir: string, status: Pick<CloudExporterStatus, "lastSuccessAt" | "lastError" | "pending">, at: number, before: number | null = null, limitMs: number | null = null, source: "agent" | "hook" = "agent"): DeliveryState {
  const patch: Partial<DeliveryState> = { last_attempt_at: at };
  if (status.lastError) {
    const code = httpStatusOf(status.lastError);
    patch.last_error = status.lastError;
    patch.last_status = code;
    patch.last_error_source = source;
    patch.last_error_at = at;
    if (code === 401) {
      const current = readDeliveryState(dir);
      patch.invalid_since = current.invalid_since ?? at;
      patch.invalid_source = current.invalid_source ?? "delivery";
    }
  } else if (status.lastSuccessAt !== null && status.lastSuccessAt !== before) {
    // Accepted: the connection works, whatever an earlier run saw.
    Object.assign(patch, { last_success_at: status.lastSuccessAt, last_error: null, last_status: null, invalid_since: null, invalid_source: null, last_error_source: null, last_error_at: null });
  } else if (limitMs !== null && status.pending > 0) {
    // A refusal seen earlier is kept: a timeout says nothing about whether the workspace
    // accepts this computer. A timeout is the last problem only when nothing has been delivered for a while (SB385):
    // after a recent delivery (often the agent's) it is history, not something to fix.
    patch.last_timeout_at = at;
    const current = readDeliveryState(dir);
    const delivered = current.last_success_at;
    // The agent's own cause of a failed delivery is not replaced by a hook call's cut-off while it is recent.
    const agentCause = current.last_error_source === "agent" && current.last_error !== null && current.last_error_at != null && at - current.last_error_at < AGENT_ERROR_STANDS_MS;
    if (!agentCause && (delivered === null || at - delivered > TIMEOUT_MATTERS_AFTER_MS)) Object.assign(patch, { last_error: timeoutError(limitMs), last_status: null, last_error_source: source, last_error_at: at });
  }
  return writeDeliveryState(dir, patch);
}

/** The rules check saw a 401 (or a working connection again). */
export function recordRulesCredential(dir: string, valid: boolean, at: number): void {
  const current = readDeliveryState(dir);
  if (valid) {
    if (current.invalid_since !== null && current.invalid_source === "rules") writeDeliveryState(dir, { invalid_since: null, invalid_source: null });
    return;
  }
  writeDeliveryState(dir, { invalid_since: current.invalid_since ?? at, invalid_source: current.invalid_source ?? "rules" });
}

/** "3 minutes ago", "2 hours ago", "4 days ago". */
export function ago(ms: number | null, now: number = Date.now()): string {
  if (ms === null) return "never";
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 90) return `${seconds} second${seconds === 1 ? "" : "s"} ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} hours ago`;
  return `${Math.round(hours / 24)} days ago`;
}
