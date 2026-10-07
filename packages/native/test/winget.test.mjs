// The winget manifests name the signed release's installer exactly, for this user and for every user.
import { test } from "node:test";
import assert from "node:assert/strict";
import { wingetManifests, PACKAGE_ID } from "../winget.mjs";

const input = {
  version: "0.5.0",
  url: "https://github.com/avouro-com/scopebond/releases/download/agent-native-v0.5.0/scopebond-agent-0.5.0-x64.msi",
  sha256: "ab".repeat(32),
  productCode: "{12345678-90AB-CDEF-1234-567890ABCDEF}",
};

test("three manifests for Avouro.Scopebond: version, installer (user and machine scope) and the English description", () => {
  const files = wingetManifests(input);
  assert.deepEqual(Object.keys(files).sort(), [`${PACKAGE_ID}.installer.yaml`, `${PACKAGE_ID}.locale.en-US.yaml`, `${PACKAGE_ID}.yaml`]);
  const installer = files[`${PACKAGE_ID}.installer.yaml`];
  assert.match(installer, /^InstallerType: wix$/m);
  assert.match(installer, /Scope: user\n    InstallerUrl: https:\/\/github\.com\/avouro-com\/scopebond\/releases\/download\/agent-native-v0\.5\.0\/scopebond-agent-0\.5\.0-x64\.msi\n    InstallerSha256: (AB){32}\n/);
  assert.match(installer, /Scope: machine[\s\S]*Custom: ALLUSERS=1/);
  assert.match(installer, /^ProductCode: '\{12345678-90AB-CDEF-1234-567890ABCDEF\}'$/m);
  assert.match(files[`${PACKAGE_ID}.locale.en-US.yaml`], /^Publisher: Avouro LLC$/m);
  for (const text of Object.values(files)) assert.match(text, /^PackageVersion: 0\.5\.0$/m);
});

test("it refuses anything but a release download with a real digest and product code", () => {
  assert.throws(() => wingetManifests({ ...input, url: "https://example.com/x.msi" }), /not a release download/);
  assert.throws(() => wingetManifests({ ...input, sha256: "zz" }), /SHA-256/);
  assert.throws(() => wingetManifests({ ...input, productCode: "x" }), /product code/);
  assert.throws(() => wingetManifests({ ...input, version: "1.0" }), /not a version/);
});
