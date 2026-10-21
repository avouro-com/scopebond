// What the tray says about a block beside the action: the rule that blocked it, the project and the coding tool. A receipt
// names its rule only when a person was asked about it, and carries the tool and repository only when its workspace reads
// them, so the hook notes them here, on this computer, for each call it blocks. The note never leaves this computer and holds
// no arguments: the action's id, the clause that denied it and the rule that clause carries, the tool's id and the project's
// name (the repository's, else the folder's). The tray reads it with the receipts (local-activity.ts).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, parse, resolve } from "node:path";
import { writeAtomic } from "./managed.js";
import { revealHidden } from "./override.js";
import { blockTitle, checkOfCode, ruleOfClause } from "./rule-titles.js";

export const BLOCK_NOTES_FILE = "block-notes.json";
const KEEP = 500;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface BlockNote {
  /** The denied receipt's action id. */
  id: string;
  at: string;
  /** The clause that denied it, when the verdict named one; else the check that refused it (`safe-install`, `session-budget`,
   *  `dispatch-check`), when one did. */
  clause: string | null;
  /** The workspace rule that clause carries (`guardrail-config-write` for Scopebond's own protection), when any. */
  rule: string | null;
  /** The rule's name as the hook read it at the time (rule-titles.ts `blockTitle`): a rule pack's rule is named only while
   *  the pack is in force, which the reader of the note may not have. */
  title?: string;
  /** The coding tool's id (`claude`, `cursor`, …). */
  harness: string;
  /** The project's name: the repository's (`checkout` for `github.com/acme/checkout`), else the folder's. */
  project: string | null;
  /** The coding agent's session, as a key that names no session (the same key the hook's other state uses); absent from an
   *  older hook. Blocks of the same action in one session a few minutes apart are retries of one block. */
  session?: string | null;
  /** What blocked it, when it was not a rule's clause: Safe Install's verdict (`install`), a service the workspace blocks
   *  (`service`) or a session budget (`budget`). Absent for a rule. */
  kind?: "install" | "service" | "budget" | null;
  /** Safe Install's verdict in words ("known malware", "published 2 hours ago"), for an install it refused. */
  verdict?: string | null;
  /** Safe Install held the install for the person to decide (its verdict was "ask") and this coding tool could not ask them:
   *  not a final block. */
  held?: boolean;
}

/** The project's name for a person: the repository's last part, else the working folder's name. Never the home folder or a
 *  drive's root (that is not a project), at most 80 characters, hidden characters written out. */
export function projectOf(repository: string | null | undefined, cwd: string | null | undefined, home = homedir()): string | null {
  let name = repository?.split("/").filter(Boolean).at(-1)?.replace(/\.git$/i, "") ?? "";
  if (!name && cwd) {
    const folder = resolve(cwd);
    const same = (a: string, b: string) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
    if (!same(folder, resolve(home)) && !same(folder, parse(folder).root)) name = basename(folder);
  }
  name = revealHidden(name.trim());
  return name ? name.slice(0, 80) : null;
}

export function readBlockNotes(dir: string): BlockNote[] {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, BLOCK_NOTES_FILE), "utf8")) as { notes?: unknown };
    return Array.isArray(parsed.notes) ? parsed.notes.filter((n): n is BlockNote => !!n && typeof n === "object" && typeof (n as BlockNote).id === "string") : [];
  } catch { return []; }
}

/** The denied receipt's action id. */
function deniedActionId(decision: { receipt?: unknown; receipts?: unknown[] }): string | null {
  const receipt = decision.receipt ?? decision.receipts?.at(-1);
  const id = (receipt as { payload?: { action_ref?: { action_id?: unknown } } } | undefined)?.payload?.action_ref?.action_id;
  return typeof id === "string" && id !== "" ? id : null;
}

/** Note a blocked call (the newest 100 of the last week). Nothing for any other decision. Never throws: the receipt is the
 *  record, the note only names it for the tray. */
export function noteBlock(dir: string, decision: { decision: string; clauseId?: string | null; code?: string; reason?: string; receipt?: unknown; receipts?: unknown[] },
  where: { harness: string; project: string | null; session?: string | null }, now = Date.now()): void {
  try {
    if (decision.decision !== "deny") return;
    const id = deniedActionId(decision);
    if (!id) return;
    const clause = decision.clauseId ?? checkOfCode(decision.code);
    const rule = ruleOfClause(clause);
    const kind = blockKind(decision.code);
    // A rule pack's rule is named only while its pack is in force: its name is kept with the note.
    const title = blockTitle(rule, clause);
    const note: BlockNote = {
      id, at: new Date(now).toISOString(), clause, rule, ...(title !== blockTitle(rule, clause, []) ? { title } : {}), harness: where.harness, project: where.project,
      ...(where.session ? { session: where.session } : {}),
      ...(kind ? { kind } : {}),
      ...(kind === "install" ? { verdict: installVerdictWords(decision.reason), ...(installHeld(decision.reason) ? { held: true } : {}) } : {}),
    };
    const notes = [...readBlockNotes(dir).filter((n) => n.id !== id), note].filter((n) => now - Date.parse(n.at) < WEEK_MS).slice(-KEEP);
    writeAtomic(join(dir, BLOCK_NOTES_FILE), `${JSON.stringify({ notes })}\n`);
  } catch { /* the tray shows the block without the rule's name */ }
}

/** What blocked a call that no rule's clause denied, from the decision's code. */
function blockKind(code: string | undefined): BlockNote["kind"] {
  if (code === "install_verdict") return "install";
  if (code === "blocked_service") return "service";
  if (code === "session_budget") return "budget";
  return null;
}

/** Safe Install stopped the install to check with the person first (its verdict was "ask"), rather than blocking it. */
const installHeld = (message: string | null | undefined): boolean => !!message && /to check with you first/.test(message);

/** Safe Install's verdict in words, from its message ("Scopebond Safe Install blocked installing left-pad 1.0.0 (npm). It is
 *  on your workspace's list of known malware."): the first sentence after the one naming the install, at most 160
 *  characters; null when the message has no such sentence. */
export function installVerdictWords(message: string | null | undefined): string | null {
  if (!message) return null;
  const why = message.split(/\.\s+/)[1]?.replace(/\.$/, "").trim();
  return why ? why.slice(0, 160) : null;
}

