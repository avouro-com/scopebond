// How often Scopebond interrupted the person today: the notifications the tray showed (toasts) and the questions a person was
// asked (prompts), counted on this computer and reported on the rules check (`x-scopebond-fatigue`), so the workspace can see
// whether its rules ask too much of its developers. Counts only: never what was shown or asked.
//
// Where it lives: `fatigue.json` in the hook's state directory, `{ "v": 1, "day": "YYYY-MM-DD", "toasts": n, "prompts": n }`,
// the day in this computer's local time. The Scopebond Agent adds a prompt when it asks a person, and a toast when the tray
// says it showed one (the agent's `POST /fatigue`); a count on a new day starts again from zero. The rules check sends the day
// the file holds, so the last day's counts reach the workspace on the first check of the next day.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "./managed.js";

export const FATIGUE_FILE = "fatigue.json";
export const FATIGUE_HEADER = "x-scopebond-fatigue";
export type FatigueKind = "toast" | "prompt";
export interface FatigueCounts { v: 1; day: string; toasts: number; prompts: number }

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX = 1_000_000;
const count = (v: unknown): number | null => (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= MAX ? v as number : null);

/** This computer's local day, as `YYYY-MM-DD`. */
export function localDay(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The counts held, or null when there are none (or the file is not exactly the documented shape). */
export function readFatigue(dir: string): FatigueCounts | null {
  try {
    const doc = JSON.parse(readFileSync(join(dir, FATIGUE_FILE), "utf8")) as Record<string, unknown>;
    const toasts = count(doc?.toasts);
    const prompts = count(doc?.prompts);
    if (doc?.v !== 1 || typeof doc.day !== "string" || !DAY.test(doc.day) || toasts === null || prompts === null) return null;
    return { v: 1, day: doc.day, toasts, prompts };
  } catch { return null; }
}

/** Count one toast or prompt shown today. Never throws: a count that cannot be written is lost, never in the person's way. */
export function recordFatigue(dir: string, kind: FatigueKind, now: Date = new Date()): FatigueCounts | null {
  try {
    const day = localDay(now);
    const held = readFatigue(dir);
    const today = held?.day === day ? held : { v: 1 as const, day, toasts: 0, prompts: 0 };
    const next: FatigueCounts = { ...today, ...(kind === "toast" ? { toasts: Math.min(MAX, today.toasts + 1) } : { prompts: Math.min(MAX, today.prompts + 1) }) };
    writeAtomic(join(dir, FATIGUE_FILE), `${JSON.stringify(next)}\n`);
    return next;
  } catch { return null; }
}

/** The rules check's `x-scopebond-fatigue` value, `toasts=n;prompts=n;day=YYYY-MM-DD`, or null when nothing was counted. */
export function fatigueHeaderValue(dir: string): string | null {
  const held = readFatigue(dir);
  return held ? `toasts=${held.toasts};prompts=${held.prompts};day=${held.day}` : null;
}
