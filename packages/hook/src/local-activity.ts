// What the tray shows from this computer's own records: today's counts and the last few blocks. Read-only and
// bounded: one indexed count since local midnight and a scan of at most the newest few thousand rows for blocks, so a large
// store costs the tray nothing. Works with no workspace: these are the computer's own receipts.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { nodeSqlite } from "./self.js";
import { describeAction, type ExplainIntent } from "./explain.js";
import { actionSummary, plainAction } from "./override.js";
import { projectOf, readBlockNotes } from "./block-notes.js";
import { blockTitle } from "./rule-titles.js";

/** A block as the tray lists it. `summary` is the one-line description `log` prints (`shell.exec rm`); `what` is the action
 *  in plain words ("Read .env.production", "git push --force origin main") and `action_text` the text the Scopebond window
 *  shows. Both come from the receipt's scrubbed action: secrets masked, digested arguments left out, never raw arguments,
 *  file contents or output. `harness` and `repository` are the receipt's context (the coding tool, and the git remote as
 *  `host/owner/name`), when it has one; the hook's note of the block fills in the tool when the receipt has none.
 *  `rule_title` is the rule's name as the workspace shows it (never empty, never a rule id) and `project` the project's
 *  name (the repository's, else the folder's), when known. */
export interface RecentBlockRecord {
  action_id: string | null;
  at: string;
  summary: string;
  rule: string | null;
  what?: string;
  action_text?: string;
  harness?: string | null;
  repository?: string | null;
  rule_title?: string;
  project?: string | null;
}

export interface LocalActivity {
  /** Since local midnight. `recorded_after`: out of policy but reported only after it ran (a Cursor edit): recorded, not
   *  prevented, and never counted as blocked. */
  today: { actions: number; blocked: number; recorded_after: number; allowed_by_person: number };
  /** Newest first, at most `limit` (20 at most). */
  recent_blocks: RecentBlockRecord[];
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
    const notes = new Map(readBlockNotes(dir).map((n) => [n.id, n]));
    const recent = rows.flatMap((row): RecentBlockRecord[] => {
      try {
        const p = (JSON.parse(row.receipt_json) as { payload?: Record<string, unknown> }).payload ?? {};
        const state = (p.execution as { state?: unknown } | undefined)?.state;
        if (state !== undefined && state !== "denied") return []; // monitored or recorded after it ran: not blocked
        // A receipt names its rule only when a person was asked about it (the override block); the blocked list names it.
        const override = p.override as { rule?: unknown } | undefined;
        const intent = (p.intent && typeof p.intent === "object" ? p.intent : {}) as { action_type?: string; params?: Record<string, unknown> };
        const context = (p.context && typeof p.context === "object" ? p.context : {}) as { harness?: unknown; repository?: unknown };
        const actionId = typeof (p.action_ref as { action_id?: unknown } | undefined)?.action_id === "string" ? String((p.action_ref as { action_id: string }).action_id) : null;
        // The hook's note names the rule (from the clause that denied it), the project and the tool when the receipt does not.
        const note = actionId ? notes.get(actionId) : undefined;
        const rule = typeof override?.rule === "string" ? override.rule : note?.rule ?? null;
        const repository = typeof context.repository === "string" ? context.repository : null;
        return [{
          action_id: actionId,
          at: typeof p.timestamp === "string" ? p.timestamp : "",
          summary: describeAction(p.intent as ExplainIntent | undefined),
          rule,
          what: plainAction(intent),
          action_text: actionSummary(intent),
          harness: typeof context.harness === "string" ? context.harness : note?.harness ?? null,
          repository,
          rule_title: blockTitle(rule, note?.clause),
          project: projectOf(repository, null) ?? note?.project ?? null,
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
