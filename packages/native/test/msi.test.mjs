// The Windows installer installs and removes cleanly, per user and for every user. It changes the computer it runs on
// (files, registry, Start menu, and the removal takes the hook out of this user's settings), so it runs only where
// SCOPEBOND_MSI=1 says so: the Windows CI job, on a throwaway runner.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { buildSea } from "../build-sea.mjs";
import { buildMsi, installerVersion } from "../build-msi.mjs";
import { readVersionInfo, stampExecutable } from "../stamp.mjs";

const enabled = process.platform === "win32" && process.env.SCOPEBOND_MSI === "1";
// Every install here names a workspace that cannot answer (.test never resolves), so an agent started by the tray, which
// signs a never-connected computer in to the recorded workspace (or the default one) on its first start, fails fast here
// and never sends a real sign-in request or opens a browser on the runner. The upgrade passes none on purpose: it keeps
// this recorded one.
const TEST_WORKSPACE = "https://cloud.example.test";
// spawnSync blocks the event loop, so node:test's own timeout can never end a test stuck in one: a hung child process
// held the CI job until GitHub cancelled it. Every child process here is bounded; an install or removal gets minutes,
// everything else a minute.
const MSIEXEC_TIMEOUT_MS = 5 * 60_000;
const TOOL = { encoding: "utf8", timeout: 60_000 };
const reg = (key, name) => {
  const r = spawnSync("reg", ["query", key, "/v", name], TOOL);
  return r.status === 0 ? (/REG_\w+\s+(.*)$/m.exec(r.stdout)?.[1] ?? "").trim() : null;
};
/** The Settings -> Apps entries named Scopebond Agent, with the values the list shows. A per-user MSI is listed from
 *  Windows Installer's own record (HKLM ...\Installer\UserData\<SID>\Products\<id>\InstallProperties), not an Uninstall
 *  key; an npm install's entry is HKCU ...\Uninstall\ScopebondAgent. Both are read. */
const appsEntries = () => {
  const roots = [
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Installer\\UserData",
  ];
  const entries = [];
  for (const root of roots) {
    const found = spawnSync("reg", ["query", root, "/s", "/f", "Scopebond Agent", "/d", "/e"], TOOL);
    if (found.status !== 0) continue;
    for (const key of found.stdout.split(/\r?\n/).filter((line) => /^HKEY_/.test(line))) {
      const values = spawnSync("reg", ["query", key.trim()], TOOL).stdout ?? "";
      const entry = { key: key.trim() };
      for (const m of values.matchAll(/^\s+(DisplayName|DisplayVersion|Publisher|UninstallString|HelpLink|URLInfoAbout|URLUpdateInfo|Contact)\s+REG_\w+\s+(.*)$/gm)) entry[m[1]] = m[2].trim();
      entries.push(entry);
    }
  }
  return entries;
};
/** msiexec, bounded. A run that does not finish in time has status null, and its log says so first. */
const msiexec = (args, log) => {
  const r = spawnSync("msiexec", [...args, "/qn", "/l*v", log], { encoding: "utf8", timeout: MSIEXEC_TIMEOUT_MS });
  const text = existsSync(log) ? readFileSync(log, "utf16le") : "";
  const timedOut = r.error?.code === "ETIMEDOUT";
  return { status: timedOut ? null : r.status, log: timedOut ? `msiexec ${args.join(" ")} did not finish within ${MSIEXEC_TIMEOUT_MS / 60_000} minutes; its log ends:\n${text.slice(-3000)}` : text };
};
const USER_ENV = "HKCU\\Environment";
const MACHINE_ENV = "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment";
/** How many entries of the PATH in `key` are `folder` (case and a trailing backslash aside). */
const onPath = (key, folder) => {
  const norm = (p) => p.trim().replace(/\\+$/, "").toLowerCase();
  return (reg(key, "Path") ?? "").split(";").filter((p) => norm(p) === norm(folder)).length;
};

test("the installer installs per user without an administrator, and removing it leaves nothing", { skip: !enabled && "Windows CI only (SCOPEBOND_MSI=1): it installs on this computer", timeout: 15 * 60_000 }, async () => {
  const msi = buildMsi(await buildSea());
  const logs = process.env.RUNNER_TEMP ?? process.env.TEMP;
  const installed = join(process.env.LOCALAPPDATA, "Programs", "Scopebond", "scopebond-agent.exe");
  const shortcut = join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "Scopebond Agent status.lnk");
  const install = msiexec(["/i", msi, `WORKSPACE=${TEST_WORKSPACE}`], join(logs, "msi-user-install.log"));
  assert.equal(install.status, 0, install.log.slice(-3000));
  assert.ok(existsSync(installed), `not installed at ${installed}`);
  assert.ok(existsSync(shortcut), "the Start-menu entry");
  assert.equal(reg("HKCU\\Software\\Avouro\\Scopebond", "InstallPath")?.replace(/\\$/, ""), join(process.env.LOCALAPPDATA, "Programs", "Scopebond"));
  assert.equal(reg("HKCU\\Software\\Avouro\\Scopebond", "Workspace"), TEST_WORKSPACE);
  const run = spawnSync(installed, ["hook", "help"], TOOL);
  assert.equal(run.status, 0, run.error ? String(run.error) : run.stderr);
  // On this user's PATH, once, so `scopebond-agent status` works in a new terminal.
  const folder = join(process.env.LOCALAPPDATA, "Programs", "Scopebond");
  assert.equal(onPath(USER_ENV, folder), 1, `the folder on this user's PATH: ${reg(USER_ENV, "Path")}`);
  assert.equal(onPath(MACHINE_ENV, folder), 0, "not on the system's PATH");
  // Settings -> Apps lists it once, as Scopebond Agent by Avouro LLC (Windows writes the entry for the installer; the
  // npm install's own entry is not written for a signed install), with where help and updates are.
  const listed = appsEntries().filter((e) => e.DisplayName === "Scopebond Agent");
  // Never leave the install behind for the next test, whatever this one finds.
  if (listed.length !== 1) msiexec(["/x", msi], join(logs, "msi-user-remove-fallback.log"));
  assert.equal(listed.length, 1, JSON.stringify(listed));
  assert.equal(listed[0].Publisher, "Avouro LLC");
  assert.match(listed[0].UninstallString ?? "", /^MsiExec\.exe \/[IX]\{[0-9A-F-]{36}\}$/i);
  assert.equal(listed[0].DisplayVersion, installerVersion());
  assert.equal(listed[0].HelpLink, "https://scopebond.com/documentation");
  assert.equal(listed[0].URLInfoAbout, "https://scopebond.com");
  assert.equal(listed[0].URLUpdateInfo, "https://github.com/avouro-com/scopebond/releases");
  assert.equal(listed[0].Contact, "Avouro LLC");
  // The installed program carries the release's version, not Node's.
  assert.equal(readVersionInfo(installed).fileVersion, `${installerVersion()}.0`);
  // A plain removal keeps the Scopebond folder (keys, records not yet sent).
  const home = join(process.env.USERPROFILE, ".scopebond");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "msi-test-marker"), "kept unless PURGE=1\n");
  // Removal from the Apps list runs the entry's own command; it runs the agent's uninstall first, then takes everything the
  // installer put there.
  const productCode = /\{[0-9A-F-]{36}\}/i.exec(listed[0].UninstallString)[0];
  const remove = msiexec(["/x", productCode], join(logs, "msi-user-remove.log"));
  assert.equal(remove.status, 0, remove.log.slice(-3000));
  assert.match(remove.log, /ReportUninstall/, "the agent's uninstall ran");
  assert.match(remove.log, /Doing action: StopAgent/, "the agent was asked to stop first");
  assert.ok(!existsSync(installed), "the executable is gone");
  assert.ok(!existsSync(shortcut), "the Start-menu entry is gone");
  assert.equal(reg("HKCU\\Software\\Avouro\\Scopebond", "InstallPath"), null);
  assert.equal(onPath(USER_ENV, folder), 0, "the folder is off this user's PATH");
  assert.ok(existsSync(join(home, "msi-test-marker")), "the Scopebond folder stays without PURGE=1");
  assert.equal(appsEntries().filter((e) => e.DisplayName === "Scopebond Agent").length, 0, "no longer listed in Settings -> Apps");
});

test("ROLLBACK=1 (the update helper taking back a version that did not start) removes it without the agent's uninstall", { skip: !enabled && "Windows CI only (SCOPEBOND_MSI=1)", timeout: 15 * 60_000 }, async () => {
  const msi = buildMsi();
  const logs = process.env.RUNNER_TEMP ?? process.env.TEMP;
  const installed = join(process.env.LOCALAPPDATA, "Programs", "Scopebond", "scopebond-agent.exe");
  const install = msiexec(["/i", msi, `WORKSPACE=${TEST_WORKSPACE}`], join(logs, "msi-rollback-install.log"));
  assert.equal(install.status, 0, install.log.slice(-3000));
  const remove = msiexec(["/x", msi, "ROLLBACK=1"], join(logs, "msi-rollback-remove.log"));
  assert.equal(remove.status, 0, remove.log.slice(-3000));
  assert.match(remove.log, /Skipping action: ReportUninstall \(condition is false\)/, "the workspace is not told of a removal; the hook stays in the settings");
  assert.match(remove.log, /Skipping action: StopAgent \(condition is false\)/, "the agent that did not start is closed, not asked");
  assert.ok(!existsSync(installed), "the version is gone, for the previous one to be installed");
  // The remembered workspace goes with it: the helper reads it first and passes it to the previous version's installer.
  assert.equal(reg("HKCU\\Software\\Avouro\\Scopebond", "Workspace"), null);
});

test("with ALLUSERS=1 it installs for every user in Program Files, and removes cleanly", { skip: !enabled && "Windows CI only (SCOPEBOND_MSI=1)", timeout: 15 * 60_000 }, async () => {
  const msi = buildMsi();
  const logs = process.env.RUNNER_TEMP ?? process.env.TEMP;
  const installed = join(process.env.ProgramFiles, "Scopebond", "scopebond-agent.exe");
  const install = msiexec(["/i", msi, "ALLUSERS=1", `WORKSPACE=${TEST_WORKSPACE}`], join(logs, "msi-machine-install.log"));
  assert.equal(install.status, 0, install.log.slice(-3000));
  assert.ok(existsSync(installed), `not installed at ${installed}`);
  assert.equal(reg("HKLM\\Software\\Avouro\\Scopebond", "InstallPath")?.replace(/\\$/, ""), join(process.env.ProgramFiles, "Scopebond"));
  assert.equal(reg("HKLM\\Software\\Avouro\\Scopebond", "Workspace"), TEST_WORKSPACE, "the workspace, for every user");
  // On the system's PATH, for every user, and not on this user's own.
  const folder = join(process.env.ProgramFiles, "Scopebond");
  assert.equal(onPath(MACHINE_ENV, folder), 1, `the folder on the system's PATH: ${reg(MACHINE_ENV, "Path")}`);
  assert.equal(onPath(USER_ENV, folder), 0);
  // PURGE=1: the removal deletes the Scopebond folder too (the agent's uninstall with its purge option).
  const home = join(process.env.USERPROFILE, ".scopebond");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "msi-test-marker"), "removed with PURGE=1\n");
  const remove = msiexec(["/x", msi, "ALLUSERS=1", "PURGE=1"], join(logs, "msi-machine-remove.log"));
  assert.equal(remove.status, 0, remove.log.slice(-3000));
  assert.match(remove.log, /uninstall --purge/, "the agent's uninstall ran with its purge option");
  assert.ok(!existsSync(installed));
  assert.equal(reg("HKLM\\Software\\Avouro\\Scopebond", "InstallPath"), null);
  assert.equal(onPath(MACHINE_ENV, folder), 0, "the folder is off the system's PATH");
  assert.ok(!existsSync(join(home, "msi-test-marker")), "PURGE=1 deleted the Scopebond folder");
  // Removal for every user (the agent's allusers-cleanup.ts): a copy in Program Files\Scopebond Cleanup and an Active Setup
  // entry, so each person's next sign-in takes Scopebond out of their own settings; installing for every user again takes
  // both away.
  const activeSetup = "HKLM\\SOFTWARE\\Microsoft\\Active Setup\\Installed Components\\{6C1E2B9A-4F3D-4E8B-9A57-3D2C1B0E8F64}";
  const cleanupFolder = join(process.env.ProgramFiles, "Scopebond Cleanup");
  const cleanup = join(cleanupFolder, "scopebond-agent.exe");
  try {
    assert.ok(existsSync(cleanup), `the copy for each person's sign-in is there: ${remove.log.slice(-3000)}`);
    assert.match(reg(activeSetup, "StubPath") ?? "", /--headless ".*Scopebond Cleanup\\scopebond-agent\.exe" uninstall --signed-in$/);
    assert.match(reg(activeSetup, "Version") ?? "", /^\d+,\d+,\d+,\d+$/);
    // This person's sign-in after the removal: PURGE=1 took their Scopebond folder, so there is nothing to do.
    const signIn = spawnSync(cleanup, ["uninstall", "--signed-in"], TOOL);
    assert.equal(signIn.status, 0, `${signIn.stdout}${signIn.stderr}`);
    const again = msiexec(["/i", msi, "ALLUSERS=1", `WORKSPACE=${TEST_WORKSPACE}`], join(logs, "msi-machine-reinstall.log"));
    assert.equal(again.status, 0, again.log.slice(-3000));
    assert.equal(reg(activeSetup, "StubPath"), null, "installing for every user again removes the Active Setup entry");
    assert.ok(!existsSync(cleanup), "and the copy");
    const last = msiexec(["/x", msi, "ALLUSERS=1"], join(logs, "msi-machine-remove-again.log"));
    assert.equal(last.status, 0, last.log.slice(-3000));
  } finally {
    // The runner as it was: no entry and no copy left behind by this test.
    spawnSync("reg", ["delete", activeSetup, "/f", "/reg:64"], TOOL);
    rmSync(cleanupFolder, { recursive: true, force: true });
  }
});

// With the native tray (SCOPEBOND_TRAY_EXE, the tray workflow's build): the installer starts the tray, the tray starts the
// agent and brings it back when it is killed, and removing it leaves nothing running and nothing behind.
const trayExe = process.env.SCOPEBOND_TRAY_EXE;
const RUN = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const running = (image) => {
  const r = spawnSync("tasklist", ["/FI", `IMAGENAME eq ${image}`, "/FO", "CSV", "/NH"], TOOL);
  return (r.stdout ?? "").split(/\r?\n/).filter((line) => line.toLowerCase().startsWith(`"${image.toLowerCase()}"`)).map((line) => Number(line.split('","')[1]));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** The pid of an agent that wrote its endpoint file and is running (not `not`), within `ms`. */
async function agentUp(home, ms, not = 0) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const { pid } = JSON.parse(readFileSync(join(home, "agent.json"), "utf8"));
      if (pid && pid !== not && running("scopebond-agent.exe").includes(pid)) return pid;
    } catch { /* not written yet */ }
    await sleep(500);
  }
  return 0;
}

test("with the native tray: it starts at sign-in and keeps the agent running, and removing it leaves nothing", { skip: !(enabled && trayExe) && "Windows CI only, with the tray built (SCOPEBOND_MSI=1, SCOPEBOND_TRAY_EXE)", timeout: 15 * 60_000 }, async () => {
  const msi = buildMsi(await buildSea(), trayExe);
  const logs = process.env.RUNNER_TEMP ?? process.env.TEMP;
  const folder = join(process.env.LOCALAPPDATA, "Programs", "Scopebond");
  const tray = join(folder, "scopebond-tray.exe");
  const home = join(process.env.USERPROFILE, ".scopebond");
  const shortcut = join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "Scopebond Agent status.lnk");
  const install = msiexec(["/i", msi, `WORKSPACE=${TEST_WORKSPACE}`], join(logs, "msi-tray-install.log"));
  assert.equal(install.status, 0, install.log.slice(-3000));
  assert.ok(existsSync(tray), `the tray is not installed at ${tray}`);
  assert.equal(reg(RUN, "Scopebond"), `"${tray}"`, "the tray starts at sign-in");
  assert.ok(existsSync(shortcut), "the Start-menu entry");

  // The installer starts the tray at its end, and the tray starts the agent.
  let pid = await agentUp(home, 90_000);
  assert.ok(pid, "the tray started the agent");
  assert.equal(running("scopebond-tray.exe").length, 1, "one tray");
  assert.equal(running("scopebond-agent.exe").length, 1, "one agent");
  const endpoint = JSON.parse(readFileSync(join(home, "agent.json"), "utf8"));
  assert.equal(endpoint.port, 0, "beside the tray the agent listens on its pipe only, not on 127.0.0.1");
  assert.match(endpoint.socket, /^\\\\\.\\pipe\\scopebond-agent-/);

  // Ended from outside (as Task Manager would): the tray starts it again within 30 seconds.
  spawnSync("taskkill", ["/F", "/PID", String(pid)], TOOL);
  const killedAt = Date.now();
  const again = await agentUp(home, 30_000, pid);
  assert.ok(again, "the agent is back within 30 s");
  console.log(`the agent was back after ${Math.round((Date.now() - killedAt) / 100) / 10} s`);
  await sleep(5_000);
  assert.equal(running("scopebond-agent.exe").length, 1, "still one agent");

  // A second start of the tray (the Start-menu entry) gives way to the first.
  spawnSync(tray, ["--status"], { timeout: 15_000 });
  await sleep(3_000);
  assert.equal(running("scopebond-tray.exe").length, 1, "still one tray");

  const remove = msiexec(["/x", msi], join(logs, "msi-tray-remove.log"));
  assert.equal(remove.status, 0, remove.log.slice(-3000));
  for (let i = 0; i < 20 && (running("scopebond-tray.exe").length || running("scopebond-agent.exe").length); i++) await sleep(500);
  assert.deepEqual(running("scopebond-tray.exe"), [], "the tray is closed");
  assert.deepEqual(running("scopebond-agent.exe"), [], "the agent is stopped");
  assert.ok(!existsSync(tray) && !existsSync(join(folder, "scopebond-agent.exe")), "the files are gone");
  assert.equal(reg(RUN, "Scopebond"), null, "the sign-in entry is gone");
  assert.equal(reg(RUN, "ScopebondAgent"), null);
  assert.equal(reg("HKCU\\Software\\Avouro\\Scopebond", "InstallPath"), null);
  assert.ok(!existsSync(shortcut), "the Start-menu entry is gone");
});

/** The release before `version`: its patch number one lower (or its minor, or its major). */
function previousVersion(version) {
  const [a, b, c] = version.split(".").map(Number);
  return c > 0 ? `${a}.${b}.${c - 1}` : b > 0 ? `${a}.${b - 1}.0` : `${a - 1}.0.0`;
}
/** The file version of the program a running process was started from (what Task Manager shows for it). */
const processFileVersion = (pid) => spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
  `(Get-Process -Id ${Number(pid)}).MainModule.FileVersionInfo.FileVersion`], TOOL).stdout?.trim() ?? "";

test("with the native tray: an upgrade replaces both running programs, keeps the workspace and needs no reboot", { skip: !(enabled && trayExe) && "Windows CI only, with the tray built (SCOPEBOND_MSI=1, SCOPEBOND_TRAY_EXE)", timeout: 30 * 60_000 }, async () => {
  const NEW = installerVersion();
  const OLD = previousVersion(NEW);
  const work = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "sb-upgrade-"));
  // Each release in a folder of its own (every build starts from an empty build folder). The older one is built as
  // releases up to 0.6.0 were: the agent with Node's own version resource (22.x, higher than any release's) and the tray
  // with its build's 0.1.0, the case where Windows Installer's default rule would keep the old files.
  const release = async (version, stamp) => {
    const exe = await buildSea({ agentVersion: version, stamp });
    const folder = join(work, version);
    mkdirSync(folder);
    const agent = join(folder, "scopebond-agent.exe");
    const tray = join(folder, "scopebond-tray.exe");
    copyFileSync(exe, agent);
    copyFileSync(trayExe, tray);
    if (stamp) stampExecutable(tray, "tray", version);
    const msi = join(folder, basename(buildMsi(agent, tray, { version })));
    copyFileSync(join(dirname(exe), basename(msi)), msi);
    return msi;
  };
  const oldMsi = await release(OLD, false);
  const newMsi = await release(NEW, true);
  const logs = process.env.RUNNER_TEMP ?? process.env.TEMP;
  const folder = join(process.env.LOCALAPPDATA, "Programs", "Scopebond");
  const agentPath = join(folder, "scopebond-agent.exe");
  const trayPath = join(folder, "scopebond-tray.exe");
  const home = join(process.env.USERPROFILE, ".scopebond");
  try {
    const first = msiexec(["/i", oldMsi, `WORKSPACE=${TEST_WORKSPACE}`, "/norestart"], join(logs, "msi-upgrade-old.log"));
    assert.equal(first.status, 0, first.log.slice(-3000));
    const oldAgent = await agentUp(home, 90_000);
    assert.ok(oldAgent, "the older tray started the older agent");
    const [oldTray] = running("scopebond-tray.exe");
    assert.ok(oldTray, "the older tray runs");
    assert.ok((spawnSync(agentPath, ["--version"], TOOL).stdout ?? "").startsWith(`agent/${OLD} `), "the older agent is installed");

    // The upgrade as a person or the agent's own update runs it: no WORKSPACE, with the tray and the agent running.
    const upgrade = msiexec(["/i", newMsi, "/norestart"], join(logs, "msi-upgrade-new.log"));
    assert.equal(upgrade.status, 0, `msiexec ended with ${upgrade.status} (3010: a reboot is needed): ${upgrade.log.slice(-3000)}`);
    assert.match(upgrade.log, /Doing action: StopAgent/, "the running agent was asked to stop first");

    // Both installed files are the new release's.
    assert.equal(readVersionInfo(agentPath).fileVersion, `${NEW}.0`, "the agent was replaced");
    assert.equal(readVersionInfo(trayPath).fileVersion, `${NEW}.0`, "the tray was replaced");
    assert.ok((spawnSync(agentPath, ["--version"], TOOL).stdout ?? "").startsWith(`agent/${NEW} `), "the new agent is installed");
    // The installer started the new tray, and the tray the new agent: new processes, from the new files.
    const newAgent = await agentUp(home, 90_000, oldAgent);
    assert.ok(newAgent, "the new agent runs");
    assert.equal(processFileVersion(newAgent), `${NEW}.0`, "the running agent is the new release");
    const trays = running("scopebond-tray.exe");
    assert.equal(trays.length, 1, "one tray");
    assert.notEqual(trays[0], oldTray, "the older tray is gone");
    assert.equal(processFileVersion(trays[0]), `${NEW}.0`, "the running tray is the new release");
    assert.equal(running("scopebond-agent.exe").length, 1, "one agent");
    // One entry in Settings -> Apps, at the new version; the workspace the first install was given is kept; the folder is on
    // PATH once.
    const listed = appsEntries().filter((e) => e.DisplayName === "Scopebond Agent");
    assert.equal(listed.length, 1, JSON.stringify(listed));
    assert.equal(listed[0].DisplayVersion, NEW);
    assert.equal(reg("HKCU\\Software\\Avouro\\Scopebond", "Workspace"), TEST_WORKSPACE, "the workspace is kept");
    assert.equal(onPath(USER_ENV, folder), 1, `the folder on PATH once: ${reg(USER_ENV, "Path")}`);
  } finally {
    // Never leave an install behind, whatever this test found.
    msiexec(["/x", newMsi], join(logs, "msi-upgrade-remove.log"));
    msiexec(["/x", oldMsi], join(logs, "msi-upgrade-remove-old.log"));
  }
  for (let i = 0; i < 20 && (running("scopebond-tray.exe").length || running("scopebond-agent.exe").length); i++) await sleep(500);
  assert.deepEqual(running("scopebond-tray.exe"), [], "the tray is closed");
  assert.deepEqual(running("scopebond-agent.exe"), [], "the agent is stopped");
  assert.ok(!existsSync(agentPath) && !existsSync(trayPath), "the files are gone");
  assert.equal(reg("HKCU\\Software\\Avouro\\Scopebond", "Workspace"), null, "the workspace value goes with the removal");
  assert.equal(appsEntries().filter((e) => e.DisplayName === "Scopebond Agent").length, 0);
});
