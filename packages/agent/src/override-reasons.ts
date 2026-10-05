// The reason a person gave in the Scopebond window goes to the workspace once (`POST /v1/overrides`); the receipt carries
// only its digest. Reasons wait in a small file in the Scopebond home until the workspace has them, so a reason given while
// offline still arrives.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HookConnection } from "@scopebond/hook";

export const REASONS_FILE = "override-reasons.json";
interface Pending { action_id: string; reason: string; at: number }

const read = (dir: string): Pending[] => {
  try { const v = JSON.parse(readFileSync(join(dir, REASONS_FILE), "utf8")) as Pending[]; return Array.isArray(v) ? v : []; } catch { return []; }
};
const write = (dir: string, list: Pending[]) => {
  const file = join(dir, REASONS_FILE);
  if (!list.length && !existsSync(file)) return;
  writeFileSync(`${file}.tmp`, JSON.stringify(list), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
};

export function queueReason(dir: string, actionId: string, reason: string, now = Date.now()): void {
  // A week is long enough for any computer to come back online; older reasons are dropped rather than kept forever.
  const list = read(dir).filter((p) => now - p.at < 7 * 24 * 60 * 60 * 1000 && p.action_id !== actionId);
  list.push({ action_id: actionId, reason, at: now });
  write(dir, list.slice(-200));
}

export const pendingReasons = (dir: string): number => read(dir).length;

/** Send what is waiting. Returns how many the workspace took. A refusal for a malformed entry drops it; anything else waits. */
export async function flushReasons(dir: string, connection: Pick<HookConnection, "url" | "credential">, fetchImpl: typeof fetch = fetch): Promise<number> {
  const list = read(dir);
  if (!list.length) return 0;
  const left: Pending[] = [];
  let sent = 0;
  for (const p of list) {
    try {
      const res = await fetchImpl(new URL("/v1/overrides", connection.url).toString(), {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
        headers: { authorization: `Bearer ${connection.credential}`, "content-type": "application/json" },
        body: JSON.stringify({ action_id: p.action_id, reason: p.reason }),
      });
      if (res.ok) sent += 1;
      else if (res.status !== 400) left.push(p);
    } catch { left.push(p); }
  }
  write(dir, left);
  return sent;
}
