// `autostartHealth` reports "starts with sign-in" only when the sign-in entry starts THIS home's launcher. An entry left
// pointing at another home's launcher (a test run or a second home, since deleted) is reported as a problem, so `setup`
// rewrites it instead of skipping it. Only files in a temp profile are created; no systemctl, launchctl or reg runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "sb-autostart-target-"));
for (const k of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SCOPEBOND_HOME"]) process.env[k] = sandbox;
// Windows programs are found under SystemRoot: pointed at the temp folder, no real reg.exe can run from here.
for (const k of ["SystemRoot", "windir"]) process.env[k] = sandbox;
const { autostartHealth, autostartPaths, launcherPath, linuxUserUnit, macLaunchAgent, posixLauncher, windowsRunCommand } = await import("../dist/index.js");

const thisHome = join(sandbox, ".scopebond");
const otherHome = join(sandbox, "ci-run-1234", ".scopebond");
mkdirSync(thisHome, { recursive: true });

test("linux: a unit that starts another home's launcher is not 'starts with sign-in'", () => {
  assert.equal(homedir(), sandbox, "the profile is the temp folder");
  const unit = autostartPaths().linuxUnit;
  assert.ok(unit.startsWith(sandbox), "unit path is inside the temp profile");
  writeFileSync(launcherPath(thisHome, "linux"), posixLauncher("/usr/bin/node", "/opt/cli.js"), { mode: 0o700 });
  mkdirSync(dirname(unit), { recursive: true });
  writeFileSync(unit, linuxUserUnit(launcherPath(otherHome, "linux")));
  const h = autostartHealth(thisHome, "linux");
  assert.equal(h.on, true);
  assert.equal(h.ok, false, JSON.stringify(h));
  assert.match(h.detail, /another launcher/);
  assert.ok(h.detail.includes(launcherPath(otherHome, "linux")), h.detail);
  assert.match(h.detail, /run: scopebond-agent autostart on/);
  writeFileSync(unit, linuxUserUnit(launcherPath(thisHome, "linux")));
  assert.deepEqual(autostartHealth(thisHome, "linux"), { on: true, ok: true, detail: "starts with sign-in" });
});

test("macOS: a LaunchAgent that starts another home's launcher is not 'starts with sign-in'", () => {
  const plist = autostartPaths().macPlist;
  writeFileSync(launcherPath(thisHome, "darwin"), posixLauncher("/usr/bin/node", "/opt/cli.js"), { mode: 0o700 });
  mkdirSync(dirname(plist), { recursive: true });
  writeFileSync(plist, macLaunchAgent(launcherPath(otherHome, "darwin"), join(otherHome, "agent.log")));
  const h = autostartHealth(thisHome, "darwin");
  assert.equal(h.ok, false, JSON.stringify(h));
  assert.match(h.detail, /another launcher/);
  writeFileSync(plist, macLaunchAgent(launcherPath(thisHome, "darwin"), join(thisHome, "agent.log")));
  assert.equal(autostartHealth(thisHome, "darwin").ok, true);
});

test("Windows: the Run value is compared with this home's launcher (read through the given reader)", () => {
  writeFileSync(launcherPath(thisHome, "win32"), "@echo off\r\n");
  const read = (value) => () => value;
  const other = autostartHealth(thisHome, "win32", null, () => false, read(windowsRunCommand(launcherPath(otherHome, "win32"))));
  assert.equal(other.on, true);
  assert.equal(other.ok, false, JSON.stringify(other));
  assert.match(other.detail, /another launcher/);
  assert.match(other.detail, /run: scopebond-agent\.cmd autostart on/);
  assert.equal(autostartHealth(thisHome, "win32", null, () => false, read(windowsRunCommand(launcherPath(thisHome, "win32")))).ok, true);
  // The form older versions wrote, and a path that differs only in letter case or slashes, are the same launcher.
  const legacy = `conhost.exe --headless cmd.exe /d /c "${launcherPath(thisHome, "win32").toUpperCase().replace(/\\/g, "/")}"`;
  assert.equal(autostartHealth(thisHome, "win32", null, () => false, read(legacy)).ok, true, legacy);
  // reg.exe prints the value in the console's code page: letters outside ASCII may come back garbled, never as other ASCII.
  const accented = join(sandbox, "José", ".scopebond");
  mkdirSync(accented, { recursive: true });
  writeFileSync(launcherPath(accented, "win32"), "@echo off\r\n");
  const garbled = windowsRunCommand(launcherPath(accented, "win32")).replace("é", "�");
  assert.equal(autostartHealth(accented, "win32", null, () => false, read(garbled)).ok, true, garbled);
  const off = autostartHealth(thisHome, "win32", null, () => false, read(null));
  assert.deepEqual([off.on, off.ok], [false, false]);
});
