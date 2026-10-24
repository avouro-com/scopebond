// What a person types to run an agent or hook command, in the words of how this agent was installed. The signed Windows
// installer puts `scopebond-agent` on PATH and carries the hook inside it (`scopebond-agent hook <command>`), so nothing
// it says names npm or npx. An npm install keeps its own forms: `scopebond-agent.cmd` on Windows (PowerShell blocks the
// plain script shim), and the hook through npx at the version this agent carries.

import { hookVersion } from "@scopebond/hook";
import { installKind, type InstallKind } from "./native-update.js";

export interface CommandContext { kind: InstallKind; platform: NodeJS.Platform }

const here = (): CommandContext => ({ kind: installKind(), platform: process.platform });
const native = (c: CommandContext) => c.kind !== "npm";

/** The agent's own program as a person types it. */
export function agentProgram(c: CommandContext = here()): string {
  if (native(c)) return "scopebond-agent";
  return c.platform === "win32" ? "scopebond-agent.cmd" : "scopebond-agent";
}

/** `scopebond-agent <sub>` (on Windows from npm: `scopebond-agent.cmd <sub>`). */
export function agentCli(sub: string, c: CommandContext = here()): string {
  return `${agentProgram(c)} ${sub}`;
}

/** A hook command: `scopebond-agent hook <sub>` in the signed install, `npx -y @scopebond/hook@<version> <sub>` from npm. */
export function hookCli(sub: string, c: CommandContext = here(), version: string = hookVersion()): string {
  if (native(c)) return `scopebond-agent hook ${sub}`;
  return `${c.platform === "win32" ? "npx.cmd" : "npx"} -y @scopebond/hook@${version} ${sub}`;
}

/** The first-time setup command: `scopebond-agent setup <sub>` in the signed install (nothing to download), and through
 *  npx at this version from npm. */
export function setupCli(sub: string, c: CommandContext = here(), version?: string): string {
  if (native(c)) return `scopebond-agent setup ${sub}`;
  return `${c.platform === "win32" ? "npx.cmd" : "npx"} -y @scopebond/agent${version ? `@${version}` : ""} setup ${sub}`;
}

/** The macOS package's removal (packages/native/macos/uninstall.sh), as a person types it. */
export const MAC_PACKAGE_UNINSTALL = `sudo "/Library/Application Support/Scopebond/uninstall.sh"`;

/** The last thing an uninstall says: what happens to the Scopebond folder, and how to remove it when it stays. `kind` is how
 *  the agent was installed: npm names the agent's purge, the signed Windows installer its PURGE=1 option, the macOS
 *  package its removal script's --purge, and null only "delete it" (the Settings entry's script, once npm has removed the
 *  agent; or the executable on a Mac, run from where no package put it). */
export function folderSentence(dir: string, o: { exists: boolean; purged: boolean; kind: InstallKind | null; me: string; platform?: NodeJS.Platform }): string {
  if (!o.exists) return o.purged ? `Your Scopebond folder ${dir} was removed, with its keys and the records not yet sent.` : `No Scopebond folder is left at ${dir}.`;
  const mac = (o.platform ?? process.platform) === "darwin";
  const command = o.kind === "npm" ? `${o.me} uninstall --purge`
    : mac ? (o.kind === "per-machine" ? `${MAC_PACKAGE_UNINSTALL} --purge` : null)
    : o.kind ? "msiexec /x … PURGE=1" : null;
  return `Your Scopebond folder ${dir} stays (keys and records not yet sent). Delete it${command ? `, or run \`${command}\`,` : ""} to remove everything.`;
}

/** npm itself, as a person types it on this platform. */
export function npmProgram(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "npm.cmd" : "npm";
}
