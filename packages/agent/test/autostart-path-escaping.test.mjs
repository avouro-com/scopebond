// A Scopebond home path is the person's own profile folder, so it can hold characters a start command would otherwise
// expand. systemd expands `%` specifiers and `$VAR` in ExecStart: they are written as `%%` and `$$`. cmd.exe expands
// `%NAME%` even inside quotes: a Windows launcher path with a `%` is refused with a clear message, never registered to start
// something else. Nothing here touches the registry, systemd or launchd (the registry runner is a fake).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "sb-autostart-escape-"));
for (const k of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SCOPEBOND_HOME"]) process.env[k] = sandbox;
// Windows programs are found under SystemRoot: pointed at the temp folder, no real reg.exe can run from here.
for (const k of ["SystemRoot", "windir"]) process.env[k] = sandbox;
const { autostartHealth, autostartPaths, enableAutostart, launcherPath, linuxUserUnit, posixLauncher, startNow, windowsLauncher, windowsRunCommand } = await import("../dist/index.js");

test("linux unit: % and $ in the launcher path are written so systemd reads them literally", () => {
  const unit = linuxUserUnit("/srv/o'neil $HOME %h \"q\" \\b/.scopebond/agent-launch.sh");
  const exec = unit.split("\n").find((l) => l.startsWith("ExecStart="));
  assert.equal(exec, "ExecStart=/bin/sh \"/srv/o'neil $$HOME %%h \\\"q\\\" \\\\b/.scopebond/agent-launch.sh\"");
  assert.match(linuxUserUnit("/opt/scopebond/agent-launch.sh"), /^ExecStart=\/bin\/sh "\/opt\/scopebond\/agent-launch\.sh"$/m, "a plain path is unchanged");
});

test("linux: a home whose path has % and $ is still recognised as this home's autostart", () => {
  const home = join(sandbox, "100%h $USER", ".scopebond");
  mkdirSync(home, { recursive: true });
  writeFileSync(launcherPath(home, "linux"), posixLauncher("/usr/bin/node", "/opt/cli.js"), { mode: 0o700 });
  const unit = autostartPaths().linuxUnit;
  mkdirSync(dirname(unit), { recursive: true });
  writeFileSync(unit, linuxUserUnit(launcherPath(home, "linux")));
  assert.deepEqual(autostartHealth(home, "linux"), { on: true, ok: true, detail: "starts with sign-in" });
});

test("Windows: a launcher path with % is refused for the Run value and for starting now", () => {
  const launcher = join(sandbox, "pct%USERNAME%dir", ".scopebond", "agent-launch.cmd");
  assert.throws(() => windowsRunCommand(launcher), /%/);
  assert.equal(startNow(join(sandbox, "pct%USERNAME%dir", ".scopebond"), "win32", 0, null), false, "nothing is started");
  assert.match(windowsRunCommand(join(sandbox, "100 off", ".scopebond", "agent-launch.cmd")), /^conhost\.exe --headless cmd\.exe \/d \/s \/c ""/);
});

test("Windows: autostart on refuses a home with % before writing anything, and names the folder", () => {
  const home = join(sandbox, "pct%USERNAME%home", ".scopebond");
  const calls = [];
  const reg = (args) => { calls.push(args); return true; };
  assert.throws(() => enableAutostart(home, "C:\\cli.js", "C:\\node.exe", "win32", null, reg), (e) => /%/.test(e.message) && e.message.includes(home));
  assert.deepEqual(calls, [], "the registry was not touched");
  const ok = join(sandbox, "plain-home", ".scopebond");
  assert.match(enableAutostart(ok, "C:\\cli.js", "C:\\node.exe", "win32", null, reg), /added ScopebondAgent/);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 3), ["add", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v"]);
});

test("Windows launcher: a % in the Node or agent path is doubled, as a batch file needs", () => {
  const text = windowsLauncher("C:\\Users\\a%b\\node.exe", "C:\\Users\\a%b\\cli.js", "C:\\x\\agent.log");
  assert.ok(text.includes('set "NODE=C:\\Users\\a%%b\\node.exe"'), text);
  assert.ok(text.includes('set "CLI=C:\\Users\\a%%b\\cli.js"'), text);
});
