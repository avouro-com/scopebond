// The typed adapter's approved resources are an exact allowlist: a bound value is approved only when it is one of the
// listed strings for its kind. A config whose shape is wrong (an entry written as one string instead of a list, an
// unknown operation class, a resource that is not { arg, kind }) is refused when the proxy starts, never read loosely.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const sandbox = mkdtempSync(join(tmpdir(), "sb-mcp-typed-shape-"));
for (const k of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SCOPEBOND_HOME"]) process.env[k] = sandbox;

const { requestBinderFromHex, describeToolCall, typedConfigProblem } = await import("../dist/index.js");
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const binder = requestBinderFromHex("44".repeat(32));
const manifest = { hash: "sha256:pinned", tools: { delete_branch: { operation_class: "mutation", resources: [{ arg: "repository", kind: "repository" }] } } };
const call = (repository) => ({ method: "tools/call", params: { name: "delete_branch", arguments: { repository, branch: "main" } } });
const config = (approved) => ({ mode: "enforce", requireResourceBinding: true, approvedResources: { repository: approved }, manifest, binder });

test("the list form approves only the exact value", () => {
  const cfg = config(["acme/widgets-prod"]);
  for (const repo of ["acme/widgets-prod", "acme/widgets", "acme", "w"]) {
    assert.equal(describeToolCall(cfg, "github", call(repo), true).allow, repo === "acme/widgets-prod", repo);
  }
});

test("an entry written as one string approves nothing, not every substring of it", () => {
  const cfg = config("acme/widgets-prod");
  for (const repo of ["acme/widgets-prod", "acme/widgets", "acme", "widgets", "w"]) {
    const d = describeToolCall(cfg, "github", call(repo), true);
    assert.equal(d.allow, false, `repository=${repo}`);
    assert.match(d.reasons.join(" "), /not in the approved set/);
  }
});

test("typedConfigProblem accepts the documented shape and names what is wrong otherwise", () => {
  const good = { mode: "enforce", requireResourceBinding: true, approvedResources: { repository: ["acme/widgets"] }, manifest: { hash: "sha256:x", tools: manifest.tools } };
  assert.equal(typedConfigProblem(good), null);
  assert.equal(typedConfigProblem({ mode: "monitor" }), null, "everything but mode is optional");
  const bad = [
    [{ ...good, mode: "audit" }, /mode/],
    [{ ...good, approvedResources: { repository: "acme/widgets" } }, /approvedResources/],
    [{ ...good, approvedResources: { repository: ["acme/widgets", 7] } }, /approvedResources/],
    [{ ...good, approvedResources: ["acme/widgets"] }, /approvedResources/],
    [{ ...good, requireResourceBinding: "yes" }, /requireResourceBinding/],
    [{ ...good, manifest: { hash: 1, tools: {} } }, /manifest/],
    [{ ...good, manifest: { hash: "sha256:x", tools: [] } }, /manifest/],
    [{ ...good, manifest: { hash: "sha256:x", tools: { t: { operation_class: "write" } } } }, /operation_class/],
    [{ ...good, manifest: { hash: "sha256:x", tools: { t: { operation_class: "mutation", resources: { arg: "a", kind: "k" } } } } }, /resources/],
    [{ ...good, manifest: { hash: "sha256:x", tools: { t: { operation_class: "mutation", resources: [{ arg: "a" }] } } } }, /resources/],
    [{ ...good, manifestRecheckMs: -1 }, /manifestRecheckMs/],
    [{ ...good, referenceSetVersion: 3 }, /referenceSetVersion/],
    [null, /object/],
    [["enforce"], /object/],
  ];
  for (const [cfg, pattern] of bad) assert.match(typedConfigProblem(cfg) ?? "(accepted)", pattern, JSON.stringify(cfg));
});

test("the proxy refuses to start with a typed config whose approved resources are not lists", () => {
  const dir = mkdtempSync(join(sandbox, "cli-"));
  writeFileSync(join(dir, "policy.json"), JSON.stringify({ vocabulary_version: "1.0", policy_id: "typed-shape", version: 1,
    clauses: [{ id: "any", type: "action_allowlist", mode: "enforce", action_types: ["mcp.tool.call"] }] }));
  writeFileSync(join(dir, "key.pem"), generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString());
  writeFileSync(join(dir, "typed.json"), JSON.stringify({ mode: "enforce", requireResourceBinding: true, approvedResources: { repository: "acme/widgets-prod" }, manifest }));
  writeFileSync(join(dir, "upstream.mjs"), "process.stdin.resume(); setTimeout(() => process.exit(0), 3000);\n");
  const r = spawnSync(process.execPath, [cli, "--server", "github", "--policy", join(dir, "policy.json"), "--key", join(dir, "key.pem"),
    "--typed", join(dir, "typed.json"), "--", process.execPath, join(dir, "upstream.mjs")], { encoding: "utf8", timeout: 30_000, input: "" });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /approvedResources/);
});
