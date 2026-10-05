// What the CLI tells a person to do next, in the form their system runs. On Windows,
// PowerShell's default script policy blocks the `npx`, `npm` and `scopebond-agent` script
// shims, so every command printed there is the `.cmd` form, which PowerShell and Command
// Prompt both run. Human output only; never on the per-action hook path.

import { cliCommand } from "./version.js";

const isWin = (platform: NodeJS.Platform) => platform === "win32";

/** `scopebond-agent <sub>` as the person types it. */
export function agentCommand(sub: string, platform: NodeJS.Platform = process.platform): string {
  return `${isWin(platform) ? "scopebond-agent.cmd" : "scopebond-agent"} ${sub}`;
}

/** `npm install -g <spec>` as the person types it. */
export function npmGlobalInstall(spec: string, platform: NodeJS.Platform = process.platform): string {
  return `${isWin(platform) ? "npm.cmd" : "npm"} install -g ${spec}`;
}

/** Node is older than 22.13: what to install and how, and what to do when an older Node
 *  still comes first on PATH (common on Windows with an installer plus nvm-windows). */
export function nodeTooOldLines(version: string, platform: NodeJS.Platform = process.platform): string[] {
  const lines = [`Scopebond needs Node.js 22.13 or later; this is Node ${version}.`];
  if (isWin(platform)) {
    lines.push(
      "Install it:  winget install --id OpenJS.NodeJS.LTS -e   (or the installer from https://nodejs.org)",
      "Then open a new PowerShell window and run the command again. If `node --version` still shows",
      "the old version, another Node comes first on PATH: `where.exe node` lists them in order.",
    );
  } else {
    lines.push("Install the current Node.js LTS from https://nodejs.org (or `nvm install --lts`), open a new terminal, and run the command again.");
  }
  return lines;
}

/** The exact command to start a sign-in again (an expired or refused code). */
export function loginAgainCommand(origin: string, flags: string[], platform: NodeJS.Platform = process.platform): string {
  return cliCommand(["login", origin, ...flags].join(" "), platform);
}

/** One line about PowerShell's script policy, from `Get-ExecutionPolicy`, when it blocks the
 *  plain `npx`/`npm` shims. Restricted is the Windows client default; Undefined means it. */
export function executionPolicyAdvice(policy: string, platform: NodeJS.Platform = process.platform): string | null {
  if (!isWin(platform)) return null;
  const p = policy.trim().toLowerCase();
  if (!["restricted", "allsigned", "undefined"].includes(p)) return null;
  return `PowerShell's script policy is ${policy.trim() || "Restricted"}: it blocks plain npx, npm and scopebond-agent, so type npx.cmd, npm.cmd and scopebond-agent.cmd (no policy change is needed).`;
}

/** A PowerShell refusal to run a script shim, explained in one line with the fix. */
export function explainPowerShellError(text: string): string | null {
  if (!/running scripts is disabled on this system|cannot be loaded because|is not digitally signed|PSSecurityException|UnauthorizedAccess/i.test(text)) return null;
  const shim = /\b(npx|npm|scopebond-agent|scopebond)\.ps1\b/i.exec(text)?.[1]?.toLowerCase() ?? "npx";
  return `PowerShell's script policy blocked ${shim}.ps1. Type ${shim}.cmd instead (same command, no policy change needed).`;
}
