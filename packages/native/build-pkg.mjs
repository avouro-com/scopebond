// Build the macOS installer package around the single executable (macOS only, Apple's own pkgbuild and productbuild).
//
//   node build-pkg.mjs [path/to/scopebond-agent]   → build/scopebond-agent-<version>-<arch>.pkg
//   node build-pkg.mjs app <scopebond-tray> [out]  → build/Scopebond.app (the menu-bar app, signed ad hoc)
//
// With the menu-bar app (`trayApp`, or SCOPEBOND_TRAY_APP: a Scopebond.app built here, signed with the Developer ID in
// the release), the package also installs /Applications/Scopebond.app and its LaunchAgent; without it, the agent alone.
//
// The executable is taken as given: build-sea.mjs signs it ad hoc, and the release workflow signs it with the Developer
// ID first. With APPLE_INSTALLER_IDENTITY set (a "Developer ID Installer: …" identity in a keychain), the package is
// signed with it and timestamped; without it, the package is unsigned, as every file of the Windows build job is. The
// release workflow then notarizes and staples the signed package.
//
// The package installs, for every user of the Mac:
//   /usr/local/bin/scopebond-agent                          the agent and the hook (on PATH in every new terminal)
//   /Library/LaunchAgents/com.scopebond.agent.plist          starts `scopebond-agent run` as each person who signs in
//   /Library/LaunchDaemons/com.scopebond.updater.plist       the updater, as root: installs the next signed package
//                                                            when a person's agent asks (`scopebond-agent update-daemon`)
//   /Library/Application Support/Scopebond/uninstall.sh      removes all of it (`sudo … uninstall.sh [--purge]`)
// Its scripts stop the running agents before an upgrade (preinstall) and start the new one for everyone signed in
// (postinstall). Signing in, the hook entries and the workspace come from the agent, as after the Windows installer.

import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { icns } from "./icon.mjs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installerVersion } from "./version.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const macos = join(here, "macos");

/** The package's identifier, and the receipt `pkgutil --pkgs` lists and uninstall.sh forgets. */
export const PACKAGE_ID = "com.scopebond.agent";
/** Where each file goes on the Mac, and the file it comes from (null: the executable given). */
export const PAYLOAD = [
  { path: "usr/local/bin/scopebond-agent", from: null, mode: 0o755 },
  // The root updater's own copy of the executable, in a folder only root can write: the LaunchDaemon runs this one, never
  // the copy in /usr/local/bin, which a person may own on a Mac where another tool took over /usr/local.
  { path: "Library/PrivilegedHelperTools/com.scopebond.updater", from: null, mode: 0o755 },
  { path: "Library/LaunchAgents/com.scopebond.agent.plist", from: join(macos, "com.scopebond.agent.plist"), mode: 0o644 },
  { path: "Library/LaunchDaemons/com.scopebond.updater.plist", from: join(macos, "com.scopebond.updater.plist"), mode: 0o644 },
  { path: "Library/Application Support/Scopebond/uninstall.sh", from: join(macos, "uninstall.sh"), mode: 0o755 },
];
/** With the menu-bar app: the app itself and its LaunchAgent. */
export const TRAY_APP = "Applications/Scopebond.app";
export const TRAY_PAYLOAD = [
  { path: "Library/LaunchAgents/com.scopebond.tray.plist", from: join(macos, "com.scopebond.tray.plist"), mode: 0o644 },
];
/** The menu-bar app's bundle identifier and program. */
export const TRAY_BUNDLE_ID = "com.scopebond.tray";
export const TRAY_PROGRAM = "scopebond-tray";

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

const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The menu-bar app's Info.plist: no Dock icon or app menu (LSUIElement), the release's version. */
export function trayInfoPlist(version) {
  const entries = {
    CFBundleIdentifier: TRAY_BUNDLE_ID, CFBundleName: "Scopebond", CFBundleDisplayName: "Scopebond", CFBundleExecutable: TRAY_PROGRAM,
    CFBundleIconFile: "scopebond", CFBundlePackageType: "APPL", CFBundleShortVersionString: version, CFBundleVersion: version,
    LSMinimumSystemVersion: MIN_MACOS, NSHumanReadableCopyright: "Copyright Avouro LLC. Apache-2.0.",
  };
  const lines = Object.entries(entries).map(([key, value]) => `  <key>${key}</key><string>${xml(value)}</string>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${lines.join("\n")}
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`;
}

/** Build Scopebond.app around the tray program (packages/tray: cargo build --release), signed ad hoc so Apple silicon
 *  runs it; the release signs it with the Developer ID before it builds the package. */
export function buildTrayApp(program, out = join(here, "build", "Scopebond.app"), { version } = {}) {
  if (process.platform !== "darwin") throw new Error("the menu-bar app is built on macOS");
  if (!existsSync(program)) throw new Error(`no tray program at ${program}; build it first (packages/tray: cargo build --release)`);
  const v = installerVersion(version);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, "Contents", "MacOS"), { recursive: true });
  mkdirSync(join(out, "Contents", "Resources"), { recursive: true });
  copyFileSync(program, join(out, "Contents", "MacOS", TRAY_PROGRAM));
  chmodSync(join(out, "Contents", "MacOS", TRAY_PROGRAM), 0o755);
  writeFileSync(join(out, "Contents", "Info.plist"), trayInfoPlist(v));
  writeFileSync(join(out, "Contents", "Resources", "scopebond.icns"), icns());
  execFileSync("codesign", ["--force", "--sign", "-", out], { stdio: "inherit" });
  return out;
}

/** Build the package. `identity` signs it (default APPLE_INSTALLER_IDENTITY; none leaves it unsigned). */
export function buildPkg(exe = join(here, "build", "scopebond-agent"), { version, identity = process.env.APPLE_INSTALLER_IDENTITY || null, arch = process.arch, trayApp = process.env.SCOPEBOND_TRAY_APP || null } = {}) {
  if (process.platform !== "darwin") throw new Error("the macOS installer package is built on macOS");
  if (!existsSync(exe)) throw new Error(`no executable at ${exe}; build it first (build-sea.mjs)`);
  if (trayApp && !existsSync(join(trayApp, "Contents", "MacOS", TRAY_PROGRAM))) throw new Error(`no menu-bar app at ${trayApp}; build it first (build-pkg.mjs app)`);
  const v = installerVersion(version);
  const work = join(here, "build", "pkg");
  rmSync(work, { recursive: true, force: true });
  const root = join(work, "root");
  for (const file of [...PAYLOAD, ...(trayApp ? TRAY_PAYLOAD : [])]) {
    const to = join(root, file.path);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(file.from ?? exe, to);
    chmodSync(to, file.mode);
  }
  // The app as it was signed (ditto keeps its signature, modes and links).
  if (trayApp) {
    mkdirSync(join(root, "Applications"), { recursive: true });
    execFileSync("ditto", [trayApp, join(root, TRAY_APP)], { stdio: "inherit" });
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
  // The menu-bar app goes to /Applications whatever else is on the Mac: Installer would otherwise move it to where it
  // finds another copy with the same identifier (a relocatable bundle, the default), and it always replaces the one there.
  const components = [];
  if (trayApp) {
    writeFileSync(join(work, "components.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<array>
  <dict>
    <key>RootRelativeBundlePath</key><string>${TRAY_APP}</string>
    <key>BundleIsRelocatable</key><false/>
    <key>BundleIsVersionChecked</key><false/>
    <key>BundleHasStrictIdentifier</key><true/>
    <key>BundleOverwriteAction</key><string>upgrade</string>
  </dict>
</array>
</plist>
`);
    components.push("--component-plist", join(work, "components.plist"));
  }
  // Every file owned by root (--ownership recommended), installed at / exactly where PAYLOAD says.
  run("pkgbuild", ["--root", root, "--scripts", scripts, "--info", join(work, "PackageInfo"), ...components, "--identifier", PACKAGE_ID, "--version", v,
    "--install-location", "/", "--ownership", "recommended", join(work, "scopebond-agent.pkg")]);
  writeFileSync(join(work, "Distribution"), distributionXml(v, arch));
  const out = join(here, "build", `scopebond-agent-${v}-${ARCH[arch]}.pkg`);
  run("productbuild", ["--distribution", join(work, "Distribution"), "--package-path", work, "--resources", resources,
    "--version", v, ...(identity ? ["--sign", identity, "--timestamp"] : []), out]);
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.argv[2] === "app") console.log(`built ${buildTrayApp(resolve(process.argv[3]), process.argv[4] ? resolve(process.argv[4]) : undefined)}`);
  else console.log(`built ${buildPkg(process.argv[2] ? resolve(process.argv[2]) : undefined)}`);
}
