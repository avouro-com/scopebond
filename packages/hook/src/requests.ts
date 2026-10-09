// "Ask an admin" (D144, SB411): a person asks the workspace's admins to allow an action a rule blocked. The hook keeps the
// request here until the Scopebond Agent sends it (`POST /v1/requests`); the workspace answers through the rules document
// (an approved request arrives as an allowance). The block stands meanwhile.

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "./managed.js";

export const REQUESTS_FILE = "requests.json";

export interface AdminRequest {
  id: string;
  rule: string;
  action_key: string;
  /** The blocked action's id (its receipt), so the workspace can show the record. */
  action_id: string;
  /** One line naming the action, never raw arguments (the same summary the window showed). */
  summary: string;
  reason: string;
  os_user_digest: string | null;
  harness: string;
  created_at: string;
  sent_at: string | null;
}

export function readRequests(dir: string): AdminRequest[] {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, REQUESTS_FILE), "utf8")) as { items?: AdminRequest[] };
    return Array.isArray(parsed.items) ? parsed.items : [];
  } catch { return []; }
}

/** How many sent requests the file keeps for the tray. Unsent ones are never dropped to make room: each one was asked for
 *  by a person, the window told them it went to an admin, and only one per rule and action is kept. */
const SENT_KEPT = 200;

export function writeRequests(dir: string, items: AdminRequest[], now = Date.now()): void {
  // Sent ones are kept a week for the tray (the newest SENT_KEPT of them), unsent ones until they are sent.
  const recent = items.filter((r) => !r.sent_at || now - Date.parse(r.sent_at) < 7 * 24 * 60 * 60 * 1000);
  const sent = recent.filter((r) => r.sent_at);
  const dropped = new Set(sent.slice(0, Math.max(0, sent.length - SENT_KEPT)));
  const kept = recent.filter((r) => !dropped.has(r));
  writeAtomic(join(dir, REQUESTS_FILE), `${JSON.stringify({ items: kept }, null, 1)}\n`);
}

export function queueRequest(dir: string, input: { rule: string; action_key: string; action_id: string; summary: string; reason: string; os_user_digest: string | null; harness: string; now?: number }): AdminRequest {
  const now = input.now ?? Date.now();
  const request: AdminRequest = {
    id: `req_${randomBytes(16).toString("base64url")}`, rule: input.rule, action_key: input.action_key, action_id: input.action_id,
    summary: input.summary.slice(0, 200), reason: input.reason.trim().slice(0, 500), os_user_digest: input.os_user_digest,
    harness: input.harness, created_at: new Date(now).toISOString(), sent_at: null,
  };
  // One open request per rule and action: asking twice replaces the reason.
  const others = readRequests(dir).filter((r) => r.sent_at || r.rule !== input.rule || r.action_key !== input.action_key);
  writeRequests(dir, [...others, request], now);
  return request;
}
