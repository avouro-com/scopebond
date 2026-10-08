// Updates for the signed Windows install: an installer is used only when the signed manifest, its digest and its
// Authenticode signature all check out; an install for every user never updates itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchVerifiedInstaller, installKind, installerName, MANIFEST_DOMAIN, verifyManifest } from "../dist/index.js";

const keys = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { pub: publicKey.export({ type: "spki", format: "der" }).toString("base64"), priv: privateKey };
};
const VERSION = "9.9.9";
const msi = Buffer.from("an installer's bytes");

function release(k, { bytes = msi, version = VERSION, signWith = k.priv } = {}) {
  const text = `${JSON.stringify({ type: "scopebond:agent-release", version, files: [{ name: installerName(VERSION), sha256: createHash("sha256").update(msi).digest("hex"), size: msi.length }] })}\n`;
  const sig = sign(null, Buffer.from(MANIFEST_DOMAIN + text), signWith).toString("base64");
  const files = { [`scopebond-agent-${VERSION}.manifest.json`]: text, [`scopebond-agent-${VERSION}.manifest.json.sig`]: sig, [installerName(VERSION)]: bytes };
  return async (url) => {
    const name = url.split("/").pop();
    return name in files ? new Response(files[name]) : new Response("not found", { status: 404 });
  };
}
const signedBy = (subject) => () => ({ valid: true, subject });

test("the install kind: npm, per user, or for every user in Program Files", () => {
  assert.equal(installKind("C:\\x\\node.exe", false), "npm");
  assert.equal(installKind("C:\\Users\\a\\AppData\\Local\\Programs\\Scopebond\\scopebond-agent.exe", true, "C:\\Program Files"), "per-user");
  assert.equal(installKind("C:\\Program Files\\Scopebond\\scopebond-agent.exe", true, "C:\\Program Files"), "per-machine");
});

test("a release is installed only when the manifest, the digest and the publisher all check out", async () => {
  const k = keys();
  const dir = mkdtempSync(join(tmpdir(), "sb-update-"));
  const ok = await fetchVerifiedInstaller(VERSION, { dir, publicKey: k.pub, fetchImpl: release(k), check: signedBy("CN=Avouro LLC, O=Avouro LLC, L=Okemos, S=Michigan, C=US") });
  assert.equal(ok.ok, true, ok.reason);
  assert.ok(existsSync(ok.path));

  const tampered = await fetchVerifiedInstaller(VERSION, { dir, publicKey: k.pub, fetchImpl: release(k, { bytes: Buffer.from("an installer's byteZ") }), check: signedBy("O=Avouro LLC") });
  assert.deepEqual(tampered, { ok: false, reason: "the installer is not the one the manifest names" });

  const forged = await fetchVerifiedInstaller(VERSION, { dir, publicKey: k.pub, fetchImpl: release(k, { signWith: keys().priv }), check: signedBy("O=Avouro LLC") });
  assert.deepEqual(forged, { ok: false, reason: "the release manifest is not signed by the updater key" });

  const otherVersion = await fetchVerifiedInstaller(VERSION, { dir, publicKey: k.pub, fetchImpl: release(k, { version: "9.9.8" }), check: signedBy("O=Avouro LLC") });
  assert.match(otherVersion.reason, /for 9\.9\.8, not 9\.9\.9/);

  const unsigned = await fetchVerifiedInstaller(VERSION, { dir, publicKey: k.pub, fetchImpl: release(k), check: () => ({ valid: false, subject: "" }) });
  assert.deepEqual(unsigned, { ok: false, reason: "the installer's signature is not valid" });

  const stranger = await fetchVerifiedInstaller(VERSION, { dir, publicKey: k.pub, fetchImpl: release(k), check: signedBy("CN=Someone, O=Someone Else LLC") });
  assert.match(stranger.reason, /signed by CN=Someone, O=Someone Else LLC, not Avouro LLC/);

  const noKey = await fetchVerifiedInstaller(VERSION, { dir, publicKey: null, fetchImpl: release(k), check: signedBy("O=Avouro LLC") });
  assert.deepEqual(noKey, { ok: false, reason: "this build has no updater key" });

  const missing = await fetchVerifiedInstaller(VERSION, { dir, publicKey: k.pub, fetchImpl: async () => new Response("", { status: 404 }), check: signedBy("O=Avouro LLC") });
  assert.deepEqual(missing, { ok: false, reason: "the release has no signed manifest" });
});

test("on Windows, the Authenticode check reads Windows' own verdict and the signer", { skip: process.platform !== "win32" && "Windows only" }, async () => {
  const { authenticode, PUBLISHER } = await import("../dist/native-update.js");
  // A Windows program is never Avouro LLC's, whatever Windows reports about it (Notepad may be catalog-signed).
  const notepad = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "notepad.exe");
  assert.equal(PUBLISHER.test(authenticode(notepad).subject), false);
  assert.deepEqual(authenticode(join(mkdtempSync(join(tmpdir(), "sb-ac-")), "nothing.msi")), { valid: false, subject: "" });
});

test("the manifest's signature covers its exact bytes, in its own domain", () => {
  const k = keys();
  const text = `${JSON.stringify({ type: "scopebond:agent-release", version: VERSION, files: [] })}\n`;
  const good = sign(null, Buffer.from(MANIFEST_DOMAIN + text), k.priv).toString("base64");
  assert.ok(verifyManifest(text, good, k.pub));
  assert.equal(verifyManifest(text.replace("9.9.9", "9.9.0"), good, k.pub), null);
  const plain = sign(null, Buffer.from(text), k.priv).toString("base64");
  assert.equal(verifyManifest(text, plain, k.pub), null, "a signature over the bare text (another use of the key) does not count");
});

test("the native tray beside the single executable, and only there", async () => {
  const { nativeTrayPath } = await import("../dist/index.js");
  const exe = "D:\\Programs\\Scopebond\\scopebond-agent.exe";
  assert.equal(nativeTrayPath(exe, true, () => true), "D:\\Programs\\Scopebond\\scopebond-tray.exe");
  assert.equal(nativeTrayPath(exe, true, () => false), null, "an install without the tray");
  assert.equal(nativeTrayPath("D:\\node\\node.exe", false, () => true), null, "npm installs keep the PowerShell tray");
});

test("after an update the helper stops the tray first, installs, then starts the tray again", async () => {
  const { installAfterExitScript } = await import("../dist/index.js");
  const script = installAfterExitScript();
  const at = (s) => script.indexOf(s);
  assert.ok(at("Stop-Process") >= 0 && at("Stop-Process") < at("Wait-Process"), "the tray would otherwise start the old agent again");
  assert.match(script, /Where-Object \{ \$_\.Path -eq \$env:SB_TRAY \}/, "only this install's tray");
  assert.ok(at("msiexec.exe") < at("Start-Process -FilePath $env:SB_TRAY"), "the new tray starts the new agent");
  assert.match(script, /elseif \(\$env:SB_LAUNCHER\)/, "without the tray, the launcher as before");
  assert.doesNotMatch(script, /scopebond-agent\.exe|Programs/, "paths reach it as environment variables only");
});

test("beside the native tray, autostart is the tray's Run value and the launcher's is retired", async () => {
  const { enableAutostart, disableAutostart, autostartHealth, startNow, TRAY_RUN_VALUE } = await import("../dist/index.js");
  const tray = "D:\\Programs\\Scopebond\\scopebond-tray.exe";
  const fakeReg = (values) => {
    const calls = [];
    const reg = (args) => {
      calls.push(args.join(" "));
      const [verb, key, , name] = args;
      const id = `${key.startsWith("HKLM") ? "HKLM" : "HKCU"}:${name}`;
      if (verb === "query") return values.has(id);
      if (verb === "delete") return values.delete(id);
      if (verb === "add") { values.add(id); return true; }
      return false;
    };
    return { reg, calls, values };
  };
  const home = mkdtempSync(join(tmpdir(), "sb-tray-autostart-"));
  const user = fakeReg(new Set(["HKCU:ScopebondAgent"]));
  assert.match(enableAutostart(home, "", "x", "win32", tray, user.reg), new RegExp(`added ${TRAY_RUN_VALUE}`));
  assert.deepEqual([...user.values], [`HKCU:${TRAY_RUN_VALUE}`], "the launcher's ScopebondAgent value is gone");
  assert.ok(user.calls.some((c) => c.includes(`/d "${tray}"`)), "the tray's path, quoted");
  assert.equal(existsSync(join(home, "agent-launch.cmd")), false, "no launcher is written");
  assert.equal(autostartHealth(home, "win32", tray, user.reg).ok, true);
  assert.match(disableAutostart(home, "win32", tray, user.reg), new RegExp(`removed ${TRAY_RUN_VALUE}`));
  assert.equal(autostartHealth(home, "win32", tray, user.reg).on, false);
  // Installed for every user: the machine's value starts it, and this user's is never added.
  const machine = fakeReg(new Set([`HKLM:${TRAY_RUN_VALUE}`]));
  assert.match(enableAutostart(home, "", "x", "win32", tray, machine.reg), /every user/);
  assert.ok(!machine.calls.some((c) => c.startsWith("add")));
  assert.equal(autostartHealth(home, "win32", tray, machine.reg).on, true);
  assert.match(disableAutostart(home, "win32", tray, machine.reg), /whoever installed it/);
  assert.equal(startNow(home, "win32", 1, tray), false, "one way to start it: the tray");
});
