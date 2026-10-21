// The version that last ran in this Scopebond folder, so the tray can say "Updated to …" once after an update, whatever
// installed it (the agent's own signed update, an installer run by hand, npm). Written when an agent starts; the tray keeps
// its own note of what it already told, so the notification is shown once.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compareVersions } from "./update.js";

export const VERSION_SEEN_FILE = "agent-version-seen.json";
/** How long after an update the tray model still names it (a tray that starts later still tells it, once). */
export const UPDATED_SHOWN_MS = 24 * 60 * 60 * 1000;

/** An update this computer took: the version before, the version now running, and when this agent first started on it. */
export interface Updated { from: string; to: string; at: string }

const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;

/** Note the version starting now. Returns the update it finished, when the version that ran before is older; null on a
 *  first start in this folder, the same version again (its earlier note is kept), or a move back to an older version. */
export function noteRunningVersion(dir: string, running: string, now = Date.now()): Updated | null {
  if (!VERSION.test(running)) return null;
  const saved = readSeen(dir);
  const before = typeof saved?.version === "string" && VERSION.test(saved.version) ? saved.version : null;
  let updated: Updated | null = null;
  if (before === running) {
    const u = saved?.updated;
    updated = u && typeof u.from === "string" && u.to === running && typeof u.at === "string" ? { from: u.from, to: u.to, at: u.at } : null;
  } else if (before && compareVersions(running, before) > 0) {
    updated = { from: before, to: running, at: new Date(now).toISOString() };
  }
  if (before !== running) {
    try { writeFileSync(join(dir, VERSION_SEEN_FILE), `${JSON.stringify({ version: running, updated })}\n`); } catch { /* told again next start */ }
  }
  return updated;
}

function readSeen(dir: string): { version?: unknown; updated?: Partial<Updated> | null } | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(dir, VERSION_SEEN_FILE), "utf8"));
    return raw && typeof raw === "object" ? raw as { version?: unknown; updated?: Partial<Updated> | null } : null;
  } catch { return null; } // first start here
}

/** The update to name in the tray model now: within UPDATED_SHOWN_MS of it, else null. */
export function recentUpdate(updated: Updated | null, now: number): Updated | null {
  if (!updated) return null;
  const at = Date.parse(updated.at);
  return Number.isFinite(at) && now >= at && now - at < UPDATED_SHOWN_MS ? updated : null;
}
