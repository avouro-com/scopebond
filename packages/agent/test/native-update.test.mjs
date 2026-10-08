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
