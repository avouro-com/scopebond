// doctor's macOS checks for the signed program: quarantine, the package's LaunchAgent and its root updater. The
// commands they run are stand-ins here, so every case runs on every platform.
import { test } from "node:test";
import assert from "node:assert/strict";
import { macInstallChecks, MAC_PACKAGE } from "../dist/index.js";

/** A Mac as the checks see it: which files exist and what each command answers. */
function mac({ quarantined = false, files = [MAC_PACKAGE.launchAgent, MAC_PACKAGE.updaterPlist, MAC_PACKAGE.updaterExe], session = true, loaded = true, disabled = "" } = {}) {
  const calls = [];
  return {
    calls,
    deps: {
      uid: 501,
      exists: (p) => files.includes(p),
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

test("the package's program: not quarantined, its LaunchAgent loaded and its updater in place", () => {
  const { deps } = mac();
  const checks = byName(macInstallChecks(MAC_PACKAGE.exe, deps));
  assert.deepEqual(Object.keys(checks), ["quarantine", "launch agent", "updater"]);
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

test("a missing LaunchAgent or updater says to install the package again", () => {
  const checks = byName(macInstallChecks(MAC_PACKAGE.exe, mac({ files: [] }).deps));
  assert.equal(checks["launch agent"].ok, false);
  assert.match(checks["launch agent"].fix, /install the Scopebond package again/);
  assert.equal(checks.updater.ok, false);
  assert.match(checks.updater.fix, /install the Scopebond package again/);
});
