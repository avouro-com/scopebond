// The engine bundle's entry: the hook as one CommonJS file (hook-bundle.mjs builds it), which the signed install's executable
// loads in place of the engine it carries once the agent has staged and checked it (engine-shim.ts), and which Node runs
// directly as the hook's command line (`node scopebond-hook.cjs packs test --all`).
//
// `run(args)` does what cli.js does: Node's SQLite notice dropped, any failure the commands do not answer and a call that
// has not decided before the coding agent's own limit answered with that agent's deny. Everything is bundled: loading this
// file starts nothing.

import { armHookDeadline, failClosed } from "../../hook/dist/hook-deadline.js";
import { main } from "../../hook/dist/cli-main.js";
import { hookVersion } from "../../hook/dist/version.js";

export const version = hookVersion();

let warningsFiltered = false;
function filterSqliteNotice() {
  if (warningsFiltered) return;
  warningsFiltered = true;
  const nodeWarningHandlers = process.listeners("warning");
  process.removeAllListeners("warning");
  process.on("warning", (warning) => {
    if (warning.name === "ExperimentalWarning" && /sqlite/i.test(warning.message)) return;
    for (const handler of nodeWarningHandlers) handler.call(process, warning);
  });
}

/** Run one hook command line (`claude`, `packs test --all`, ...), as `scopebond-hook <args>` would. */
export async function run(args) {
  filterSqliteNotice();
  const fail = (error) => failClosed(error, args[0]);
  process.on("uncaughtException", fail);
  process.on("unhandledRejection", fail);
  const disarm = armHookDeadline(args[0]);
  try { await main(args); } catch (error) { fail(error); }
  disarm();
}
