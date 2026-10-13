// The decision deadline. A coding agent that waits past its own hook time limit treats the hook as a non-blocking error
// and runs the action with no check: Claude Code after 60 seconds by default, Codex after the 30 seconds the entry Scopebond
// writes says, GitHub Copilot after the 60 seconds (`timeoutSec`) its installed entry says. So a hook call that has not
// decided shortly before that limit answers "deny" itself: a slow workspace, a stalled delivery or a person who never
// answers in the Scopebond window ends as a block, never as an unchecked action. (The Copilot entry also checks its own
// deadline before evaluating, in cli-main.ts; this one also covers a stall after that point.)
//
// The waits the hook takes on purpose fit inside it. The person's answer in the Scopebond window waits at most 45 s for
// Claude Code, 25 s for GitHub Copilot and 20 s for Codex and Cursor, and never longer than what is left of the deadline
// after `WAIT_RESERVE_MS` (`waitWithinDeadline`). The local log's lock wait on a hook call is capped at
// `HOT_PATH_STORE_BUSY_MS` (5 s after the person answered), the delivery queue's at 2 s.
//
// Residual risk: a wait inside a synchronous call (a SQLite lock wait) cannot be interrupted by a timer. Each is bounded
// by its own cap, and the deny follows the moment it returns; but several such waits in one call (opening the log, then
// writing it) can still add up past the agent's own limit on a computer where another process holds the log's lock for
// that long. The agent then treats the call as timed out.
//
// `SCOPEBOND_HOOK_DEADLINE_MS` can only shorten the deadline (tests use it to prove the deny); it can never lengthen it.

import { writeSync } from "node:fs";

export const HOOK_DEADLINE_MS: Readonly<Record<string, number>> = { claude: 55_000, codex: 28_000, cursor: 28_000, copilot: 45_000 };
export const HOOK_DEADLINE_ENV = "SCOPEBOND_HOOK_DEADLINE_MS";
/** How long the local log may wait for another process's lock on a hook call (instead of the 15 s other commands wait). */
export const HOT_PATH_STORE_BUSY_MS = 8_000;
/** What a hook call keeps back from its deadline when it asks a person: the log's lock wait after the answer (5 s), the
 *  delivery queue's (2 s), the window's own grace (2 s) and a second to write the answer. */
export const WAIT_RESERVE_MS = 10_000;

let deadlineAt: number | null = null;

/** The deadline for a hook command, or null when the command is not a hook call. */
export function hookDeadlineMs(command: string | undefined, env: NodeJS.ProcessEnv = process.env): number | null {
  const limit = command !== undefined && Object.prototype.hasOwnProperty.call(HOOK_DEADLINE_MS, command) ? HOOK_DEADLINE_MS[command] : null;
  if (limit === null) return null;
  const asked = Number(env[HOOK_DEADLINE_ENV]);
  return Number.isFinite(asked) && asked > 0 ? Math.min(asked, limit) : limit;
}

/** How long this hook call has left before its deadline; Infinity when none is armed (a library caller, a test). */
export function hookDeadlineRemainingMs(now = Date.now()): number {
  return deadlineAt === null ? Infinity : Math.max(0, deadlineAt - now);
}

/** The person's wait in the Scopebond window: `preferredMs`, or less when the deadline is nearer (at least a second, so a
 *  late call still shows the window rather than skipping the question; the deadline then denies). */
export function waitWithinDeadline(preferredMs: number, now = Date.now()): number {
  return Math.max(1_000, Math.min(preferredMs, hookDeadlineRemainingMs(now) - WAIT_RESERVE_MS));
}

/** Write to a standard stream and return only once it is written: a pipe is asynchronous on macOS, and the process exits
 *  right after. Falls back to the stream when the descriptor cannot take a synchronous write. */
function writeNow(fd: 1 | 2, text: string): void {
  try { writeSync(fd, text); } catch { (fd === 1 ? process.stdout : process.stderr).write(text); }
}

/** Each agent's "deny" for a hook call that cannot decide (a crash, a missed deadline), then exit. The one fail-closed
 *  answer: cli.js, the single executable and the deadline all use it. */
export function denyHookCall(command: string | undefined, reason: string): never {
  try {
    if (command === "claude" || command === "codex") {
      writeNow(1, JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }) + "\n");
      if (command === "claude") writeNow(2, `${reason}\n`);
      process.exit(command === "claude" ? 2 : 0);
    }
    if (command === "cursor") {
      writeNow(1, JSON.stringify({ permission: "deny", agentMessage: reason }) + "\n");
      process.exit(0);
    }
    // GitHub Copilot denies on exit 2 whatever stdout holds; the JSON carries the reason.
    if (command === "copilot") {
      writeNow(1, JSON.stringify({ permissionDecision: "deny", permissionDecisionReason: reason }) + "\n");
      writeNow(2, `${reason}\n`);
      process.exit(2);
    }
    writeNow(2, `${reason}\n`);
  } catch { /* nothing left to report with */ }
  process.exit(command === "claude" || command === "copilot" ? 2 : 1);
}

/** The deny for a failure no command answered itself (a module that cannot load, an uncaught error). */
export function failClosed(error: unknown, command: string | undefined = process.argv[2]): never {
  denyHookCall(command, `Scopebond hook failed closed: ${(error as Error | null)?.message ?? String(error)}. Repair: reinstall the Scopebond hook, then run its doctor command.`);
}

/** Start the deadline for this hook call; returns the function that stops it. Every decision exits the process as soon as
 *  it is written, so the deny never follows a decision already given; a command that returns instead stops the deadline.
 *  The timer keeps the process alive on purpose: a call whose work stalls with nothing left to wait on would otherwise end
 *  with no answer at all, which the coding agent reads as "run it". */
export function armHookDeadline(command: string | undefined = process.argv[2], env: NodeJS.ProcessEnv = process.env): () => void {
  const ms = hookDeadlineMs(command, env);
  if (ms === null) return () => {};
  deadlineAt = Date.now() + ms;
  const timer = setTimeout(() => denyHookCall(command,
    `Scopebond hook failed closed: no decision within ${ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} s`}, so this action is blocked rather than run unchecked. Run it again; if it keeps happening, run the Scopebond doctor command.`), ms);
  return () => { clearTimeout(timer); deadlineAt = null; };
}
