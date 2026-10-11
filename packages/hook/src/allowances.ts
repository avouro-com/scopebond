// Allowances: an action a rule blocks that stands allowed for a while. A person at the computer makes one from
// the Scopebond window or the tray ("Allow for 15 min", "Always allow this here…"); an admin makes one by approving a request
// ("Ask an admin") or confirming a person's. Each is bound to one rule and one exact action (the same type and parameters,
// whatever tool call it came from), expires (30 days by default, 90 at most unless the workspace allows more), and is
// recorded: the receipt of an action an allowance lets through says `method: "allowance"` and names it.
//
// Nothing here can allow Scopebond's own protection: the override handler checks the floor before any allowance.
//
// Files in the Scopebond home (the coding agent cannot write them; the hook refuses any write there):
//   allowances.json  the allowances this computer holds (made here, or delivered by the workspace)
//   blocked.json     the last blocks under rules a person may allow or ask about, for the tray's "Recently blocked"

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { digestOf } from "./override.js";
import { writeAtomic } from "./managed.js";

export const ALLOWANCES_FILE = "allowances.json";
export const BLOCKED_FILE = "blocked.json";
const DAY_MS = 24 * 60 * 60 * 1000;
/** 30 days by default; at most 90 (a workspace on Business or Enterprise may send a longer expiry it allows). */
export const ALLOWANCE_DEFAULT_DAYS = 30;
export const ALLOWANCE_MAX_DAYS = 365;

export interface Allowance {
  id: string;
  rule: string;
  /** The exact action (see `actionKey`): the same action type and parameters. */
  action_key: string;
  /** computer: anyone on this computer. person: only the operating-system account it was made by. */
  scope: "computer" | "person";
  os_user_digest: string | null;
  /** active: in force. proposed: waiting for an admin (not in force). revoked: an admin took it back. */
  state: "active" | "proposed" | "revoked";
  /** One use only (an action allowed after it was blocked, for the next try). */
  once: boolean;
  reason_digest: string;
  reason_length: number;
  created_by: "person" | "workspace";
  created_at: string;
  expires_at: string;
  uses: number;
  /** When the agent sent it to the workspace (person-made allowances). */
  sent_at?: string | null;
  /** The reason text, kept only until it is sent (the workspace shows it); the receipt carries its digest. */
  reason?: string;
}

interface AllowanceFile { version: 1; items: Allowance[] }

const HEX64 = /^[0-9a-f]{64}$/;
const ID = /^alw_[A-Za-z0-9_-]{16,64}$/;

export function newAllowanceId(): string {
  return `alw_${randomBytes(16).toString("base64url")}`;
}

export function readAllowances(dir: string): Allowance[] {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, ALLOWANCES_FILE), "utf8")) as AllowanceFile;
    return Array.isArray(parsed.items) ? parsed.items.filter(validAllowance) : [];
  } catch { return []; }
}

export function writeAllowances(dir: string, items: Allowance[], now = Date.now()): void {
  // Expired ones are kept a week (the tray and the workspace may still name them), then dropped.
  const kept = items.filter((a) => Date.parse(a.expires_at) > now - 7 * DAY_MS).slice(-1000);
  writeAtomic(join(dir, ALLOWANCES_FILE), `${JSON.stringify({ version: 1, items: kept }, null, 1)}\n`);
}

/** Whether a value has the shape of an allowance (one from the workspace is checked the same way; a bad one is ignored, so
 *  a malformed delivery can only allow less). */
export function validAllowance(a: unknown): a is Allowance {
  if (!a || typeof a !== "object") return false;
  const x = a as Record<string, unknown>;
  return typeof x.id === "string" && ID.test(x.id) && typeof x.rule === "string" && /^[a-z0-9-]{1,64}$/.test(x.rule)
    && typeof x.action_key === "string" && HEX64.test(x.action_key)
    && (x.scope === "computer" || x.scope === "person") && (x.os_user_digest === null || (typeof x.os_user_digest === "string" && HEX64.test(x.os_user_digest)))
    && (x.state === "active" || x.state === "proposed" || x.state === "revoked") && typeof x.once === "boolean"
    && typeof x.reason_digest === "string" && HEX64.test(x.reason_digest) && Number.isInteger(x.reason_length) && (x.reason_length as number) >= 1 && (x.reason_length as number) <= 500
    && (x.created_by === "person" || x.created_by === "workspace") && typeof x.created_at === "string" && Number.isFinite(Date.parse(x.created_at))
    && typeof x.expires_at === "string" && Number.isFinite(Date.parse(x.expires_at)) && Number.isInteger(x.uses) && (x.uses as number) >= 0
    && (x.scope !== "person" || typeof x.os_user_digest === "string");
}

/** The allowance in force for this rule and action, for this person, now; or null. Revoked, proposed, expired and used
 *  one-time allowances never match. */
export function matchAllowance(items: Allowance[], query: { rule: string; actionKey: string; osUserDigest: string | null; now: number }): Allowance | null {
  return items.find((a) => a.state === "active" && a.rule === query.rule && a.action_key === query.actionKey
    && Date.parse(a.expires_at) > query.now && !(a.once && a.uses > 0)
    && (a.scope === "computer" || (a.os_user_digest !== null && a.os_user_digest === query.osUserDigest))) ?? null;
}

/** Make an allowance on this computer. `lasts`: once (the next try), 15 minutes, or `always` (the workspace's default expiry;
 *  "proposed" when the workspace wants an admin to confirm first). */
export function makeAllowance(input: {
  rule: string; actionKey: string; reason: string; osUserDigest: string | null; lasts: "once" | "15m" | "always";
  alwaysDays?: number; needsAdmin?: boolean; now?: number;
}): Allowance {
  const now = input.now ?? Date.now();
  const reason = input.reason.trim().slice(0, 500);
  const days = Math.min(ALLOWANCE_MAX_DAYS, Math.max(1, Math.round(input.alwaysDays ?? ALLOWANCE_DEFAULT_DAYS)));
  const expires = input.lasts === "15m" ? now + 15 * 60_000 : input.lasts === "once" ? now + DAY_MS : now + days * DAY_MS;
  return {
    id: newAllowanceId(), rule: input.rule, action_key: input.actionKey,
    scope: input.osUserDigest ? "person" : "computer", os_user_digest: input.osUserDigest,
    state: input.lasts === "always" && input.needsAdmin ? "proposed" : "active", once: input.lasts === "once",
    reason_digest: digestOf(reason), reason_length: reason.length, reason, created_by: "person",
    created_at: new Date(now).toISOString(), expires_at: new Date(expires).toISOString(), uses: 0, sent_at: null,
  };
}

/** Bring the workspace's view in: its allowances for this computer (approved requests, confirmed ones) are added or
 *  updated, and the ones it revoked stop applying here. */
export function mergeWorkspaceAllowances(local: Allowance[], delivered: unknown, revoked: unknown): Allowance[] {
  const revokedIds = new Set(Array.isArray(revoked) ? revoked.filter((id): id is string => typeof id === "string") : []);
  const fromWorkspace = (Array.isArray(delivered) ? delivered : []).filter(validAllowance).filter((a) => a.state !== "proposed");
  const byId = new Map(local.map((a) => [a.id, a]));
  for (const a of fromWorkspace) {
    const mine = byId.get(a.id);
    // Uses are counted here; the workspace's copy decides state and expiry.
    byId.set(a.id, { ...a, uses: Math.max(a.uses, mine?.uses ?? 0), sent_at: mine?.sent_at ?? a.sent_at ?? null, ...(mine?.reason ? { reason: mine.reason } : {}) });
  }
  return [...byId.values()].map((a) => (revokedIds.has(a.id) ? { ...a, state: "revoked" as const } : a));
}

export interface BlockedItem {
  id: string;
  at: string;
  rule: string;
  /** override: a person may allow it; ask: a person may ask an admin. */
  mode: "override" | "ask";
  action_key: string;
  summary: string;
  harness: string;
  /** What a person did about it afterwards, from the tray: allowed it (an allowance), or asked an admin. */
  acted?: "allowed" | "asked";
  acted_at?: string;
}

export function readBlocked(dir: string): BlockedItem[] {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, BLOCKED_FILE), "utf8")) as { items?: BlockedItem[] };
    return Array.isArray(parsed.items) ? parsed.items : [];
  } catch { return []; }
}

/** Remember a block a person may act on afterwards (the newest 50 of the last week). Never throws. */
export function recordBlocked(dir: string, item: BlockedItem, now = Date.now()): void {
  try {
    const items = [...readBlocked(dir).filter((b) => b.id !== item.id), item]
      .filter((b) => now - Date.parse(b.at) < 7 * DAY_MS).slice(-50);
    writeAtomic(join(dir, BLOCKED_FILE), `${JSON.stringify({ items }, null, 1)}\n`);
  } catch { /* the receipt is the record; the list is a convenience */ }
}

/** Note what a person did about a block, so the tray says so and does not offer it again. */
export function markBlocked(dir: string, id: string, acted: "allowed" | "asked", now = Date.now()): void {
  const items = readBlocked(dir).map((b) => (b.id === id ? { ...b, acted, acted_at: new Date(now).toISOString() } : b));
  writeAtomic(join(dir, BLOCKED_FILE), `${JSON.stringify({ items }, null, 1)}\n`);
}
