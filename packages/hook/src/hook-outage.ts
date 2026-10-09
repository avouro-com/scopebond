// A hook entry the coding agent cannot start lets every action through with no check and no record: Claude Code, Codex
// and Cursor all treat a hook that cannot start as a non-blocking error. Claude Code's session events show the workspace
// that the hook is running; Codex and Cursor send nothing between actions, so for them silence is all the workspace
// would see. The Scopebond Agent checks their entries on each maintenance pass and keeps each outage as one delivery gap
// (`hook_unresolvable`), which the rules check reports to the workspace with the other gaps.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SqliteCloudOutbox } from "@scopebond/gateway/node";
import { configuredHookCommands, hookCommandResolves, userHarnessFile, type Harness } from "./install.js";
import { LOSSLESS_OUTBOX, OUTBOX_FILE } from "./delivery-report.js";

/** The outages already kept as a gap, `{ <harness>: <first seen, ms> }`, so a long outage counts once. */
export const HOOK_OUTAGE_FILE = "hook-outages.json";

function readOutages(dir: string): Record<string, number> {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, HOOK_OUTAGE_FILE), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter(([, v]) => typeof v === "number" && Number.isFinite(v))) as Record<string, number>;
  } catch { return {}; }
}

/** Check each harness's Scopebond hook entries; keep a newly found outage as a `hook_unresolvable` gap in the delivery
 *  queue (only when there is one: a computer not connected to a workspace has no one to tell). `unresolvable`: the
 *  harnesses whose entry cannot start now; `recorded`: those kept as a new gap by this call. Never throws. */
export function noteUnresolvableHooks(
  dir: string, harnesses: Harness[], options: { files?: Partial<Record<Harness, string>>; now?: number } = {},
): { unresolvable: Harness[]; recorded: Harness[] } {
  const now = options.now ?? Date.now();
  const unresolvable = harnesses.filter((harness) => {
    try { return configuredHookCommands(options.files?.[harness] ?? userHarnessFile(harness)).some((c) => !hookCommandResolves(c)); }
    catch { return false; }
  });
  const known = readOutages(dir);
  const fresh = unresolvable.filter((h) => known[h] === undefined);
  const recorded: Harness[] = [];
  const outbox = join(dir, OUTBOX_FILE);
  if (fresh.length && existsSync(outbox)) {
    try {
      const queue = new SqliteCloudOutbox(outbox, LOSSLESS_OUTBOX);
      try { for (const harness of fresh) { queue.recordGap(null, "hook_unresolvable"); recorded.push(harness); } }
      finally { queue.close(); }
    } catch { /* the next pass tries again */ }
  }
  // Outages that ended are forgotten (the next one is a new gap); harnesses not checked this time keep their entry.
  const next: Record<string, number> = {};
  for (const [harness, since] of Object.entries(known)) if (!harnesses.includes(harness as Harness)) next[harness] = since;
  for (const harness of unresolvable) {
    if (known[harness] !== undefined) next[harness] = known[harness]!;
    else if (recorded.includes(harness)) next[harness] = now;
  }
  try {
    if (Object.keys(next).length || Object.keys(known).length) writeFileSync(join(dir, HOOK_OUTAGE_FILE), JSON.stringify(next) + "\n");
  } catch { /* the gap is kept; a second one may be kept next pass */ }
  return { unresolvable, recorded };
}
