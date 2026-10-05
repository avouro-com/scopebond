// SB273/SB274: what delivery to the workspace looks like from this computer — the persisted
// delivery state plus the queue — in the lines `status` prints and the problems `doctor` reports.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { SqliteCloudOutbox } from "@scopebond/gateway/node";
import type { HookConnection } from "./cloud.js";
import { ago, readDeliveryState } from "./delivery-state.js";
import { cliCommand } from "./version.js";

export const OUTBOX_FILE = "receipts.db.cloud-outbox.db";

/** The queue opened without limits, so reading it never expires or drops anything. */
export const LOSSLESS_OUTBOX = { maxPending: Number.MAX_SAFE_INTEGER, maxBytes: Number.MAX_SAFE_INTEGER, maxAgeMs: Number.MAX_SAFE_INTEGER } as const;

/** How many records wait to send and since when, read without changing the queue. */
export function queueStatus(dir: string): { pending: number; oldest: number | null; queueId?: string; seqAssigned?: number } {
  const outboxPath = join(dir, OUTBOX_FILE);
  if (!existsSync(outboxPath)) return { pending: 0, oldest: null };
  try {
    const outbox = new SqliteCloudOutbox(outboxPath, LOSSLESS_OUTBOX);
    try {
      const status = outbox.status();
      return { pending: status.pending, oldest: status.oldestEnqueuedAt, ...(status.queueId ? { queueId: status.queueId, seqAssigned: status.seqAssigned ?? 0 } : {}) };
    } finally { outbox.close(); }
  } catch { return { pending: 0, oldest: null }; }
}

export interface DeliveryReport {
  lines: string[];
  problems: string[];
  /** The one command that fixes a refused connection, when the connection was refused. */
  fix: string | null;
}

export function describeDelivery(dir: string, connection: Pick<HookConnection, "url">, now = Date.now()): DeliveryReport {
  const state = readDeliveryState(dir);
  const lines: string[] = [];
  const problems: string[] = [];
  const { pending, oldest } = queueStatus(dir);
  let fix: string | null = null;
  if (state.invalid_since !== null) {
    fix = cliCommand(`login ${connection.url}`);
    lines.push(`NOT DELIVERING since ${new Date(state.invalid_since).toISOString()}: the workspace refused this computer's connection (it was revoked, replaced or removed).`);
    lines.push(`fix: run ${fix}`);
    problems.push(`the workspace no longer accepts this computer's connection; run ${fix}`);
  }
  const tried = state.last_attempt_at !== null ? `; last tried ${ago(state.last_attempt_at, now)}` : "";
  lines.push(`last delivered   ${ago(state.last_success_at, now)}${tried}`);
  const age = oldest !== null ? `, oldest from ${ago(oldest, now)}` : "";
  lines.push(`waiting to send  ${pending} record(s)${age}`);
  if (state.last_error && state.invalid_since === null) {
    lines.push(`last problem     ${state.last_error}`);
    if (pending > 0 && oldest !== null && now - oldest > 60 * 60 * 1000) {
      problems.push(`${pending} record(s) have waited more than an hour to send (${state.last_error}); they stay queued and send once the workspace accepts them`);
    }
  }
  return { lines, problems, fix };
}
