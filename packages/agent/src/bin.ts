#!/usr/bin/env node
// The command people type. Node announces its built-in SQLite (which the hook's record store uses) as experimental on every
// run; that line is noise to a person checking status, so it is dropped here before anything loads. Other warnings print.
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (warning.name === "ExperimentalWarning" && /SQLite/i.test(warning.message)) return;
  process.stderr.write(`${warning.name}: ${warning.message}\n`);
});
void import("./cli.js");
