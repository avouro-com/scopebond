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
}

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

/** Record the outcome of one delivery attempt from the exporter's in-process status.
 *  `before` is the exporter's last success time before this attempt, so an attempt with
 *  nothing to send does not count as a delivery. */
export function recordDeliveryAttempt(dir: string, status: Pick<CloudExporterStatus, "lastSuccessAt" | "lastError" | "pending">, at: number, before: number | null = null): DeliveryState {
  const patch: Partial<DeliveryState> = { last_attempt_at: at };
  if (status.lastError) {
    const code = httpStatusOf(status.lastError);
    patch.last_error = status.lastError;
    patch.last_status = code;
    if (code === 401) {
      const current = readDeliveryState(dir);
      patch.invalid_since = current.invalid_since ?? at;
      patch.invalid_source = current.invalid_source ?? "delivery";
    }
  } else if (status.lastSuccessAt !== null && status.lastSuccessAt !== before) {
    // Accepted: the connection works, whatever an earlier run saw.
    Object.assign(patch, { last_success_at: status.lastSuccessAt, last_error: null, last_status: null, invalid_since: null, invalid_source: null });
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
