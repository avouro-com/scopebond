// The Windows installer installs and removes cleanly, per user and for every user. It changes the computer it runs on
// (files, registry, Start menu, and the removal takes the hook out of this user's settings), so it runs only where
// SCOPEBOND_MSI=1 says so: the Windows CI job, on a throwaway runner.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSea } from "../build-sea.mjs";
import { buildMsi } from "../build-msi.mjs";

const enabled = process.platform === "win32" && process.env.SCOPEBOND_MSI === "1";
const reg = (key, name) => {
  const r = spawnSync("reg", ["query", key, "/v", name], { encoding: "utf8" });
  return r.status === 0 ? (/REG_\w+\s+(.*)$/m.exec(r.stdout)?.[1] ?? "").trim() : null;
};
const msiexec = (args, log) => {
  const r = spawnSync("msiexec", [...args, "/qn", "/l*v", log], { encoding: "utf8" });
  return { status: r.status, log: existsSync(log) ? readFileSync(log, "utf16le") : "" };
};

test("the installer installs per user without an administrator, and removing it leaves nothing", { skip: !enabled && "Windows CI only (SCOPEBOND_MSI=1): it installs on this computer", timeout: 15 * 60_000 }, async () => {
  const msi = buildMsi(await buildSea());
  const logs = process.env.RUNNER_TEMP ?? process.env.TEMP;
  const installed = join(process.env.LOCALAPPDATA, "Programs", "Scopebond", "scopebond-agent.exe");
  const shortcut = join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "Scopebond Agent status.lnk");
  const install = msiexec(["/i", msi, "WORKSPACE=https://cloud.example.test"], join(logs, "msi-user-install.log"));
  assert.equal(install.status, 0, install.log.slice(-3000));
  assert.ok(existsSync(installed), `not installed at ${installed}`);
  assert.ok(existsSync(shortcut), "the Start-menu entry");
  assert.equal(reg("HKCU\\Software\\Avouro\\Scopebond", "InstallPath")?.replace(/\\$/, ""), join(process.env.LOCALAPPDATA, "Programs", "Scopebond"));
  assert.equal(reg("HKCU\\Software\\Avouro\\Scopebond", "Workspace"), "https://cloud.example.test");
  const run = spawnSync(installed, ["hook", "help"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  // Removal runs the agent's uninstall first, then takes everything the installer put there.
  const remove = msiexec(["/x", msi], join(logs, "msi-user-remove.log"));
  assert.equal(remove.status, 0, remove.log.slice(-3000));
  assert.match(remove.log, /ReportUninstall/, "the agent's uninstall ran");
  assert.ok(!existsSync(installed), "the executable is gone");
  assert.ok(!existsSync(shortcut), "the Start-menu entry is gone");
  assert.equal(reg("HKCU\\Software\\Avouro\\Scopebond", "InstallPath"), null);
});

test("with ALLUSERS=1 it installs for every user in Program Files, and removes cleanly", { skip: !enabled && "Windows CI only (SCOPEBOND_MSI=1)", timeout: 15 * 60_000 }, async () => {
  const msi = buildMsi();
  const logs = process.env.RUNNER_TEMP ?? process.env.TEMP;
  const installed = join(process.env.ProgramFiles, "Scopebond", "scopebond-agent.exe");
  const install = msiexec(["/i", msi, "ALLUSERS=1"], join(logs, "msi-machine-install.log"));
  assert.equal(install.status, 0, install.log.slice(-3000));
  assert.ok(existsSync(installed), `not installed at ${installed}`);
  assert.equal(reg("HKLM\\Software\\Avouro\\Scopebond", "InstallPath")?.replace(/\\$/, ""), join(process.env.ProgramFiles, "Scopebond"));
  const remove = msiexec(["/x", msi, "ALLUSERS=1"], join(logs, "msi-machine-remove.log"));
  assert.equal(remove.status, 0, remove.log.slice(-3000));
  assert.ok(!existsSync(installed));
  assert.equal(reg("HKLM\\Software\\Avouro\\Scopebond", "InstallPath"), null);
});

// With the native tray (SCOPEBOND_TRAY_EXE, the tray workflow's build): the installer starts the tray, the tray starts the
// agent and brings it back when it is killed, and removing it leaves nothing running and nothing behind.
const trayExe = process.env.SCOPEBOND_TRAY_EXE;
const RUN = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const running = (image) => {
  const r = spawnSync("tasklist", ["/FI", `IMAGENAME eq ${image}`, "/FO", "CSV", "/NH"], { encoding: "utf8" });
  return r.stdout.split(/\r?\n/).filter((line) => line.toLowerCase().startsWith(`"${image.toLowerCase()}"`)).map((line) => Number(line.split('","')[1]));
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
  const install = msiexec(["/i", msi], join(logs, "msi-tray-install.log"));
  assert.equal(install.status, 0, install.log.slice(-3000));
  assert.ok(existsSync(tray), `the tray is not installed at ${tray}`);
  assert.equal(reg(RUN, "Scopebond"), `"${tray}"`, "the tray starts at sign-in");
  assert.ok(existsSync(shortcut), "the Start-menu entry");

  // The installer starts the tray at its end, and the tray starts the agent.
  let pid = await agentUp(home, 90_000);
  assert.ok(pid, "the tray started the agent");
  assert.equal(running("scopebond-tray.exe").length, 1, "one tray");
  assert.equal(running("scopebond-agent.exe").length, 1, "one agent");

  // Ended from outside (as Task Manager would): the tray starts it again within 30 seconds.
  spawnSync("taskkill", ["/F", "/PID", String(pid)]);
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
