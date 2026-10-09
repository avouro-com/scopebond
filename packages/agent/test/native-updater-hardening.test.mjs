// The signed native updater: replayed manifests are refused, the updater key can be rotated (a list of keys, each with a
// key id and an optional last day of use), and the installer is checked again right before it runs (no network, no
// msiexec; the Authenticode check is stubbed where it would need a signed file).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchVerifiedInstaller, installerName, installerUnchanged, installHelperScript, installerRecheckScript, keyId, MANIFEST_DOMAIN, verifyManifest, windowsTool } from "../dist/index.js";

const newKey = () => {
  const k = generateKeyPairSync("ed25519");
  const pub = k.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  return { pub, priv: k.privateKey, kid: keyId(pub) };
};
const k = newKey();
const msi = Buffer.from("genuine signed installer bytes");

function signedRelease(version, { bytes = msi, key = k, kid } = {}) {
  const body = { type: "scopebond:agent-release", version, ...(kid ? { kid } : {}), files: [{ name: installerName(version), sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length }] };
  const text = `${JSON.stringify(body)}\n`;
  return { text, sig: sign(null, Buffer.from(MANIFEST_DOMAIN + text), key.priv).toString("base64"), bytes };
}
const serve = (map) => async (url) => { const name = url.split("/").pop(); return name in map ? new Response(map[name]) : new Response("no", { status: 404 }); };
const files = (version, rel) => ({ [`scopebond-agent-${version}.manifest.json`]: rel.text, [`scopebond-agent-${version}.manifest.json.sig`]: rel.sig, [installerName(version)]: rel.bytes });
const avouro = () => ({ valid: true, subject: "CN=Avouro LLC, O=Avouro LLC" });

test("replay: an older genuinely-signed manifest served under a newer version's name is refused", async () => {
  const old = signedRelease("0.5.0");
  const r = await fetchVerifiedInstaller("0.6.0", {
    dir: mkdtempSync(join(tmpdir(), "sb-native-replay-")), publicKey: k.pub, check: avouro,
    fetchImpl: serve({ "scopebond-agent-0.6.0.manifest.json": old.text, "scopebond-agent-0.6.0.manifest.json.sig": old.sig, [installerName("0.5.0")]: old.bytes, [installerName("0.6.0")]: old.bytes }),
  });
  assert.equal(r.ok, false); assert.match(r.reason, /manifest is for 0\.5\.0/);
});

test("the installer is checked again right before it runs: a replacement after the first check is caught", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-native-recheck-"));
  const rel = signedRelease("0.6.0");
  const r = await fetchVerifiedInstaller("0.6.0", { dir, publicKey: k.pub, check: avouro, fetchImpl: serve(files("0.6.0", rel)) });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.path, join(dir, "updates", installerName("0.6.0")));
  assert.equal(r.sha256, createHash("sha256").update(msi).digest("hex"), "the result carries the digest to check again");
  assert.equal(r.size, msi.length);
  assert.equal(installerUnchanged(r, avouro), true);
  writeFileSync(r.path, "replaced");
  assert.equal(installerUnchanged(r, avouro), false, "a same-user replacement is caught before the helper starts");
  writeFileSync(r.path, msi);
  assert.equal(installerUnchanged(r, () => ({ valid: false, subject: "" })), false, "the signature is checked again too");
  // The helper that runs msiexec checks digest, size and signature itself, from a handle that keeps the file from being
  // changed, before it starts msiexec; and it starts Windows' own tools by their full paths.
  const script = installHelperScript();
  const at = (s) => { const i = script.indexOf(s); assert.ok(i >= 0, `the helper has ${s}`); return i; };
  assert.ok(at("FileShare]::Read") < at("msiexec.exe"));
  assert.ok(at("SB_SHA256") < at("msiexec.exe"));
  assert.ok(at("Get-AuthenticodeSignature") < at("msiexec.exe"));
  assert.match(script, /System32\\msiexec\.exe/);
  assert.match(windowsTool("powershell"), /System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/);
});

test("on Windows, the helper's own check refuses a replaced or unsigned installer", { skip: process.platform !== "win32" && "Windows only" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-native-ps-"));
  const file = join(dir, installerName("0.6.0"));
  writeFileSync(file, msi);
  const run = (sha256, size) => spawnSync(windowsTool("powershell"), ["-NoProfile", "-NonInteractive", "-Command", installerRecheckScript()], {
    encoding: "utf8", windowsHide: true, timeout: 60_000, env: { ...process.env, SB_MSI: file, SB_SHA256: sha256, SB_SIZE: String(size) },
  });
  const good = createHash("sha256").update(msi).digest("hex");
  assert.notEqual(run("0".repeat(64), msi.length).status, 0, "a digest that does not match is refused");
  assert.notEqual(run(good, msi.length + 1).status, 0, "a size that does not match is refused");
  assert.notEqual(run(good, msi.length).status, 0, "an unsigned file is refused");
  assert.equal(readFileSync(file).equals(msi), true);
});

test("updater key rotation: any listed key that is still in date verifies; an expired one does not", () => {
  const next = newKey();
  const rel = signedRelease("0.6.0", { key: next });
  const now = Date.parse("2026-10-08T00:00:00Z");
  const ring = [{ kid: k.kid, key: k.pub, not_after: null }, { kid: next.kid, key: next.pub, not_after: "2027-10-08" }];
  assert.ok(verifyManifest(rel.text, rel.sig, ring, now), "the second key in the list verifies");
  assert.equal(verifyManifest(rel.text, rel.sig, [ring[0]], now), null, "a key not in the list does not");
  const expired = [{ kid: next.kid, key: next.pub, not_after: "2026-10-01" }];
  assert.equal(verifyManifest(rel.text, rel.sig, expired, now), null, "a key past its last day does not");
  assert.equal(verifyManifest(rel.text, rel.sig, [{ kid: next.kid, key: next.pub, not_after: "not a date" }], now), null, "an unreadable date counts as expired");
});

test("a manifest that names its key id is checked with that key only", async () => {
  const other = newKey();
  const ring = [{ kid: k.kid, key: k.pub, not_after: null }, { kid: other.kid, key: other.pub, not_after: null }];
  const named = signedRelease("0.6.0", { kid: k.kid });
  assert.ok(verifyManifest(named.text, named.sig, ring));
  const wrongKid = signedRelease("0.6.0", { kid: other.kid }); // signed by k, names other
  assert.equal(verifyManifest(wrongKid.text, wrongKid.sig, ring), null);
  const unknown = signedRelease("0.6.0", { kid: "0000000000000000" });
  assert.equal(verifyManifest(unknown.text, unknown.sig, ring), null);
  const dir = mkdtempSync(join(tmpdir(), "sb-native-kid-"));
  const r = await fetchVerifiedInstaller("0.6.0", { dir, publicKey: ring, check: avouro, fetchImpl: serve(files("0.6.0", named)) });
  assert.equal(r.ok, true, r.reason);
  const none = await fetchVerifiedInstaller("0.6.0", { dir, publicKey: [], check: avouro, fetchImpl: serve(files("0.6.0", named)) });
  assert.deepEqual(none, { ok: false, reason: "this build has no updater key" });
});
