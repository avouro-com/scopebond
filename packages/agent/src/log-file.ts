// The agent's own log. A launcher redirecting the agent's output into the log would hold the file open for as long as
// the agent runs, shared for reading only on Windows, and every child of the agent would inherit that handle. Writing it
// here instead opens the file for each line, shared for reading and writing, so two agents (an old one handing over to
// its update) can both write to it and no handle outlives a line.

import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Where lines go while the log itself cannot be opened: an agent started by an older launcher's agent inherits that
 *  launcher's handle on agent.log, which keeps everyone else from writing it until the computer signs in again. */
export const FALLBACK_LOG = "agent-handover.log";

/** Send everything this process writes to stdout and stderr, and an error that would end it, to `file`. */
export function writeOutputTo(file: string): void {
  const fallback = join(dirname(file), FALLBACK_LOG);
  const append = (data: string | Uint8Array) => {
    try { appendFileSync(file, data); }
    catch { try { appendFileSync(fallback, data); } catch { /* nowhere to write: the line is lost, the agent runs on */ } }
  };
  for (const stream of [process.stdout, process.stderr]) {
    stream.write = ((data: string | Uint8Array, encoding?: unknown, callback?: unknown) => {
      append(data);
      const done = typeof encoding === "function" ? encoding : callback;
      if (typeof done === "function") queueMicrotask(() => (done as () => void)());
      return true;
    });
  }
  // Node prints a fatal error straight to the console, which is nul here: note it in the log, then exit as Node would,
  // so the launcher restarts the agent.
  process.on("uncaughtException", (error) => {
    append(`${new Date().toISOString()} the agent stopped on an error: ${error?.stack ?? String(error)}\n`);
    process.exit(1);
  });
}
