// "This shouldn't be blocked": a person's mark on a block, sent to the workspace so its admins see which rules get in the
// way (the allow rate and its suggestion on the workspace's Protection page). The mark names the block's record, its rule and
// the action's key; never a reason, a command or anything about the person. It is kept on this computer until sent, and sent
// only to a workspace that says it takes it (`block_feedback` in its capabilities); a workspace that refuses one item for
// good (`rejected`) is not sent it again.

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic, type HookConnection } from "@scopebond/hook";

export const BLOCK_FEEDBACK_FILE = "block-feedback.json";
/** What the workspace names when it takes marks (`GET /v1/computer/summary` `capabilities`). */
export const BLOCK_FEEDBACK_CAPABILITY = "block_feedback";
/** The most marks kept waiting, and sent in one request. */
const KEEP = 200;
const BATCH = 100;

export interface BlockFeedback {
  id: string;
  action_id: string;
  rule: string;
  action_key: string;
  kind: "not_a_concern";
  harness: string | null;
  created_at: string;
  sent_at: string | null;
}

export function readBlockFeedback(dir: string): BlockFeedback[] {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, BLOCK_FEEDBACK_FILE), "utf8")) as { items?: unknown };
    return Array.isArray(parsed.items) ? parsed.items.filter((i): i is BlockFeedback => !!i && typeof i === "object" && typeof (i as BlockFeedback).id === "string") : [];
  } catch { return []; }
}

function writeBlockFeedback(dir: string, items: BlockFeedback[]): void {
  writeAtomic(join(dir, BLOCK_FEEDBACK_FILE), `${JSON.stringify({ items: items.slice(-KEEP) })}\n`);
}

/** Note the person's mark on a block (once per block). Returns false when the block was already marked. */
export function queueBlockFeedback(dir: string, block: { action_id: string; rule: string; action_key: string; harness: string | null }, now = Date.now()): boolean {
  const items = readBlockFeedback(dir);
  if (items.some((i) => i.action_id === block.action_id)) return false;
  items.push({
    id: `fbk_${randomBytes(12).toString("hex")}`, action_id: block.action_id, rule: block.rule, action_key: block.action_key,
    kind: "not_a_concern", harness: block.harness, created_at: new Date(now).toISOString(), sent_at: null,
  });
  writeBlockFeedback(dir, items);
  return true;
}

/** Whether this block was marked already. */
export const blockFeedbackFor = (dir: string): Set<string> => new Set(readBlockFeedback(dir).map((i) => i.action_id));

/** A mark as the workspace takes it: no send time, and no harness when it is not known. */
function wireItem(i: BlockFeedback): Record<string, string> {
  return { id: i.id, action_id: i.action_id, rule: i.rule, action_key: i.action_key, kind: i.kind, created_at: i.created_at, ...(i.harness ? { harness: i.harness } : {}) };
}

/** Send waiting marks (at most 100). Each accepted or refused item is marked sent; nothing is marked when the workspace could
 *  not take the request (offline, 5xx, 429): those wait for the next cycle. */
export async function sendBlockFeedback(dir: string, connection: Pick<HookConnection, "url" | "credential">, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<number> {
  const waiting = readBlockFeedback(dir).filter((i) => !i.sent_at).slice(0, BATCH);
  if (!waiting.length) return 0;
  let answer: { rejected?: Array<{ index?: number }> } | null = null;
  try {
    const res = await fetchImpl(new URL("/v1/block-feedback", connection.url).toString(), {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${connection.credential}`, "content-type": "application/json" },
      body: JSON.stringify({ items: waiting.map(wireItem) }),
    });
    if (!res.ok) return 0;
    answer = await res.json() as { rejected?: Array<{ index?: number }> };
  } catch { return 0; }
  const rejected = new Set((answer?.rejected ?? []).map((r) => r.index).filter((n): n is number => typeof n === "number"));
  const done = new Set(waiting.map((i) => i.id));
  const at = new Date(now).toISOString();
  writeBlockFeedback(dir, readBlockFeedback(dir).map((i) => (done.has(i.id) && !i.sent_at ? { ...i, sent_at: at } : i)));
  return waiting.length - rejected.size;
}
