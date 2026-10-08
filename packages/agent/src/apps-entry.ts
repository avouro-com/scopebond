// Scopebond in Windows Settings → Apps → Installed apps, for an agent installed with npm. The signed installer has its own
// entry (Windows writes it for the MSI); an npm install had none, so a person looking for Scopebond in Settings did not find
// it. `setup` and `autostart on` write a per-user entry (no administrator rights) whose Uninstall runs a small PowerShell
// script: the agent's own `uninstall` (autostart off, the agent stopped, the hook taken out of the coding agents' settings,
// the workspace told), then `npm uninstall -g @scopebond/agent`. `uninstall` removes the entry. The Scopebond folder (keys,
// the connection, records not yet sent) stays, so installing again is the same computer; `uninstall --purge` deletes it.

import { execFileSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const UNINSTALL_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ScopebondAgent";
export const UNINSTALL_SCRIPT = "uninstall-agent.ps1";
export const DISPLAY_NAME = "Scopebond Agent";
export const PUBLISHER = "Avouro LLC";

/** A PowerShell single-quoted string: only the quote itself needs doubling. */
const psQuote = (text: string) => `'${text.replace(/'/g, "''")}'`;

/** The script the entry's Uninstall runs. Paths reach PowerShell only as quoted data. */
export function uninstallScript(o: { node: string; cli: string; npm: string }): string {
  return `# Scopebond Agent, installed with npm: what Windows Settings -> Apps -> Scopebond Agent -> Uninstall runs.
# The Scopebond folder (keys, connection, records not yet sent) stays; delete it with: scopebond-agent uninstall --purge
$ErrorActionPreference = 'Continue'
Write-Host 'Removing the Scopebond Agent...'
$node = ${psQuote(o.node)}
$cli = ${psQuote(o.cli)}
$npm = ${psQuote(o.npm)}
if (Test-Path -LiteralPath $cli) { & $node --disable-warning=ExperimentalWarning $cli uninstall }
& $npm uninstall -g @scopebond/agent
& reg.exe delete ${psQuote(UNINSTALL_KEY)} /f 2>$null | Out-Null
Write-Host 'The Scopebond Agent is removed.'
Start-Sleep -Seconds 3
`;
}

/** The registry values of the entry: [name, type, data]. */
export function appsEntryValues(o: { version: string; script: string; home: string }): Array<[string, "REG_SZ" | "REG_DWORD", string]> {
  const run = `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${o.script}"`;
  return [
    ["DisplayName", "REG_SZ", DISPLAY_NAME],
    ["DisplayVersion", "REG_SZ", o.version],
    ["Publisher", "REG_SZ", PUBLISHER],
    ["URLInfoAbout", "REG_SZ", "https://scopebond.com"],
    ["InstallLocation", "REG_SZ", o.home],
    ["UninstallString", "REG_SZ", run],
    ["QuietUninstallString", "REG_SZ", `${run.replace("-File", "-WindowStyle Hidden -File")}`],
    ["NoModify", "REG_DWORD", "1"],
    ["NoRepair", "REG_DWORD", "1"],
  ];
}

/** npm beside the Node that runs the agent (where the Node installer puts it), else npm.cmd on PATH. */
export function npmBeside(node: string): string {
  const beside = join(dirname(node), "npm.cmd");
  return existsSync(beside) ? beside : "npm.cmd";
}

/** Write the entry and its script for this user. Windows only; returns a one-line description, or null elsewhere. */
export function writeAppsEntry(home: string, o: { version: string; cli: string; node?: string }, platform = process.platform): string | null {
  if (platform !== "win32") return null;
  const node = o.node ?? process.execPath;
  const script = join(home, UNINSTALL_SCRIPT);
  writeFileSync(script, uninstallScript({ node, cli: o.cli, npm: npmBeside(node) }), "utf8");
  for (const [name, type, data] of appsEntryValues({ version: o.version, script, home })) {
    execFileSync("reg", ["add", UNINSTALL_KEY, "/v", name, "/t", type, "/d", data, "/f"], { stdio: "ignore" });
  }
  return `listed ${DISPLAY_NAME} in Settings -> Apps (uninstall removes it)`;
}

/** Remove the entry and its script. Windows only; never throws. */
export function removeAppsEntry(home: string, platform = process.platform): string | null {
  if (platform !== "win32") return null;
  rmSync(join(home, UNINSTALL_SCRIPT), { force: true });
  try { execFileSync("reg", ["delete", UNINSTALL_KEY, "/f"], { stdio: "ignore" }); } catch { return null; }
  return `removed ${DISPLAY_NAME} from Settings -> Apps`;
}
