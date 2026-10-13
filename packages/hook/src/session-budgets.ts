// Session budgets: what one coding-agent session may do, at most. A workspace may send, in its rules document, budgets for
// named sessions (`session_budgets`): for example at most 50 file writes, no pushes and no package installs, until the budget
// expires (two hours after it was set, unless the workspace says otherwise). An admin sets one for a session, or approves one
// from a person's "Ask an admin" request. The words are the gateway's action-budget words (budget_id, operations, max, mode,
// version, expires_at); the scope is one session, named by the same keyed opaque id the receipts carry as `context.session_id`.
//
// The hook counts here, per session, before an action runs. It counts tool calls, not files: a tool call counts once for a limit
// when any of its actions is one of that limit's action types (one Write is one file write; a shell command that writes ten
// files is one shell command), and a retry of the same tool call is not counted twice. A shell command that installs packages
// counts as `package.install`; a push in a shell command is its own `git.push`. With `count_shell_as_write`, any other shell
// command also counts as a file write (off by default). Under `enforce`, a tool call beyond a limit is denied with the reason
// "session budget", and the session may not start another coding agent (whose actions it would not count; a person can still
// start a new session); under `monitor` it is recorded as over and allowed. An action reported only after it ran (Cursor's
// after-edit event) is counted but never refused. A budget applies until it expires; then it ends and the rules alone decide
// again. Every receipt a budget counted or refused carries `payload.budget`.
//
// Fail closed: when a session has a budget and its count cannot be read or written (a damaged or unreadable count file, a lock
// that cannot be taken), a limited action is denied, never let through as if there were no limit. A tool call a rule denies
// gives its count back.
//
// File in the Scopebond home (the coding agent cannot write there; the hook refuses any write there):
//   session-budgets.json  the counts: per session, per limit, and the last tool calls counted (bounded, written atomically)

import { closeSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ReceiptBudget } from "@scopebond/gateway";
import { MANAGED_DOC_FILE, writeAtomic } from "./managed.js";
import { loadOrCreateBindingKey } from "./observation.js";
import { validSessionBudget, type SessionBudget, type SessionBudgetLimit } from "./session-budget-shape.js";

export { validSessionBudget, validSessionBudgets, type SessionBudget, type SessionBudgetLimit } from "./session-budget-shape.js";

export const SESSION_BUDGETS_FILE = "session-budgets.json";
const LOCK_FILE = "session-budgets.lock";
const MAX_SESSIONS = 200;
const MAX_GROUPS = 50;
const KEEP_MS = 2 * 24 * 60 * 60 * 1000;
const LOCK_WAIT_MS = 1_500;
const LOCK_STALE_MS = 30_000;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const intIn = (v: unknown, min: number, max: number): boolean => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

/** The keyed opaque id of the harness's session (the same id receipts carry as `context.session_id`), or null when the hook
 *  input names no session. Throws when the key cannot be read or made. */
export function keyedSessionId(dir: string, input: Record<string, unknown>): string | null {
  const raw = input.session_id;
  return typeof raw === "string" && raw !== "" ? loadOrCreateBindingKey(dir).sessionId(raw) : null;
}

/** The budgets the workspace's rules document holds (the document was checked when it was installed). */
export function readSessionBudgets(dir: string): SessionBudget[] {
  try {
    const doc = JSON.parse(readFileSync(join(dir, MANAGED_DOC_FILE), "utf8")) as { session_budgets?: unknown };
    return Array.isArray(doc.session_budgets) ? doc.session_budgets.filter(validSessionBudget) : [];
  } catch { return []; }
}

interface SessionCounts { updated_at: number; counts: Record<string, number>; groups: string[]; keep_until?: number }
interface CountFile { version: 1; sessions: Record<string, SessionCounts> }

/** A limit's count key: the budget and its action types (a new version of the budget keeps what the session already did). */
const countKey = (budget: SessionBudget, limit: SessionBudgetLimit): string => `${budget.budget_id}|${[...limit.operations].sort().join(",")}`;

class CountUnavailable extends Error {}

function readCounts(dir: string): CountFile {
  let text: string;
  try { text = readFileSync(join(dir, SESSION_BUDGETS_FILE), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, sessions: {} };
    throw new CountUnavailable(`the count file could not be read (${(error as NodeJS.ErrnoException).code ?? "error"})`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new CountUnavailable("the count file is damaged"); }
  if (!isObject(parsed) || parsed.version !== 1 || !isObject(parsed.sessions)) throw new CountUnavailable("the count file is damaged");
  for (const s of Object.values(parsed.sessions)) {
    if (!isObject(s) || !Number.isFinite(s.updated_at) || !isObject(s.counts) || !Array.isArray(s.groups) || (s.keep_until !== undefined && !Number.isFinite(s.keep_until))
      || !Object.values(s.counts).every((n) => intIn(n, 0, 1_000_001))) throw new CountUnavailable("the count file is damaged");
  }
  return parsed as unknown as CountFile;
}

function writeCounts(dir: string, file: CountFile, now: number): void {
  // Bounded: a session's counts are kept a day past its last budget's expiry (and at least two days after its last count), then
  // dropped; then the most recent 200 are kept.
  const kept = Object.entries(file.sessions).filter(([, s]) => now - s.updated_at < KEEP_MS || now < (s.keep_until ?? 0))
    .sort((a, b) => b[1].updated_at - a[1].updated_at).slice(0, MAX_SESSIONS);
  writeAtomic(join(dir, SESSION_BUDGETS_FILE), `${JSON.stringify({ version: 1, sessions: Object.fromEntries(kept) })}\n`);
}

/** Run `fn` holding the count lock (an exclusive lock file; one left behind by a process that died is taken over after 30 s). */
function withLock<T>(dir: string, fn: () => T, wait = LOCK_WAIT_MS): T {
  const path = join(dir, LOCK_FILE);
  const until = Date.now() + wait;
  let fd: number | null = null;
  while (fd === null) {
    try { fd = openSync(path, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new CountUnavailable(`the count lock could not be taken (${(error as NodeJS.ErrnoException).code ?? "error"})`);
      try { if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) { rmSync(path, { force: true }); continue; } } catch { continue; }
      if (Date.now() > until) throw new CountUnavailable("another Scopebond check held the count lock too long");
      const pause = Date.now() + 15;
      while (Date.now() < pause) { /* a short wait: the hook is a short-lived process with nothing else to do */ }
    }
  }
  try { return fn(); }
  finally { try { closeSync(fd); } catch { /* closed */ } try { rmSync(path, { force: true }); } catch { /* left for the stale check */ } }
}

/** One action of a tool call, as the runtime evaluates it. */
export interface BudgetIntent { action_type: string; params: Record<string, unknown> }

export type BudgetReservation =
  | { allow: true; budgetFor(intent: BudgetIntent): ReceiptBudget | undefined; release(): void }
  | { allow: false; index: number; budget: ReceiptBudget; reason: string };

export interface SessionBudgetGuard {
  /** Count one tool call (its group id and its actions) against this session's budgets, before it runs. `postHoc`: the call
   *  already happened (Cursor's after-edit event), so it is counted but never refused; later calls are refused once over. */
  reserve(group: string, intents: readonly BudgetIntent[], options?: { postHoc?: boolean }): BudgetReservation;
}

const VERB: Record<string, string> = {
  "file.write": "write files", "git.push": "push", "package.install": "install packages", "shell.exec": "run commands",
  "net.fetch": "fetch from the web", "mcp.tool.call": "call MCP tools", "file.read": "read files",
};
const times = (n: number): string => (n === 0 ? "no times" : n === 1 ? "once" : `${n} times`);
const AGENT_LAUNCH_REASON = "Scopebond blocked this: session budget: starting another coding agent is not allowed in a budgeted session. A person can still start a new session.";

// --- what a shell command does, for counting -----------------------------------------------------------------------------------
// A shell command is one `shell.exec` action with its program and command text. Package installs come only from shell commands
// (the typed records of an install are observations, not actions), so they are recognised here; a push in a shell command is
// already its own `git.push` action. Recognised broadly on purpose: an install the hook would not otherwise name (a bare
// `npm install`, `pip install -r requirements.txt`, `npm ci`) still counts.

const programOf = (params: Record<string, unknown>): string => {
  const program = typeof params.program === "string" ? params.program : "";
  return (program.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, "");
};
/** The command's words after the program, without the keyed digest the hook appends to the text. */
const argsOf = (params: Record<string, unknown>): string[] => {
  const command = typeof params.command === "string" ? params.command.replace(/ ?\(hmac-sha256:[0-9a-f]{64}\)/g, "") : "";
  return command.trim().split(/\s+/).slice(1).filter((w) => !w.startsWith("-"));
};
const JS_INSTALL = new Set(["install", "i", "ci", "add", "update", "up", "upgrade"]);

/** Whether a shell command installs packages (npm, pnpm, yarn, bun, pip, uv, poetry, pipx, cargo, gem, go). */
export function isPackageInstall(intent: BudgetIntent): boolean {
  if (intent.action_type !== "shell.exec") return false;
  const program = programOf(intent.params);
  const [a, b] = argsOf(intent.params);
  if (["npm", "pnpm", "yarn", "bun"].includes(program)) return program === "yarn" && a === undefined ? true : a !== undefined && JS_INSTALL.has(a);
  const unversioned = program.replace(/[\d.]+$/, ""); // pip3, pip3.12, python3.11
  if (unversioned === "pip" || program === "pipx") return a === "install";
  if (unversioned === "python" || program === "py") return a === "pip" && b === "install";
  if (program === "uv") return a === "add" || a === "sync" || (a === "pip" && b === "install") || (a === "tool" && b === "install");
  if (program === "poetry") return a === "add" || a === "install";
  if (program === "cargo" || program === "gem") return a === "install" || a === "add";
  if (program === "go") return a === "get" || a === "install";
  return false;
}

const AGENT_PROGRAMS = new Set(["claude", "codex", "cursor-agent", "copilot", "gemini", "aider", "opencode"]);
const AGENT_PACKAGES = /(^|\/)(claude-code|codex|copilot|cursor-agent|gemini-cli)(@|$)/;
/** Whether a shell command starts another coding agent (Claude Code, Codex, Cursor's agent, GitHub Copilot and the like). */
export function isAgentLaunch(intent: BudgetIntent): boolean {
  if (intent.action_type !== "shell.exec") return false;
  const program = programOf(intent.params);
  const args = argsOf(intent.params);
  if (AGENT_PROGRAMS.has(program)) return true;
  if (program === "gh") return args[0] === "copilot";
  if (["npx", "bunx", "pnpx"].includes(program) || (["pnpm", "yarn"].includes(program) && args[0] === "dlx")) return args.some((w) => AGENT_PACKAGES.test(w));
  return false;
}

/** The action types one action counts as under a budget: its own type, `package.install` for an install, and `file.write` for
 *  any other shell command when the budget says so (`count_shell_as_write`). */
function typesOf(intent: BudgetIntent, budget: SessionBudget): string[] {
  const types = [intent.action_type];
  if (isPackageInstall(intent)) types.push("package.install");
  else if (budget.count_shell_as_write === true && intent.action_type === "shell.exec") types.push("file.write");
  return types;
}

function denialReason(budget: SessionBudget | null, operation: string, state: ReceiptBudget["state"], max: number, used: number, detail?: string): string {
  const what = VERB[operation] ?? `run ${operation}`;
  const who = budget?.source === "request" ? "approved by an admin for this session" : "set by your workspace for this session";
  if (state === "unavailable") return `Scopebond blocked this: session budget. Scopebond could not check this session's count (${detail ?? "unavailable"}), so it blocks what the budget limits rather than run without a limit. Run \`scopebond doctor\`, or ask an admin to lift the budget.`;
  return `Scopebond blocked this: session budget. This session may ${what} ${times(max)} (${who}; ${used} used). Ask an admin to raise it.`;
}

const live = (budgets: SessionBudget[], t: number): SessionBudget[] => budgets.filter((b) => Date.parse(b.expires_at) > t);
const ALLOW_ALL: BudgetReservation = { allow: true, budgetFor: () => undefined, release: () => {} };
const DAY_MS = 24 * 60 * 60 * 1000;

/** The guard for one session, or null when no budget names it. A budget applies until it expires; then it ends and the rules alone
 *  decide again. `sessionId` null (the hook input names no session) means no budget applies. When the session id could not be
 *  worked out (`sessionId` is an Error) while enforce budgets are in force, every limited action type is refused as unavailable. */
export function sessionBudgetGuard(dir: string, sessionId: string | null | Error, now: () => number = Date.now): SessionBudgetGuard | null {
  const all = readSessionBudgets(dir);
  if (all.length === 0 || sessionId === null) return null;
  if (sessionId instanceof Error) {
    return {
      reserve: (_group, intents, options = {}) => {
        if (options.postHoc) return ALLOW_ALL;
        for (const b of live(all, now()).filter((x) => x.mode === "enforce")) {
          for (const l of b.limits) {
            const index = intents.findIndex((i) => typesOf(i, b).some((t) => l.operations.includes(t)));
            if (index < 0) continue;
            const op = typesOf(intents[index], b).find((t) => l.operations.includes(t))!;
            return { allow: false, index, reason: denialReason(null, op, "unavailable", 0, 0, "this session's id could not be read"),
              budget: { version: 1, scope: "session", budget_id: b.budget_id, budget_version: b.version, mode: b.mode, operation: op, count: 0, max: l.max, state: "unavailable" } };
          }
        }
        return ALLOW_ALL;
      },
    };
  }
  const mine = all.filter((b) => b.session_id === sessionId);
  if (mine.length === 0) return null;
  return {
    reserve(group, intents, options = {}) {
      const t = now();
      const budgets = live(mine, t);
      if (budgets.length === 0) return ALLOW_ALL;
      // While an enforce budget is in force, the session may not start another coding agent (whose actions it would not count).
      const launch = options.postHoc ? -1 : intents.findIndex(isAgentLaunch);
      const enforcing = budgets.find((b) => b.mode === "enforce");
      if (launch >= 0 && enforcing) {
        return { allow: false, index: launch, reason: AGENT_LAUNCH_REASON,
          budget: { version: 1, scope: "session", budget_id: enforcing.budget_id, budget_version: enforcing.version, mode: "enforce", operation: "shell.exec", count: 1, max: 0, state: "over" } };
      }
      const matched = budgets.flatMap((budget) => budget.limits.flatMap((limit) => {
        const index = intents.findIndex((i) => typesOf(i, budget).some((ty) => limit.operations.includes(ty)));
        if (index < 0) return [];
        return [{ budget, limit, index, key: countKey(budget, limit), operation: typesOf(intents[index], budget).find((ty) => limit.operations.includes(ty))! }];
      }));
      if (matched.length === 0) return ALLOW_ALL;
      const keepUntil = Math.max(...budgets.map((b) => Date.parse(b.expires_at))) + DAY_MS;
      const unavailable = (detail: string): BudgetReservation => {
        const m = matched.find((x) => x.budget.mode === "enforce") ?? matched[0];
        const budget: ReceiptBudget = { version: 1, scope: "session", budget_id: m.budget.budget_id, budget_version: m.budget.version, mode: m.budget.mode, operation: m.operation, count: 0, max: m.limit.max, state: "unavailable" };
        // A monitor budget never blocks, not even when its count is unavailable; nor does a call that already happened.
        if (m.budget.mode === "monitor" || options.postHoc) return { allow: true, budgetFor: () => undefined, release: () => {} };
        return { allow: false, index: m.index, budget, reason: denialReason(m.budget, m.operation, "unavailable", m.limit.max, 0, detail) };
      };
      let observations: Array<{ budget: SessionBudget; operations: string[]; receipt: ReceiptBudget }> = [];
      let denial: BudgetReservation | null = null;
      let counted = false;
      try {
        withLock(dir, () => {
          const file = readCounts(dir);
          const session = file.sessions[sessionId] ?? { updated_at: t, counts: {}, groups: [] };
          const repeated = session.groups.includes(group);
          observations = [];
          for (const m of matched) {
            const before = session.counts[m.key] ?? 0;
            const count = repeated ? before : before + 1;
            const state: ReceiptBudget["state"] = count > m.limit.max ? "over" : count === m.limit.max ? "at_limit" : "within";
            const receipt: ReceiptBudget = { version: 1, scope: "session", budget_id: m.budget.budget_id, budget_version: m.budget.version, mode: m.budget.mode, operation: m.operation, count, max: m.limit.max, state };
            if (!denial && !options.postHoc && m.budget.mode === "enforce" && state === "over") {
              denial = { allow: false, index: m.index, budget: receipt, reason: denialReason(m.budget, m.operation, state, m.limit.max, before) };
            }
            observations.push({ budget: m.budget, operations: m.limit.operations, receipt });
          }
          if (denial || repeated) return;
          for (const m of matched) session.counts[m.key] = (session.counts[m.key] ?? 0) + 1;
          session.groups = [...session.groups, group].slice(-MAX_GROUPS);
          session.updated_at = t;
          session.keep_until = Math.max(session.keep_until ?? 0, keepUntil);
          file.sessions[sessionId] = session;
          writeCounts(dir, file, t);
          counted = true;
        });
      } catch (error) {
        return unavailable(error instanceof CountUnavailable ? error.message : `the count could not be written (${(error as Error).name})`);
      }
      const refused = denial as BudgetReservation | null;
      if (refused) return refused;
      const list = observations;
      return {
        allow: true,
        budgetFor: (intent) => list.find((o) => typesOf(intent, o.budget).some((ty) => o.operations.includes(ty)))?.receipt,
        release: () => {
          if (!counted || options.postHoc) return;
          // A tool call a rule denied gives its count back. Best effort: if this fails the session is counted one more
          // than it did, which can only block sooner.
          try {
            withLock(dir, () => {
              const file = readCounts(dir);
              const session = file.sessions[sessionId];
              if (!session) return;
              for (const m of matched) session.counts[m.key] = Math.max(0, (session.counts[m.key] ?? 0) - 1);
              session.groups = session.groups.filter((g) => g !== group);
              writeCounts(dir, file, now());
            });
          } catch { /* counted once more than it did: stricter, never looser */ }
        },
      };
    },
  };
}

/** The guard for the session a hook input names, or null when no budget applies. */
export function sessionBudgetGuardFor(dir: string, input: Record<string, unknown>): SessionBudgetGuard | null {
  if (readSessionBudgets(dir).length === 0) return null;
  let sessionId: string | null | Error;
  try { sessionId = keyedSessionId(dir, input); } catch (error) { sessionId = error instanceof Error ? error : new Error("session id unavailable"); }
  return sessionBudgetGuard(dir, sessionId);
}
