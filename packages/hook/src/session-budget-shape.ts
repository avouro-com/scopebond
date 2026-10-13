// The shape of a session budget as a workspace sends it in its rules document (`session_budgets`), checked exactly as the
// policy schema's session-budgets.schema.json says: closed, so an unknown key makes a budget, and the document, invalid.
// See session-budgets.ts for what the hook does with them.

export interface SessionBudgetLimit { operations: string[]; max: number }
export interface SessionBudget {
  budget_id: string;
  scope: "session";
  session_id: string;
  limits: SessionBudgetLimit[];
  mode: "enforce" | "monitor";
  version: number;
  expires_at: string;
  source?: "request" | "admin";
  /** Count a command the hook cannot classify (a shell command that is not a package install) as a file write, for a budget
   *  that limits file writes. Off by default: a shell command can write files the hook does not see as writes. */
  count_shell_as_write?: boolean;
}

const BUDGET_ID = /^[A-Za-z0-9._:-]{8,128}$/;
// eslint-disable-next-line security/detect-unsafe-regex -- linear: each repeated group starts with a "." its own class excludes
const OPERATION = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/;
const BUDGET_KEYS = new Set(["budget_id", "scope", "session_id", "limits", "mode", "version", "expires_at", "source", "count_shell_as_write"]);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const intIn = (v: unknown, min: number, max: number): boolean => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

function validLimit(l: unknown): l is SessionBudgetLimit {
  return isObject(l) && Object.keys(l).every((k) => k === "operations" || k === "max") && intIn(l.max, 0, 1_000_000)
    && Array.isArray(l.operations) && l.operations.length >= 1 && l.operations.length <= 20 && new Set(l.operations).size === l.operations.length
    && l.operations.every((o) => typeof o === "string" && o.length <= 64 && OPERATION.test(o));
}

/** Whether a value is one session budget, exactly as the schema says (closed: an unknown key makes it invalid). */
export function validSessionBudget(b: unknown): b is SessionBudget {
  return isObject(b) && Object.keys(b).every((k) => BUDGET_KEYS.has(k))
    && typeof b.budget_id === "string" && BUDGET_ID.test(b.budget_id) && b.scope === "session"
    && typeof b.session_id === "string" && b.session_id.length >= 1 && b.session_id.length <= 200
    && Array.isArray(b.limits) && b.limits.length >= 1 && b.limits.length <= 10 && b.limits.every(validLimit)
    && (b.mode === "enforce" || b.mode === "monitor") && intIn(b.version, 1, 2_147_483_647)
    && typeof b.expires_at === "string" && Number.isFinite(Date.parse(b.expires_at))
    && (b.source === undefined || b.source === "request" || b.source === "admin")
    && (b.count_shell_as_write === undefined || typeof b.count_shell_as_write === "boolean");
}

/** Whether a rules document's `session_budgets` is a valid list (at most 50, each valid, budget ids unique). */
export function validSessionBudgets(list: unknown): list is SessionBudget[] {
  return Array.isArray(list) && list.length <= 50 && list.every(validSessionBudget) && new Set(list.map((b) => b.budget_id)).size === list.length;
}

