#!/usr/bin/env node
// scopebond-hook — govern a coding agent's tool calls against policy, in-path,
// before they run, with a signed local receipt. This is the program npm installs and agent
// settings name (`.../dist/cli.js claude`); the commands themselves are in cli-main.ts.

// Small and dependency-free, so it loads even when the commands cannot.
import { armHookDeadline, failClosed } from "./hook-deadline.js";

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
// run the action with no check. Every failure the commands do not answer themselves is answered with each agent's own
// "deny" (hook-deadline.ts holds the one fail-closed answer, shared with the deadline and the single executable).
const fail = (error: unknown): never => failClosed(error, process.argv[2]);
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);

try {
  // A hook call that has not decided shortly before the coding agent's own time limit denies (hook-deadline.ts).
  const disarm = armHookDeadline(process.argv[2]);
  const { main } = await import("./cli-main.js");
  await main(process.argv.slice(2));
  disarm();
} catch (error) {
  fail(error);
}
