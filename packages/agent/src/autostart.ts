// Start the agent when the person signs in to the computer, per user, with no administrator
// rights: a Run entry on Windows, a LaunchAgent on macOS, a systemd user unit on Linux.
//
// Each of them starts a small launcher script in the Scopebond home, not Node directly. The
// launcher finds Node and the agent when it runs (the recorded paths first, then the system's),
// so upgrading Node or switching versions never leaves an autostart entry pointing at nothing.
// On Windows it runs under `conhost --headless`, so no window opens at sign-in.

import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, win32 } from "node:path";

export const LABEL = "com.scopebond.agent";
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_VALUE = "ScopebondAgent";

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const noQuotes = (s: string) => s.replace(/"/g, "");

export function launcherPath(home: string, platform: NodeJS.Platform = process.platform): string {
  return join(home, platform === "win32" ? "agent-launch.cmd" : "agent-launch.sh");
}

export function windowsLauncher(node: string, cli: string, logFile: string): string {
  return [
    "@echo off",
    // cmd.exe reads a batch file in the console code page: switch to UTF-8 first, so a profile folder
    // with non-ASCII letters in the paths below reads as written.
    "chcp 65001 >nul",
    "rem Scopebond Agent launcher: finds Node and the agent each time, so a Node upgrade never stops it.",
    "setlocal",
    `set "NODE=${noQuotes(node)}"`,
    `if not exist "%NODE%" set "NODE="`,
    `if not defined NODE for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE set "NODE=%%i"`,
    `set "CLI=${noQuotes(cli)}"`,
    `if not exist "%CLI%" for /f "delims=" %%i in ('npm.cmd root -g 2^>nul') do set "CLI=%%i\\@scopebond\\agent\\dist\\cli.js"`,
    `if not defined NODE exit /b 1`,
    // Restart on failure, as launchd (KeepAlive) and systemd (Restart=on-failure) do: a crash restarts the agent after
    // 30 seconds, up to 50 times; a clean exit (stop, autostart off, an update handing over) ends the launcher.
    "set /a TRIES=0",
    ":run",
    // The log sits beside this launcher; %~dp0 keeps it right whatever the folder is called.
    `"%NODE%" --disable-warning=ExperimentalWarning "%CLI%" run >> "%~dp0${win32.basename(noQuotes(logFile))}" 2>&1`,
    `set "CODE=%ERRORLEVEL%"`,
    "if %CODE% EQU 0 exit /b 0",
    "set /a TRIES+=1",
    `echo %DATE% %TIME% the agent stopped with exit code %CODE%; restarting in 30 seconds (attempt %TRIES% of 50) >> "%~dp0${win32.basename(noQuotes(logFile))}"`,
    "if %TRIES% GEQ 50 exit /b 1",
    // ping waits without a console to read from (timeout.exe refuses to run under a headless console).
    "ping -n 31 127.0.0.1 >nul",
    "goto run",
    "",
  ].join("\r\n");
}

export function posixLauncher(node: string, cli: string): string {
  const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  return `#!/bin/sh
# Scopebond Agent launcher: finds Node and the agent each time, so a Node upgrade never stops it.
NODE=${q(node)}
if [ ! -x "$NODE" ]; then
  [ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
  NODE="$(command -v node 2>/dev/null)"
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    [ -n "$NODE" ] && break
    [ -x "$candidate" ] && NODE="$candidate"
  done
fi
CLI=${q(cli)}
[ -f "$CLI" ] || CLI="$(npm root -g 2>/dev/null)/@scopebond/agent/dist/cli.js"
[ -n "$NODE" ] || exit 1
exec "$NODE" --disable-warning=ExperimentalWarning "$CLI" run
`;
}

/** The Run value: the launcher under a headless console host, so nothing appears on screen. */
/** `cmd /s /c ""<launcher>""`: cmd drops only the outer quotes and runs the quoted path as it is, so a
 *  profile folder with a space and a `(`, `)` or `&` ("John (Work)") still starts the launcher. */
const cmdRun = (launcher: string) => `/d /s /c ""${noQuotes(launcher)}""`;

export function windowsRunCommand(launcher: string): string {
  return `conhost.exe --headless cmd.exe ${cmdRun(launcher)}`;
}

export function macLaunchAgent(launcher: string, logFile: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>/bin/sh</string><string>${xml(launcher)}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>${xml(logFile)}</string>
  <key>StandardErrorPath</key><string>${xml(logFile)}</string>
</dict>
</plist>
`;
}

export function linuxUserUnit(launcher: string): string {
  const q = (s: string) => `"${s.replace(/(["\\])/g, "\\$1")}"`;
  return `[Unit]
Description=Scopebond Agent (delivers this computer's records to its Scopebond workspace)
After=network-online.target

[Service]
ExecStart=/bin/sh ${q(launcher)}
Restart=on-failure
RestartSec=30

[Install]
WantedBy=default.target
`;
}

export function autostartPaths(home = homedir()) {
  return {
    macPlist: join(home, "Library", "LaunchAgents", `${LABEL}.plist`),
    linuxUnit: join(home, ".config", "systemd", "user", "scopebond-agent.service"),
  };
}

function writeLauncher(scopebondHome: string, node: string, cli: string, platform: NodeJS.Platform): string {
  mkdirSync(scopebondHome, { recursive: true });
  const launcher = launcherPath(scopebondHome, platform);
  const log = join(scopebondHome, "agent.log");
  writeFileSync(launcher, platform === "win32" ? windowsLauncher(node, cli, log) : posixLauncher(node, cli), { mode: 0o700 });
  if (platform !== "win32") chmodSync(launcher, 0o700);
  return launcher;
}

/** The ways to start the agent now on Windows, in order: the launcher under a headless console (no window,
 *  as sign-in does), then the launcher through cmd.exe with its window hidden, for a session where the
 *  headless console host does not start (seen on Windows Server). macOS and Linux start it themselves
 *  when autostart is turned on (RunAtLoad, enable --now). */
export function startCommands(launcher: string, platform: NodeJS.Platform = process.platform): Array<[string, string[]]> {
  if (platform !== "win32") return [];
  // Passed verbatim (startNow sets windowsVerbatimArguments): Node's own quoting follows other rules than cmd's.
  return [["conhost.exe", ["--headless", "cmd.exe", cmdRun(launcher)]], ["cmd.exe", [cmdRun(launcher)]]];
}

/** Start the agent now with the `attempt`-th way (0 first), detached from this terminal. Returns whether it tried one. */
export function startNow(scopebondHome: string, platform = process.platform, attempt = 0): boolean {
  const launcher = launcherPath(scopebondHome, platform);
  const command = startCommands(launcher, platform)[attempt];
  if (!command || !existsSync(launcher)) return false;
  try {
    const child = spawn(command[0], command[1], { detached: true, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true });
    child.on("error", () => { /* the next way, or the next sign-in */ });
    child.unref();
    return true;
  } catch { return false; }
}

/** Turn autostart on for this user. Returns a one-line description of what changed. */
export function enableAutostart(scopebondHome: string, cli: string, node = process.execPath, platform = process.platform): string {
  const launcher = writeLauncher(scopebondHome, node, cli, platform);
  const paths = autostartPaths();
  if (platform === "win32") {
    execFileSync("reg", ["add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/d", windowsRunCommand(launcher), "/f"], { stdio: "ignore" });
    return `added ${RUN_VALUE} to ${RUN_KEY} (launcher ${launcher})`;
  }
  if (platform === "darwin") {
    mkdirSync(dirname(paths.macPlist), { recursive: true });
    writeFileSync(paths.macPlist, macLaunchAgent(launcher, join(scopebondHome, "agent.log")));
    try { execFileSync("launchctl", ["load", "-w", paths.macPlist], { stdio: "ignore" }); } catch { /* loads at next sign-in */ }
    return `wrote ${paths.macPlist}`;
  }
  mkdirSync(dirname(paths.linuxUnit), { recursive: true });
  writeFileSync(paths.linuxUnit, linuxUserUnit(launcher));
  try { execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" }); execFileSync("systemctl", ["--user", "enable", "--now", "scopebond-agent.service"], { stdio: "ignore" }); }
  catch { return `wrote ${paths.linuxUnit} (enable it with: systemctl --user enable --now scopebond-agent)`; }
  return `wrote and enabled ${paths.linuxUnit}`;
}

export function disableAutostart(scopebondHome: string, platform = process.platform): string {
  const paths = autostartPaths();
  rmSync(launcherPath(scopebondHome, platform), { force: true });
  if (platform === "win32") {
    try { execFileSync("reg", ["delete", RUN_KEY, "/v", RUN_VALUE, "/f"], { stdio: "ignore" }); } catch { return "autostart was not on"; }
    return `removed ${RUN_VALUE} from ${RUN_KEY}`;
  }
  if (platform === "darwin") {
    if (!existsSync(paths.macPlist)) return "autostart was not on";
    try { execFileSync("launchctl", ["unload", "-w", paths.macPlist], { stdio: "ignore" }); } catch { /* not loaded */ }
    rmSync(paths.macPlist, { force: true });
    return `removed ${paths.macPlist}`;
  }
  if (!existsSync(paths.linuxUnit)) return "autostart was not on";
  try { execFileSync("systemctl", ["--user", "disable", "--now", "scopebond-agent.service"], { stdio: "ignore" }); } catch { /* not enabled */ }
  rmSync(paths.linuxUnit, { force: true });
  return `removed ${paths.linuxUnit}`;
}

/** Whether autostart is on and its launcher can start the agent now. */
export function autostartHealth(scopebondHome: string, platform = process.platform): { on: boolean; ok: boolean; detail: string } {
  const paths = autostartPaths();
  let on = false;
  if (platform === "win32") {
    try { execFileSync("reg", ["query", RUN_KEY, "/v", RUN_VALUE], { stdio: "ignore" }); on = true; } catch { on = false; }
  } else on = existsSync(platform === "darwin" ? paths.macPlist : paths.linuxUnit);
  // The fix as the person types it: PowerShell blocks the plain scopebond-agent script shim.
  const fix = `${platform === "win32" ? "scopebond-agent.cmd" : "scopebond-agent"} autostart on`;
  if (!on) return { on, ok: false, detail: `the agent does not start with sign-in (run: ${fix})` };
  if (!existsSync(launcherPath(scopebondHome, platform))) return { on, ok: false, detail: `the autostart launcher is missing (run: ${fix})` };
  return { on, ok: true, detail: "starts with sign-in" };
}
