// The release manifest the workflow signs is the one the agent's updater accepts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manifestFor, signManifest } from "../manifest.mjs";
import { verifyManifest } from "@scopebond/agent";

test("a manifest signed here verifies in the agent, and names every program with its digest and size", () => {
  const folder = mkdtempSync(join(tmpdir(), "sb-manifest-"));
  writeFileSync(join(folder, "scopebond-agent-1.2.3-x64.msi"), "msi");
  writeFileSync(join(folder, "scopebond-agent-1.2.3-x64.exe"), "exe");
  writeFileSync(join(folder, "SHA256SUMS"), "not part of it");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const text = manifestFor("1.2.3", folder);
  const signature = signManifest(text, privateKey.export({ type: "pkcs8", format: "pem" }));
  const manifest = verifyManifest(text, signature, publicKey.export({ type: "spki", format: "der" }).toString("base64"));
  assert.ok(manifest);
  assert.equal(manifest.version, "1.2.3");
  assert.deepEqual(manifest.files.map((f) => [f.name, f.size]), [["scopebond-agent-1.2.3-x64.exe", 3], ["scopebond-agent-1.2.3-x64.msi", 3]]);
  assert.equal(manifest.files[1].sha256, createHash("sha256").update("msi").digest("hex"));
});
