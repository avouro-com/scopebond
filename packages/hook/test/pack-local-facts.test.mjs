// Local facts in pack grammars: a pack may read the environment (`env_var`), a file's digest (`file_sha256`) and a top-level
// value of a configuration file (`config_value`), relative to the folder the command runs in. The mapper hands the pack
// readers this computer's environment and files, so these facts are known when a command is decided (they were left out
// before). A pack's own vectors still run with no probe: the same pack derives the same actions on every computer there.

import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mapClaudeToolUse, setActivePacks, runPackVectors } from "../dist/index.js";

const temps = [];
after(() => { for (const d of temps) { try { rmSync(d, { recursive: true, force: true, maxRetries: 5 }); } catch { /* a handle still open on Windows */ } } });
afterEach(() => { setActivePacks([]); delete process.env.DEMO_DEPLOY_ENV; });

const pack = {
  format: "scopebond:pack/v1", id: "demo-facts", version: "1.0.0", issued_at: "2026-10-01T00:00:00Z",
  signature: { alg: "Ed25519", key_id: "test-only", value: "A".repeat(86) + "==" },
  grammars: [{ id: "demodeploy", programs: ["demodeploy"], commands: [
    { path: ["ship"], emit: [{ action_type: "deploy.release", params: {
      provider: { const: "unknown" },
      environment: { first: [{ env_var: "DEMO_DEPLOY_ENV" }, { config_value: { files: ["demo.json", "demo.toml"], key: "environment" } }] },
      config_env: { config_value: { files: ["demo.json", "demo.toml"], key: "environment" } },
      lock_digest: { file_sha256: { const: "demo.lock" } },
    } }] },
  ] }],
  profiles: [{ id: "demofacts", servers: ["demofacts"], tools: [
    { names: ["ship"], emit: [{ action_type: "deploy.release", params: { provider: { const: "unknown" }, environment: { env_var: "DEMO_DEPLOY_ENV" } } }] },
  ] }],
  rules: [],
  vectors: [
    { id: "ship", shell: { command: "demodeploy ship" }, expect: [{ action_type: "deploy.release", params: { provider: "unknown", via: "demodeploy", derived_from: "shell.exec" } }] },
  ],
};

function project() {
  const dir = mkdtempSync(join(tmpdir(), "sb-facts-"));
  temps.push(dir);
  writeFileSync(join(dir, "demo.json"), JSON.stringify({ environment: "staging" }));
  writeFileSync(join(dir, "demo.lock"), "lock v1\n");
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "sub", "demo.toml"), 'environment = "production"\n');
  return dir;
}
const derived = (command, cwd) => mapClaudeToolUse({ tool_name: "Bash", tool_input: { command }, cwd }).find((m) => m.intent.action_type === "deploy.release")?.intent.params;

test("a grammar reads the environment, a file's digest and a configuration value in the folder the command runs in", () => {
  const dir = project();
  setActivePacks([pack]);
  const params = derived("demodeploy ship", dir);
  assert.equal(params.config_env, "staging");
  assert.equal(params.environment, "staging", "no environment variable: the configuration file");
  assert.equal(params.lock_digest, createHash("sha256").update("lock v1\n").digest("hex"));
  process.env.DEMO_DEPLOY_ENV = "production";
  assert.equal(derived("demodeploy ship", dir).environment, "production", "the environment variable comes first");
});

test("after a cd, the files are read in the folder the command runs in", () => {
  const dir = project();
  setActivePacks([pack]);
  const params = derived("cd sub && demodeploy ship", dir);
  assert.equal(params.config_env, "production");
  assert.equal(params.lock_digest, undefined, "no lock file there: left out, never guessed");
});

test("an MCP profile reads the environment", () => {
  setActivePacks([pack]);
  process.env.DEMO_DEPLOY_ENV = "staging";
  const mapped = mapClaudeToolUse({ tool_name: "mcp__demofacts__ship", tool_input: {} });
  assert.equal(mapped.find((m) => m.intent.action_type === "deploy.release").intent.params.environment, "staging");
});

test("a pack's own vectors run with no probe, so they derive the same on every computer", () => {
  process.env.DEMO_DEPLOY_ENV = "production";
  assert.deepEqual(runPackVectors(pack).failures, []);
});
