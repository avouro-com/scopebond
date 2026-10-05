// Start the agent when the person signs in to the computer, per user, with no administrator
// rights: a Run entry on Windows, a LaunchAgent on macOS, a systemd user unit on Linux. The
// builders are pure (and tested); `enable`/`disable` apply them. The command pins this Node and
// this agent's absolute path, so it never depends on a shell's PATH or npm's temporary cache.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const LABEL = "com.scopebond.agent";
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_VALUE = "ScopebondAgent";

const quoteWin = (s: string) => `"${s.replace(/"/g, "")}"`;
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function windowsRunCommand(node: string, cli: string): string {
  return `${quoteWin(node)} ${quoteWin(cli)} run`;
}

export function macLaunchAgent(node: string, cli: string, logFile: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(node)}</string><string>${xml(cli)}</string><string>run</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>${xml(logFile)}</string>
  <key>StandardErrorPath</key><string>${xml(logFile)}</string>
</dict>
</plist>
`;
}

export function linuxUserUnit(node: string, cli: string): string {
  const q = (s: string) => `"${s.replace(/(["\\])/g, "\\$1")}"`;
  return `[Unit]
Description=Scopebond Agent (delivers this computer's records to its Scopebond workspace)
After=network-online.target

[Service]
ExecStart=${q(node)} ${q(cli)} run
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
    log: join(home, ".scopebond", "agent.log"),
  };
}

/** Turn autostart on for this user. Returns a one-line description of what changed. */
export function enableAutostart(cli: string, node = process.execPath, platform = process.platform): string {
  const paths = autostartPaths();
  if (platform === "win32") {
    execFileSync("reg", ["add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/d", windowsRunCommand(node, cli), "/f"], { stdio: "ignore" });
    return `added ${RUN_VALUE} to ${RUN_KEY}`;
  }
  if (platform === "darwin") {
    mkdirSync(dirname(paths.macPlist), { recursive: true });
    mkdirSync(dirname(paths.log), { recursive: true });
    writeFileSync(paths.macPlist, macLaunchAgent(node, cli, paths.log));
    try { execFileSync("launchctl", ["load", "-w", paths.macPlist], { stdio: "ignore" }); } catch { /* loads at next sign-in */ }
    return `wrote ${paths.macPlist}`;
  }
  mkdirSync(dirname(paths.linuxUnit), { recursive: true });
  writeFileSync(paths.linuxUnit, linuxUserUnit(node, cli));
  try { execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" }); execFileSync("systemctl", ["--user", "enable", "--now", "scopebond-agent.service"], { stdio: "ignore" }); }
  catch { return `wrote ${paths.linuxUnit} (enable it with: systemctl --user enable --now scopebond-agent)`; }
  return `wrote and enabled ${paths.linuxUnit}`;
}

export function disableAutostart(platform = process.platform): string {
  const paths = autostartPaths();
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
