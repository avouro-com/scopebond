// Since when the computer has been awake, kept across agent restarts (SB388). Time asleep or switched off never counts as
// records waiting, but a restart of the agent alone (an update, a crash, `stop` and `run`) is not sleep: before this, every
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

/** Where waiting is counted from when the agent starts.
 *  - The last cycle was recent and after the computer started: the agent restarted while the computer stayed awake, so the
 *    saved wake time stands (never earlier than the computer's start).
 *  - The computer started after the last cycle: it was off (or rebooted), so it has been awake since it started.
 *  - Otherwise (no saved state, or a long gap without a restart of the computer: asleep, or the agent stopped): from now. */
export function awakeSinceAtStart(input: { saved: AwakeState | null; now: number; uptimeMs: number; allowedGapMs: number }): number {
  const { saved, now } = input;
  const bootAt = now - Math.max(0, input.uptimeMs);
  if (!saved) return now;
  const { awake_since: since, last_cycle_at: last } = saved;
  if (last <= now && now - last <= input.allowedGapMs && since <= last && last >= bootAt) return Math.max(since, bootAt);
  if (last < bootAt && bootAt <= now) return bootAt;
  return now;
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
