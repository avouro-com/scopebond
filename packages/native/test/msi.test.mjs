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
