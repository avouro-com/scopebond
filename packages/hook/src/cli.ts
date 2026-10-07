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

const { main } = await import("./cli-main.js");
await main(process.argv.slice(2));
