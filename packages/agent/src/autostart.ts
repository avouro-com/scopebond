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
import { dirname, join } from "node:path";

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
    "rem Scopebond Agent launcher: finds Node and the agent each time, so a Node upgrade never stops it.",
    "setlocal",
    `set "NODE=${noQuotes(node)}"`,
    `if not exist "%NODE%" set "NODE="`,
    `if not defined NODE for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE set "NODE=%%i"`,
    `set "CLI=${noQuotes(cli)}"`,
    `if not exist "%CLI%" for /f "delims=" %%i in ('npm.cmd root -g 2^>nul') do set "CLI=%%i\\@scopebond\\agent\\dist\\cli.js"`,
    `if not defined NODE exit /b 1`,
    `"%NODE%" --disable-warning=ExperimentalWarning "%CLI%" run >> "${noQuotes(logFile)}" 2>&1`,
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
export function windowsRunCommand(launcher: string): string {
  return `conhost.exe --headless cmd.exe /d /c "${noQuotes(launcher)}"`;
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

/** Start the agent now, the way sign-in will (Windows: the launcher under a headless console, detached from this terminal).
 *  macOS and Linux start it themselves when autostart is turned on (RunAtLoad, enable --now). Returns whether it started one. */
export function startNow(scopebondHome: string, platform = process.platform): boolean {
  if (platform !== "win32") return false;
  const launcher = launcherPath(scopebondHome, platform);
  if (!existsSync(launcher)) return false;
  try {
    const child = spawn("conhost.exe", ["--headless", "cmd.exe", "/d", "/c", launcher], { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => { /* it starts at the next sign-in instead */ });
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
  if (!on) return { on, ok: false, detail: "the agent does not start with sign-in (run: scopebond-agent autostart on)" };
  if (!existsSync(launcherPath(scopebondHome, platform))) return { on, ok: false, detail: "the autostart launcher is missing (run: scopebond-agent autostart on)" };
  return { on, ok: true, detail: "starts with sign-in" };
}
