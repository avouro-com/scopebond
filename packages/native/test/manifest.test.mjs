// The release manifest the workflow signs is the one the agent's updater accepts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manifestFor, signManifest } from "../manifest.mjs";
import { verifyManifest } from "@scopebond/agent";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

function release() {
  const folder = mkdtempSync(join(tmpdir(), "sb-manifest-"));
  writeFileSync(join(folder, "scopebond-agent-1.2.3-x64.msi"), "msi");
  writeFileSync(join(folder, "scopebond-agent-1.2.3-x64.exe"), "exe");
  writeFileSync(join(folder, "SHA256SUMS"), "not part of it");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    folder,
    sign: (text) => signManifest(text, privateKey.export({ type: "pkcs8", format: "pem" })),
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  };
}

test("a manifest signed here verifies in the agent, and names every program with its digest and size", () => {
  const { folder, sign, publicKey } = release();
  const text = manifestFor("1.2.3", folder, COMMIT);
  const manifest = verifyManifest(text, sign(text), publicKey);
  assert.ok(manifest);
  assert.equal(manifest.version, "1.2.3");
  assert.deepEqual(manifest.files.map((f) => [f.name, f.size]), [["scopebond-agent-1.2.3-x64.exe", 3], ["scopebond-agent-1.2.3-x64.msi", 3]]);
  assert.equal(manifest.files[1].sha256, createHash("sha256").update("msi").digest("hex"));
});

test("the signed manifest names the commit the release was built from, and the agent accepts it", () => {
  const { folder, sign, publicKey } = release();
  const text = manifestFor("1.2.3", folder, COMMIT);
  assert.equal(JSON.parse(text).commit, COMMIT);
  const manifest = verifyManifest(text, sign(text), publicKey);
  assert.ok(manifest, "the agent's updater accepts a manifest that carries the commit");
  assert.equal(manifest.commit, COMMIT);
  // The commit is covered by the signature: another commit under the same signature is refused.
  const other = text.replace(COMMIT, "f".repeat(40));
  assert.equal(verifyManifest(other, sign(text), publicKey), null);
});

test("a manifest without a full commit id is not written", () => {
  const { folder } = release();
  for (const commit of [undefined, "", "0123456", "main", COMMIT.toUpperCase(), `${COMMIT}\n`]) {
    assert.throws(() => manifestFor("1.2.3", folder, commit), /full commit id/);
  }
  assert.ok(manifestFor("1.2.3", folder, "a".repeat(64)));
});

test("the manifest names the id of the key that signed it, the agent computes the same id, and a key list builds in", async () => {
  const { keyId, keyIdOfPrivate } = await import("../manifest.mjs");
  const { keyId: agentKeyId } = await import("@scopebond/agent");
  const { updaterKeysDefine } = await import("../build-sea.mjs");
  const folder = mkdtempSync(join(tmpdir(), "sb-manifest-kid-"));
  writeFileSync(join(folder, "scopebond-agent-1.2.3-x64.msi"), "msi");
  const a = generateKeyPairSync("ed25519"), b = generateKeyPairSync("ed25519");
  const pub = (k) => k.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const pem = (k) => k.privateKey.export({ type: "pkcs8", format: "pem" });
  assert.equal(keyId(pub(a)), agentKeyId(pub(a)));
  assert.equal(keyIdOfPrivate(pem(a)), keyId(pub(a)));
  const text = manifestFor("1.2.3", folder, COMMIT, keyIdOfPrivate(pem(b)));
  assert.equal(JSON.parse(text).kid, keyId(pub(b)));
  assert.equal(JSON.parse(text).commit, COMMIT);
  const ring = [{ kid: keyId(pub(a)), key: pub(a), not_after: "2027-01-01" }, { kid: keyId(pub(b)), key: pub(b), not_after: null }];
  assert.ok(verifyManifest(text, signManifest(text, pem(b)), ring, Date.parse("2026-10-08T00:00:00Z")));
  assert.equal(verifyManifest(text, signManifest(text, pem(a)), ring), null, "a manifest naming key b is not accepted under key a");

  const keys = mkdtempSync(join(tmpdir(), "sb-keys-"));
  assert.equal(updaterKeysDefine(keys), "undefined", "no keys: the build never updates itself");
  writeFileSync(join(keys, "updater-public-key.txt"), `${pub(a)}\n`);
  assert.deepEqual(JSON.parse(JSON.parse(updaterKeysDefine(keys))), [{ kid: keyId(pub(a)), key: pub(a), not_after: null }]);
  writeFileSync(join(keys, "updater-keys.json"), JSON.stringify(ring));
  assert.deepEqual(JSON.parse(JSON.parse(updaterKeysDefine(keys))), ring, "the list wins over the single key");
  writeFileSync(join(keys, "updater-keys.json"), JSON.stringify([{ kid: "0000000000000000", key: pub(a), not_after: null }]));
  assert.throws(() => updaterKeysDefine(keys), /not the id of its key/);
});
