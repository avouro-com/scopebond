import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "scopebond-package-smoke-"));
const pnpmCli = process.env.npm_execpath;
assert.ok(pnpmCli, "run this check through pnpm so its pinned CLI can be reused");

try {
  for (const packageName of ["policy-schema", "verify", "gateway", "sdk", "hook", "github-action", "mcp", "framework"]) {
    execFileSync(process.execPath, [pnpmCli, "pack", "--pack-destination", scratch], {
      cwd: new URL(`../packages/${packageName}/`, import.meta.url),
      stdio: "inherit",
    });
  }
  const archives = readdirSync(scratch).filter((name) => name.endsWith(".tgz"));
  assert.equal(archives.length, 8, "schema, verifier, gateway, SDK, hook, github-action, mcp and framework archives must be created");
  const archiveFor = (name) => {
    const archive = archives.find((candidate) => candidate.includes(`scopebond-${name}-`));
    assert.ok(archive, `${name} package archive was not created`);
    return `file:./${archive}`;
  };
  const policyArchive = archiveFor("policy-schema");
  const verifyArchive = archiveFor("verify");
  const gatewayArchive = archiveFor("gateway");
  const sdkArchive = archiveFor("sdk");
  const hookArchive = archiveFor("hook");
  const githubActionArchive = archiveFor("github-action");
  const mcpArchive = archiveFor("mcp");
  const frameworkArchive = archiveFor("framework");

  // Every @scopebond/* dependency (including transitive ones) must resolve to a
  // local archive, so override the full set.
  const overrides = {
    "@scopebond/policy-schema": policyArchive,
    "@scopebond/verify": verifyArchive,
    "@scopebond/gateway": gatewayArchive,
    "@scopebond/sdk": sdkArchive,
    "@scopebond/hook": hookArchive,
    "@scopebond/github-action": githubActionArchive,
    "@scopebond/mcp": mcpArchive,
    "@scopebond/framework": frameworkArchive,
  };
  writeFileSync(join(scratch, "package.json"), JSON.stringify({
    private: true,
    type: "module",
    dependencies: { ...overrides },
    // pnpm 9 reads overrides from package.json; pnpm 10+ reads the same
    // declarations from pnpm-workspace.yaml below.
    pnpm: { overrides },
  }));
  writeFileSync(join(scratch, "pnpm-workspace.yaml"), [
    "packages:",
    "  - .",
    "overrides:",
    ...Object.entries(overrides).map(([name, archive]) => `  '${name}': '${archive}'`),
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
    import { validateActionParams } from "@scopebond/policy-schema/registry";
    import { mapClaudeToolUse } from "@scopebond/hook";
    import { evaluatePullRequest } from "@scopebond/github-action";
    import { mapMcpToolCall } from "@scopebond/mcp";
    import { wrapVercelTools } from "@scopebond/framework";
    import { merkleTreeHash, leafHash, inclusionProof, verifyInclusionProof, verifyAnchorSignature } from "@scopebond/verify/anchor";
    if (merkleRoot([sha256("candidate")]).length !== 64) process.exit(1);
    {
      const leaves = await Promise.all(["a", "b", "c"].map((x) => leafHash(x)));
      const root = await merkleTreeHash(leaves);
      const p = await inclusionProof(leaves, 2);
      if (!(await verifyInclusionProof({ leaf_hash: leaves[2], ...p, root }))) process.exit(1);
    }
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
    const anchor = await gateway.anchor();
    if (anchor.algo !== "rfc9162-sha256" || !(await verifyAnchorSignature(anchor, gateway.attester.publicKeyJwk))) process.exit(1);
    // The taxonomy registry and the hook connector resolve and agree.
    if (!validateActionParams("git.push", { ref: "main" }).valid) process.exit(1);
    if (mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "git push origin main" } })[0].intent.action_type !== "git.push") process.exit(1);
    const prPolicy = { vocabulary_version: "1.0", policy_id: "smoke", version: 1, clauses: [
      { id: "no-prod", type: "action_allowlist", mode: "enforce", action_types: ["pr.merge"], param_bounds: { paths: { items: { pattern: "^(?!infra/prod/).*" }, match: "all" } } },
    ] };
    const prCtx = { event: "pull_request", repo: "a/b", base: "main", head: "x", headSha: "s", paths: ["infra/prod/x.tf"], filesChanged: 1, additions: 1, deletions: 0, actor: "copilot-swe-agent[bot]" };
    if (evaluatePullRequest(prCtx, prPolicy).decision !== "deny") process.exit(1);
    if (mapMcpToolCall("filesystem", { name: "read_file", arguments: { path: "x" } }).action_type !== "mcp.tool.call") process.exit(1);
    if (typeof wrapVercelTools({ t: { execute: async () => "ok" } }, { check: async () => ({ allowed: true }) }).t.execute !== "function") process.exit(1);
  `);
  execFileSync(process.execPath, [join(scratch, "smoke.mjs")], { cwd: scratch, stdio: "inherit" });
  console.log("Packed policy-schema, verify, gateway, SDK, hook, github-action, mcp and framework candidates authenticate together in a clean consumer project.");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
