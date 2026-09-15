import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "scopebond-package-smoke-"));
const pnpmCli = process.env.npm_execpath;
assert.ok(pnpmCli, "run this check through pnpm so its pinned CLI can be reused");

try {
  for (const packageName of ["policy-schema", "verify", "gateway", "sdk"]) {
    execFileSync(process.execPath, [pnpmCli, "pack", "--pack-destination", scratch], {
      cwd: new URL(`../packages/${packageName}/`, import.meta.url),
      stdio: "inherit",
    });
  }
  const archives = readdirSync(scratch).filter((name) => name.endsWith(".tgz"));
  assert.equal(archives.length, 4, "schema, verifier, gateway and SDK archives must be created");
  const archiveFor = (name) => {
    const archive = archives.find((candidate) => candidate.includes(name));
    assert.ok(archive, `${name} package archive was not created`);
    return `file:./${archive}`;
  };
  const policyArchive = archiveFor("policy-schema");
  const verifyArchive = archiveFor("verify");
  const gatewayArchive = archiveFor("gateway");
  const sdkArchive = archiveFor("sdk");

  writeFileSync(join(scratch, "package.json"), JSON.stringify({
    private: true,
    type: "module",
    dependencies: {
      "@scopebond/policy-schema": policyArchive,
      "@scopebond/verify": verifyArchive,
      "@scopebond/gateway": gatewayArchive,
      "@scopebond/sdk": sdkArchive,
    },
    pnpm: {
      // pnpm 9 reads overrides from package.json; pnpm 10+ reads the same
      // declarations from pnpm-workspace.yaml below.
      overrides: {
        "@scopebond/policy-schema": policyArchive,
        "@scopebond/verify": verifyArchive,
      },
    },
  }));
  writeFileSync(join(scratch, "pnpm-workspace.yaml"), [
    "packages:",
    "  - .",
    "overrides:",
    `  '@scopebond/policy-schema': '${policyArchive}'`,
    `  '@scopebond/verify': '${verifyArchive}'`,
    "",
  ].join("\n"));
  execFileSync(process.execPath, [pnpmCli, "install", "--ignore-scripts"], {
    cwd: scratch,
    stdio: "inherit",
  });
  writeFileSync(join(scratch, "smoke.mjs"), `
    import { merkleRoot, sha256, createGateway, StaticPrincipalKeyRegistry, canonical as gatewayCanonical } from "@scopebond/gateway";
    import { createSigner, canonical as sdkCanonical } from "@scopebond/sdk";
    import { canonical as verifyCanonical } from "@scopebond/verify";
    import { canonical as schemaCanonical } from "@scopebond/policy-schema/canonical";
    if (merkleRoot([sha256("candidate")]).length !== 64) process.exit(1);
    const canonicalVector = { numbers: [333333333.33333329, 1e30, 4.50, 2e-3, 1e-27], nested: { z: null, a: true } };
    const canonicalBytes = [schemaCanonical, verifyCanonical, gatewayCanonical, sdkCanonical].map((fn) => fn(canonicalVector));
    if (!canonicalBytes.every((value) => value === canonicalBytes[0])) process.exit(1);
    const agent = createSigner();
    const keys = new StaticPrincipalKeyRegistry([{ kid: agent.kid, publicKeyPem: agent.publicKeyPem, purposes: ["agent"] }]);
    const policy = { vocabulary_version: "1.0", policy_id: "smoke", version: 1, clauses: [
      { id: "actions", type: "action_allowlist", mode: "enforce", action_types: ["smoke.call"] },
    ] };
    const gateway = createGateway({ policy, authentication: { keys } });
    const result = await gateway.handleAction(agent.sign({ action_type: "smoke.call" }));
    if (!result.allowed || result.receipt.payload.authorization.mode !== "authenticated") process.exit(1);
  `);
  execFileSync(process.execPath, [join(scratch, "smoke.mjs")], { cwd: scratch, stdio: "inherit" });
  console.log("Packed policy-schema, verify, gateway, and SDK candidates authenticate together in a clean consumer project.");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
