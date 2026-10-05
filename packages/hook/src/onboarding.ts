import type { Harness } from "./install.js";

/** Human setup output only; never called on the per-action hook path. */
export function onboardingSteps(options: {
  harness: Harness;
  command: (args: string) => string;
  connected?: boolean;
  project?: boolean;
}): string[] {
  const windows = process.platform === "win32";
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
  lines.push(
    "Keep this computer connected with the Scopebond Agent (optional):",
    "  https://scopebond.com/get-started#desktop-agent",
    `  ${windows ? "npm.cmd" : "npm"} install -g @scopebond/agent`,
    `  ${windows ? "scopebond-agent.cmd" : "scopebond-agent"} autostart on`,
    "It sends waiting records and refreshes the connection and rules. The hook keeps deciding actions without it.",
    "Nothing extra is installed or started by this prompt; run those commands when ready.",
  );
  return lines;
}
