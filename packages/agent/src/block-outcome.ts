// What the person can do about a block, as one outcome and the sentence the tray shows for it. Every block in the tray has
// exactly one: Unblock…, Ask an admin…, or a plain sentence saying why it stays blocked or where its request stands. The
// tray draws this; it never works out an outcome itself.

/** `unblock`: the person may let it through; `ask`: an admin decides; `always_on`: Scopebond's own protection, never
 *  unblocked; `workspace_rule`: a rule the workspace set with no unblocking; `safe_install`: Safe Install refused the
 *  install; `requested`: the person asked an admin (waiting, approved or declined); `allowed`: an allowance in force already
 *  covers it; `quiet`: the person chose to keep it blocked without being asked again (Undo is under Allowed). */
export type BlockOutcome = "unblock" | "ask" | "always_on" | "workspace_rule" | "safe_install" | "requested" | "allowed" | "quiet";

/** The state of the person's request for a block, as the workspace last said. */
export interface BlockRequest {
  state: "waiting" | "approved" | "declined";
  answered_by: string | null;
  answered_at: string | null;
}

export interface OutcomeInput {
  /** What the workspace offers for it now (null: nothing). */
  offers: { once: boolean; fifteen: boolean; always: boolean; ask: boolean; hour?: boolean; tomorrow?: boolean } | null;
  /** The clause that denied it, the workspace rule and what blocked it when no rule did (block-notes.ts). */
  clause: string | null;
  rule: string | null;
  kind: "install" | "service" | "budget" | null;
  verdict: string | null;
  /** Safe Install held the install for the person (its verdict was "ask") and the coding tool could not ask them. */
  held?: boolean;
  /** The person's newest request for this action, and whether an allowance in force covers it. */
  request: BlockRequest | null;
  allowed: boolean;
  /** The person chose to keep it blocked without being asked (a quiet block in force, or this block's own answer). */
  quiet?: boolean;
  /** The workspace's name, the coding tool's name, the action in words, the rule's name and the record's id (for Copy
   *  details). */
  workspace: string | null;
  tool: string | null;
  what: string;
  rule_title: string;
  action_id: string | null;
}

export interface OutcomeOutput {
  outcome: BlockOutcome;
  /** The sentence the row shows instead of a button; null for `unblock` and `ask` (the row shows the button). */
  outcome_text: string | null;
  /** Text for "Copy details" (the action, the rule and the record's id, for a chat or a ticket); null when not offered. */
  copy_details: string | null;
}

/** Scopebond's own protection (its folder, its keys, the coding agents' hook settings): always on, never unblocked. */
const ALWAYS_ON_CLAUSES: ReadonlySet<string> = new Set(["protect-scopebond-read", "protect-scopebond-write"]);

export function blockOutcome(b: OutcomeInput): OutcomeOutput {
  const copy = `${b.what}\nRule: ${b.rule_title}${b.action_id ? `\nRecord: ${b.action_id}` : ""}`;
  const tool = b.tool ?? "the coding agent";
  if (b.request) {
    const who = b.request.answered_by ? ` by ${b.request.answered_by}` : "";
    const text = b.request.state === "approved" ? `Approved${who}: ask ${tool} to try again`
      : b.request.state === "declined" ? `Declined${who}`
      : "Waiting for an admin";
    return { outcome: "requested", outcome_text: text, copy_details: null };
  }
  if (b.allowed) return { outcome: "allowed", outcome_text: `Allowed: ask ${tool} to try again`, copy_details: null };
  if (b.quiet) return { outcome: "quiet", outcome_text: "Kept blocked: you won't be asked about it again. Undo it under Allowed.", copy_details: null };
  if (b.offers && (b.offers.once || b.offers.fifteen || b.offers.always || b.offers.hour || b.offers.tomorrow)) return { outcome: "unblock", outcome_text: null, copy_details: null };
  if (b.offers?.ask) return { outcome: "ask", outcome_text: null, copy_details: null };
  if (b.clause && ALWAYS_ON_CLAUSES.has(b.clause)) {
    return { outcome: "always_on", outcome_text: "Always on. Scopebond protects its own keys and records on this computer.", copy_details: null };
  }
  if (b.kind === "install" && b.held) {
    // Not a final block: the coding tool could not ask, so the person decides by running the install themselves.
    const why = b.verdict ? ` ${b.verdict.replace(/\.$/, "")}.` : "";
    return { outcome: "safe_install", outcome_text: `Waiting for you: Safe Install held this install to check with you first.${why} If you meant to install it, run the install yourself in your terminal.`, copy_details: copy };
  }
  if (b.kind === "install") {
    return { outcome: "safe_install", outcome_text: `Blocked by Safe Install${b.verdict ? `: ${lowerFirst(b.verdict)}` : ""}.`.replace(/\.\.$/, "."), copy_details: copy };
  }
  const by = b.workspace ? `Set by ${b.workspace}` : "Set by your workspace";
  return { outcome: "workspace_rule", outcome_text: `${by}. Ask an admin to change the rule.`, copy_details: copy };
}

const lowerFirst = (s: string): string => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);
