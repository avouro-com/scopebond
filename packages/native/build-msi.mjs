// Build the Windows installer around the single executable (Windows only, WiX 5 as a local dotnet tool).
//
//   node build-msi.mjs [path\to\scopebond-agent.exe] [path\to\scopebond-tray.exe]   → build/scopebond-agent-<version>-x64.msi
//
// The executables are taken as given (the release workflow stamps their version resource and signs them first, then
// signs the installer). With the native tray (the second argument, or SCOPEBOND_TRAY_EXE), the installer also installs
// the tray and starts it at sign-in; without it, the installer is the agent alone, as before.
//
// After the build, the installer goes through Windows Installer's own validation (the ICE rules, `wix msi validate`). In
// CI (CI=true) a warning fails the build too; elsewhere validation needs an administrator, and WiX only warns without one.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeIcon } from "./icon.mjs";
import { installerVersion } from "./version.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const WIX_UTIL = "WixToolset.Util.wixext/5.0.2";

// ICE rules this package breaks on purpose (rule: the reason). Everything else must pass.
export const SUPPRESSED_ICES = {
  // REINSTALLMODE=amus in the Property table (wix/Package.wxs says why): an upgrade must replace the agent that releases
  // up to 0.6.0 shipped with Node's file version (22.x), higher than any release's own.
  ICE40: "REINSTALLMODE is set on purpose so an upgrade always replaces this package's own files",
  // The Start-menu entry is per-user data in a per-user install and per-machine data with ALLUSERS=1, so its key path is
  // HKMU (HKCU or HKLM to match). ICE57 assumes a package is one or the other; an HKCU key path would leave every-user
  // installs keyed to the one administrator who ran them.
  ICE57: "the Start-menu entry's HKMU key path follows the install's scope (perUserOrMachine)",
  // ICE105 refuses any deferred action that does not impersonate in a package that can install per user. The one here is
  // WiX's own close-application action (util:CloseApplication), which must close every user's tray and agent in an
  // install for every user; in a per-user install Windows Installer runs it with the person's own rights, no elevation.
  ICE105: "WiX's CloseApplication deferred action needs system rights in an every-user install",
};

export { installerVersion };

/** Build the installer. `version` replaces the agent package's version: only the upgrade test builds an older one. */
export function buildMsi(exe = join(here, "build", "scopebond-agent.exe"), tray = process.env.SCOPEBOND_TRAY_EXE || null, { version, validate = true } = {}) {
  if (process.platform !== "win32") throw new Error("the installer is built on Windows");
  if (!existsSync(exe)) throw new Error(`no executable at ${exe}; build it first (build-sea.mjs)`);
  if (tray && !existsSync(tray)) throw new Error(`no tray at ${tray}; build it first (packages/tray: cargo build --release)`);
  const v = installerVersion(version);
  const out = join(here, "build", `scopebond-agent-${v}-x64.msi`);
  const icon = writeIcon(join(here, "build", "scopebond.ico"));
  const run = (args) => execFileSync("dotnet", args, { cwd: here, stdio: "inherit" });
  run(["tool", "restore"]);
  run(["tool", "run", "wix", "extension", "add", WIX_UTIL]);
  run(["tool", "run", "wix", "build", "-arch", "x64", "-ext", WIX_UTIL, "-d", `Version=${v}`, "-d", `ExePath=${resolve(exe)}`,
    "-d", `IconPath=${icon}`, ...(tray ? ["-d", `TrayPath=${resolve(tray)}`] : []), "-o", out, join(here, "wix", "Package.wxs")]);
  if (validate) {
    run(["tool", "run", "wix", "msi", "validate", ...(process.env.CI === "true" ? ["-wx"] : []),
      ...Object.keys(SUPPRESSED_ICES).flatMap((ice) => ["-sice", ice]), out]);
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  console.log(`built ${buildMsi(process.argv[2], process.argv[3] || process.env.SCOPEBOND_TRAY_EXE || null)}`);
}
