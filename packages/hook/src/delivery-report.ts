// SB273/SB274: what delivery to the workspace looks like from this computer — the persisted
// delivery state plus the queue — in the lines `status` prints and the problems `doctor` reports.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { SqliteCloudOutbox } from "@scopebond/gateway/node";
import type { HookConnection } from "./cloud.js";
import { ago, readDeliveryState, type DeliveryState } from "./delivery-state.js";
import { cliCommand } from "./version.js";

export const OUTBOX_FILE = "receipts.db.cloud-outbox.db";

/** The queue opened without limits, so reading it never expires or drops anything. */
export const LOSSLESS_OUTBOX = { maxPending: Number.MAX_SAFE_INTEGER, maxBytes: Number.MAX_SAFE_INTEGER, maxAgeMs: Number.MAX_SAFE_INTEGER } as const;

/** How many records wait to send and since when, read without changing the queue. */
export function queueStatus(dir: string): {
  pending: number; oldest: number | null; queueId?: string; seqAssigned?: number; error?: string;
  /** Records that left the queue without being delivered as queued, over the queue's lifetime, and their counts by reason. */
  gapsTotal: number; gapsByReason: Record<string, number>;
} {
  const outboxPath = join(dir, OUTBOX_FILE);
  if (!existsSync(outboxPath)) return { pending: 0, oldest: null, gapsTotal: 0, gapsByReason: {} };
  try {
    const outbox = new SqliteCloudOutbox(outboxPath, LOSSLESS_OUTBOX);
    try {
      const status = outbox.status();
      return {
        pending: status.pending, oldest: status.oldestEnqueuedAt, ...(status.queueId ? { queueId: status.queueId, seqAssigned: status.seqAssigned ?? 0 } : {}),
        gapsTotal: status.gaps, gapsByReason: status.gapsByReason ?? {},
      };
    } finally { outbox.close(); }
  } catch (error) {
    // Not "nothing waiting": the queue cannot be opened. Actions stay allowed and are recorded on this computer; each record
    // written meanwhile is noted and queued once the queue can be written again.
    return { pending: 0, oldest: null, error: `${outboxPath}: ${(error as Error).message}`, gapsTotal: 0, gapsByReason: {} };
  }
}

/** "rejected 2, outbox_error 1": the counts by reason, largest first. */
export function gapReasons(byReason: Record<string, number>): string {
  return Object.entries(byReason).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([r, n]) => `${r} ${n}`).join(", ");
}

/** How long the oldest waiting record may wait, with nothing accepted since it was queued,
 *  before this computer counts as not delivering. Each tool call tries to send, so a working
 *  connection empties the queue within seconds. */
export const STALLED_AFTER_MS = 5 * 60 * 1000;

/** Records are waiting and nothing has been accepted since the oldest was queued, for longer
 *  than `STALLED_AFTER_MS`. True whatever the last error says, including none at all: an
 *  attempt can end without one, and "last tried a moment ago" is no evidence of delivery. */
export function deliveryStalled(state: Pick<DeliveryState, "last_success_at">, pending: number, oldest: number | null, now: number): boolean {
  return pending > 0 && oldest !== null && now - oldest > STALLED_AFTER_MS
    && (state.last_success_at === null || state.last_success_at < oldest);
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
  const { pending, oldest, error: queueError, gapsTotal, gapsByReason } = queueStatus(dir);
  let fix: string | null = null;
  if (queueError) {
    lines.push(`DELIVERY QUEUE UNUSABLE: ${queueError}`);
    lines.push("actions stay allowed and are recorded on this computer; they are sent once the queue can be written again");
    lines.push("fix: free some disk space, or make that file and its -wal and -shm files writable for your user (do not delete it: it holds records waiting to be sent)");
    problems.push(`the delivery queue cannot be opened (${queueError}); actions stay allowed and are recorded on this computer, and are sent once the queue can be written again`);
  }
  if (state.invalid_since !== null) {
    fix = cliCommand(`login ${connection.url}`);
    lines.push(`NOT DELIVERING since ${new Date(state.invalid_since).toISOString()}: the workspace refused this computer's connection (it was revoked, replaced or removed).`);
    lines.push(`fix: run ${fix}`);
    problems.push(`the workspace no longer accepts this computer's connection; run ${fix}`);
  }
  const tried = state.last_attempt_at !== null ? `; last tried ${ago(state.last_attempt_at, now)}` : "";
  lines.push(`last delivered   ${ago(state.last_success_at, now)}${tried}`);
  const age = oldest !== null ? `, oldest from ${ago(oldest, now)}` : "";
  if (!queueError) lines.push(`waiting to send  ${pending} record(s)${age}`);
  if (state.last_error && state.invalid_since === null) lines.push(`last problem     ${state.last_error}`);
  // Gaps are history (the workspace hears of them on the rules check), so they are shown, not counted as a problem.
  if (gapsTotal > 0) {
    const reasons = gapReasons(gapsByReason);
    lines.push(`delivery gaps    ${gapsTotal} record(s) missed normal delivery${reasons ? ` (${reasons})` : ""}; each stays in this computer's log`);
  }
  const paused = /HTTP 402 \(agent_paused\)/.test(state.last_error ?? "");
  if (state.invalid_since === null && paused && pending > 0) {
    // The plan paused this agent: sending again changes nothing, so no flush is suggested.
    lines.unshift(`PAUSED BY THE WORKSPACE'S PLAN: ${pending} record(s) wait on this computer and send once an owner keeps this agent active or changes the plan (Settings, Plan and billing).`);
    problems.push(`the workspace's plan paused this agent; ${pending} record(s) wait until an owner keeps it active or changes the plan`);
  } else if (state.invalid_since === null && deliveryStalled(state, pending, oldest, now)) {
    const since = state.last_success_at === null ? "nothing from this computer has ever reached the workspace" : `nothing has reached the workspace since ${ago(state.last_success_at, now)}`;
    const why = state.last_error ?? "no attempt recorded an error, so the cause is unknown";
    const flush = cliCommand("flush");
    lines.unshift(`NOT DELIVERING: ${since}, and ${pending} record(s) wait, the oldest from ${ago(oldest, now)}.`);
    lines.push(`next step        run ${flush}: it sends the queue with no time limit and prints what the workspace answers`);
    problems.push(`${pending} record(s) are not reaching the workspace: ${since} (${why}); they stay queued — run ${flush} to send them now and see the answer`);
  }
  return { lines, problems, fix };
}
