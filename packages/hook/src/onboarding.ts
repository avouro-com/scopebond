import type { Harness } from "./install.js";
import { isSingleExecutable } from "./self.js";
import { agentCommand, npmGlobalInstall } from "./windows-hints.js";

/** Human setup output only; never called on the per-action hook path. */
export function onboardingSteps(options: {
  harness: Harness;
  command: (args: string) => string;
  connected?: boolean;
  project?: boolean;
  /** The Scopebond Agent already runs for this user: nothing to suggest installing. */
  agentRunning?: boolean;
  /** Running as the signed installer's single executable, which is the Scopebond Agent too: nothing to install from npm.
   *  Defaults to whether this process is that executable. */
  native?: boolean;
  platform?: NodeJS.Platform;
}): string[] {
  const platform = options.platform ?? process.platform;
  const native = options.native ?? isSingleExecutable();
  const lines: string[] = [];
  if (!options.connected) {
    const flag = options.harness === "claude" ? "" : ` --${options.harness}`;
    lines.push(
      "See activity, rules and signed records in your Scopebond workspace.",
      "Start free with one agent: https://cloud.scopebond.com/app",
      "Create the workspace, add your agent, then connect this computer from your own terminal:",
      `  ${options.command(`login https://cloud.scopebond.com${flag}${options.project ? " --project" : ""}`)}`,
    );
  }
  if (options.agentRunning) {
    lines.push("The Scopebond Agent runs here: records send and Scopebond stays up to date without a coding agent open.");
    return lines;
  }
  if (native) {
    // The installer's program is the Scopebond Agent already: it only needs to start with Windows.
    lines.push(
      "Keep this computer connected with the Scopebond Agent (already installed; optional):",
      `  ${agentCommand("autostart on", platform, true)}`,
      "It sends waiting records and refreshes the connection and rules. The hook keeps deciding actions without it.",
      "Nothing extra is started by this prompt; run that command when ready.",
    );
    return lines;
  }
  lines.push(
    "Keep this computer connected with the Scopebond Agent (optional):",
    "  https://scopebond.com/get-started#desktop-agent",
    `  ${npmGlobalInstall("@scopebond/agent", platform)}`,
    `  ${agentCommand("autostart on", platform, false)}`,
    "It sends waiting records and refreshes the connection and rules. The hook keeps deciding actions without it.",
    "Nothing extra is installed or started by this prompt; run those commands when ready.",
  );
  return lines;
}
