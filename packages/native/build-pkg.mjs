// Build the macOS installer package around the single executable (macOS only, Apple's own pkgbuild and productbuild).
//
//   node build-pkg.mjs [path/to/scopebond-agent]   → build/scopebond-agent-<version>-<arch>.pkg
//
// The executable is taken as given: build-sea.mjs signs it ad hoc, and the release workflow signs it with the Developer
// ID first. With APPLE_INSTALLER_IDENTITY set (a "Developer ID Installer: …" identity in a keychain), the package is
// signed with it and timestamped; without it, the package is unsigned, as every file of the Windows build job is. The
// release workflow then notarizes and staples the signed package.
//
// The package installs, for every user of the Mac:
//   /usr/local/bin/scopebond-agent                          the agent and the hook (on PATH in every new terminal)
//   /Library/LaunchAgents/com.scopebond.agent.plist          starts `scopebond-agent run` as each person who signs in
//   /Library/Application Support/Scopebond/uninstall.sh      removes all of it (`sudo … uninstall.sh [--purge]`)
// Its scripts stop the running agents before an upgrade (preinstall) and start the new one for everyone signed in
// (postinstall). Signing in, the hook entries and the workspace come from the agent, as after the Windows installer.

import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installerVersion } from "./build-msi.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const macos = join(here, "macos");

/** The package's identifier, and the receipt `pkgutil --pkgs` lists and uninstall.sh forgets. */
export const PACKAGE_ID = "com.scopebond.agent";
/** Where each file goes on the Mac, and the file it comes from (null: the executable given). */
export const PAYLOAD = [
  { path: "usr/local/bin/scopebond-agent", from: null, mode: 0o755 },
  { path: "Library/LaunchAgents/com.scopebond.agent.plist", from: join(macos, "com.scopebond.agent.plist"), mode: 0o644 },
  { path: "Library/Application Support/Scopebond/uninstall.sh", from: join(macos, "uninstall.sh"), mode: 0o755 },
];
/** The oldest macOS the package installs on: Node 22's own minimum. */
export const MIN_MACOS = "11.0";

/** The architecture names of Apple's installer for Node's. The executable is the Node that builds it, so it is that one. */
const ARCH = { arm64: "arm64", x64: "x86_64" };

/** The product's Distribution: one package, no choices, installed on the startup disk for every user. */
export function distributionXml(version, arch = process.arch) {
  const host = ARCH[arch];
  if (!host) throw new Error(`no macOS installer for the ${arch} architecture`);
  return `<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
  <title>Scopebond Agent</title>
  <organization>com.scopebond</organization>
  <domains enable_localSystem="true" enable_anywhere="false" enable_currentUserHome="false"/>
  <options customize="never" require-scripts="true" rootVolumeOnly="true" hostArchitectures="${host}"/>
  <allowed-os-versions><os-version min="${MIN_MACOS}"/></allowed-os-versions>
  <conclusion file="conclusion.txt" mime-type="text/plain"/>
  <choices-outline><line choice="default"><line choice="${PACKAGE_ID}"/></line></choices-outline>
  <choice id="default"/>
  <choice id="${PACKAGE_ID}" visible="false"><pkg-ref id="${PACKAGE_ID}"/></choice>
  <pkg-ref id="${PACKAGE_ID}" version="${version}" onConclusion="none">#scopebond-agent.pkg</pkg-ref>
</installer-gui-script>
`;
}

/** Build the package. `identity` signs it (default APPLE_INSTALLER_IDENTITY; none leaves it unsigned). */
export function buildPkg(exe = join(here, "build", "scopebond-agent"), { version, identity = process.env.APPLE_INSTALLER_IDENTITY || null, arch = process.arch } = {}) {
  if (process.platform !== "darwin") throw new Error("the macOS installer package is built on macOS");
  if (!existsSync(exe)) throw new Error(`no executable at ${exe}; build it first (build-sea.mjs)`);
  const v = installerVersion(version);
  const work = join(here, "build", "pkg");
  rmSync(work, { recursive: true, force: true });
  const root = join(work, "root");
  for (const file of PAYLOAD) {
    const to = join(root, file.path);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(file.from ?? exe, to);
    chmodSync(to, file.mode);
  }
  const scripts = join(work, "scripts");
  mkdirSync(scripts, { recursive: true });
  for (const name of ["preinstall", "postinstall"]) {
    copyFileSync(join(macos, "scripts", name), join(scripts, name));
    chmodSync(join(scripts, name), 0o755);
  }
  const resources = join(work, "resources");
  mkdirSync(resources, { recursive: true });
  copyFileSync(join(macos, "conclusion.txt"), join(resources, "conclusion.txt"));
  // No extended attributes or resource forks in the payload (they would land as ._ files).
  const env = { ...process.env, COPYFILE_DISABLE: "1" };
  const run = (program, args) => execFileSync(program, args, { stdio: "inherit", env });
  // The folders on the way (/usr/local, /Library/Application Support, …) are in the payload too. They keep the owner and
  // mode they already have on the Mac (overwrite-permissions="false", pkgbuild's PackageInfo template, `--info`): an
  // install never takes over a /usr/local that another tool owns.
  writeFileSync(join(work, "PackageInfo"), `<?xml version="1.0" encoding="utf-8"?>\n<pkg-info overwrite-permissions="false" relocatable="false"/>\n`);
  // Every file owned by root (--ownership recommended), installed at / exactly where PAYLOAD says.
  run("pkgbuild", ["--root", root, "--scripts", scripts, "--info", join(work, "PackageInfo"), "--identifier", PACKAGE_ID, "--version", v,
    "--install-location", "/", "--ownership", "recommended", join(work, "scopebond-agent.pkg")]);
  writeFileSync(join(work, "Distribution"), distributionXml(v, arch));
  const out = join(here, "build", `scopebond-agent-${v}-${ARCH[arch]}.pkg`);
  run("productbuild", ["--distribution", join(work, "Distribution"), "--package-path", work, "--resources", resources,
    "--version", v, ...(identity ? ["--sign", identity, "--timestamp"] : []), out]);
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  console.log(`built ${buildPkg(process.argv[2] ? resolve(process.argv[2]) : undefined)}`);
}
