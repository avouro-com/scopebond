// Updates for the signed Windows install: an installer is used only when the signed manifest, its digest and its
// Authenticode signature all check out; an install for every user never updates itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("the install helper is constant text; the installer, its digest, size and publisher rule reach it as environment values", async () => {
  const { installHelper, INSTALL_HELPER_SCRIPT, INSTALL_RESULT, PUBLISHER } = await import("../dist/index.js");
  const installer = { path: join("D:", "Apps", "O'Brien $x", ".scopebond", "updates", installerName(VERSION)), version: VERSION, sha256: "ab".repeat(32), size: 1234 };
  const helper = installHelper(installer, 4242, join("D:", "Apps", "launch.cmd"), { tray: join("D:", "Apps", "scopebond-tray.exe") });
  assert.match(helper.program, /System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i, "Windows PowerShell by its full path");
  assert.deepEqual(helper.args, ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", INSTALL_HELPER_SCRIPT]);
  for (const value of [installer.path, installer.sha256, "1234", VERSION, "4242", "O'Brien"]) {
    assert.ok(!INSTALL_HELPER_SCRIPT.includes(value), `the script text carries ${value}`);
  }
  assert.equal(helper.env.SB_MSI, installer.path);
  assert.equal(helper.env.SB_SHA256, installer.sha256);
  assert.equal(helper.env.SB_SIZE, "1234");
  assert.equal(helper.env.SB_VERSION, VERSION);
  assert.equal(helper.env.SB_PID, "4242");
  assert.equal(helper.env.SB_PUBLISHER, PUBLISHER.source, "the same anchored publisher rule as the first check");
  assert.equal(helper.env.SB_RESULT, join("D:", "Apps", "O'Brien $x", ".scopebond", "updates", INSTALL_RESULT));
  assert.match(helper.env.SB_MSIEXEC, /System32[\\/]msiexec\.exe$/);
  assert.equal(helper.env.SB_TRAY, join("D:", "Apps", "scopebond-tray.exe"));
  assert.equal(installHelper(installer, 4242, null).env.SB_TRAY, "", "without the native tray: none to stop or start");
  // Checked again right before installing, holding the file: size, then SHA-256, then the signature and its publisher, then msiexec.
  const at = (s) => { const i = INSTALL_HELPER_SCRIPT.indexOf(s); assert.ok(i >= 0, `the script has ${s}`); return i; };
  const order = [
    at("Stop-Process -Force"),
    at("Wait-Process -Id ([int]$env:SB_PID)"),
    at("[IO.FileShare]::Read)"),
    at("$lock.Length -ne [long]$env:SB_SIZE"),
    at("$digest -cne $env:SB_SHA256"),
    at("Get-AuthenticodeSignature -LiteralPath $env:SB_MSI"),
    at("-ne 'Valid'"),
    at("$subject -cmatch $env:SB_PUBLISHER"),
    at("if ($reason) { Write-Result $false $reason $null }"),
    at("Start-Process -FilePath $msiexec"),
    at("finally { if ($lock) { $lock.Dispose() } }"),
    at("Start-Process -FilePath $env:SB_TRAY"),
  ];
  assert.deepEqual([...order].sort((a, b) => a - b), order, "stop the tray, wait, hold, size, digest, signature, publisher, install, release, start the tray");
  assert.doesNotMatch(INSTALL_HELPER_SCRIPT, /Invoke-Expression|iex |\$\{/);
});

test("Windows PowerShell is started without another PowerShell's module path", async () => {
  const { powershellEnv } = await import("../dist/native-update.js");
  const env = powershellEnv({ SB_FILE: "x" }, { PATH: "p", PSModulePath: "C:\\Program Files\\PowerShell\\7\\Modules", psmodulepath: "y" });
  assert.deepEqual(env, { PATH: "p", SB_FILE: "x" });
});

test("a verified installer carries the manifest's digest and size, for the check right before installing", async () => {
  const k = keys();
  const dir = mkdtempSync(join(tmpdir(), "sb-update-"));
  const ok = await fetchVerifiedInstaller(VERSION, { dir, publicKey: k.pub, fetchImpl: release(k), check: signedBy("O=Avouro LLC") });
  assert.equal(ok.sha256, createHash("sha256").update(msi).digest("hex"));
  assert.equal(ok.size, msi.length);
});

// The helper itself, in Windows PowerShell, with a stand-in msiexec. A copy of this Node (signed by its own publisher) stands
// in for a signed installer; nothing is installed.
test("on Windows, the helper installs nothing and records why when the installer changed or is not signed by the publisher", { skip: process.platform !== "win32" && "Windows only", timeout: 300_000 }, async () => {
  const { authenticode, installHelper, powershellEnv, takeInstallResult } = await import("../dist/native-update.js");
  const dir = mkdtempSync(join(tmpdir(), "sb-helper-"));
  const updates = join(dir, "updates");
  mkdirSync(updates, { recursive: true });
  const fakeMsiexec = join(dir, "msiexec.cmd");
  const ran = join(dir, "msiexec-ran.txt");
  writeFileSync(fakeMsiexec, "@echo off\r\necho %*> \"%~dp0msiexec-ran.txt\"\r\nexit /b 0\r\n");
  const runHelper = (installer, publisher) => {
    rmSync(ran, { force: true });
    const h = installHelper(installer, 2 ** 31 - 2, null, { msiexec: fakeMsiexec, publisher });
    const r = spawnSync(h.program, h.args.filter((a) => a !== "-WindowStyle" && a !== "Hidden"), { encoding: "utf8", env: powershellEnv(h.env), timeout: 120_000 });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    return { result: takeInstallResult(dir), msiexec: existsSync(ran) ? readFileSync(ran, "utf8").trim() : null };
  };
  const digest = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // An unsigned file: refused for its size, its digest, then its missing signature; msiexec never runs.
  const plain = join(updates, installerName(VERSION));
  writeFileSync(plain, msi);
  const good = { path: plain, version: VERSION, sha256: digest(plain), size: msi.length };
  const wrongSize = runHelper({ ...good, size: msi.length + 1 });
  assert.equal(wrongSize.msiexec, null, "nothing installed");
  assert.equal(wrongSize.result.installed, false);
  assert.equal(wrongSize.result.version, VERSION);
  assert.match(wrongSize.result.reason, /bytes, not the manifest's/);
  const wrongDigest = runHelper({ ...good, sha256: "00".repeat(32) });
  assert.equal(wrongDigest.msiexec, null);
  assert.match(wrongDigest.result.reason, /SHA-256 is not the manifest's/);
  const unsigned = runHelper(good);
  assert.equal(unsigned.msiexec, null);
  assert.match(unsigned.result.reason, /signature is not valid/);
  assert.equal(takeInstallResult(dir), null, "the result is read once");

  // A validly signed file by someone else: refused by the anchored publisher rule; accepted only when the rule names its signer.
  const signer = authenticode(process.execPath);
  if (!signer.valid) return; // an unsigned Node build: the signed half cannot be shown here
  const copy = join(updates, "signed.msi");
  copyFileSync(process.execPath, copy);
  const signed = { path: copy, version: VERSION, sha256: digest(copy), size: readFileSync(copy).length };
  const stranger = runHelper(signed);
  assert.equal(stranger.msiexec, null);
  assert.match(stranger.result.reason, /signed by .*, not the expected publisher/);
  const org = /(?:^|,\s*)O=([^,]+)/.exec(signer.subject)?.[1];
  assert.ok(org, signer.subject);
  // Anchored to the whole field: a publisher whose name only starts the same way does not count.
  const prefix = runHelper(signed, new RegExp(`(^|,\\s*)O=${escape(org.slice(0, -1))}(,|$)`));
  assert.equal(prefix.msiexec, null);
  const installed = runHelper(signed, new RegExp(`(^|,\\s*)O=${escape(org)}(,|$)`));
  assert.equal(installed.result.installed, true, installed.result.reason);
  assert.equal(installed.result.exit_code, 0);
  assert.match(installed.msiexec, /^\/i ".*signed\.msi" \/qn \/norestart$/);
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
  assert.ok(at("Start-Process -FilePath $msiexec") >= 0, "it installs");
  assert.ok(at("Start-Process -FilePath $msiexec") < at("Start-Process -FilePath $env:SB_TRAY"), "the new tray starts the new agent");
  // The tray is started again also when nothing was installed (the check refused the installer): never left without one.
  assert.ok(at("finally { if ($lock) { $lock.Dispose() } }") < at("Start-Process -FilePath $env:SB_TRAY"));
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
