// What the tray shows from this computer's own records: today's counts and the week's blocks. Read-only and bounded: one
// indexed count since local midnight and the denied receipts of the last seven days through the store's index of denials
// (at most a few thousand rows), so a large store costs the tray nothing. Works with no workspace: these are the computer's own
// receipts.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { nodeSqlite } from "./self.js";
import { describeAction, type ExplainIntent } from "./explain.js";
import { actionSummary, plainAction } from "./override.js";
import { projectOf, readBlockNotes, type BlockNote } from "./block-notes.js";
import { blockTitle } from "./rule-titles.js";

/** A block as the tray lists it. `summary` is the one-line description `log` prints (`shell.exec rm`); `what` is the action
 *  in plain words ("Read .env.production", "git push --force origin main") and `action_text` the text the Scopebond window
 *  shows. Both come from the receipt's scrubbed action: secrets masked, digested arguments left out, never raw arguments,
 *  file contents or output. `harness` and `repository` are the receipt's context (the coding tool, and the git remote as
 *  `host/owner/name`), when it has one; the hook's note of the block fills in the tool when the receipt has none.
 *  `rule_title` is the rule's name as the workspace shows it (never empty, never a rule id) and `project` the project's
 *  name (the repository's, else the folder's), when known.
 *
 *  Retries fold into one block: the same action under the same rule in the same project and coding-agent session, each try
 *  within 10 minutes of the one before. `tries` counts them (1 for a single block), `at` and `action_id` are the newest
 *  try's and `first_at` the first's. `clause` is the clause that denied it; `kind` says when no rule's clause did (Safe
 *  Install, a blocked service, a session budget) and `verdict` is Safe Install's verdict in words. */
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
  tries?: number;
  first_at?: string;
  clause?: string | null;
  kind?: BlockNote["kind"];
  verdict?: string | null;
}

export interface LocalActivity {
  /** Since local midnight. `blocked`: distinct blocks (retries folded), the number the tray shows everywhere; `attempts`: every
   *  denied call. `recorded_after`: out of policy but reported only after it ran (a Cursor edit): recorded, not prevented, and
   *  never counted as blocked. */
  today: { actions: number; blocked: number; attempts: number; recorded_after: number; allowed_by_person: number };
  /** Newest first: today's blocks, then the rest of the last seven days; at most `limit` (200 at most). */
  recent_blocks: RecentBlockRecord[];
}

type Db = { prepare(sql: string): { all(...a: unknown[]): unknown[] }; close(): void };

/** The most blocks returned, and the most denied receipts read from the last seven days. */
export const RECENT_BLOCKS_LIMIT = 200;
const SCAN_DENIED = 5_000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** A block of the same action this soon after the last try is a retry of it. */
export const RETRY_WINDOW_MS = 10 * 60 * 1000;

/** Today's counts and the week's blocks from `<dir>/receipts.db`, or null when there is no store or it cannot be read. */
export function localActivity(dir: string, options: { now?: Date; limit?: number } = {}): LocalActivity | null {
  const path = join(dir, "receipts.db");
  if (!existsSync(path)) return null;
  const now = options.now ?? new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const weekAgo = new Date(now.getTime() - WEEK_MS).toISOString();
  let db: Db | null = null;
  try {
    const { DatabaseSync } = nodeSqlite<{ DatabaseSync: new (p: string, o: { readOnly: boolean }) => Db }>();
    db = new DatabaseSync(path, { readOnly: true });
    const counts = db.prepare(
      `SELECT COUNT(*) AS actions,
              SUM(CASE WHEN json_extract(receipt_json, '$.payload.execution.state') = 'observed_after' THEN 1 ELSE 0 END) AS recorded_after,
              SUM(CASE WHEN json_extract(receipt_json, '$.payload.override.state') = 'allowed' THEN 1 ELSE 0 END) AS allowed_by_person
         FROM receipts INDEXED BY receipts_timestamp WHERE timestamp >= ?`,
    ).all(midnight)[0] as { actions: number; recorded_after: number | null; allowed_by_person: number | null } | undefined;
    // The denials of the week, newest first: through the store's index of denials when it has one (the agent's upkeep makes
    // it), else through the time index. Either way bounded to the week and to SCAN_DENIED rows.
    const indexed = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'receipts_denied'`).all().length > 0;
    const rows = db.prepare(indexed
      ? `SELECT receipt_json FROM receipts INDEXED BY receipts_denied
          WHERE realtime_result = 'deny' AND timestamp >= ? ORDER BY id DESC LIMIT ?`
      : `SELECT receipt_json FROM receipts INDEXED BY receipts_timestamp
          WHERE timestamp >= ? AND realtime_result = 'deny' ORDER BY id DESC LIMIT ?`,
    ).all(weekAgo, SCAN_DENIED) as Array<{ receipt_json: string }>;
    const notes = new Map(readBlockNotes(dir).map((n) => [n.id, n]));
    const tries = rows.flatMap((row): Array<RecentBlockRecord & { session: string | null }> => {
      try {
        const p = (JSON.parse(row.receipt_json) as { payload?: Record<string, unknown> }).payload ?? {};
        const state = (p.execution as { state?: unknown } | undefined)?.state;
        if (state !== undefined && state !== "denied") return []; // monitored or recorded after it ran: not blocked
        // A receipt names its rule only when a person was asked about it (the override block); the blocked list names it.
        const override = p.override as { rule?: unknown } | undefined;
        const intent = (p.intent && typeof p.intent === "object" ? p.intent : {}) as { action_type?: string; params?: Record<string, unknown> };
        const context = (p.context && typeof p.context === "object" ? p.context : {}) as { harness?: unknown; repository?: unknown; session?: unknown };
        const actionId = typeof (p.action_ref as { action_id?: unknown } | undefined)?.action_id === "string" ? String((p.action_ref as { action_id: string }).action_id) : null;
        // The hook's note names the rule (from the clause that denied it), the project and the tool when the receipt does not.
        const note = actionId ? notes.get(actionId) : undefined;
        const clause = typeof p.clause_id === "string" ? p.clause_id : note?.clause ?? null;
        const rule = typeof override?.rule === "string" ? override.rule : note?.rule ?? null;
        const repository = typeof context.repository === "string" ? context.repository : null;
        const at = typeof p.timestamp === "string" ? p.timestamp : "";
        return [{
          action_id: actionId,
          at,
          summary: describeAction(p.intent as ExplainIntent | undefined),
          rule,
          what: plainAction(intent),
          action_text: actionSummary(intent),
          harness: typeof context.harness === "string" ? context.harness : note?.harness ?? null,
          repository,
          rule_title: blockTitle(rule, clause),
          project: projectOf(repository, null) ?? note?.project ?? null,
          clause,
          ...(note?.kind ? { kind: note.kind } : {}),
          ...(note?.verdict ? { verdict: note.verdict } : {}),
          session: note?.session ?? (typeof context.session === "string" ? context.session : null),
        }];
      } catch { return []; }
    });
    const blocks = foldRetries(tries);
    const today = blocks.filter((b) => b.at >= midnight);
    const attempts = tries.filter((t) => t.at >= midnight).length;
    const limit = Math.max(1, Math.min(RECENT_BLOCKS_LIMIT, options.limit ?? 3));
    return {
      today: {
        actions: Number(counts?.actions ?? 0), blocked: today.length, attempts,
        recorded_after: Number(counts?.recorded_after ?? 0), allowed_by_person: Number(counts?.allowed_by_person ?? 0),
      },
      recent_blocks: blocks.slice(0, limit),
    };
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* read-only */ }
  }
}

/** One retry group's key: the same action (as shown) under the same rule, in the same project, tool and session. */
const retryKey = (b: RecentBlockRecord & { session: string | null }): string =>
  JSON.stringify([b.session ?? "", b.harness ?? "", b.rule ?? b.clause ?? b.kind ?? "", b.project ?? "", b.action_text ?? b.what ?? b.summary]);

/** Fold retries (newest-first input) into one block each: each try within RETRY_WINDOW_MS of the one before it in the same
 *  group. Returns the groups newest first, each named by its newest try. */
export function foldRetries(newestFirst: Array<RecentBlockRecord & { session: string | null }>): RecentBlockRecord[] {
  const open = new Map<string, RecentBlockRecord & { earliest: number }>();
  const groups: Array<RecentBlockRecord & { earliest: number }> = [];
  for (const b of newestFirst) {
    const key = retryKey(b);
    const at = Date.parse(b.at);
    const group = open.get(key);
    if (group && Number.isFinite(at) && group.earliest - at <= RETRY_WINDOW_MS) {
      group.tries = (group.tries ?? 1) + 1;
      group.first_at = b.at;
      group.earliest = at;
      continue;
    }
    const { session: _session, ...shown } = b;
    const made = { ...shown, tries: 1, first_at: b.at, earliest: Number.isFinite(at) ? at : 0 };
    open.set(key, made);
    groups.push(made);
  }
  return groups.map(({ earliest: _earliest, ...b }) => b);
}

