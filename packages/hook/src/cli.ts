#!/usr/bin/env node
// scopebond-hook — govern a coding agent's tool calls against policy, in-path,
// before they run, with a signed local receipt. This is the program npm installs and agent
// settings name (`.../dist/cli.js claude`); the commands themselves are in cli-main.ts.

import { writeSync } from "node:fs";
import { copilotAnswer } from "./copilot-answer.js";

// `node:sqlite` (the receipt store) is still flagged experimental on Node 22, and Node
// prints a warning on stderr the first time it loads — on every `verify`, and into the
// agent's transcript on every hook call. It is a notice about Node, not about the user's
// setup, so it is dropped; every other warning still prints through Node's own handler.
// (The commands load after this filter is in place, and the store loads later still.)
{
  const nodeWarningHandlers = process.listeners("warning");
  process.removeAllListeners("warning");
  process.on("warning", (warning) => {
    if (warning.name === "ExperimentalWarning" && /sqlite/i.test(warning.message)) return;
    for (const handler of nodeWarningHandlers) handler.call(process, warning);
  });
}

// Fail closed outside the commands too. Claude Code, Codex, Cursor and GitHub Copilot all treat a hook that crashes (a
// module that cannot load, an uncaught error, a non-zero exit other than their own deny code) as a non-blocking error and
// run the action with no check. Every failure the commands do not answer themselves is answered here with each agent's
// own "deny". This answer stays in this file, with no import: it must work when nothing beside cli.js can load. (The
// deadline and the single executable use the same answer from hook-deadline.ts.)
function writeNow(fd: 1 | 2, text: string): void {
  // Written before exit: a pipe is asynchronous on macOS, so a plain stream write could be cut off by the exit.
  try { writeSync(fd, text); } catch { (fd === 1 ? process.stdout : process.stderr).write(text); }
}
function failClosed(error: unknown): never {
  const reason = `Scopebond hook failed closed: ${(error as Error | null)?.message ?? String(error)}. Repair: reinstall the Scopebond hook, then run its doctor command.`;
  const command = process.argv[2];
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
      const answer = copilotAnswer("deny", reason, false);
      writeNow(1, answer.stdout);
      writeNow(2, answer.stderr);
      process.exit(answer.exitCode);
    }
    writeNow(2, `${reason}\n`);
  } catch { /* nothing left to report with */ }
  process.exit(command === "claude" || command === "copilot" ? 2 : 1);
}
process.on("uncaughtException", failClosed);
process.on("unhandledRejection", failClosed);

try {
  // A hook call that has not decided shortly before the coding agent's own time limit denies (hook-deadline.ts).
  const { armHookDeadline } = await import("./hook-deadline.js");
  const disarm = armHookDeadline(process.argv[2]);
  const { main } = await import("./cli-main.js");
  await main(process.argv.slice(2));
  disarm();
} catch (error) {
  failClosed(error);
}
