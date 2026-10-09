// Since when the computer has been awake, kept across agent restarts. Time asleep or switched off never counts as records
// waiting, but a restart of the agent alone (an update, a crash, `stop` and `run`) is not sleep: before this, every
// restart counted waiting again from the agent's start, so a four-hour backlog showed as protected for fifteen minutes.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const AWAKE_FILE = "agent-awake.json";

export interface AwakeState {
  /** When the computer last woke (or started), as this agent saw it, in milliseconds. */
  awake_since: number;
  /** When this agent last ran a cycle. */
  last_cycle_at: number;
}

/** Where waiting is counted from when the agent starts. The tray counts waiting as `now - max(oldest record, this)`.
 *  - The last cycle was recent and after the computer started: the agent restarted while the computer stayed awake, so the
 *    saved wake time stands (never earlier than the computer's start).
 *  - The computer started after the last cycle: it was off (or rebooted), so it has been awake since it started, and the
 *    oldest record counts from `max(its enqueue time, the computer's start)`.
 *  - A long gap since the last cycle without a restart of the computer. The agent cannot tell sleep (or a shutdown with
 *    Windows Fast Startup, which keeps the uptime) from an agent that was stopped, so it uses the records as evidence:
 *    - the oldest waiting record was written after the last cycle: the hook ran while the agent did not, so the computer was
 *      awake and the agent was not running; waiting counts from that record (`now - max(record, computer's start)`);
 *    - the oldest waiting record is older than the gap: the time it waited before the gap, while the agent ran its cycles,
 *      was awake time and still counts; the gap itself does not (it may have been sleep). Waiting resumes from there.
 *    - nothing waiting: from now.
 *  - No saved state, or times that make no sense (a clock moved back): from now. */
export function awakeSinceAtStart(input: { saved: AwakeState | null; now: number; uptimeMs: number; allowedGapMs: number; oldestPendingAt?: number | null }): number {
  const { saved, now } = input;
  const bootAt = now - Math.max(0, input.uptimeMs);
  if (!saved) return now;
  const { awake_since: since, last_cycle_at: last } = saved;
  if (last > now || since > last) return now;
  if (last < bootAt) return bootAt;
  if (now - last <= input.allowedGapMs) return Math.max(since, bootAt);
  const oldest = input.oldestPendingAt;
  if (oldest === null || oldest === undefined || !Number.isFinite(oldest) || oldest > now) return now;
  if (oldest > last) return Math.max(oldest, bootAt);
  const awakeBeforeGap = Math.max(0, last - Math.max(oldest, since, bootAt));
  return now - awakeBeforeGap;
}

/** The saved state, or null when there is none or it cannot be read. */
export function readAwake(dir: string): AwakeState | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, AWAKE_FILE), "utf8")) as Partial<AwakeState>;
    return Number.isFinite(raw.awake_since) && Number.isFinite(raw.last_cycle_at)
      ? { awake_since: Number(raw.awake_since), last_cycle_at: Number(raw.last_cycle_at) } : null;
  } catch { return null; }
}

export function writeAwake(dir: string, state: AwakeState): void {
  try { writeFileSync(join(dir, AWAKE_FILE), `${JSON.stringify(state)}\n`); } catch { /* the next cycle writes it again */ }
}
