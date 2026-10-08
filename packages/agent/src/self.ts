// Where this agent's own program is: Node running this package's cli.js when installed from npm, or the single executable
// (one signed file that is both the agent and the hook). Read when needed, never at load: in the single executable there
// is no cli.js to find.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isSingleExecutable } from "@scopebond/hook";

/** The file autostart and a handover start: this package's cli.js, or the single executable itself. */
export function agentCliPath(): string {
  return isSingleExecutable() ? process.execPath : realpathSync(fileURLToPath(new URL("./cli.js", import.meta.url)));
}

/** The program and arguments that run this agent's command line with `args`, in either build. */
export function agentSelfCommand(args: readonly string[]): [string, string[]] {
  return isSingleExecutable() ? [process.execPath, [...args]] : [process.execPath, ["--disable-warning=ExperimentalWarning", agentCliPath(), ...args]];
}
