// What the tray shows from this computer's own records: today's counts and the last few blocks. Read-only and
// bounded: one indexed count since local midnight and a scan of at most the newest few thousand rows for blocks, so a large
// store costs the tray nothing. Works with no workspace: these are the computer's own receipts.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { nodeSqlite } from "./self.js";
import { describeAction, type ExplainIntent } from "./explain.js";

export interface LocalActivity {
  /** Since local midnight. `recorded_after`: out of policy but reported only after it ran (a Cursor edit): recorded, not
   *  prevented, and never counted as blocked. */
  today: { actions: number; blocked: number; recorded_after: number; allowed_by_person: number };
  /** Newest first, at most `limit`. The summary is the same one-line description `log` prints: the scrubbed action, never
   *  raw arguments. */
  recent_blocks: Array<{ action_id: string | null; at: string; summary: string; rule: string | null }>;
}

type Db = { prepare(sql: string): { all(...a: unknown[]): unknown[] }; close(): void };

/** Today's counts and the newest blocks from `<dir>/receipts.db`, or null when there is no store or it cannot be read. */
export function localActivity(dir: string, options: { now?: Date; limit?: number; scan?: number } = {}): LocalActivity | null {
  const path = join(dir, "receipts.db");
  if (!existsSync(path)) return null;
  const now = options.now ?? new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  let db: Db | null = null;
  try {
    const { DatabaseSync } = nodeSqlite<{ DatabaseSync: new (p: string, o: { readOnly: boolean }) => Db }>();
    db = new DatabaseSync(path, { readOnly: true });
    const counts = db.prepare(
      `SELECT COUNT(*) AS actions,
              SUM(CASE WHEN realtime_result = 'deny' AND json_extract(receipt_json, '$.payload.execution.state') = 'denied' THEN 1 ELSE 0 END) AS blocked,
              SUM(CASE WHEN json_extract(receipt_json, '$.payload.execution.state') = 'observed_after' THEN 1 ELSE 0 END) AS recorded_after,
              SUM(CASE WHEN json_extract(receipt_json, '$.payload.override.state') = 'allowed' THEN 1 ELSE 0 END) AS allowed_by_person
         FROM receipts INDEXED BY receipts_timestamp WHERE timestamp >= ?`,
    ).all(midnight)[0] as { actions: number; blocked: number | null; recorded_after: number | null; allowed_by_person: number | null } | undefined;
    const rows = db.prepare(
      `SELECT receipt_json FROM receipts
        WHERE id > (SELECT COALESCE(MAX(id), 0) - ? FROM receipts) AND realtime_result = 'deny'
        ORDER BY id DESC LIMIT ?`,
    ).all(Math.max(1, options.scan ?? 5_000), Math.max(1, Math.min(20, options.limit ?? 3))) as Array<{ receipt_json: string }>;
    const recent = rows.flatMap((row) => {
      try {
        const p = (JSON.parse(row.receipt_json) as { payload?: Record<string, unknown> }).payload ?? {};
        const state = (p.execution as { state?: unknown } | undefined)?.state;
        if (state !== undefined && state !== "denied") return []; // monitored or recorded after it ran: not blocked
        // A receipt names its rule only when a person was asked about it (the override block); the blocked list names it.
        const override = p.override as { rule?: unknown } | undefined;
        return [{
          action_id: typeof (p.action_ref as { action_id?: unknown } | undefined)?.action_id === "string" ? String((p.action_ref as { action_id: string }).action_id) : null,
          at: typeof p.timestamp === "string" ? p.timestamp : "",
          summary: describeAction(p.intent as ExplainIntent | undefined),
          rule: typeof override?.rule === "string" ? override.rule : null,
        }];
      } catch { return []; }
    });
    return {
      today: { actions: Number(counts?.actions ?? 0), blocked: Number(counts?.blocked ?? 0), recorded_after: Number(counts?.recorded_after ?? 0), allowed_by_person: Number(counts?.allowed_by_person ?? 0) },
      recent_blocks: recent,
    };
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* read-only */ }
  }
}
