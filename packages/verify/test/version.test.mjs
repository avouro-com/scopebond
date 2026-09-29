// `verifier_version` is a field inside signed evidence: SPEC.md defines it as "the
// violates() verifier version that produced the verdict". It was a hardcoded
// `scopebond-verify@0.1.1` in the gateway and stayed that way through 0.2, 0.3 and 0.4, so
// every receipt for three releases named a verifier version that had not produced its
// verdict. This test is the guard that stops it drifting again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { VERIFIER_VERSION } from "../dist/violates.js";

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));

test("VERIFIER_VERSION names this package at its published version", () => {
  // The `scopebond-verify@` spelling is the established one and receipts in the wild carry
  // it, so only the version is corrected here — not the shape of the identifier.
  assert.equal(VERIFIER_VERSION, `scopebond-verify@${pkg.version}`,
    "bump VERIFIER_VERSION in src/violates.ts together with the package version — receipts assert this");
});

test("it names a real, fetchable version", () => {
  assert.match(VERIFIER_VERSION, /^scopebond-verify@\d+\.\d+\.\d+$/);
  assert.doesNotMatch(VERIFIER_VERSION, /@0\.1\.1$/, "the stale hardcoded value must not come back");
});
