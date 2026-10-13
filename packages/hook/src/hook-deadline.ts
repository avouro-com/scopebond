// The decision deadline. A coding agent that waits past its own hook time limit treats the hook as a non-blocking error
// and runs the action with no check: Claude Code after 60 seconds by default, Codex after the 30 seconds the entry Scopebond
// writes says. So a hook call that has not decided shortly before that limit answers "deny" itself: a slow workspace, a
// stalled delivery or a person who never answers in the Scopebond window ends as a block, never as an unchecked action.
//
// The deadline leaves room for every wait the hook takes on purpose (the person's answer in the window, 45 s for Claude
// Code and 20 s for Codex and Cursor, then the local log's lock wait). A wait inside a synchronous call (the local log's
// lock wait) cannot be interrupted; it is bounded by its own limit, and the deny follows the moment it returns.
//
// `SCOPEBOND_HOOK_DEADLINE_MS` can only shorten the deadline (tests use it to prove the deny); it can never lengthen it.

export const HOOK_DEADLINE_MS: Readonly<Record<string, number>> = { claude: 55_000, codex: 28_000, cursor: 28_000 };
export const HOOK_DEADLINE_ENV = "SCOPEBOND_HOOK_DEADLINE_MS";

/** The deadline for a hook command, or null when the command is not a hook call. */
export function hookDeadlineMs(command: string | undefined, env: NodeJS.ProcessEnv = process.env): number | null {
  const limit = command !== undefined && Object.prototype.hasOwnProperty.call(HOOK_DEADLINE_MS, command) ? HOOK_DEADLINE_MS[command] : null;
  if (limit === null) return null;
  const asked = Number(env[HOOK_DEADLINE_ENV]);
  return Number.isFinite(asked) && asked > 0 ? Math.min(asked, limit) : limit;
}

/** Each agent's "deny" for a hook call that cannot decide, then exit. */
export function denyHookCall(command: string | undefined, reason: string): never {
  try {
    if (command === "claude" || command === "codex") {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }) + "\n");
      if (command === "claude") process.stderr.write(`${reason}\n`);
      process.exit(command === "claude" ? 2 : 0);
    }
    if (command === "cursor") {
      process.stdout.write(JSON.stringify({ permission: "deny", agentMessage: reason }) + "\n");
      process.exit(0);
    }
    process.stderr.write(`${reason}\n`);
  } catch { /* nothing left to report with */ }
  process.exit(command === "claude" ? 2 : 1);
}

/** Start the deadline for this hook call; returns the function that stops it. Every decision exits the process as soon as
 *  it is written, so the deny never follows a decision already given; a command that returns instead stops the deadline.
 *  The timer keeps the process alive on purpose: a call whose work stalls with nothing left to wait on would otherwise end
 *  with no answer at all, which the coding agent reads as "run it". */
export function armHookDeadline(command: string | undefined = process.argv[2], env: NodeJS.ProcessEnv = process.env): () => void {
  const ms = hookDeadlineMs(command, env);
  if (ms === null) return () => {};
  const timer = setTimeout(() => denyHookCall(command,
    `Scopebond hook failed closed: no decision within ${ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} s`}, so this action is blocked rather than run unchecked. Run it again; if it keeps happening, run the Scopebond doctor command.`), ms);
  return () => clearTimeout(timer);
}
