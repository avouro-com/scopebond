// Scopebond in Windows Settings → Apps → Installed apps, for an agent installed with npm. The signed installer has its own
// entry (Windows writes it for the MSI); an npm install had none, so a person looking for Scopebond in Settings did not find
// it. `setup` and `autostart on` write a per-user entry (no administrator rights) whose Uninstall runs a small PowerShell
// script: the agent's own `uninstall` (autostart off, the agent stopped, the hook taken out of the coding agents' settings,
// the workspace told), then `npm uninstall -g @scopebond/agent`. `uninstall` removes the entry. The Scopebond folder (keys,
// the connection, records not yet sent) stays, so installing again is the same computer; `uninstall --purge` deletes it.

import { execFileSync } from "node:child_process";
import { windowsSystemProgram } from "@scopebond/gateway/node";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { UNINSTALL_CALLER_ENV, UNINSTALL_NOT_TOLD_EXIT } from "@scopebond/hook";
import { folderSentence } from "./commands.js";

export const UNINSTALL_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ScopebondAgent";
export const UNINSTALL_SCRIPT = "uninstall-agent.ps1";
const DISPLAY_NAME = "Scopebond Agent";
export const PUBLISHER = "Avouro LLC";

/** A PowerShell single-quoted string. PowerShell ends such a string at any of its single quotes, the ASCII one and the
 *  typographic ones (U+2018, U+2019, U+201A, U+201B), and reads each one doubled as itself; a profile folder named
 *  O’Brien must not end the string early. */
export const psQuote = (text: string) => `'${text.replace(/['\u2018\u2019\u201A\u201B]/g, "$&$&")}'`;

/** The byte-order mark the script is written with: without it, Windows PowerShell 5.1 reads the script in the ANSI code
 *  page and a non-ASCII path (a profile folder named Jörg) no longer names the folder. */
export const UTF8_BOM = "\uFEFF";

/** The script the entry's Uninstall runs. Paths reach PowerShell only as quoted data. It says "removed" only when the
 *  agent's own uninstall ran and succeeded and npm removed the package; otherwise it says what did not happen and exits 1.
 *  - The agent is not there (npm uninstall -g ran first): its own uninstall cannot run, so autostart, the hook entries and
 *    the workspace may still need it; npm's uninstall still runs and the entry is still removed, but the exit code is 1.
 *  - The agent's uninstall fails: the package stays, so `scopebond-agent.cmd uninstall` can be run again to see why.
 *  - The agent's uninstall removed everything but could not tell the workspace (UNINSTALL_NOT_TOLD_EXIT): said, and npm's
 *    uninstall still runs, since nothing is left for the agent to do.
 *  The agent runs with UNINSTALL_CALLER_ENV set, so the script, not the agent, ends with the sentence about the Scopebond
 *  folder (`home`; without it, the script's own folder, where it is written). */
export function uninstallScript(o: { node: string; cli: string; npm: string; key?: string; home?: string; version?: string }): string {
  // The sentences as the agent words them (folderSentence), with the folder filled in when the script runs.
  const kept = psQuote(folderSentence("{0}", { exists: true, purged: false, kind: null, me: "" }));
  const gone = psQuote(folderSentence("{0}", { exists: false, purged: false, kind: null, me: "" }));
  return `# Scopebond Agent${o.version ? ` ${o.version}` : ""}, installed with npm: what Windows Settings -> Apps -> Scopebond Agent -> Uninstall runs.
# The Scopebond folder (keys, connection, records not yet sent) stays; delete it with: scopebond-agent uninstall --purge
$ErrorActionPreference = 'Continue'
Write-Host 'Removing the Scopebond Agent...'
$node = ${psQuote(o.node)}
$cli = ${psQuote(o.cli)}
$npm = ${psQuote(o.npm)}
$folder = ${o.home ? psQuote(o.home) : "$PSScriptRoot"}
$problems = @()
$agentRan = $false
if (-not (Test-Path -LiteralPath $cli)) {
  $problems += "The agent is not at $cli, so its own uninstall did not run: autostart, the hook in the coding agents' settings and the workspace may still need it. Install it again (npm.cmd install -g @scopebond/agent) and run: scopebond-agent.cmd uninstall"
} else {
  try {
    $env:${UNINSTALL_CALLER_ENV} = 'apps-entry'
    & $node --disable-warning=ExperimentalWarning $cli uninstall
    if ($LASTEXITCODE -eq ${UNINSTALL_NOT_TOLD_EXIT}) {
      $problems += "The workspace was not told that this computer was removed (see above): it will see this computer go quiet."
      # Everything else was removed: carry on as after a success.
      $global:LASTEXITCODE = 0
    }
    if ($LASTEXITCODE -eq 0) { $agentRan = $true }
    else { $problems += "The agent's own uninstall stopped with exit code $LASTEXITCODE. The agent is still installed; run it again to see why: scopebond-agent.cmd uninstall" }
  } catch {
    $problems += "The agent's own uninstall could not start ($($_.Exception.Message)). Run: scopebond-agent.cmd uninstall"
  }
}
if ($agentRan -or -not (Test-Path -LiteralPath $cli)) {
  try {
    & $npm uninstall -g @scopebond/agent
    if ($LASTEXITCODE -ne 0) { $problems += "npm.cmd uninstall -g @scopebond/agent stopped with exit code $LASTEXITCODE." }
  } catch {
    $problems += "npm.cmd uninstall -g @scopebond/agent could not start ($($_.Exception.Message))."
  }
}
& reg.exe delete ${psQuote(o.key ?? UNINSTALL_KEY)} /f 2>$null | Out-Null
if (Test-Path -LiteralPath $folder) { $folderNote = ${kept} -f $folder } else { $folderNote = ${gone} -f $folder }
if ($problems.Count -eq 0) {
  Write-Host 'The Scopebond Agent is removed.'
  Write-Host $folderNote
  if (-not $env:SCOPEBOND_NO_PAUSE) { Start-Sleep -Seconds 3 }
  exit 0
}
Write-Host 'The Scopebond Agent is not fully removed:'
foreach ($problem in $problems) { Write-Host "  - $problem" }
Write-Host $folderNote; if (-not $env:SCOPEBOND_NO_PAUSE) { Start-Sleep -Seconds 15 }
exit 1
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

/** Write the uninstall script (UTF-8 with a byte-order mark) into the Scopebond folder; returns its path. */
export function writeUninstallScript(home: string, o: { node: string; cli: string; npm: string; key?: string; home?: string; version?: string }): string {
  const script = join(home, UNINSTALL_SCRIPT);
  // Readable and writable by this user only (on Windows the folder's own access list decides; elsewhere the mode does).
  writeFileSync(script, UTF8_BOM + uninstallScript({ ...o, home: o.home ?? home }), { encoding: "utf8", mode: 0o600 });
  return script;
}

/** Write the entry and its script for this user. Windows only; returns a one-line description, or null elsewhere. */
export function writeAppsEntry(home: string, o: { version: string; cli: string; node?: string }, platform = process.platform): string | null {
  if (platform !== "win32") return null;
  const node = o.node ?? process.execPath;
  const script = writeUninstallScript(home, { node, cli: o.cli, npm: npmBeside(node), version: o.version });
  for (const [name, type, data] of appsEntryValues({ version: o.version, script, home })) {
    execFileSync(windowsSystemProgram("reg"), ["add", UNINSTALL_KEY, "/v", name, "/t", type, "/d", data, "/f"], { stdio: "ignore" });
  }
  return `listed ${DISPLAY_NAME} in Settings -> Apps (uninstall removes it)`;
}

/** Rewrite the entry and its script when the script is not the one this version writes: an update replaces the agent, not
 *  the script, and Settings should run this version's uninstall and show its version. Only an entry that is there (its
 *  script in the Scopebond folder) is rewritten. Windows only; whether it rewrote; never throws. */
export function refreshAppsEntry(
  home: string, o: { version: string; cli: string; node?: string }, platform = process.platform,
  write: (home: string, o: { version: string; cli: string; node: string }, platform: NodeJS.Platform) => string | null = writeAppsEntry,
): boolean {
  if (platform !== "win32") return false;
  let current: string;
  try { current = readFileSync(join(home, UNINSTALL_SCRIPT), "utf8"); } catch { return false; }
  const node = o.node ?? process.execPath;
  if (current === UTF8_BOM + uninstallScript({ node, cli: o.cli, npm: npmBeside(node), home, version: o.version })) return false;
  try { return write(home, { ...o, node }, platform) !== null; } catch { return false; }
}

/** Remove the entry and its script. Windows only; never throws. */
export function removeAppsEntry(home: string, platform = process.platform): string | null {
  if (platform !== "win32") return null;
  rmSync(join(home, UNINSTALL_SCRIPT), { force: true });
  try { execFileSync(windowsSystemProgram("reg"), ["delete", UNINSTALL_KEY, "/f"], { stdio: "ignore" }); } catch { return null; }
  return `removed ${DISPLAY_NAME} from Settings -> Apps`;
}
