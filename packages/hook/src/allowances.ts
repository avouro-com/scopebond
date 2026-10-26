// Allowances: an action a rule blocks that stands allowed for a while. A person at the computer makes one from
// the Scopebond window or the tray ("Allow for 15 min", "Always allow this here…"); an admin makes one by approving a request
// ("Ask an admin") or confirming a person's. Each is bound to one rule and one exact action: for a shell command, what the
// window showed (the command, the folder a relative target is in, the project), whatever line it came in; for any other
// action, the same type and parameters, whatever tool call it came from. It expires (30 days by default, 90 at most unless
// the workspace allows more), and is recorded: the receipt of an action an allowance lets through says `method: "allowance"`
// and names it.
//
// A pattern allowance ("Similar commands in this project", pattern-recipes.ts) carries `match` instead: the same rule and
// action type, and bounds on the parameter the rule matched (a folder of one project or repository, a file pattern in it, a
// package in any version, a host, an MCP server's tool). It is matched here (`matchPatternAllowance`) and never outside its
// bounds; its `action_key` is a digest of the match, which no action has, so it never matches as an exact allowance.
//
// Nothing here can allow Scopebond's own protection: the override handler checks the floor before any allowance.
//
// Files in the Scopebond home (the coding agent cannot write them; the hook refuses any write there):
//   allowances.json  the allowances this computer holds (made here, or delivered by the workspace)
//   blocked.json     the last blocks under rules a person may allow or ask about, for the tray's "Recently blocked"

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { canonical } from "@scopebond/policy-schema/canonical";
import { DELETE_RECIPE, fullPathSegments, relativeSegments, validAllowanceMatch, withinSegments, type AllowanceBounds, type AllowanceMatch } from "@scopebond/policy-schema/allow-patterns";
import { digestOf } from "./override.js";
import { writeAtomic } from "./managed.js";
import { enginePath, foldCase, pathKey, rulePatternable, type SimilarProposal } from "./pattern-recipes.js";
import { namesProtectedPlace } from "./delete-scope.js";
import { canonProgram } from "./shell.js";

export const ALLOWANCES_FILE = "allowances.json";
export const BLOCKED_FILE = "blocked.json";
const DAY_MS = 24 * 60 * 60 * 1000;
/** 30 days by default; at most 90 (a workspace on Business or Enterprise may send a longer expiry it allows). */
export const ALLOWANCE_DEFAULT_DAYS = 30;
export const ALLOWANCE_MAX_DAYS = 365;

export interface Allowance {
  id: string;
  rule: string;
  /** The exact action (see `allowanceKey` in override.ts): what the window showed for a shell command, else the same action
   *  type and parameters. */
  action_key: string;
  /** computer: anyone on this computer. person: only the operating-system account it was made by. session: only the coding-agent
   *  session it names (`session_id`, the keyed id receipts carry), approved by an admin with a session budget. A hook that
   *  predates session scope finds such an allowance invalid and ignores it, so it can only allow less. */
  scope: "computer" | "person" | "session";
  /** The session a session-scoped allowance applies to. */
  session_id?: string;
  os_user_digest: string | null;
  /** active: in force. proposed: waiting for an admin (not in force). revoked: an admin took it back. */
  state: "active" | "proposed" | "revoked";
  /** One use only (an action allowed after it was blocked, for the next try). */
  once: boolean;
  /** The reason's digest and length; null and 0 when the person gave none (the workspace asks for none). */
  reason_digest: string | null;
  reason_length: number;
  created_by: "person" | "workspace";
  created_at: string;
  expires_at: string;
  uses: number;
  /** When the agent sent it to the workspace (person-made allowances). */
  sent_at?: string | null;
  /** How it was unblocked, for a workspace that sets the unblock terms (`lasts`, `review`): "automatic" (applied at once and
   *  reviewed later) or "person" (the person chose). Absent otherwise, so an older workspace gets the record it knows. */
  unblocked?: "automatic" | "person" | "admin";
  /** The person stopped it here ("Stop allowing"): when. It no longer applies; the agent sends the ended record once
   *  (`end_sent_at`). Kept on this computer; never part of the allowance's own record. */
  ended_at?: string;
  ended_by?: "person";
  end_sent_at?: string | null;
  /** The reason text, kept only until it is sent (the workspace shows it); the receipt carries its digest. */
  reason?: string;
  /** "quiet": not an allowance but a quiet block ("Keep blocking without asking me", `makeQuietBlock`): the person chose to
   *  keep this action blocked, so it is denied at once and no one is asked. It never lets anything through. Absent (or
   *  "allow"): an allowance. */
  kind?: "allow" | "quiet";
  /** A pattern allowance: what it lets through (pattern-recipes.ts). Absent: an exact allowance for `action_key`. A hook that
   *  predates it finds an `action_key` no action has, so it can only allow less. */
  match?: AllowanceMatch;
}

/** The `action_key` of a pattern allowance: a digest of its match, which no action's key equals. */
export const patternKey = (match: AllowanceMatch): string => digestOf(`pattern:${canonical(match)}`);

interface AllowanceFile { version: 1; items: Allowance[] }

const HEX64 = /^[0-9a-f]{64}$/;
const ID = /^alw_[A-Za-z0-9_-]{16,64}$/;

function newAllowanceId(): string {
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
function validAllowance(a: unknown): a is Allowance {
  if (!a || typeof a !== "object") return false;
  const x = a as Record<string, unknown>;
  return typeof x.id === "string" && ID.test(x.id) && typeof x.rule === "string" && /^[a-z0-9-]{1,64}$/.test(x.rule)
    && typeof x.action_key === "string" && HEX64.test(x.action_key)
    && (x.scope === "computer" || x.scope === "person" || x.scope === "session") && (x.os_user_digest === null || (typeof x.os_user_digest === "string" && HEX64.test(x.os_user_digest)))
    && (x.state === "active" || x.state === "proposed" || x.state === "revoked") && typeof x.once === "boolean"
    && ((x.reason_digest === null && x.reason_length === 0)
      || (typeof x.reason_digest === "string" && HEX64.test(x.reason_digest) && Number.isInteger(x.reason_length) && (x.reason_length as number) >= 1 && (x.reason_length as number) <= 500))
    && (x.created_by === "person" || x.created_by === "workspace") && typeof x.created_at === "string" && Number.isFinite(Date.parse(x.created_at))
    && typeof x.expires_at === "string" && Number.isFinite(Date.parse(x.expires_at)) && Number.isInteger(x.uses) && (x.uses as number) >= 0
    && (x.scope !== "person" || typeof x.os_user_digest === "string")
    && (x.scope === "session" ? typeof x.session_id === "string" && x.session_id.length >= 1 && x.session_id.length <= 200 : x.session_id === undefined)
    && (x.kind === undefined || x.kind === "allow" || x.kind === "quiet")
    // A pattern allowance: well-formed narrow bounds, for its own rule, never an always-on protection, never a quiet block.
    && (x.match === undefined || (validAllowanceMatch(x.match) && x.match.rule === x.rule && rulePatternable(x.rule) && x.kind !== "quiet"));
}

/** Whether an entry applies to this person or session (its scope): the same test for an allowance and a quiet block. */
const inScope = (a: Allowance, query: { osUserDigest: string | null; sessionId?: string | null }): boolean =>
  a.scope === "computer" || (a.scope === "session" ? !!query.sessionId && a.session_id === query.sessionId
    : a.os_user_digest !== null && a.os_user_digest === query.osUserDigest);

/** The allowance in force for this rule and action, for this person, now; or null. Revoked, proposed, expired and used
 *  one-time allowances never match, and neither does a quiet block. */
export function matchAllowance(items: Allowance[], query: { rule: string; actionKey: string; osUserDigest: string | null; now: number; sessionId?: string | null }): Allowance | null {
  return items.find((a) => a.kind !== "quiet" && a.match === undefined && a.state === "active" && !a.ended_at && a.rule === query.rule && a.action_key === query.actionKey
    && Date.parse(a.expires_at) > query.now && !(a.once && a.uses > 0) && inScope(a, query)) ?? null;
}

/** What a pattern allowance is asked about: the rule that blocked, the action (as signed: the home folder masked), and the
 *  call's working folder (engine form, home masked). `real`: the real path of a path in engine form, or null when it does not
 *  exist (a link is followed); a delete pattern then also holds for where the targets really are. `home`: the home folder,
 *  unmasked (the operating system's by default). */
export interface PatternQuery {
  rule: string; action: { action_type?: string; params?: Record<string, unknown> }; project: string | null;
  osUserDigest: string | null; now: number; sessionId?: string | null;
  real?: (path: string) => string | null; home?: string;
}

/** The pattern allowance in force that covers this action under this rule, for this person, now; or null. Revoked, proposed,
 *  ended, expired and used one-time ones never match. */
export function matchPatternAllowance(items: Allowance[], query: PatternQuery): Allowance | null {
  return items.find((a) => a.kind !== "quiet" && a.match !== undefined && a.state === "active" && !a.ended_at && a.rule === query.rule
    && Date.parse(a.expires_at) > query.now && !(a.once && a.uses > 0) && inScope(a, query) && patternCovers(a.match, query)) ?? null;
}

const rootOf = (path: string): string => (path.startsWith("~/") ? "~/" : /^[a-z]:\//i.test(path) ? path.slice(0, 3).toLowerCase() : "/");

/** Whether a pattern covers an action: the same rule and action type, and the widened parameter inside the bounds. Fails
 *  closed: a match or an action that is not well formed covers nothing. */
export function patternCovers(match: AllowanceMatch, query: Pick<PatternQuery, "rule" | "action" | "project" | "real" | "home">): boolean {
  try {
    if (!validAllowanceMatch(match) || match.rule !== query.rule || !rulePatternable(match.rule) || match.action_type !== query.action.action_type) return false;
    const params = query.action.params ?? {};
    const b = match.bounds;
    if (match.recipe === DELETE_RECIPE) return deleteCovered(b, params, query);
    // Every other recipe holds in the project it was made in, and only there.
    if (!query.project || pathKey(query.project) !== pathKey(b.project)) return false;
    if (b.with && !Object.entries(b.with).every(([k, w]) => params[k] === w)) return false;
    const v = params[b.param];
    if (typeof v !== "string" || v === "") return false;
    const fold = foldCase(b.project);
    switch (b.kind) {
      case "path_prefix": {
        const segs = relativeSegments(v);
        const folder = relativeSegments(b.value);
        return !!segs && !!folder && segs.length > 0 && !namesProtectedPlace(segs) && withinSegments(segs, folder, fold);
      }
      case "path_glob": {
        const segs = relativeSegments(v);
        const glob = b.value.split("/");
        if (!segs || segs.length !== glob.length || namesProtectedPlace(segs)) return false;
        return withinSegments(segs.slice(0, -1), glob.slice(0, -1), fold) && wildcard(glob[glob.length - 1], segs[segs.length - 1], fold);
      }
      case "package_name": return v === b.value;
      case "host": return v.toLowerCase() === b.value;
      case "mcp_tool": return v === b.value;
    }
    return false;
  } catch { return false; }
}

/** The built-in delete recipe: the same program, a plain delete (not a destructive form), every target inside the folder (or
 *  the folder itself), the folder inside its project, and the project never the home folder or a folder holding it. Where the
 *  real paths can be read, they must agree: a target reached through a link to elsewhere is not covered. */
function deleteCovered(b: AllowanceBounds, params: Record<string, unknown>, query: Pick<PatternQuery, "real" | "home">): boolean {
  if (typeof params.program !== "string" || canonProgram(params.program) !== b.program || params.program_scope !== params.program) return false;
  const targets = params.delete_targets;
  if (!Array.isArray(targets) || targets.length === 0) return false;
  const folder = fullPathSegments(b.value);
  const project = fullPathSegments(b.project);
  if (!folder || !project) return false;
  // The project holds the home folder (`c:/Users`): never. A project under `~/` is inside it.
  const home = enginePath(query.home ?? homedir());
  const homeSegs = fullPathSegments(home);
  if (homeSegs && rootOf(b.project) !== "~/" && rootOf(home) === rootOf(b.project) && withinSegments(homeSegs, project, foldCase(b.project))) return false;
  const fold = foldCase(b.value);
  const realFolder = query.real ? query.real(b.value) : null;
  const realProject = query.real ? query.real(b.project) : null;
  for (const t of targets) {
    if (typeof t !== "string") return false;
    const segs = fullPathSegments(t);
    if (!segs || namesProtectedPlace(segs) || rootOf(t) !== rootOf(b.value) || !withinSegments(segs, folder, fold)) return false;
    const real = query.real?.(t) ?? null;
    if (real === null) continue;
    // Where it really is: inside where the folder really is, inside where the project really is.
    const realSegs = fullPathSegments(real);
    const folderSegs = realFolder ? fullPathSegments(realFolder) : null;
    const projectSegs = realProject ? fullPathSegments(realProject) : null;
    if (!realSegs || !folderSegs || !projectSegs || rootOf(real) !== rootOf(realFolder!) || rootOf(real) !== rootOf(realProject!)
      || !withinSegments(realSegs, folderSegs, foldCase(real)) || !withinSegments(folderSegs, projectSegs, foldCase(real))) return false;
  }
  return true;
}

/** Whether a file name matches a pattern with `*` (any run of characters) and `?` (one character): the usual two-pointer
 *  walk, on names of at most a few hundred characters. */
function wildcard(pattern: string, name: string, fold: boolean): boolean {
  const p = fold ? pattern.toLowerCase() : pattern;
  const n = fold ? name.toLowerCase() : name;
  let i = 0;
  let j = 0;
  let star = -1;
  let mark = 0;
  while (j < n.length) {
    if (i < p.length && (p[i] === "?" || p[i] === n[j])) { i++; j++; }
    else if (i < p.length && p[i] === "*") { star = i++; mark = j; }
    else if (star >= 0) { i = star + 1; j = ++mark; }
    else return false;
  }
  while (i < p.length && p[i] === "*") i++;
  return i === p.length;
}

/** The quiet block in force for this rule and action, for this person, now; or null. Revoked, ended and expired ones never
 *  match. */
export function matchQuietBlock(items: Allowance[], query: { rule: string; actionKey: string; osUserDigest: string | null; now: number; sessionId?: string | null }): Allowance | null {
  return items.find((a) => a.kind === "quiet" && a.state === "active" && !a.ended_at && a.rule === query.rule && a.action_key === query.actionKey
    && Date.parse(a.expires_at) > query.now && inScope(a, query)) ?? null;
}

/** How long a quiet block lasts. */
export const QUIET_BLOCK_DAYS = 30;

/** Make a quiet block on this computer ("Keep blocking without asking me"): the same action stays blocked and no one is asked
 *  for 30 days, or until the person undoes it (`endAllowance`). It carries no reason and no new personal data; the agent sends
 *  it to the workspace as an allowance record with `kind: "quiet"`. */
export function makeQuietBlock(input: { rule: string; actionKey: string; osUserDigest: string | null; now?: number }): Allowance {
  const now = input.now ?? Date.now();
  return {
    id: newAllowanceId(), rule: input.rule, action_key: input.actionKey,
    scope: input.osUserDigest ? "person" : "computer", os_user_digest: input.osUserDigest,
    state: "active", once: false, reason_digest: null, reason_length: 0, created_by: "person",
    created_at: new Date(now).toISOString(), expires_at: new Date(now + QUIET_BLOCK_DAYS * DAY_MS).toISOString(), uses: 0, sent_at: null,
    kind: "quiet",
  };
}

/** Make an allowance on this computer. `lasts`: once (the next try), 15 minutes, an hour, until tomorrow (24 hours), 30 days,
 *  or `always` (the workspace's default expiry). The long lengths (30 days, always) are "proposed" when the workspace wants
 *  an admin to confirm first. */
export function makeAllowance(input: {
  rule: string; actionKey: string; reason: string; osUserDigest: string | null; lasts: "once" | "15m" | "1h" | "tomorrow" | "30d" | "always";
  alwaysDays?: number; needsAdmin?: boolean; now?: number; unblocked?: "automatic" | "person";
  /** A pattern allowance ("Similar commands in this project"): its match, and whether it waits for an admin whatever its
   *  length (`override.patterns: "needs_admin"`). Its key is `patternKey(match)`, whatever `actionKey` says. */
  match?: AllowanceMatch; patternNeedsAdmin?: boolean;
}): Allowance {
  if (input.match) {
    const { match, patternNeedsAdmin, ...rest } = input;
    const made = makeAllowance({ ...rest, actionKey: patternKey(match) });
    return { ...made, match, ...(patternNeedsAdmin ? { state: "proposed" as const } : {}) };
  }
  const now = input.now ?? Date.now();
  const reason = input.reason.trim().slice(0, 500);
  const days = Math.min(ALLOWANCE_MAX_DAYS, Math.max(1, Math.round(input.alwaysDays ?? ALLOWANCE_DEFAULT_DAYS)));
  const expires = input.lasts === "15m" ? now + 15 * 60_000 : input.lasts === "1h" ? now + 60 * 60_000
    : input.lasts === "once" || input.lasts === "tomorrow" ? now + DAY_MS : input.lasts === "30d" ? now + 30 * DAY_MS : now + days * DAY_MS;
  const long = input.lasts === "always" || input.lasts === "30d";
  return {
    id: newAllowanceId(), rule: input.rule, action_key: input.actionKey,
    scope: input.osUserDigest ? "person" : "computer", os_user_digest: input.osUserDigest,
    state: long && input.needsAdmin ? "proposed" : "active", once: input.lasts === "once",
    // No reason given: no digest, and no text to send.
    reason_digest: reason ? digestOf(reason) : null, reason_length: reason.length, ...(reason ? { reason } : {}), created_by: "person",
    created_at: new Date(now).toISOString(), expires_at: new Date(expires).toISOString(), uses: 0, sent_at: null,
    ...(input.unblocked ? { unblocked: input.unblocked } : {}),
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
    byId.set(a.id, { ...a, uses: Math.max(a.uses, mine?.uses ?? 0), sent_at: mine?.sent_at ?? a.sent_at ?? null, ...(mine?.reason ? { reason: mine.reason } : {}),
      // Stopped here: it stays stopped, whatever the workspace's copy says until it has the ended record.
      ...(mine?.ended_at ? { ended_at: mine.ended_at, ended_by: mine.ended_by, end_sent_at: mine.end_sent_at ?? null } : {}),
      // A quiet block made here stays one: a workspace copy without the kind never turns it into an allowance.
      ...(mine?.kind === "quiet" ? { kind: "quiet" as const } : {}) });
  }
  return [...byId.values()].map((a) => (revokedIds.has(a.id) ? { ...a, state: "revoked" as const } : a));
}

/** `allowances` without the ones that came from the workspace: made by it, or named among the allowances it delivered (an
 *  approved request arrives that way, under the id of the person's request). What is left when the workspace's grants expired
 *  (policy-freshness.ts). The objects are the same ones, so a use counted on one is counted in `allowances` too. */
export function withoutWorkspaceAllowances(allowances: Allowance[], delivered: unknown): Allowance[] {
  const ids = new Set((Array.isArray(delivered) ? delivered : []).map((a) => (a && typeof a === "object" ? (a as { id?: unknown }).id : undefined)).filter((id): id is string => typeof id === "string"));
  return allowances.filter((a) => a.created_by !== "workspace" && !ids.has(a.id));
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
  /** What a person did about it afterwards: allowed it (an allowance), asked an admin, or kept it blocked without being asked
   *  again (a quiet block; also noted on each later block a quiet block denies). */
  acted?: "allowed" | "asked" | "quiet";
  acted_at?: string;
  /** What "Similar commands in this project" would allow for it (pattern-recipes.ts), when a recipe fits: kept with the
   *  block, because the action itself is not. */
  similar?: SimilarProposal;
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
export function markBlocked(dir: string, id: string, acted: "allowed" | "asked" | "quiet", now = Date.now()): void {
  const items = readBlocked(dir).map((b) => (b.id === id ? { ...b, acted, acted_at: new Date(now).toISOString() } : b));
  writeAtomic(join(dir, BLOCKED_FILE), `${JSON.stringify({ items }, null, 1)}\n`);
}

/** What the action an allowance names looked like: the text the Scopebond window showed, by the action's key, so the tray
 *  can say what an allowance lets through (an allowance carries only the key). Kept on this computer only and never sent;
 *  the newest 500. */
export const ACTION_TEXT_FILE = "action-text.json";

export function readActionText(dir: string): Map<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, ACTION_TEXT_FILE), "utf8")) as { items?: Array<{ action_key?: unknown; text?: unknown }> };
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    return new Map(items.filter((i) => typeof i.action_key === "string" && typeof i.text === "string").map((i) => [i.action_key as string, (i.text as string).slice(0, 200)]));
  } catch { return new Map(); }
}

/** Remember the text for an action a person allowed. Never throws: the allowance stands either way. */
export function rememberActionText(dir: string, actionKey: string, text: string, now = Date.now()): void {
  try {
    const kept = [...readActionText(dir)].filter(([key]) => key !== actionKey).map(([action_key, t]) => ({ action_key, text: t }));
    const items = [...kept, { action_key: actionKey, text: text.slice(0, 200), at: new Date(now).toISOString() }].slice(-500);
    writeAtomic(join(dir, ACTION_TEXT_FILE), `${JSON.stringify({ items }, null, 1)}\n`);
  } catch { /* the tray shows the rule's name instead */ }
}

/** "Stop allowing" (or "Undo" for a quiet block): the person ends an allowance they made on this computer (or one made at
 *  once by the workspace's terms).
 *  It stops applying at once; the agent sends the ended record to the workspace. Only one in force or waiting for an admin,
 *  made by a person, and not already ended or expired. */
export function endAllowance(dir: string, id: string, now = Date.now()): { outcome: "ended" | "gone" } {
  const items = readAllowances(dir);
  const a = items.find((x) => x.id === id);
  if (!a || a.created_by !== "person" || a.ended_at || (a.state !== "active" && a.state !== "proposed") || !(Date.parse(a.expires_at) > now)) return { outcome: "gone" };
  writeAllowances(dir, items.map((x) => (x.id === id ? { ...x, ended_at: new Date(now).toISOString(), ended_by: "person" as const, end_sent_at: null } : x)), now);
  return { outcome: "ended" };
}
