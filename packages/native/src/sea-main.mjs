// The single executable's entry: one signed file that is the Scopebond Agent (`scopebond-agent.exe run`, `status`, …)
// and, with `hook` first, the hook a coding agent runs for each tool call (`scopebond-agent.exe hook claude`).
//
// It is bundled into one CommonJS file (build-sea.mjs), so the commands are loaded with `import()`, which the bundler turns
// into code already inside the file: the hook path never runs the agent's module code, and the other way round.

// Node's SQLite is still flagged experimental on Node 22 and says so on stderr the first time it loads, which would land
// in the coding agent's transcript on every hook call. Only that notice is dropped.
{
  const nodeWarningHandlers = process.listeners("warning");
  process.removeAllListeners("warning");
  process.on("warning", (warning) => {
    if (warning.name === "ExperimentalWarning" && /sqlite/i.test(warning.message)) return;
    for (const handler of nodeWarningHandlers) handler.call(process, warning);
  });
}

void (async () => {
  // As with `node cli.js <command>`: the program, then one slot the commands skip, then the command. The hook reads
  // process.argv itself (`--strict`, the event name), so `hook` is taken out to keep those positions the same.
  const args = process.argv.slice(2);
  if (args[0] === "hook") {
    process.argv.splice(2, 1);
    const { main } = await import("../../hook/dist/cli-main.js");
    await main(args.slice(1));
    return;
  }
  const { main } = await import("../../agent/dist/cli-main.js");
  await main(args);
})().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
