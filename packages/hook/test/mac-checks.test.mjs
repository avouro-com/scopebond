// doctor's macOS checks for the signed program: quarantine, the package's LaunchAgent and its root updater. The
// commands they run are stand-ins here, so every case runs on every platform.
import { test } from "node:test";
import assert from "node:assert/strict";
import { macInstallChecks, MAC_PACKAGE } from "../dist/index.js";

/** A Mac as the checks see it: which files exist and what each command answers. */
function mac({ quarantined = false, files = [MAC_PACKAGE.launchAgent, MAC_PACKAGE.updaterPlist, MAC_PACKAGE.updaterExe, MAC_PACKAGE.link], session = true, loaded = true, disabled = "", owners = {}, link = MAC_PACKAGE.exe } = {}) {
  const calls = [];
  return {
    calls,
    deps: {
      uid: 501,
      exists: (p) => files.includes(p),
      // Everything root's and writable by root alone, unless `owners` says otherwise for a path.
      lstat: (p) => (p in owners ? owners[p] : { uid: 0, mode: 0o755, link: false }),
      readlink: (p) => (p === MAC_PACKAGE.link ? link : null),
      run(program, args) {
        calls.push([program, ...args].join(" "));
        if (program.endsWith("xattr")) return { status: quarantined ? 0 : 1, stdout: "" };
        if (args[0] === "print" && args[1] === "gui/501") return { status: session ? 0 : 113, stdout: "" };
        if (args[0] === "print") return { status: loaded ? 0 : 113, stdout: "" };
        if (args[0] === "print-disabled") return { status: 0, stdout: disabled };
        return { status: null, stdout: "" };
      },
    },
  };
}
const byName = (checks) => Object.fromEntries(checks.map((c) => [c.name, c]));

test("the package's program: not quarantined, root's alone, its LaunchAgent loaded and its updater in place", () => {
  const { deps } = mac();
  assert.equal(MAC_PACKAGE.exe, "/Library/PrivilegedHelperTools/scopebond-agent");
  const checks = byName(macInstallChecks(MAC_PACKAGE.exe, deps));
  assert.deepEqual(Object.keys(checks), ["quarantine", "program owner", "launch agent", "updater"]);
  for (const c of Object.values(checks)) assert.equal(c.ok, true, `${c.name}: ${c.detail}`);
  assert.match(checks["launch agent"].detail, /com\.scopebond\.agent is loaded/);
});

test("a quarantined program fails with the command that clears it; a bare program gets that check only", () => {
  const { deps } = mac({ quarantined: true });
  const checks = macInstallChecks("/tmp/downloads/scopebond-agent", deps);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].ok, false);
  assert.ok(checks[0].fix.includes('xattr -d com.apple.quarantine "/tmp/downloads/scopebond-agent"'), checks[0].fix);
});

test("an agent not loaded fails with the command that starts it; autostart turned off is fine", () => {
  const off = byName(macInstallChecks(MAC_PACKAGE.exe, mac({ loaded: false }).deps))["launch agent"];
  assert.equal(off.ok, false);
  assert.ok(off.fix.includes(`launchctl bootstrap gui/501 ${MAC_PACKAGE.launchAgent}`), off.fix);
  for (const disabled of ['\t"com.scopebond.agent" => disabled\n', '\t"com.scopebond.agent" => true\n']) {
    const chosen = byName(macInstallChecks(MAC_PACKAGE.exe, mac({ loaded: false, disabled }).deps))["launch agent"];
    assert.equal(chosen.ok, true, disabled);
    assert.match(chosen.detail, /autostart is off/);
  }
  // Another label's switch is not this one's.
  assert.equal(byName(macInstallChecks(MAC_PACKAGE.exe, mac({ loaded: false, disabled: '"com.scopebond.tray" => disabled' }).deps))["launch agent"].ok, false);
});

test("without a graphical session launchd is not asked about the agent", () => {
  const { deps, calls } = mac({ session: false, loaded: false });
  const check = byName(macInstallChecks(MAC_PACKAGE.exe, deps))["launch agent"];
  assert.equal(check.ok, true);
  assert.match(check.detail, /no graphical session/);
  assert.ok(!calls.some((c) => c.includes(`gui/501/${MAC_PACKAGE.label}`)));
});

// H2 (2026-10-27 review): the package's agent ran from /usr/local/bin, which Homebrew on Intel gives to a person; launchd
// then ran whatever they put there as every user. doctor now says when anyone but root could change the program.
test("a program someone other than root could change fails, naming what and why", () => {
  const helper = "/Library/PrivilegedHelperTools";
  const cases = [
    [{ [MAC_PACKAGE.exe]: { uid: 501, mode: 0o755, link: false } }, /scopebond-agent belongs to user 501, not root/],
    [{ [helper]: { uid: 0, mode: 0o775, link: false } }, /PrivilegedHelperTools can be changed by its group \(mode 775\)/],
    [{ "/Library": { uid: 0, mode: 0o757, link: false } }, /\/Library can be changed by anyone/],
    [{ [MAC_PACKAGE.exe]: { uid: 0, mode: 0o755, link: true } }, /scopebond-agent is a link/],
    [{ [MAC_PACKAGE.exe]: null }, /scopebond-agent is missing/],
  ];
  for (const [owners, why] of cases) {
    const owner = byName(macInstallChecks(MAC_PACKAGE.exe, mac({ owners }).deps))["program owner"];
    assert.equal(owner.ok, false, JSON.stringify(owners));
    assert.match(owner.detail, why);
    assert.match(owner.fix, /install the Scopebond package again/);
  }
  // The sticky, root-owned folder macOS makes (mode 1755) is root's alone.
  assert.equal(byName(macInstallChecks(MAC_PACKAGE.exe, mac({ owners: { [helper]: { uid: 0, mode: 0o1755, link: false } } }).deps))["program owner"].ok, true);
  // An earlier package's program in /usr/local/bin itself: flagged whoever owns the folder today.
  const legacy = byName(macInstallChecks(MAC_PACKAGE.link, mac().deps));
  assert.equal(legacy["program owner"].ok, false);
  assert.match(legacy["program owner"].detail, /where earlier packages put it/);
  assert.ok(legacy["launch agent"] && legacy.updater, "the package's other checks still run");
});

test("the link on PATH must point to the package's program", () => {
  assert.equal(byName(macInstallChecks(MAC_PACKAGE.exe, mac().deps))["PATH link"], undefined, "fine: no check shown");
  assert.equal(byName(macInstallChecks(MAC_PACKAGE.exe, mac({ files: [], link: null }).deps))["PATH link"], undefined, "no link at all is fine too");
  const elsewhere = byName(macInstallChecks(MAC_PACKAGE.exe, mac({ link: "/opt/someone/evil" }).deps))["PATH link"];
  assert.equal(elsewhere.ok, false);
  assert.match(elsewhere.detail, /points to \/opt\/someone\/evil/);
  assert.ok(elsewhere.fix.includes(`sudo ln -sf ${MAC_PACKAGE.exe} ${MAC_PACKAGE.link}`), elsewhere.fix);
  const replaced = byName(macInstallChecks(MAC_PACKAGE.exe, mac({ link: null }).deps))["PATH link"];
  assert.equal(replaced.ok, false, "a file in place of the link");
});

test("a missing LaunchAgent or updater says to install the package again", () => {
  const checks = byName(macInstallChecks(MAC_PACKAGE.exe, mac({ files: [] }).deps));
  assert.equal(checks["launch agent"].ok, false);
  assert.match(checks["launch agent"].fix, /install the Scopebond package again/);
  assert.equal(checks.updater.ok, false);
  assert.match(checks.updater.fix, /install the Scopebond package again/);
});
