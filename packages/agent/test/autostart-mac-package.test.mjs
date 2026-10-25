// Beside the macOS installer package's LaunchAgent (/Library/LaunchAgents/com.scopebond.agent.plist), autostart is that
// LaunchAgent: `autostart on` never writes a second one with the same label, `off` disables the label for this person in
// launchd, and `status` reads launchd's disabled list. launchctl is a stand-in that records its calls; only files in a
// temp profile are created.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "sb-autostart-mac-package-"));
for (const k of ["HOME", "USERPROFILE", "SCOPEBOND_HOME"]) process.env[k] = sandbox;
const { autostartHealth, autostartPaths, disableAutostart, enableAutostart, launcherPath, macLabelDisabled, macPackage, macLaunchAgent, LABEL, MAC_PACKAGE_PLIST } = await import("../dist/index.js");

const home = join(sandbox, ".scopebond");
mkdirSync(home, { recursive: true });
const noReg = () => { throw new Error("the registry is never read on macOS"); };
/** The package installed, and a launchd whose disabled list says `state` for the label (or nothing). */
function launchd(state = null, loadedFrom = null) {
  const calls = [];
  const launchctl = (args) => {
    calls.push(args.join(" "));
    if (args[0] === "print-disabled") return { ok: true, out: `\tdisabled services = {\n\t\t"com.apple.Siri.agent" => enabled\n${state ? `\t\t"${LABEL}" => ${state}\n` : ""}\t}\n` };
    if (args[0] === "print") return loadedFrom ? { ok: true, out: `gui/501/${LABEL} = {\n\tactive count = 1\n\tpath = ${loadedFrom}\n\tstate = running\n}\n` } : { ok: false, out: "" };
    return { ok: true, out: "" };
  };
  return { mac: { plist: MAC_PACKAGE_PLIST, launchctl, uid: 501 }, calls };
}
/** A LaunchAgent of the person's own, as `autostart on` wrote it before the package. */
function ownLaunchAgent() {
  const plist = autostartPaths().macPlist;
  mkdirSync(dirname(plist), { recursive: true });
  writeFileSync(plist, macLaunchAgent(launcherPath(home, "darwin"), join(home, "agent.log")));
  writeFileSync(launcherPath(home, "darwin"), "#!/bin/sh\n", { mode: 0o700 });
  return plist;
}

test("the package's LaunchAgent path and label are the agent's own", () => {
  assert.equal(MAC_PACKAGE_PLIST, "/Library/LaunchAgents/com.scopebond.agent.plist");
  assert.equal(LABEL, "com.scopebond.agent");
  assert.equal(macPackage("linux").plist, null);
  assert.equal(macPackage("win32").plist, null);
});

test("autostart on beside the package: no LaunchAgent of the person's own, the package's enabled and started", () => {
  const own = ownLaunchAgent();
  const { mac, calls } = launchd("disabled");
  const said = enableAutostart(home, "", "/usr/local/bin/scopebond-agent", "darwin", null, noReg, mac);
  assert.equal(said, `the Scopebond package's LaunchAgent (${MAC_PACKAGE_PLIST}) starts the agent with your sign-in`);
  assert.ok(!existsSync(own), "the person's own LaunchAgent with the same label is gone");
  assert.ok(!existsSync(launcherPath(home, "darwin")), "and its launcher");
  assert.deepEqual(calls, [`print gui/501/${LABEL}`, `enable gui/501/${LABEL}`, `bootstrap gui/501 ${MAC_PACKAGE_PLIST}`]);
});

test("autostart on beside the package: the label loaded from another LaunchAgent gives way; the package's own stays", () => {
  const own = ownLaunchAgent();
  const fromOwn = launchd(null, own);
  enableAutostart(home, "", "/usr/local/bin/scopebond-agent", "darwin", null, noReg, fromOwn.mac);
  assert.deepEqual(fromOwn.calls, [`print gui/501/${LABEL}`, `bootout gui/501/${LABEL}`, `enable gui/501/${LABEL}`, `bootstrap gui/501 ${MAC_PACKAGE_PLIST}`]);
  // Already running from the package's LaunchAgent (the agent itself turning autostart on): never booted out.
  const fromPackage = launchd(null, MAC_PACKAGE_PLIST);
  enableAutostart(home, "", "/usr/local/bin/scopebond-agent", "darwin", null, noReg, fromPackage.mac);
  assert.ok(!fromPackage.calls.some((c) => c.startsWith("bootout")), fromPackage.calls.join("; "));
});

test("autostart off beside the package: the label disabled for this person, the agent launchd runs stopped", () => {
  const own = ownLaunchAgent();
  const { mac, calls } = launchd();
  const said = disableAutostart(home, "darwin", null, noReg, mac);
  assert.equal(said, `launchd no longer starts the Scopebond package's LaunchAgent at your sign-in (scopebond-agent autostart on turns it back on)`);
  assert.ok(!existsSync(own));
  assert.deepEqual(calls, [`disable gui/501/${LABEL}`, `bootout gui/501/${LABEL}`]);
});

test("status beside the package: on unless launchd has the label disabled for this person", () => {
  for (const state of [null, "enabled"]) {
    const { mac } = launchd(state);
    assert.deepEqual(autostartHealth(home, "darwin", null, noReg, () => null, mac),
      { on: true, ok: true, detail: "starts with sign-in (the Scopebond package's LaunchAgent, for every user of this Mac)" }, String(state));
  }
  // `disabled`, or `true` as older macOS prints it.
  for (const state of ["disabled", "true"]) {
    const { mac } = launchd(state);
    assert.equal(macLabelDisabled(mac), true, state);
    assert.deepEqual(autostartHealth(home, "darwin", null, noReg, () => null, mac),
      { on: false, ok: false, detail: "the agent does not start with your sign-in: it is turned off for you (run: scopebond-agent autostart on)" }, state);
  }
});
