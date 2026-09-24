import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
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

test("claude: an in-policy action defers to Claude Code's own prompt (exit 0, no auto-allow)", () => {
  const r = run(enrolledDir(), ["claude"], JSON.stringify({ tool_name: "Write", tool_input: { file_path: "src/app.ts" } }));
  assert.equal(r.status, 0);
  // The hook must NOT return permissionDecision:"allow" — that would suppress the
  // user's normal review. It records the receipt and stays silent so the host decides.
  assert.equal(r.stdout.trim(), "", "an allowed action produces no permission decision");
});

test("claude: invalid stdin fails closed (deny, exit 2)", () => {
  const r = run(enrolledDir(), ["claude"], "not json");
  assert.equal(r.status, 2);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "deny");
});

test("codex: a protected branch push is denied and an allowed action stays silent", () => {
  const denied = run(enrolledDir(), ["codex"], JSON.stringify({
    hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git push origin main" },
  }));
  assert.equal(denied.status, 0, "Codex consumes the structured deny without treating the hook as failed");
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, "deny");

  const allowed = run(enrolledDir(), ["codex"], JSON.stringify({
    hook_event_name: "PreToolUse", tool_name: "apply_patch",
    tool_input: { command: "*** Begin Patch\n*** Update File: src/app.ts\n@@\n-old\n+new\n*** End Patch" },
  }));
  assert.equal(allowed.status, 0);
  assert.equal(allowed.stdout.trim(), "", "Codex keeps its normal approval flow");
});

test("codex: apply_patch cannot rewrite Codex's own hook configuration", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-hook-codex-protect-"));
  scaffold(dir);
  const r = run(dir, ["codex"], JSON.stringify({
    hook_event_name: "PreToolUse", tool_name: "apply_patch",
    tool_input: { command: "*** Begin Patch\n*** Update File: .codex/hooks.json\n@@\n-old\n+new\n*** End Patch" },
  }));
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "deny");
});

test("init scaffolds keys and a policy and auto-configures the agent", () => {
  const project = mkdtempSync(join(tmpdir(), "sb-hook-init-"));
  const dir = join(project, ".scopebond");
  const stdout = execFileSync(process.execPath, [cli, "init", "--yes"], { encoding: "utf8", cwd: project, env: { ...process.env, SCOPEBOND_HOOK_DIR: dir } });
  assert.ok(existsSync(join(dir, "agent.key")) && existsSync(join(dir, "policy.json")), "keys and policy exist");
  const settings = join(project, ".claude", "settings.json");
  assert.ok(existsSync(settings), "init writes the Claude settings automatically");
  const cfg = JSON.parse(readFileSync(settings, "utf8"));
  assert.match(cfg.hooks.PreToolUse[0].hooks[0].command, /^npx -y @scopebond\/hook@\S+ claude$/);
  assert.match(stdout, /configured/, "reports that the agent was configured");
});

test("init --no-install prints the snippet instead of writing config", () => {
  const project = mkdtempSync(join(tmpdir(), "sb-hook-init-ni-"));
  const dir = join(project, ".scopebond");
  const stdout = execFileSync(process.execPath, [cli, "init", "--no-install", "--yes"], { encoding: "utf8", cwd: project, env: { ...process.env, SCOPEBOND_HOOK_DIR: dir } });
  assert.ok(!existsSync(join(project, ".claude", "settings.json")), "no config written with --no-install");
  assert.match(stdout, /npx -y @scopebond\/hook@\S+ claude/, "prints the pinned hook command");
});

test("init --codex configures .codex/hooks.json and prints the trust step", () => {
  const project = mkdtempSync(join(tmpdir(), "sb-hook-init-codex-"));
  const dir = join(project, ".scopebond");
  const stdout = execFileSync(process.execPath, [cli, "init", "--codex", "--yes"], { encoding: "utf8", cwd: project, env: { ...process.env, SCOPEBOND_HOOK_DIR: dir } });
  const hooks = join(project, ".codex", "hooks.json");
  assert.ok(existsSync(hooks));
  const cfg = JSON.parse(readFileSync(hooks, "utf8"));
  assert.match(cfg.hooks.PreToolUse[0].hooks[0].command, /^npx -y @scopebond\/hook@\S+ codex$/);
  assert.match(stdout, /run `\/hooks`/i);
});

test("first-run smoke: init, a blocked command, then the receipt shows in log and verifies", () => {
  const project = mkdtempSync(join(tmpdir(), "sb-hook-e2e-"));
  const dir = join(project, ".scopebond");
  const env = { ...process.env, SCOPEBOND_HOOK_DIR: dir };
  execFileSync(process.execPath, [cli, "init", "--no-install", "--yes"], { encoding: "utf8", cwd: project, env });
  // A destructive command is blocked (exit 2) and recorded.
  const blocked = run(dir, ["claude"], JSON.stringify({ tool_name: "Bash", tool_input: { command: "rm -rf /" }, cwd: project }));
  assert.equal(blocked.status, 2, "the destructive command is denied");
  // log shows it; verify passes offline.
  const log = execFileSync(process.execPath, [cli, "log"], { encoding: "utf8", cwd: project, env });
  assert.match(log, /shell\.exec rm/, "the receipt appears in the log");
  assert.match(log, /deny/, "recorded as a deny");
  const verify = execFileSync(process.execPath, [cli, "verify"], { encoding: "utf8", cwd: project, env });
  assert.match(verify, /receipt\(s\) verify offline/);
  assert.doesNotMatch(verify, /0\/[1-9]/, "at least one receipt verifies");
});

test("test subcommand shows the decision without recording a receipt", () => {
  const project = mkdtempSync(join(tmpdir(), "sb-hook-test-"));
  const dir = join(project, ".scopebond");
  const env = { ...process.env, SCOPEBOND_HOOK_DIR: dir };
  execFileSync(process.execPath, [cli, "init", "--no-install", "--yes"], { encoding: "utf8", cwd: project, env });
  const denied = run(dir, ["test", "echo hi && rm -rf x"]);
  assert.equal(denied.status, 2, "a command containing rm is denied");
  assert.match(denied.stdout, /overall: deny/);
  const allowed = run(dir, ["test", "npm run build"]);
  assert.equal(allowed.status, 0);
  assert.match(allowed.stdout, /overall: (allow|not_evaluated)/);
  // `test` must not persist anything.
  assert.ok(!existsSync(join(dir, "receipts.db")), "test does not record a receipt");
});

test("starter policy: a fetch and an MCP call are observed (allowed), a bare git push on a feature branch is allowed", async () => {
  const project = mkdtempSync(join(tmpdir(), "sb-hook-starter-"));
  const dir = join(project, ".scopebond");
  scaffold(dir);
  const { createHookRuntime } = await import("../dist/index.js");
  const { mapClaudeToolUse, fillPushBranch } = await import("../dist/index.js");
  const rt = createHookRuntime({ policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"), attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db") });
  assert.notEqual((await rt.evaluate(mapClaudeToolUse({ tool_name: "WebFetch", tool_input: { url: "https://example.com/x" } }))).decision, "deny", "net.fetch is observed, not denied");
  assert.notEqual((await rt.evaluate(mapClaudeToolUse({ tool_name: "mcp__github__create_issue", tool_input: { title: "x" } }))).decision, "deny", "mcp.tool.call is observed, not denied");
  const push = fillPushBranch(mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "git push" } }), "feature/x");
  assert.notEqual((await rt.evaluate(push)).decision, "deny", "a bare push on a feature branch is allowed");
  const toMain = fillPushBranch(mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "git push" } }), "main");
  assert.equal((await rt.evaluate(toMain)).decision, "deny", "a bare push resolved to main is denied");
});

test("init, trust and uninstall refuse a non-interactive stdin without --yes (the agent's shell)", () => {
  const project = mkdtempSync(join(tmpdir(), "sb-hook-noninteractive-"));
  const dir = join(project, ".scopebond");
  const env = { ...process.env, SCOPEBOND_HOOK_DIR: dir, SCOPEBOND_HOME: join(project, "home"), HOME: join(project, "home"), USERPROFILE: join(project, "home") };
  for (const args of [["init", "--no-install"], ["trust"], ["uninstall"]]) {
    let status = 0;
    let stderr = "";
    try { execFileSync(process.execPath, [cli, ...args], { encoding: "utf8", cwd: project, env, input: "", stdio: ["pipe", "pipe", "pipe"] }); }
    catch (error) { status = error.status; stderr = String(error.stderr ?? ""); }
    assert.equal(status, 1, `${args[0]} must refuse without a TTY`);
    assert.match(stderr, /interactive terminal/);
  }
  assert.ok(!existsSync(join(dir, "policy.json")), "a refused init writes nothing");
});
