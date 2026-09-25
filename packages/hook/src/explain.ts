// The sentence a person — and the coding agent they are supervising — sees when
// Scopebond blocks an action.
//
// The engine's own reason is precise and unreadable ("param ref fails pattern"):
// it names the mechanism, not the rule. The policy clause that decided already
// carries a written `description`, and the verdict names that clause, so both are
// available here. The composed message says what was blocked, which rule blocked
// it, why that rule exists, and where to change it — and it keeps the engine's
// detail so a surprising decision stays debuggable.
//
// This string is also fed back to the agent (Claude Code's
// `permissionDecisionReason`, Cursor's `agentMessage`), so a clear one lets the
// agent pick a different approach instead of retrying the same blocked call.

/** A policy clause, as much of it as the message needs. */
export interface ExplainClause {
  id?: unknown;
  mode?: unknown;
  description?: unknown;
}

export interface ExplainPolicy {
  clauses?: unknown;
}

/** An intent, as much of it as the message needs. */
export interface ExplainIntent {
  action_type?: unknown;
  params?: unknown;
}

/** How long a clause description may run before it is cut. Long enough for the
 *  starter policy's first clause, short enough not to bury a terminal. */
const MAX_WHY = 300;

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** One line naming the action: `git.push origin main`, `shell.exec rm`,
 *  `file.read .env`. Shared with `log` so a decision reads the same in both. */
export function describeAction(intent: ExplainIntent | undefined): string {
  const type = str(intent?.action_type);
  const p = (intent?.params ?? {}) as Record<string, unknown>;
  const bits = type === "shell.exec" ? str(p.program)
    : type === "git.push" ? `${str(p.remote)} ${str(p.ref)}`.trim()
    : type === "file.write" || type === "file.read" ? str(p.path)
    : type === "mcp.tool.call" ? `${str(p.server)}/${str(p.tool)}`
    : type === "net.fetch" ? str(p.host) : "";
  return `${type || "?"}${bits ? ` ${bits}` : ""}`;
}

/** Trim a description to one readable fragment, cut on a word boundary. */
function shorten(text: string, max = MAX_WHY): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[,;:—-]$/, "")}…`;
}

/** Find the clause that decided, by the id the verdict reported. */
export function findClause(policy: ExplainPolicy | undefined, clauseId: string | null | undefined): ExplainClause | null {
  if (!clauseId || !Array.isArray(policy?.clauses)) return null;
  for (const clause of policy.clauses) {
    if (clause && typeof clause === "object" && str((clause as ExplainClause).id) === clauseId) {
      return clause as ExplainClause;
    }
  }
  return null;
}

export interface ExplainDenyInput {
  /** The loaded policy, for the deciding clause's own words. */
  policy?: ExplainPolicy;
  /** The clause id the verdict reported, when it reported one. */
  clauseId?: string | null;
  /** The engine's reason — kept verbatim as the technical detail. */
  detail: string;
  /** The action that was blocked. */
  intent?: ExplainIntent;
  /** Where the rule lives, so the next step is a real path. */
  policyPath?: string;
  /** The harness reported this action only after it happened, so the decision records
   *  and flags it but did not prevent it. The wording must not claim otherwise. */
  postHoc?: boolean;
}

/** Compose the block message. Degrades in order: with a clause and a description
 *  it explains the rule; with a clause but no description it still names it; with
 *  no clause at all (an undetermined verdict, a kill switch) it reports the
 *  engine's reason unchanged rather than inventing a rule that did not decide. */
export function explainDeny(input: ExplainDenyInput): string {
  const detail = input.detail.trim() || "denied";
  const action = describeAction(input.intent);
  const clause = findClause(input.policy, input.clauseId);
  const clauseId = str(clause?.id) || str(input.clauseId);
  // "blocked" is a claim about prevention, so it is only used where the action really
  // was stopped in flight.
  const verb = input.postHoc ? "recorded an out-of-policy" : "blocked";
  if (!clauseId) {
    return action ? `Scopebond ${verb} ${action}: ${detail}` : `Scopebond ${verb} action: ${detail}`;
  }
  const mode = str(clause?.mode) || "enforce";
  const why = shorten(str(clause?.description));
  const lines = [
    `Scopebond ${verb} ${action || "action"} — rule "${clauseId}" (${mode}).`,
    ...(why ? [`Why: ${why}`] : []),
    ...(detail && detail !== "denied" ? [`Detail: ${detail}`] : []),
    `Change the rule: edit clause "${clauseId}" in ${input.policyPath || "your Scopebond policy"}`,
  ];
  return lines.join("\n");
}
