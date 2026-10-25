#!/usr/bin/env node
// scopebond-hook — govern a coding agent's tool calls against policy, in-path,
// before they run, with a signed local receipt. This is the program npm installs and agent
// settings name (`.../dist/cli.js claude`); the commands themselves are in cli-main.ts.

import { existsSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
    // Written out here, not imported: this handler must work with nothing else loaded (the file runs alone). It is the
    // same deny copilotAnswer("deny", …) gives (copilot-answer.ts), in both shapes Copilot's surfaces read; a test holds
    // the two equal.
    if (command === "copilot") {
      const permission = { permissionDecision: "deny", permissionDecisionReason: reason };
      writeNow(1, JSON.stringify({ ...permission, hookSpecificOutput: { hookEventName: "PreToolUse", ...permission } }) + "\n");
      writeNow(2, `${reason.startsWith("Scopebond") ? reason : `Scopebond: ${reason}`}\n`);
      process.exit(2);
    }
    writeNow(2, `${reason}\n`);
  } catch { /* nothing left to report with */ }
  process.exit(command === "claude" || command === "copilot" ? 2 : 1);
}
process.on("uncaughtException", failClosed);
process.on("unhandledRejection", failClosed);

// A hook call keeps Node's compiled code for the commands, so the next call skips compiling them (about 15 ms of every
// tool call). Only on the hook calls: setup and uninstall gain nothing from it. The cache sits beside this package, never in
// a shared temporary folder: whoever can change it could change what runs, and next to the program that is no one who
// could not already change the program itself (the pinned copy lives under the Scopebond home the floor protects). Where
// the package's folder is read-only Node keeps no cache and says nothing; NODE_DISABLE_COMPILE_CACHE=1 turns it off.
// Taken from the built-ins rather than imported: a Node without it must still reach the fail-closed answer above.
const HOOK_CALLS = ["claude", "codex", "cursor", "copilot"];
if (HOOK_CALLS.includes(process.argv[2] ?? "")) {
  try {
    // The package's own folder (dist/..), and only when it is one: a cli.js copied somewhere alone keeps no cache.
    if (existsSync(new URL("../package.json", import.meta.url))) {
      const nodeModule = process.getBuiltinModule?.("node:module") as { enableCompileCache?: (dir: string) => unknown } | undefined;
      nodeModule?.enableCompileCache?.(fileURLToPath(new URL("../.compile-cache", import.meta.url)));
    }
  } catch { /* no cache: the call is only slower */ }
}

try {
  // The package build bundles hook-deadline.js and cli-main.js, with everything they load, into one file and points these
  // two imports at it (scripts/bundle-cli.mjs): one file to read instead of about a hundred. A plain tsc build loads them
  // as they are.
  // A hook call that has not decided shortly before the coding agent's own time limit denies (hook-deadline.ts).
  const { armHookDeadline } = await import("./hook-deadline.js");
  const disarm = armHookDeadline(process.argv[2]);
  const { main } = await import("./cli-main.js");
  await main(process.argv.slice(2));
  disarm();
} catch (error) {
  failClosed(error);
}
