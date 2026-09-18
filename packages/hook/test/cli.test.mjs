import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scaffold } from "../dist/index.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const policy = {
  vocabulary_version: "1.0", policy_id: "cli", version: 1,
  clauses: [
    { id: "branch", type: "action_allowlist", mode: "enforce", action_types: ["git.push"], param_bounds: { ref: { pattern: "^(?!(?:main|master)$).+" } } },
    { id: "files", type: "action_allowlist", mode: "enforce", action_types: ["file.write"] },
  ],
};

function enrolledDir() {
  const dir = mkdtempSync(join(tmpdir(), "sb-hook-cli-"));
  scaffold(dir);
  writeFileSync(join(dir, "policy.json"), JSON.stringify(policy));
  return dir;
}

// Run the CLI; returns { status, stdout }. execFileSync throws on non-zero exit,
// so a deny (exit 2) is caught and its fields read.
function run(dir, args, input) {
  try {
    const stdout = execFileSync(process.execPath, [cli, ...args], {
      input, encoding: "utf8", env: { ...process.env, SCOPEBOND_HOOK_DIR: dir },
    });
    return { status: 0, stdout };
  } catch (error) {
    return { status: error.status, stdout: String(error.stdout ?? "") };
  }
}

test("claude: a protected-branch push is denied with exit 2 and a deny decision", () => {
  const r = run(enrolledDir(), ["claude"], JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push origin main" } }));
  assert.equal(r.status, 2, "a deny hard-blocks with exit code 2");
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "deny");
});

test("claude: an in-policy write is allowed with exit 0", () => {
  const r = run(enrolledDir(), ["claude"], JSON.stringify({ tool_name: "Write", tool_input: { file_path: "src/app.ts" } }));
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "allow");
});

test("claude: invalid stdin fails closed (deny, exit 2)", () => {
  const r = run(enrolledDir(), ["claude"], "not json");
  assert.equal(r.status, 2);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "deny");
});

test("init scaffolds keys and a policy and prints the harness snippet", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-hook-init-"));
  const stdout = execFileSync(process.execPath, [cli, "init"], { encoding: "utf8", env: { ...process.env, SCOPEBOND_HOOK_DIR: dir } });
  assert.ok(existsSync(join(dir, "agent.key")) && existsSync(join(dir, "policy.json")), "keys and policy exist");
  assert.match(stdout, /scopebond-hook claude/, "prints the Claude hook command");
});
