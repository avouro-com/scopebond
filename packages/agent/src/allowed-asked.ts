// What a person let through and what they asked an admin, for the tray's Allowed and Asked lists, from the stores the hook
// keeps on this computer: allowances.json (made here, or delivered by the workspace in its rules document), requests.json,
// the rules document's allowances and revoked allowances, and the text the Scopebond window showed for each action.
// Read-only; nothing here allows or asks anything.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MANAGED_DOC_FILE, mergeWorkspaceAllowances, readActionText, readAllowances, readBlocked, readRequests, ruleTitle, type Allowance } from "@scopebond/hook";

/** An allowance in force or waiting for an admin. `choice`: once (the next try), fifteen (15 minutes) or always (until
 *  `ends_at`). `by`: the person on this computer, or an admin in the workspace (an approved request, or one an admin made). */
export interface AllowedItem {
  id: string;
  rule: string;
  rule_title: string | null;
  /** The action as the Scopebond window showed it, when this computer knows it. */
  what: string | null;
  choice: "once" | "fifteen" | "always";
  state: "active" | "proposed";
  /** Waiting for an admin to approve before it applies. */
  needs_admin: boolean;
  by: "person" | "admin";
  created_at: string;
  ends_at: string;
  /** Who approved it, when the workspace said. */
  answered_by: string | null;
}

/** A request to an admin. `state`: waiting (not answered yet), approved (the workspace sent an allowance for it) or declined
 *  (the workspace said so). `sent`: it has reached the workspace. */
export interface AskedItem {
  id: string;
  rule: string;
  rule_title: string | null;
  what: string;
  reason: string;
  asked_at: string;
  sent: boolean;
  state: "waiting" | "approved" | "declined";
  answered_by: string | null;
  note: string | null;
  answered_at: string | null;
}

const MAX_ITEMS = 50;
/** An allowance made for 15 minutes ends this long after it was made. */
const FIFTEEN_MS = 15 * 60_000;

// eslint-disable-next-line no-control-regex -- deliberate: control characters are taken out of text the workspace sent
const text = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : null);

function rulesDocument(dir: string): { allowances?: unknown; revoked_allowances?: unknown; request_answers?: unknown } | null {
  try { return JSON.parse(readFileSync(join(dir, MANAGED_DOC_FILE), "utf8")) as { allowances?: unknown; revoked_allowances?: unknown; request_answers?: unknown }; }
  catch { return null; }
}

/** Every allowance this computer knows: its own, with the workspace's view (delivered and revoked) brought in. */
function allAllowances(dir: string): Allowance[] {
  const doc = rulesDocument(dir);
  const local = readAllowances(dir);
  return doc && (doc.allowances || doc.revoked_allowances) ? mergeWorkspaceAllowances(local, doc.allowances, doc.revoked_allowances) : local;
}

/** The text for an action key: what the window showed when it was allowed, else a block or a request that named it. */
function textsByKey(dir: string): Map<string, string> {
  const texts = new Map<string, string>();
  for (const r of readRequests(dir)) if (r.summary) texts.set(r.action_key, r.summary);
  for (const b of readBlocked(dir)) if (b.summary) texts.set(b.action_key, b.summary);
  for (const [key, t] of readActionText(dir)) texts.set(key, t);
  return texts;
}

const extra = (a: Allowance, key: string, max: number): string | null => text((a as unknown as Record<string, unknown>)[key], max);

/** Allowances in force now, and those waiting for an admin, newest first. */
export function allowedList(dir: string, now = Date.now()): AllowedItem[] {
  const texts = textsByKey(dir);
  return allAllowances(dir)
    .filter((a) => Date.parse(a.expires_at) > now && (a.state === "proposed" || (a.state === "active" && !(a.once && a.uses > 0))))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .slice(0, MAX_ITEMS)
    .map((a) => ({
      id: a.id, rule: a.rule, rule_title: ruleTitle(a.rule), what: texts.get(a.action_key) ?? null,
      choice: a.once ? "once" : a.created_by === "person" && Date.parse(a.expires_at) - Date.parse(a.created_at) <= FIFTEEN_MS + 60_000 ? "fifteen" : "always",
      state: a.state === "proposed" ? "proposed" : "active", needs_admin: a.state === "proposed", by: a.created_by === "workspace" ? "admin" : "person",
      created_at: a.created_at, ends_at: a.expires_at, answered_by: a.created_by === "workspace" ? extra(a, "approved_by", 120) : null,
    }));
}

interface RequestAnswer { request_id: string; state: "approved" | "declined"; by: string | null; note: string | null; at: string | null }

/** Answers the workspace sent for requests, when its rules document carries them (`request_answers`). */
function requestAnswers(dir: string): Map<string, RequestAnswer> {
  const list = rulesDocument(dir)?.request_answers;
  const out = new Map<string, RequestAnswer>();
  if (!Array.isArray(list)) return out;
  for (const raw of list as unknown[]) {
    const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const id = text(r.request_id, 200);
    if (!id || (r.state !== "approved" && r.state !== "declined")) continue;
    out.set(id, { request_id: id, state: r.state, by: text(r.by, 120), note: text(r.note, 300), at: text(r.at, 40) });
  }
  return out;
}

/** Requests to an admin, newest first: waiting, approved (an allowance came back for the same rule and action, or the
 *  workspace said so) or declined (the workspace said so), with who answered and their note when the workspace sent them. */
export function askedList(dir: string): AskedItem[] {
  const answers = requestAnswers(dir);
  const fromWorkspace = allAllowances(dir).filter((a) => a.created_by === "workspace" && a.state !== "proposed");
  return readRequests(dir)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .slice(0, MAX_ITEMS)
    .map((r) => {
      const said = answers.get(r.id);
      const approved = fromWorkspace.find((a) => a.rule === r.rule && a.action_key === r.action_key && Date.parse(a.created_at) >= Date.parse(r.created_at) - 5 * 60_000);
      const state: AskedItem["state"] = said?.state ?? (approved ? "approved" : "waiting");
      return {
        id: r.id, rule: r.rule, rule_title: ruleTitle(r.rule), what: r.summary, reason: r.reason, asked_at: r.created_at, sent: !!r.sent_at, state,
        answered_by: said?.by ?? (approved ? extra(approved, "approved_by", 120) : null),
        note: said?.note ?? (approved ? extra(approved, "note", 300) : null),
        answered_at: said?.at ?? (state === "approved" && approved ? approved.created_at : null),
      };
    });
}
