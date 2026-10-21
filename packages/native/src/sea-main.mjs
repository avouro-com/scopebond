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
    // A newer engine the agent staged and checked (engine-shim.ts): run it when it verifies against the updater keys this
    // executable carries and starts; otherwise the engine inside this file (the baseline) runs, and a start failure is
    // recorded. The bundle arms its own deadline and fail-closed answer.
    let engine = null;
    const { engineToRun, engineKeysFrom, recordEngineStartFailure, engineHome, ENGINE_CANDIDATE_ENV } = await import("../../hook/dist/engine-shim.js");
    try {
      engine = engineToRun({ keys: engineKeysFrom(typeof __SCOPEBOND_UPDATER_KEYS__ === "string" ? __SCOPEBOND_UPDATER_KEYS__ : undefined), baselineVersion: __SCOPEBOND_HOOK_VERSION__ });
    } catch (error) {
      // Only a candidate (an update being checked) throws: that check fails, it never passes on the baseline.
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(3);
    }
    if (engine) {
      try { await engine.run(args.slice(1)); return; }
      catch (error) {
        if (process.env[ENGINE_CANDIDATE_ENV]) { console.error(error instanceof Error ? error.message : String(error)); process.exit(3); }
        recordEngineStartFailure(engineHome(), engine.version, error);
      }
    }
    // As `cli.js` does: any failure the commands do not answer, and a call that has not decided shortly before the coding
    // agent's own time limit, answer with that agent's deny.
    const { armHookDeadline, failClosed } = await import("../../hook/dist/hook-deadline.js");
    const fail = (error) => failClosed(error, args[1]);
    process.on("uncaughtException", fail);
    process.on("unhandledRejection", fail);
    const disarm = armHookDeadline(args[1]);
    try {
      const { main } = await import("../../hook/dist/cli-main.js");
      await main(args.slice(1));
    } catch (error) { fail(error); }
    disarm();
    return;
  }
  const { main } = await import("../../agent/dist/cli-main.js");
  await main(args);
})().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
