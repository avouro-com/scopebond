// A project's own policy governs only while it matches the digest the person trusted. `policy load --yes` in a trusted
// project replaces that policy, so it re-pins the new one (as `policy sync` and `rules apply` do): the export it reports as
// loaded, and acknowledges to the workspace as loaded, is the policy the hook then uses.
// Isolated: HOME/USERPROFILE/APPDATA/LOCALAPPDATA/SCOPEBOND_HOME point at a fresh temp folder before any import.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(join(tmpdir(), "sb-policy-load-trust-"));
const fakeHome = join(root, "home");
mkdirSync(fakeHome, { recursive: true });
for (const k of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]) process.env[k] = fakeHome;
process.env.SCOPEBOND_HOME = join(fakeHome, ".scopebond");
delete process.env.SCOPEBOND_HOOK_DIR;
delete process.env.CLAUDE_PROJECT_DIR;

const { canonical } = await import("@scopebond/policy-schema/canonical");
const { scaffold } = await import("../dist/init.js");
const { trustProjectPolicy, isTrustedProject, resolveConfigDir, userHome } = await import("../dist/install.js");
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

function exportFor(policy) {
  const exportId = "3f9d0c1e-1b2a-4c3d-8e4f-5a6b7c8d9e0f", agentId = "agent-7", environmentId = "env-1";
  return {
    type: "scopebond:reviewed-policy-export", version: 1, policy, policy_hash: sha256(canonical(policy)),
    scope: { export_id: exportId, policy_id: "draft-1", policy_version: 2, environment_id: environmentId, agent_id: agentId,
      scope_digest: sha256("scopebond:policy-scope/v1\n" + canonical({ agent_id: agentId, environment_id: environmentId, export_id: exportId })) },
  };
}

test("policy load --yes in a trusted project keeps it trusted, so the loaded export governs", () => {
  assert.equal(homedir(), fakeHome, "isolation: homedir() is the temp folder");
  assert.ok(userHome().startsWith(root), "isolation: SCOPEBOND_HOME is the temp folder");
  scaffold(userHome());                                   // user-level install
  const project = join(root, "proj");
  const projDir = join(project, ".scopebond");
  scaffold(projDir);                                      // project-level setup
  trustProjectPolicy(projDir);                            // the person trusted the project's policy
  assert.equal(resolveConfigDir(project), projDir, "before: the trusted project policy governs");

  const policy = JSON.parse(readFileSync(join(projDir, "policy.json"), "utf8"));
  policy.version = (policy.version ?? 1) + 1;
  const file = join(root, "export.json");
  writeFileSync(file, JSON.stringify(exportFor(policy)));

  const env = { ...process.env, SCOPEBOND_OBSERVATIONS_HEARTBEAT: "off" };
  const r = spawnSync(process.execPath, [cli, "policy", "load", file, "--yes"], { cwd: project, env, encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /loaded policy/);
  assert.ok(r.stdout.includes(join(projDir, "policy.json")), r.stdout);
  assert.deepEqual(JSON.parse(readFileSync(join(projDir, "policy.json"), "utf8")), policy, "the export was written");
  assert.equal(isTrustedProject(projDir), true, "the new project policy is pinned as trusted");
  assert.equal(resolveConfigDir(project), projDir, "the hook resolves the project policy that was just loaded");
});

test("policy load --yes never trusts a project policy that was not trusted before", () => {
  const project = join(root, "untrusted");
  const projDir = join(project, ".scopebond");
  scaffold(projDir);
  assert.equal(resolveConfigDir(project), userHome(), "an untrusted project policy does not govern");
  const policy = JSON.parse(readFileSync(join(userHome(), "policy.json"), "utf8"));
  policy.version = (policy.version ?? 1) + 7;
  const file = join(root, "export-2.json");
  writeFileSync(file, JSON.stringify(exportFor(policy)));
  const env = { ...process.env, SCOPEBOND_OBSERVATIONS_HEARTBEAT: "off" };
  const r = spawnSync(process.execPath, [cli, "policy", "load", file, "--yes"], { cwd: project, env, encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(isTrustedProject(projDir), false, "loading never trusts a project on its own");
  assert.equal(resolveConfigDir(project), userHome());
});
