// The macOS installer package: what it installs, its LaunchAgent and its scripts. The files it is made from are checked
// everywhere; the package itself is built and taken apart (`pkgutil --expand-full`, nothing installed) where
// SCOPEBOND_PKG=1 says so on macOS: the macOS CI job, after it has built the single executable. Installing it and
// removing it again changes the computer (files for every user, a LaunchAgent, the agent started for the person signed
// in), so that runs only where SCOPEBOND_PKG_INSTALL=1 says so as well: the macOS CI job, on a throwaway runner.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FIRST_SIGNIN_FILE, LABEL, MAC_PACKAGE_EXE, MAC_PACKAGE_UNINSTALL, MAC_UPDATER_COMMAND, MAC_UPDATER_LABEL, MAC_UPDATER_PATHS, MAC_UPDATER_PLIST } from "@scopebond/agent";
import { buildSea } from "../build-sea.mjs";
import { buildPkg, distributionXml, MIN_MACOS, PACKAGE_ID, PAYLOAD } from "../build-pkg.mjs";
import { installerVersion } from "../version.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const macos = join(here, "..", "macos");
const enabled = process.platform === "darwin" && process.env.SCOPEBOND_PKG === "1";
const read = (...p) => readFileSync(join(macos, ...p), "utf8");
/** `s` as a regular expression that matches it literally. */
const literal = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const PLIST_PATH = `/Library/LaunchAgents/${LABEL}.plist`;
const UNINSTALL_PATH = "/Library/Application Support/Scopebond/uninstall.sh";

test("the package's files agree with the agent: its path, its autostart label and its removal command", () => {
  assert.deepEqual(PAYLOAD.map((f) => `/${f.path}`), [MAC_PACKAGE_EXE, PLIST_PATH, MAC_UPDATER_PLIST, UNINSTALL_PATH]);
  // The updater the package runs as root: the agent's own command, started when a request lands in the agent's folder.
  const daemon = read("com.scopebond.updater.plist");
  assert.ok(daemon.includes(`<key>Label</key><string>${MAC_UPDATER_LABEL}</string>`));
  assert.ok(daemon.includes(`<string>${MAC_PACKAGE_EXE}</string>\n    <string>${MAC_UPDATER_COMMAND}</string>`));
  assert.ok(daemon.includes(`<array><string>${MAC_UPDATER_PATHS.requests}</string></array>`), "WatchPaths is the requests folder");
  const postinstall = read("scripts", "postinstall");
  assert.ok(postinstall.includes('/bin/chmod 1733 "$SUPPORT/update-requests"') && postinstall.includes('/bin/chmod 0700 "$SUPPORT/updater"'));
  assert.equal(`/Library/Application Support/Scopebond/update-requests`, MAC_UPDATER_PATHS.requests);
  assert.match(read("uninstall.sh"), /launchctl bootout "system\/\$UPDATER"/);
  assert.equal(MAC_PACKAGE_UNINSTALL, `sudo "${UNINSTALL_PATH}"`);
  const plist = read("com.scopebond.agent.plist");
  assert.match(plist, new RegExp(`<key>Label</key><string>${literal(LABEL)}</string>`));
  assert.ok(plist.includes(`exec ${MAC_PACKAGE_EXE} run</string>`), "it runs the installed executable's `run`");
  for (const script of [read("scripts", "preinstall"), read("scripts", "postinstall"), read("uninstall.sh")]) {
    assert.ok(script.startsWith("#!/bin/sh\n"));
    assert.ok(script.includes(`LABEL=${LABEL}\n`), "every script names the same label");
  }
  assert.match(read("scripts", "postinstall"), /launchctl bootstrap "gui\/\$uid" "\$PLIST"/);
  assert.match(read("scripts", "preinstall"), /launchctl bootout "gui\/\$uid\/\$LABEL"/);
  const uninstall = read("uninstall.sh");
  assert.ok(uninstall.includes(`EXE=${MAC_PACKAGE_EXE}\n`) && uninstall.includes(`PACKAGE_ID=${PACKAGE_ID}\n`));
  assert.ok(uninstall.includes("SCOPEBOND_UNINSTALL_CALLER=macos-package"), "the script says the folder sentence itself");
});

test("the Distribution: one package at the agent's version, for this architecture and macOS 11 or later", () => {
  const v = installerVersion();
  const xml = distributionXml(v, "arm64");
  assert.match(xml, new RegExp(`<pkg-ref id="${literal(PACKAGE_ID)}" version="${literal(v)}" onConclusion="none">#scopebond-agent\\.pkg</pkg-ref>`));
  assert.match(xml, /hostArchitectures="arm64"/);
  assert.match(distributionXml(v, "x64"), /hostArchitectures="x86_64"/);
  assert.match(xml, new RegExp(`<os-version min="${MIN_MACOS}"/>`));
  assert.match(xml, /enable_localSystem="true" enable_anywhere="false" enable_currentUserHome="false"/);
  assert.throws(() => distributionXml(v, "ia32"), /no macOS installer for the ia32 architecture/);
});

test("the scripts are valid sh", { skip: process.platform === "win32" && "no /bin/sh" }, () => {
  for (const script of [join(macos, "scripts", "preinstall"), join(macos, "scripts", "postinstall"), join(macos, "uninstall.sh")]) {
    const r = spawnSync("/bin/sh", ["-n", script], { encoding: "utf8" });
    assert.equal(r.status, 0, `${script}: ${r.stderr}`);
  }
});

test("the uninstall script refuses to run without an administrator, and an unknown option, before it touches anything", { skip: (process.platform === "win32" || process.getuid?.() === 0) && "runs as a person without administrator rights" }, () => {
  const script = join(macos, "uninstall.sh");
  const plain = spawnSync("/bin/sh", [script], { encoding: "utf8" });
  assert.equal(plain.status, 1);
  assert.match(plain.stderr, /needs an administrator: sudo "\/Library\/Application Support\/Scopebond\/uninstall\.sh"/);
  const purge = spawnSync("/bin/sh", [script, "--purge"], { encoding: "utf8" });
  assert.equal(purge.status, 1);
  assert.match(purge.stderr, /uninstall\.sh" --purge\n$/);
  const other = spawnSync("/bin/sh", [script, "--all"], { encoding: "utf8" });
  assert.equal(other.status, 2);
  assert.match(other.stderr, /^usage: /);
});

test("the package installs the executable, the LaunchAgent and the uninstall script, owned by root, with its scripts", { skip: !enabled && "set SCOPEBOND_PKG=1 on macOS to build and take apart the package", timeout: 10 * 60_000 }, async () => {
  const built = join(here, "..", "build", "scopebond-agent");
  const exe = existsSync(built) ? built : await buildSea();
  const v = installerVersion();
  const pkg = buildPkg(exe, { identity: null });
  assert.equal(pkg, join(here, "..", "build", `scopebond-agent-${v}-${process.arch === "arm64" ? "arm64" : "x86_64"}.pkg`));
  // Unsigned without an identity, as the Windows build job's files are (the release workflow signs it).
  const signature = spawnSync("pkgutil", ["--check-signature", pkg], { encoding: "utf8" });
  assert.notEqual(signature.status, 0);
  assert.match(signature.stdout, /Status: no signature/);

  const out = join(mkdtempSync(join(tmpdir(), "sb-pkg-")), "expanded");
  const expand = spawnSync("pkgutil", ["--expand-full", pkg, out], { encoding: "utf8" });
  assert.equal(expand.status, 0, expand.stderr);
  assert.deepEqual(readdirSync(out).sort(), ["Distribution", "Resources", "scopebond-agent.pkg"]);
  // productbuild writes the Distribution again, with the sizes it measured: what the build said is still there.
  const distribution = readFileSync(join(out, "Distribution"), "utf8");
  assert.match(distribution, new RegExp(`<pkg-ref id="${literal(PACKAGE_ID)}" version="${literal(v)}" onConclusion="none"[^>]*>#scopebond-agent\\.pkg</pkg-ref>`));
  assert.match(distribution, new RegExp(`hostArchitectures="${process.arch === "arm64" ? "arm64" : "x86_64"}"`));
  assert.match(distribution, /customize="never" require-scripts="true"/);
  assert.match(distribution, /<conclusion file="conclusion\.txt" mime-type="text\/plain"\/>/);
  assert.equal(readFileSync(join(out, "Resources", "conclusion.txt"), "utf8"), read("conclusion.txt"));
  const component = join(out, "scopebond-agent.pkg");
  const info = readFileSync(join(component, "PackageInfo"), "utf8");
  assert.match(info, new RegExp(`identifier="${literal(PACKAGE_ID)}"`));
  assert.match(info, new RegExp(`version="${literal(v)}"`));
  assert.match(info, /install-location="\/"/);
  assert.match(info, /overwrite-permissions="false"/, "existing folders keep their owner and mode");
  assert.match(info, /relocatable="false"/);
  assert.match(info, /<preinstall file="\.\/preinstall"[^>]*\/>/);
  assert.match(info, /<postinstall file="\.\/postinstall"[^>]*\/>/);

  // Exactly these files, each owned by root:wheel with its mode (the bill of materials is what Installer writes).
  const bom = spawnSync("lsbom", ["-p", "fMUG", join(component, "Bom")], { encoding: "utf8" });
  assert.equal(bom.status, 0, bom.stderr);
  // Not counted: the `._` entries pkgbuild adds where the build's own files carry extended attributes (macOS gives files
  // written under some apps com.apple.provenance, which nobody can remove). Installer turns them back into attributes of
  // the file they belong to; they are never files on the Mac.
  const files = bom.stdout.trim().split("\n").map((line) => line.split("\t").map((field) => field.trim()))
    .filter(([path, mode]) => mode.startsWith("-") && !path.split("/").at(-1).startsWith("._"));
  assert.deepEqual(files.map(([path, mode, user, group]) => [path, mode, user, group]).sort(), [
    ["./Library/Application Support/Scopebond/uninstall.sh", "-rwxr-xr-x", "root", "wheel"],
    ["./Library/LaunchAgents/com.scopebond.agent.plist", "-rw-r--r--", "root", "wheel"],
    ["./Library/LaunchDaemons/com.scopebond.updater.plist", "-rw-r--r--", "root", "wheel"],
    ["./usr/local/bin/scopebond-agent", "-rwxr-xr-x", "root", "wheel"],
  ]);

  // The payload's executable is the one given, still signed, and it runs.
  const payload = join(component, "Payload");
  const installed = join(payload, "usr", "local", "bin", "scopebond-agent");
  assert.equal(sha256(installed), sha256(exe));
  const verify = spawnSync("codesign", ["--verify", "--strict", installed], { encoding: "utf8" });
  assert.equal(verify.status, 0, verify.stderr);
  const version = spawnSync(installed, ["--version"], { encoding: "utf8" });
  assert.equal(version.status, 0, version.stderr);
  assert.ok(version.stdout.startsWith(`agent/${v} hook/`), version.stdout);

  // The LaunchAgent: a valid property list that runs `scopebond-agent run` for each person, restarting it after a crash.
  const plist = join(payload, "Library", "LaunchAgents", "com.scopebond.agent.plist");
  const lint = spawnSync("plutil", ["-lint", plist], { encoding: "utf8" });
  assert.equal(lint.status, 0, lint.stdout);
  const agent = JSON.parse(spawnSync("plutil", ["-convert", "json", "-o", "-", plist], { encoding: "utf8" }).stdout);
  assert.deepEqual(agent, {
    Label: LABEL,
    ProgramArguments: ["/bin/sh", "-c", `SCOPEBOND_AGENT_LOG="\${SCOPEBOND_HOME:-$HOME/.scopebond}/agent.log" exec ${MAC_PACKAGE_EXE} run`],
    RunAtLoad: true,
    KeepAlive: { SuccessfulExit: false },
    ThrottleInterval: 30,
    LimitLoadToSessionType: "Aqua",
    ProcessType: "Background",
  });
  assert.equal(readFileSync(join(payload, "Library", "Application Support", "Scopebond", "uninstall.sh"), "utf8"), read("uninstall.sh"));
  const updater = join(payload, "Library", "LaunchDaemons", "com.scopebond.updater.plist");
  assert.equal(spawnSync("plutil", ["-lint", updater], { encoding: "utf8" }).status, 0);
  assert.deepEqual(JSON.parse(spawnSync("plutil", ["-convert", "json", "-o", "-", updater], { encoding: "utf8" }).stdout), {
    Label: MAC_UPDATER_LABEL,
    ProgramArguments: [MAC_PACKAGE_EXE, MAC_UPDATER_COMMAND],
    WatchPaths: [MAC_UPDATER_PATHS.requests],
    ThrottleInterval: 60,
    ProcessType: "Background",
    StandardOutPath: "/Library/Logs/Scopebond-updater.log",
    StandardErrorPath: "/Library/Logs/Scopebond-updater.log",
  });

  // The scripts Installer runs, as they are in the repository and executable.
  const scripts = join(component, "Scripts");
  assert.deepEqual(readdirSync(scripts).sort(), ["postinstall", "preinstall"]);
  for (const name of ["preinstall", "postinstall"]) {
    assert.equal(readFileSync(join(scripts, name), "utf8"), read("scripts", name));
    assert.equal(statSync(join(scripts, name)).mode & 0o111, 0o111, `${name} is executable`);
  }
});

test("with APPLE_INSTALLER_IDENTITY the package is signed by that Developer ID Installer identity", { skip: (!enabled || !process.env.APPLE_INSTALLER_IDENTITY) && "set SCOPEBOND_PKG=1 and APPLE_INSTALLER_IDENTITY on macOS (the release job)" }, () => {
  const pkg = buildPkg(join(here, "..", "build", "scopebond-agent"));
  const signature = spawnSync("pkgutil", ["--check-signature", pkg], { encoding: "utf8" });
  assert.equal(signature.status, 0, signature.stdout);
  assert.match(signature.stdout, /Developer ID Installer: /);
  assert.ok(signature.stdout.includes(process.env.APPLE_INSTALLER_IDENTITY.replace(/^Developer ID Installer: /, "")), signature.stdout);
});

const installs = enabled && process.env.SCOPEBOND_PKG_INSTALL === "1";
const sudo = (args) => spawnSync("sudo", ["-n", ...args], { encoding: "utf8" });
const loaded = (uid) => spawnSync("launchctl", ["print", `gui/${uid}/${LABEL}`], { encoding: "utf8" });
/** Whether this person has a graphical session, where the LaunchAgent runs (a CI runner signs its user in). */
const signedIn = (uid) => spawnSync("/bin/ps", ["-axo", "uid=,comm="], { encoding: "utf8" }).stdout
  .split("\n").some((line) => { const [u, comm] = line.trim().split(/\s+/, 2); return Number(u) === uid && /\/loginwindow$/.test(comm ?? ""); });
const waitFor = async (check, ms) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) return false;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return true;
};

test("the package installs for every user and starts the agent, and its uninstall script leaves nothing", { skip: !installs && "macOS CI only (SCOPEBOND_PKG=1 SCOPEBOND_PKG_INSTALL=1): it installs on this computer", timeout: 10 * 60_000 }, async () => {
  assert.equal(sudo(["true"]).status, 0, "needs sudo without a password (a CI runner)");
  const pkg = buildPkg(join(here, "..", "build", "scopebond-agent"), { identity: null });
  // The agent the package starts would sign this never-connected computer in to Scopebond Cloud on its first start and
  // open the browser: marked as done already, so the runner never sends a real sign-in request.
  const home = process.env.SCOPEBOND_HOME ?? join(homedir(), ".scopebond");
  mkdirSync(home, { recursive: true });
  if (!existsSync(join(home, FIRST_SIGNIN_FILE))) writeFileSync(join(home, FIRST_SIGNIN_FILE), "{}\n");
  const uid = process.getuid();
  const removed = () => sudo([UNINSTALL_PATH]);
  const install = sudo(["installer", "-pkg", pkg, "-target", "/"]);
  // Never leave the install behind for the next job step, whatever this test finds.
  if (install.status !== 0) removed();
  assert.equal(install.status, 0, install.stdout + install.stderr);
  try {
    for (const file of [MAC_PACKAGE_EXE, PLIST_PATH, MAC_UPDATER_PLIST, UNINSTALL_PATH]) {
      assert.ok(existsSync(file), `installed: ${file}`);
      assert.equal(statSync(file).uid, 0, `${file} belongs to root`);
    }
    const version = spawnSync(MAC_PACKAGE_EXE, ["--version"], { encoding: "utf8" });
    assert.equal(version.status, 0, version.stderr);
    assert.equal(spawnSync("pkgutil", ["--pkg-info", PACKAGE_ID], { encoding: "utf8" }).status, 0, "the receipt");
    // The updater: loaded as root, its requests folder writable by everyone and readable by root alone, its own folder
    // root's. A request this person leaves starts it; a release that does not exist is refused, and the result says so.
    assert.equal(sudo(["launchctl", "print", `system/${MAC_UPDATER_LABEL}`]).status, 0, "the updater is loaded");
    assert.equal(statSync(MAC_UPDATER_PATHS.requests).mode & 0o7777, 0o1733);
    assert.equal(statSync(MAC_UPDATER_PATHS.work).mode & 0o7777, 0o700);
    assert.equal(spawnSync("/bin/ls", [MAC_UPDATER_PATHS.requests]).status, 1, "nobody else can list the requests");
    writeFileSync(join(MAC_UPDATER_PATHS.requests, `${uid}-0123456789abcdef.json`), JSON.stringify({ version: "99.0.0" }));
    const result = () => { try { return JSON.parse(readFileSync(MAC_UPDATER_PATHS.result, "utf8")); } catch { return null; } };
    assert.ok(await waitFor(() => result()?.version === "99.0.0", 90_000), `the updater ran: ${readFileSync("/Library/Logs/Scopebond-updater.log", "utf8").slice(-2000)}`);
    assert.equal(result().installed, false);
    assert.match(result().reason, /no signed manifest/, "a release that does not exist installs nothing");
    if (signedIn(uid)) {
      // postinstall started it for the person signed in; launchd runs it as that person.
      assert.ok(await waitFor(() => /state = running/.test(loaded(uid).stdout), 30_000), loaded(uid).stdout + loaded(uid).stderr);
      const status = spawnSync(MAC_PACKAGE_EXE, ["status", "--json"], { encoding: "utf8" });
      assert.equal(status.status, 0, status.stderr);
      // Autostart is the package's LaunchAgent: on, off for this person in launchd, and on again, with no LaunchAgent of
      // the person's own.
      const autostart = () => JSON.parse(spawnSync(MAC_PACKAGE_EXE, ["status", "--json"], { encoding: "utf8" }).stdout).autostart;
      assert.deepEqual(autostart(), { on: true, ok: true, detail: "starts with sign-in (the Scopebond package's LaunchAgent, for every user of this Mac)" });
      const own = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
      const off = spawnSync(MAC_PACKAGE_EXE, ["autostart", "off"], { encoding: "utf8" });
      assert.equal(off.status, 0, off.stderr);
      assert.equal(autostart().on, false, off.stdout);
      assert.ok(await waitFor(() => loaded(uid).status !== 0, 15_000), "autostart off stops the agent launchd ran");
      const on = spawnSync(MAC_PACKAGE_EXE, ["autostart", "on"], { encoding: "utf8" });
      assert.equal(on.status, 0, on.stderr);
      assert.deepEqual(autostart(), { on: true, ok: true, detail: "starts with sign-in (the Scopebond package's LaunchAgent, for every user of this Mac)" });
      assert.ok(await waitFor(() => /state = running/.test(loaded(uid).stdout), 30_000), "autostart on starts it again");
      assert.ok(!existsSync(own), "no LaunchAgent of the person's own");
    } else console.log(`no graphical session for uid ${uid}: the LaunchAgent starts at the next sign-in, not checked here`);
  } catch (error) { removed(); throw error; }

  const uninstall = removed();
  assert.ok(uninstall.status === 0 || uninstall.status === 75, `exit ${uninstall.status}: ${uninstall.stdout}${uninstall.stderr}`);
  assert.match(uninstall.stdout, /Removed the Scopebond Agent/);
  assert.match(uninstall.stdout, /Your Scopebond folder .* stays|No Scopebond folder is left/, "the last sentence names the folder");
  for (const file of [MAC_PACKAGE_EXE, PLIST_PATH, MAC_UPDATER_PLIST, dirname(UNINSTALL_PATH)]) assert.ok(!existsSync(file), `removed: ${file}`);
  assert.notEqual(sudo(["launchctl", "print", `system/${MAC_UPDATER_LABEL}`]).status, 0, "the updater is no longer loaded");
  assert.notEqual(spawnSync("pkgutil", ["--pkg-info", PACKAGE_ID], { encoding: "utf8" }).status, 0, "the receipt is forgotten");
  assert.notEqual(loaded(uid).status, 0, "launchd no longer has the agent");
  assert.ok(await waitFor(() => spawnSync("pgrep", ["-f", MAC_PACKAGE_EXE]).status !== 0, 15_000), "no agent left running");
});
