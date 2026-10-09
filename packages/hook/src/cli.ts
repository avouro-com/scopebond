#!/usr/bin/env node
// scopebond-hook — govern a coding agent's tool calls against policy, in-path,
// before they run, with a signed local receipt. This is the program npm installs and agent
// settings name (`.../dist/cli.js claude`); the commands themselves are in cli-main.ts.

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

// Fail closed outside the commands too. Claude Code, Codex and Cursor all treat a hook that crashes (a module that cannot
// load, an uncaught error, a non-zero exit other than Claude Code's 2) as a non-blocking error and run the action with no
// check. Every failure the commands do not answer themselves is answered here with each agent's own "deny".
function failClosed(error: unknown): never {
  const reason = `Scopebond hook failed closed: ${(error as Error | null)?.message ?? String(error)}. Repair: reinstall the Scopebond hook, then run its doctor command.`;
  const command = process.argv[2];
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
process.on("uncaughtException", failClosed);
process.on("unhandledRejection", failClosed);

try {
  const { main } = await import("./cli-main.js");
  await main(process.argv.slice(2));
} catch (error) {
  failClosed(error);
}
