#!/usr/bin/env node
/**
 * deps-allowlist.mjs — enforce ADR-008: core packages carry no vendor or
 * agent-framework SDK dependencies. Fail-closed allowlist: a core package's
 * runtime dependencies must be `@scopebond/*` or explicitly allowlisted below.
 * Dev dependencies (test/build tooling) are exempt. Runs in CI and locally.
 */

import { readFileSync, existsSync } from "node:fs";

const CORE_PACKAGES = ["policy-schema", "verify", "gateway", "sdk", "contracts"];

// Runtime deps a core package MAY use. Keep this list short and justified;
// widening it is a maintainer decision (CODEOWNERS covers this file).
const CORE_DEP_ALLOW = new Set([
  // e.g. "zod"  ← add with a one-line justification in the PR when first needed
]);

const isWorkspaceDep = (name) => name.startsWith("@scopebond/");
let violations = 0;

for (const pkg of CORE_PACKAGES) {
  const p = `packages/${pkg}/package.json`;
  if (!existsSync(p)) continue; // not created yet
  let json;
  try { json = JSON.parse(readFileSync(p, "utf8")); }
  catch (e) { console.error(`  [PARSE] ${p}: ${e.message}`); violations++; continue; }
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    for (const name of Object.keys(json[field] || {})) {
      if (isWorkspaceDep(name) || CORE_DEP_ALLOW.has(name)) continue;
      console.error(`  [DEP] core package "${pkg}" has non-allowlisted ${field} "${name}"`);
      console.error(`        ADR-008: core packages take no vendor/framework SDKs.`);
      console.error(`        Move it to a leaf package, or add "${name}" to CORE_DEP_ALLOW with justification.`);
      violations++;
    }
  }
}

if (violations === 0) { console.log("✓ deps-allowlist: core packages carry no disallowed dependencies."); process.exit(0); }
console.error(`\n✗ deps-allowlist: ${violations} violation(s).`);
process.exit(1);
