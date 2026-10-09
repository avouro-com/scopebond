// Start the agent when the person signs in to the computer, per user, with no administrator
// rights: a Run entry on Windows, a LaunchAgent on macOS, a systemd user unit on Linux.
//
// Each of them starts a small launcher script in the Scopebond home, not Node directly. The
// launcher finds Node and the agent when it runs (the recorded paths first, then the system's),
// so upgrading Node or switching versions never leaves an autostart entry pointing at nothing.
// On Windows it runs under `conhost --headless`, so no window opens at sign-in.

import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, win32 } from "node:path";
import { isSingleExecutable } from "@scopebond/hook";
import { nativeTrayPath, windowsTool } from "./native-update.js";

export const LABEL = "com.scopebond.agent";
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_VALUE = "ScopebondAgent";

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const noQuotes = (s: string) => s.replace(/"/g, "");
/** A literal value in a batch file: cmd reads `%NAME%` (and a lone `%`) in a batch line as a variable, `%%` as one `%`. */
const batchLiteral = (s: string) => noQuotes(s).replace(/%/g, "%%");

/** The agent's log, which the agent writes itself (`SCOPEBOND_AGENT_LOG`) when a Windows launcher or a handover starts it. */
export const AGENT_LOG_ENV = "SCOPEBOND_AGENT_LOG";

/** Written into every Windows launcher this version makes. A launcher without it redirects the agent's output into
 *  agent.log itself, which keeps a replacement agent from starting (see `spawnReplacement`). */
export const LAUNCHER_MARK = "rem Scopebond Agent launcher 2:";

/** Whether a launcher's text is this version's (an older one is rewritten once no agent runs under it). */
export function launcherIsCurrent(text: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "win32" || text.includes(LAUNCHER_MARK);
}

export function launcherPath(home: string, platform: NodeJS.Platform = process.platform): string {
  return join(home, platform === "win32" ? "agent-launch.cmd" : "agent-launch.sh");
}

/** The Windows launcher. With `cli` empty, `node` is the single executable: it is started as it is, with no Node to find. */
export function windowsLauncher(node: string, cli: string, logFile: string): string {
  const log = `"%~dp0${win32.basename(noQuotes(logFile))}"`;
  const single = cli === "";
  return [
    "@echo off",
    // cmd.exe reads a batch file in the console code page: switch to UTF-8 first, so a profile folder
    // with non-ASCII letters in the paths below reads as written.
    "chcp 65001 >nul",
    `${LAUNCHER_MARK} finds Node and the agent each time, so a Node upgrade never stops it.`,
    "setlocal",
    // The agent writes its own log. A `>> agent.log` here would hold the file shared for reading only, the old agent's
    // children inherit that handle, and a replacement started during an update could then never open it: cmd skips the
    // whole command line when a redirect fails. The log sits beside this launcher; %~dp0 keeps it right whatever the folder is called.
    `set "${AGENT_LOG_ENV}=%~dp0${win32.basename(noQuotes(logFile))}"`,
    `set "NODE=${batchLiteral(node)}"`,
    ...(single ? [`if not exist "%NODE%" exit /b 1`] : [
      `if not exist "%NODE%" set "NODE="`,
      `if not defined NODE for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE set "NODE=%%i"`,
      `set "CLI=${batchLiteral(cli)}"`,
      `if not exist "%CLI%" for /f "delims=" %%i in ('npm.cmd root -g 2^>nul') do set "CLI=%%i\\@scopebond\\agent\\dist\\cli.js"`,
      `if not defined NODE exit /b 1`,
    ]),
    // Restart on failure, as launchd (KeepAlive) and systemd (Restart=on-failure) do: a crash restarts the agent after
    // 30 seconds, up to 50 times; a clean exit (stop, autostart off, an update handing over) ends the launcher.
    "set /a TRIES=0",
    ":run",
    // (call) sets the error level to 1 first, so a command that never ran counts as a failure, not a clean stop.
    "(call)",
    single ? `"%NODE%" run >nul 2>&1` : `"%NODE%" --disable-warning=ExperimentalWarning "%CLI%" run >nul 2>&1`,
    `set "CODE=%ERRORLEVEL%"`,
    // An update's handover names the agent to wait for; a restart after a crash has nothing to wait for.
    `set "SCOPEBOND_AGENT_AFTER_PID="`,
    "if %CODE% EQU 0 exit /b 0",
    "set /a TRIES+=1",
    `echo %DATE% %TIME% the agent stopped with exit code %CODE%; restarting in 30 seconds (attempt %TRIES% of 50) >> ${log}`,
    "if %TRIES% GEQ 50 exit /b 1",
    // ping waits without a console to read from (timeout.exe refuses to run under a headless console).
    "ping -n 31 127.0.0.1 >nul",
    "goto run",
    "",
  ].join("\r\n");
}

/** The macOS/Linux launcher. With `cli` empty, `node` is the single executable, started as it is. */
export function posixLauncher(node: string, cli: string): string {
  const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  if (cli === "") return `#!/bin/sh
# Scopebond Agent launcher: the single executable.
exec ${q(node)} run
`;
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

/** Why cmd.exe cannot be given this launcher path on its command line, or null. cmd expands `%NAME%` even inside quotes
 *  (and a command line has no escape for `%`), so a path with a `%` could start a different path. */
function cmdPathProblem(launcher: string): string | null {
  return launcher.includes("%")
    ? `the Scopebond folder ${win32.dirname(launcher)} has a % in its path, which Windows would read as a variable when it starts the agent; set SCOPEBOND_HOME to a folder without % and run this again`
    : null;
}

/** The Run value: the launcher under a headless console host, so nothing appears on screen. */
/** `cmd /s /c ""<launcher>""`: cmd drops only the outer quotes and runs the quoted path as it is, so a
 *  profile folder with a space and a `(`, `)` or `&` ("John (Work)") still starts the launcher. A path with a `%` is
 *  refused (see `cmdPathProblem`). */
const cmdRun = (launcher: string) => {
  const problem = cmdPathProblem(launcher);
  if (problem) throw new Error(problem);
  return `/d /s /c ""${noQuotes(launcher)}""`;
};

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

/** A quoted ExecStart argument: `"` and `\` escaped, and systemd's own expansions written literally (`%%` for a `%`
 *  specifier, `$$` for a `$` variable), so a home path with `%h` or `$HOME` in it is started as written. */
const systemdQuoted = (s: string) => `"${s.replace(/(["\\])/g, "\\$1").replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;

/** The path a unit's `ExecStart=/bin/sh "<path>"` starts, read back as `systemdQuoted` wrote it; null when it has another form. */
function systemdUnquoted(unit: string): string | null {
  const m = /^ExecStart=\/bin\/sh "((?:[^"\\]|\\.)*)"[ \t]*$/m.exec(unit);
  if (!m) return null;
  return m[1].replace(/\\(.)|%%|\$\$/g, (all, escaped: string | undefined) => escaped ?? all[0]);
}

export function linuxUserUnit(launcher: string): string {
  const q = systemdQuoted;
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

/** Rewrite an older Windows launcher as this version's, keeping autostart as it is. Only safe once no cmd.exe runs the old
 *  one (cmd reads a batch file line by line from where it left off): the handover calls it after the old agent has exited.
 *  Returns whether it rewrote one. */
export function refreshLauncher(scopebondHome: string, cli: string, node = process.execPath, platform = process.platform): boolean {
  const launcher = launcherPath(scopebondHome, platform);
  let text: string;
  try { text = readFileSync(launcher, "utf8"); } catch { return false; }
  if (launcherIsCurrent(text, platform)) return false;
  writeLauncher(scopebondHome, node, cli, platform);
  return true;
}

function writeLauncher(scopebondHome: string, node: string, cli: string, platform: NodeJS.Platform): string {
  // The single executable is both Node and the agent: the launcher starts it with `run`.
  if (isSingleExecutable()) { node = process.execPath; cli = ""; }
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
  // Passed verbatim (startNow sets windowsVerbatimArguments): Node's own quoting follows other rules than cmd's. Both by
  // full path: started by bare name from a terminal open in a project, Windows would look in that folder first.
  const cmd = windowsTool("cmd");
  return [[windowsTool("conhost"), ["--headless", cmd, cmdRun(launcher)]], [cmd, [cmdRun(launcher)]]];
}

// The signed Windows install with its native tray (`scopebond-tray.exe` beside the agent): the installer adds a Run value
// `Scopebond` that starts the tray, and the tray starts the agent and keeps it running. Autostart then means that value,
// not the launcher's `ScopebondAgent`, which would start a second agent (refused by its lock) at every sign-in.

/** Runs `reg.exe` with these arguments; whether it succeeded. Tests pass their own. */
export type RegRunner = (args: string[]) => boolean;
const runReg: RegRunner = (args) => {
  try { execFileSync(windowsTool("reg"), args, { stdio: "ignore", windowsHide: true }); return true; } catch { return false; }
};
export const TRAY_RUN_VALUE = "Scopebond";
const MACHINE_RUN_KEY = "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const trayFor = (platform: NodeJS.Platform) => (platform === "win32" ? nativeTrayPath() : null);
/** The tray's Run value set for every user (an install with ALLUSERS=1): only whoever installed it changes it. */
const trayForEveryone = (reg: RegRunner) => reg(["query", MACHINE_RUN_KEY, "/v", TRAY_RUN_VALUE]);

/** The launcher's Run value is not used beside the native tray. Whether there was one to remove. */
export function retireLauncherRunValue(reg: RegRunner = runReg): boolean {
  return reg(["query", RUN_KEY, "/v", RUN_VALUE]) && reg(["delete", RUN_KEY, "/v", RUN_VALUE, "/f"]);
}

/** Start the agent now with the `attempt`-th way (0 first), detached from this terminal. Returns whether it tried one.
 *  Beside the native tray, the one way is to start the tray (it starts the agent; a second tray gives way to the first). */
export function startNow(scopebondHome: string, platform = process.platform, attempt = 0, tray: string | null = trayFor(platform)): boolean {
  if (tray) {
    if (attempt > 0) return false;
    try {
      const child = spawn(tray, [], { detached: true, stdio: "ignore", windowsHide: true });
      child.on("error", () => { /* the next sign-in starts it */ });
      child.unref();
      return true;
    } catch { return false; }
  }
  const launcher = launcherPath(scopebondHome, platform);
  let command: [string, string[]] | undefined;
  try { command = startCommands(launcher, platform)[attempt]; } catch { return false; } // a path cmd.exe would misread
  if (!command || !existsSync(launcher)) return false;
  try {
    const child = spawn(command[0], command[1], { detached: true, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true });
    child.on("error", () => { /* the next way, or the next sign-in */ });
    child.unref();
    return true;
  } catch { return false; }
}

/** Turn autostart on for this user. Returns a one-line description of what changed. */
export function enableAutostart(scopebondHome: string, cli: string, node = process.execPath, platform = process.platform, tray: string | null = trayFor(platform), reg: RegRunner = runReg): string {
  if (tray) {
    retireLauncherRunValue(reg);
    if (trayForEveryone(reg)) return "the Scopebond tray starts for every user of this computer and keeps the agent running";
    if (!reg(["add", RUN_KEY, "/v", TRAY_RUN_VALUE, "/t", "REG_SZ", "/d", `"${noQuotes(tray)}"`, "/f"])) throw new Error(`could not add ${TRAY_RUN_VALUE} to ${RUN_KEY}`);
    return `added ${TRAY_RUN_VALUE} to ${RUN_KEY}: the Scopebond tray starts with your sign-in and keeps the agent running`;
  }
  // Refused before anything is written: a Run value for this launcher would start a different path.
  const problem = platform === "win32" ? cmdPathProblem(launcherPath(scopebondHome, platform)) : null;
  if (problem) throw new Error(`autostart was not turned on: ${problem}`);
  const launcher = writeLauncher(scopebondHome, node, cli, platform);
  const paths = autostartPaths();
  if (platform === "win32") {
    if (!reg(["add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/d", windowsRunCommand(launcher), "/f"])) throw new Error(`could not add ${RUN_VALUE} to ${RUN_KEY}`);
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

export function disableAutostart(scopebondHome: string, platform = process.platform, tray: string | null = trayFor(platform), reg: RegRunner = runReg): string {
  const paths = autostartPaths();
  rmSync(launcherPath(scopebondHome, platform), { force: true });
  if (tray) {
    const launcherValue = retireLauncherRunValue(reg);
    const trayValue = reg(["query", RUN_KEY, "/v", TRAY_RUN_VALUE]) && reg(["delete", RUN_KEY, "/v", TRAY_RUN_VALUE, "/f"]);
    if (trayValue || launcherValue) return `removed ${trayValue ? TRAY_RUN_VALUE : RUN_VALUE} from ${RUN_KEY}`;
    return trayForEveryone(reg) ? "Scopebond starts for every user of this computer; whoever installed it changes that" : "autostart was not on";
  }
  if (platform === "win32") {
    try { execFileSync(windowsTool("reg"), ["delete", RUN_KEY, "/v", RUN_VALUE, "/f"], { stdio: "ignore" }); } catch { return "autostart was not on"; }
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

/** Reads the launcher's Run value: its data, or null when there is none. Tests pass their own. */
export type RunValueReader = () => string | null;
const readRunValue: RunValueReader = () => {
  let out: string;
  try { out = execFileSync(windowsTool("reg"), ["query", RUN_KEY, "/v", RUN_VALUE], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }); }
  catch { return null; }
  // "    ScopebondAgent    REG_SZ    conhost.exe --headless cmd.exe ..."; a value of another form still counts as there.
  const line = out.split(/\r?\n/).find((l) => l.trim().startsWith(`${RUN_VALUE} `));
  return /^\s*\S+\s+REG_(?:EXPAND_)?SZ\s+(.*?)\s*$/.exec(line ?? "")?.[1] ?? "";
};

/** The launcher an autostart entry starts, read back from it; null when it names none this version would write. */
function entryTarget(platform: NodeJS.Platform, readRun: RunValueReader): string | null {
  if (platform === "win32") {
    // The launcher is the last quoted path of the command (this version's `""<launcher>""`, and the `"<launcher>"` older ones wrote).
    const quoted = [...(readRun() ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    return quoted.at(-1) ?? null;
  }
  const paths = autostartPaths();
  let text: string;
  try { text = readFileSync(platform === "darwin" ? paths.macPlist : paths.linuxUnit, "utf8"); } catch { return null; }
  if (platform === "darwin") {
    const m = /<key>ProgramArguments<\/key>\s*<array>\s*<string>[^<]*<\/string>\s*<string>([^<]*)<\/string>/.exec(text);
    return m ? m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&") : null;
  }
  return systemdUnquoted(text);
}

/** Whether an entry's launcher is this home's. Windows paths compare without regard to case or slash direction, and
 *  reg.exe prints the value in the console's code page, so letters outside ASCII (which can come back garbled, never as
 *  other ASCII letters) compare as one wildcard run on both sides. */
function sameLauncher(target: string, launcher: string, platform: NodeJS.Platform): boolean {
  if (platform !== "win32") return target === launcher;
  const shape = (p: string) => p.replace(/\//g, "\\").toLowerCase().replace(/(?:[^\x20-\x7e]|\?)+/g, "*");
  return shape(target) === shape(launcher);
}

/** Whether autostart is on, starts this home's launcher, and that launcher can start the agent now. An entry that starts
 *  another launcher (another home's, say, left by a test run or a second home since deleted) is not this agent starting. */
export function autostartHealth(scopebondHome: string, platform = process.platform, tray: string | null = trayFor(platform), reg: RegRunner = runReg, readRun: RunValueReader = readRunValue): { on: boolean; ok: boolean; detail: string } {
  if (tray) {
    const on = reg(["query", RUN_KEY, "/v", TRAY_RUN_VALUE]) || trayForEveryone(reg);
    return on
      ? { on, ok: true, detail: "starts with sign-in (the Scopebond tray keeps the agent running)" }
      : { on, ok: false, detail: "the Scopebond tray does not start with sign-in (turn on Start with Windows in its menu, or run: scopebond-agent.exe autostart on)" };
  }
  const paths = autostartPaths();
  // The Run value is read once: whether it is there, and what it starts.
  let runValue: string | null = null;
  let on: boolean;
  if (platform === "win32") {
    runValue = readRun();
    on = runValue !== null;
  } else on = existsSync(platform === "darwin" ? paths.macPlist : paths.linuxUnit);
  // The fix as the person types it: PowerShell blocks the plain scopebond-agent script shim.
  const fix = `${platform === "win32" ? "scopebond-agent.cmd" : "scopebond-agent"} autostart on`;
  if (!on) return { on, ok: false, detail: `the agent does not start with sign-in (run: ${fix})` };
  const launcher = launcherPath(scopebondHome, platform);
  const target = entryTarget(platform, () => runValue);
  if (target === null || !sameLauncher(target, launcher, platform)) {
    return { on, ok: false, detail: `autostart starts another launcher (${target ?? "not this agent's"}), not ${launcher} (run: ${fix})` };
  }
  if (!existsSync(launcher)) return { on, ok: false, detail: `the autostart launcher is missing (run: ${fix})` };
  return { on, ok: true, detail: "starts with sign-in" };
}
