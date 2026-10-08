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
    const found = spawnSync("reg", ["query", root, "/s", "/f", "Scopebond Agent", "/d", "/e"], { encoding: "utf8" });
    if (found.status !== 0) continue;
    for (const key of found.stdout.split(/\r?\n/).filter((line) => /^HKEY_/.test(line))) {
      const values = spawnSync("reg", ["query", key.trim()], { encoding: "utf8" }).stdout ?? "";
      const entry = { key: key.trim() };
      for (const m of values.matchAll(/^\s+(DisplayName|Publisher|UninstallString)\s+REG_\w+\s+(.*)$/gm)) entry[m[1]] = m[2].trim();
      entries.push(entry);
    }
  }
  return entries;
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
  // Settings -> Apps lists it once, as Scopebond Agent by Avouro LLC (Windows writes the entry for the installer; the
  // npm install's own entry is not written for a signed install).
  const listed = appsEntries().filter((e) => e.DisplayName === "Scopebond Agent");
  // Never leave the install behind for the next test, whatever this one finds.
  if (listed.length !== 1) msiexec(["/x", msi], join(logs, "msi-user-remove-fallback.log"));
  assert.equal(listed.length, 1, JSON.stringify(listed));
  assert.equal(listed[0].Publisher, "Avouro LLC");
  assert.match(listed[0].UninstallString ?? "", /^MsiExec\.exe \/[IX]\{[0-9A-F-]{36}\}$/i);
  // Removal from the Apps list runs the entry's own command; it runs the agent's uninstall first, then takes everything the
  // installer put there.
  const productCode = /\{[0-9A-F-]{36}\}/i.exec(listed[0].UninstallString)[0];
  const remove = msiexec(["/x", productCode], join(logs, "msi-user-remove.log"));
  assert.equal(remove.status, 0, remove.log.slice(-3000));
  assert.match(remove.log, /ReportUninstall/, "the agent's uninstall ran");
  assert.ok(!existsSync(installed), "the executable is gone");
  assert.ok(!existsSync(shortcut), "the Start-menu entry is gone");
  assert.equal(reg("HKCU\\Software\\Avouro\\Scopebond", "InstallPath"), null);
  assert.equal(appsEntries().filter((e) => e.DisplayName === "Scopebond Agent").length, 0, "no longer listed in Settings -> Apps");
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
