// A hook call reads `rules.json` and `cloud.json` from several places (the decision, the database guard, delivery, the rules
// check, upkeep). Each read after the first comes from here while the file is unchanged on disk (same size and modification
// time); a write by this process forgets the entry, and a write by another process changes what `stat` reports (SB407).
import { readFileSync, statSync } from "node:fs";

const texts = new Map<string, { mtimeMs: number; size: number; text: string }>();

/** The file's text, or null when it does not exist. Throws like `readFileSync` for any other failure. */
export function readTextCached(path: string): string | null {
  let stat;
  try { stat = statSync(path); } catch { texts.delete(path); return null; }
  const hit = texts.get(path);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.text;
  const text = readFileSync(path, "utf8");
  texts.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, text });
  return text;
}

/** Forget a file this process is about to write or has just written. */
export function forgetCached(path: string): void {
  texts.delete(path);
}
