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
import { ruleOfClause } from "./rule-titles.js";

export const BLOCK_NOTES_FILE = "block-notes.json";
const KEEP = 100;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface BlockNote {
  /** The denied receipt's action id. */
  id: string;
  at: string;
  /** The clause that denied it, when the verdict named one. */
  clause: string | null;
  /** The workspace rule that clause carries (`guardrail-config-write` for Scopebond's own protection), when any. */
  rule: string | null;
  /** The coding tool's id (`claude`, `cursor`, …). */
  harness: string;
  /** The project's name: the repository's (`checkout` for `github.com/acme/checkout`), else the folder's. */
  project: string | null;
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
export function noteBlock(dir: string, decision: { decision: string; clauseId?: string | null; receipt?: unknown; receipts?: unknown[] },
  where: { harness: string; project: string | null }, now = Date.now()): void {
  try {
    if (decision.decision !== "deny") return;
    const id = deniedActionId(decision);
    if (!id) return;
    const clause = decision.clauseId ?? null;
    const note: BlockNote = { id, at: new Date(now).toISOString(), clause, rule: ruleOfClause(clause), harness: where.harness, project: where.project };
    const notes = [...readBlockNotes(dir).filter((n) => n.id !== id), note].filter((n) => now - Date.parse(n.at) < WEEK_MS).slice(-KEEP);
    writeAtomic(join(dir, BLOCK_NOTES_FILE), `${JSON.stringify({ notes })}\n`);
  } catch { /* the tray shows the block without the rule's name */ }
}
