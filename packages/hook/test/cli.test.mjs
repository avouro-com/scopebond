import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scaffold, hookCommandResolves, configuredHookCommands, isMachineSpecificCommand, gitShareState, excludeFromGit } from "../dist/index.js";
import { ENFORCE } from "./enforce-all.mjs";

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
  scaffold(dir, ENFORCE);
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

test("claude: an event that starts with a UTF-8 byte-order mark is read as the event", () => {
  // Windows PowerShell 5.1 and other .NET Framework programs write a BOM before piped text.
  const bom = "﻿";
  const allowed = run(enrolledDir(), ["claude"], bom + JSON.stringify({ tool_name: "Write", tool_input: { file_path: "src/app.ts" } }));
  assert.equal(allowed.status, 0, `an allowed action is not refused as invalid JSON: ${allowed.stdout}`);
  const denied = run(enrolledDir(), ["claude"], bom + JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push origin main" } }));
  assert.equal(denied.status, 2);
  assert.doesNotMatch(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecisionReason, /invalid JSON/);
});

test("claude: a policy.json saved with a byte-order mark (Windows PowerShell 5.1) is read as the policy", () => {
  const dir = enrolledDir();
  writeFileSync(join(dir, "policy.json"), "\uFEFF" + readFileSync(join(dir, "policy.json"), "utf8"));
  const allowed = run(dir, ["claude"], JSON.stringify({ tool_name: "Write", tool_input: { file_path: "src/app.ts" } }));
  assert.equal(allowed.status, 0, `an allowed action is not refused because the policy could not be read: ${allowed.stdout}`);
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
  scaffold(dir, ENFORCE);
  const r = run(dir, ["codex"], JSON.stringify({
    hook_event_name: "PreToolUse", tool_name: "apply_patch",
    tool_input: { command: "*** Begin Patch\n*** Update File: .codex/hooks.json\n@@\n-old\n+new\n*** End Patch" },
  }));
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "deny");
});

/** Every Scopebond hook command configured for Claude Code in a project, from whichever
 *  project file holds it (the shared settings.json or the personal settings.local.json),
 *  found by the hook matcher rather than by a substring. */
function claudeHookCommands(project) {
  return [join(project, ".claude", "settings.json"), join(project, ".claude", "settings.local.json")]
    .flatMap((file) => configuredHookCommands(file).map((command) => ({ file, command })));
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function gitProject(prefix) {
  const project = mkdtempSync(join(tmpdir(), prefix));
  git(project, "init", "-q");
  return project;
}

const hasGit = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();

test("init scaffolds keys and a policy and auto-configures the agent", () => {
  const project = mkdtempSync(join(tmpdir(), "sb-hook-init-"));
  const dir = join(project, ".scopebond");
  const stdout = execFileSync(process.execPath, [cli, "init", "--yes"], { encoding: "utf8", cwd: project, env: { ...process.env, SCOPEBOND_HOOK_DIR: dir } });
  assert.ok(existsSync(join(dir, "agent.key")) && existsSync(join(dir, "policy.json")), "keys and policy exist");
  const hooks = claudeHookCommands(project);
  assert.equal(hooks.length, 1, "init writes exactly one Claude hook");
  const { command } = hooks[0];
  // The command may be either form — a pinned absolute path (fast) or the portable
  // `npx` fallback — but it must end in the harness name and be runnable as written.
  assert.match(command, /\sclaude$/, `hook command targets Claude Code: ${command}`);
  assert.ok(hookCommandResolves(command), `hook command must be startable: ${command}`);
  assert.match(stdout, /configured/, "reports that the agent was configured");
});

test("init never leaves a machine-specific command in the shared .claude/settings.json", () => {
  const project = mkdtempSync(join(tmpdir(), "sb-hook-init-shared-file-"));
  const dir = join(project, ".scopebond");
  execFileSync(process.execPath, [cli, "init", "--yes"], { encoding: "utf8", cwd: project, env: { ...process.env, SCOPEBOND_HOOK_DIR: dir } });
  const shared = configuredHookCommands(join(project, ".claude", "settings.json"));
  assert.ok(shared.every((c) => !isMachineSpecificCommand(c)), `shared file carries only portable commands: ${shared}`);
  for (const { file, command } of claudeHookCommands(project)) {
    if (isMachineSpecificCommand(command)) assert.ok(file.endsWith("settings.local.json"), "a pinned command goes to the personal file");
  }
});

test("init in a git repository pins the fast command in settings.local.json and keeps it out of git", { skip: !hasGit }, () => {
  const project = gitProject("sb-hook-init-git-");
  const dir = join(project, ".scopebond");
  execFileSync(process.execPath, [cli, "init", "--yes"], { encoding: "utf8", cwd: project, env: { ...process.env, SCOPEBOND_HOOK_DIR: dir } });
  const hooks = claudeHookCommands(project);
  assert.equal(hooks.length, 1);
  // The invariant, whichever form init chose: nothing git would commit carries a
  // machine-specific command.
  const shareable = git(project, "ls-files", "--cached", "--others", "--exclude-standard").split(/\r?\n/).filter(Boolean);
  for (const rel of shareable) {
    for (const command of configuredHookCommands(join(project, rel))) {
      assert.equal(isMachineSpecificCommand(command), false, `${rel} would be committed with ${command}`);
    }
  }
  if (isMachineSpecificCommand(hooks[0].command)) {
    assert.ok(hooks[0].file.endsWith("settings.local.json"));
    // `git check-ignore -q` exits 0 (no throw) when the file is ignored.
    git(project, "check-ignore", "-q", "--", ".claude/settings.local.json");
    assert.equal(gitShareState(hooks[0].file), "ignored");
  }
  // The team's .gitignore is not touched; any exclusion is this clone's own.
  assert.ok(!existsSync(join(project, ".gitignore")), "the repository .gitignore is left alone");
});

test("excludeFromGit uses git's own path for the directory, so a second spelling of it still works", { skip: !hasGit }, () => {
  const project = gitProject("sb-hook-exclude-");
  mkdirSync(join(project, ".claude"), { recursive: true });
  const file = join(project, ".claude", "settings.local.json");
  writeFileSync(file, "{}\n");
  assert.equal(gitShareState(file), "untracked");
  assert.equal(excludeFromGit(file), true);
  assert.equal(gitShareState(file), "ignored");
  const exclude = readFileSync(join(project, ".git", "info", "exclude"), "utf8");
  assert.match(exclude, /^\/\.claude\/settings\.local\.json$/m, "a root-anchored entry for exactly this file");
  assert.equal(excludeFromGit(file), true, "idempotent");
  assert.equal(exclude.split("/.claude/settings.local.json").length, readFileSync(join(project, ".git", "info", "exclude"), "utf8").split("/.claude/settings.local.json").length, "no duplicate entry");
});

test("init repairs a pinned command an older init committed to .claude/settings.json", { skip: !hasGit }, () => {
  const project = gitProject("sb-hook-init-repair-");
  const dir = join(project, ".scopebond");
  mkdirSync(join(project, ".claude"), { recursive: true });
  const stale = `"${process.execPath}" "${join(project, "gone", "@scopebond", "hook", "dist", "cli.js")}" claude`;
  writeFileSync(join(project, ".claude", "settings.json"), JSON.stringify({
    theme: "dark",
    hooks: { PreToolUse: [
      { matcher: "*", hooks: [{ type: "command", command: stale }] },
      { matcher: "Bash", hooks: [{ type: "command", command: "./lint.sh" }] },
    ] },
  }));
  git(project, "add", ".claude/settings.json");
  const env = { ...process.env, SCOPEBOND_HOOK_DIR: dir };
  // The doctor on the machine that wrote it is the one place the leak is visible.
  let doctor = "";
  try { execFileSync(process.execPath, [cli, "doctor"], { encoding: "utf8", cwd: project, env }); } catch (error) { doctor = String(error.stdout ?? ""); }
  assert.match(doctor, /cannot start|names a path on this machine/, "doctor reports the committed pinned command");
  execFileSync(process.execPath, [cli, "init", "--yes"], { encoding: "utf8", cwd: project, env });
  const settings = JSON.parse(readFileSync(join(project, ".claude", "settings.json"), "utf8"));
  assert.equal(settings.theme, "dark", "other settings survive");
  const remaining = settings.hooks.PreToolUse.flatMap((e) => e.hooks.map((h) => h.command));
  assert.ok(!remaining.includes(stale), "the machine-specific entry is gone from the shared file");
  assert.ok(remaining.includes("./lint.sh"), "the user's own hooks are untouched");
  assert.equal(claudeHookCommands(project).length, 1, "exactly one Scopebond hook remains");
});

test("doctor flags a working pinned command in a file git shares", { skip: !hasGit }, () => {
  const project = gitProject("sb-hook-doctor-leak-");
  const dir = join(project, ".scopebond");
  const env = { ...process.env, SCOPEBOND_HOOK_DIR: dir };
  execFileSync(process.execPath, [cli, "init", "--no-install", "--yes"], { encoding: "utf8", cwd: project, env });
  mkdirSync(join(project, ".claude"), { recursive: true });
  // A pinned command that starts fine here — the resolve check alone passes it.
  const pinned = `"${process.execPath}" "${cli}" claude`;
  writeFileSync(join(project, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: pinned }] }] } }));
  let status = 0; let out;
  try { out = execFileSync(process.execPath, [cli, "doctor"], { encoding: "utf8", cwd: project, env }); } catch (error) { status = error.status; out = String(error.stdout ?? ""); }
  assert.equal(status, 1, "doctor fails");
  assert.match(out, /names a path on this machine and git shares that file/);
});

test("init --shared writes the portable command to settings.json and no personal copy", () => {
  const project = mkdtempSync(join(tmpdir(), "sb-hook-init-shared-"));
  const dir = join(project, ".scopebond");
  const env = { ...process.env, SCOPEBOND_HOOK_DIR: dir };
  execFileSync(process.execPath, [cli, "init", "--yes"], { encoding: "utf8", cwd: project, env });
  execFileSync(process.execPath, [cli, "init", "--shared", "--yes"], { encoding: "utf8", cwd: project, env });
  const hooks = claudeHookCommands(project);
  assert.equal(hooks.length, 1, "one hook, so no action is checked twice");
  assert.ok(hooks[0].file.endsWith("settings.json"));
  assert.match(hooks[0].command, /^npx -y @scopebond\/hook@\S+ claude$/);
});

test("init --cursor uses the portable command when git already tracks .cursor/hooks.json", { skip: !hasGit }, () => {
  const project = gitProject("sb-hook-init-cursor-tracked-");
  const dir = join(project, ".scopebond");
  mkdirSync(join(project, ".cursor"), { recursive: true });
  writeFileSync(join(project, ".cursor", "hooks.json"), JSON.stringify({ version: 1, hooks: {} }));
  git(project, "add", ".cursor/hooks.json");
  execFileSync(process.execPath, [cli, "init", "--cursor", "--yes"], { encoding: "utf8", cwd: project, env: { ...process.env, SCOPEBOND_HOOK_DIR: dir } });
  const commands = configuredHookCommands(join(project, ".cursor", "hooks.json"));
  assert.ok(commands.length > 0);
  assert.ok(commands.every((c) => /^npx -y @scopebond\/hook@\S+ cursor$/.test(c)), `portable only: ${commands}`);
});

test("init --dry-run writes nothing and needs no terminal", () => {
  const project = mkdtempSync(join(tmpdir(), "sb-hook-init-dry-"));
  const dir = join(project, ".scopebond");
  const out = execFileSync(process.execPath, [cli, "init", "--dry-run"], { encoding: "utf8", cwd: project, input: "", env: { ...process.env, SCOPEBOND_HOOK_DIR: dir } });
  assert.match(out, /Dry run/);
  assert.match(out, /settings\.local\.json/, "names the file it would write");
  assert.ok(!existsSync(dir), "no .scopebond was scaffolded");
  assert.ok(!existsSync(join(project, ".claude")), "no agent config was written");
});

test("init --npx forces the portable command; the default pins a startable one", () => {
  const project = mkdtempSync(join(tmpdir(), "sb-hook-init-npx-"));
  const dir = join(project, ".scopebond");
  execFileSync(process.execPath, [cli, "init", "--npx", "--yes"], { encoding: "utf8", cwd: project, env: { ...process.env, SCOPEBOND_HOOK_DIR: dir } });
  const cfg = JSON.parse(readFileSync(join(project, ".claude", "settings.json"), "utf8"));
  assert.match(cfg.hooks.PreToolUse[0].hooks[0].command, /^npx -y @scopebond\/hook@\S+ claude$/);
});

test("init is idempotent: re-running leaves exactly one Scopebond hook entry", () => {
  const project = mkdtempSync(join(tmpdir(), "sb-hook-init-twice-"));
  const dir = join(project, ".scopebond");
  const env = { ...process.env, SCOPEBOND_HOOK_DIR: dir };
  for (let i = 0; i < 2; i += 1) {
    execFileSync(process.execPath, [cli, "init", "--yes"], { encoding: "utf8", cwd: project, env });
  }
  // Counted with the hook matcher: a substring test for "scopebond" matched the pinned
  // path only when the checkout folder was named that, and failed anywhere else.
  assert.equal(claudeHookCommands(project).length, 1, "no duplicate hook entry after a second init");
});

test("init --no-install prints the snippet instead of writing config", () => {
  const project = mkdtempSync(join(tmpdir(), "sb-hook-init-ni-"));
  const dir = join(project, ".scopebond");
  const stdout = execFileSync(process.execPath, [cli, "init", "--no-install", "--yes"], { encoding: "utf8", cwd: project, env: { ...process.env, SCOPEBOND_HOOK_DIR: dir } });
  assert.ok(!existsSync(join(project, ".claude", "settings.json")), "no config written with --no-install");
  // The printed snippet must be the same command init would have written, so copying
  // it by hand gives the same result.
  const snippet = JSON.parse(stdout.slice(stdout.indexOf("{"), stdout.lastIndexOf("}") + 1));
  const command = snippet.hooks.PreToolUse[0].hooks[0].command;
  assert.match(command, /\sclaude$/, `snippet targets Claude Code: ${command}`);
  assert.ok(hookCommandResolves(command), `snippet command must be startable: ${command}`);
});

test("init --codex configures .codex/hooks.json and prints the trust step", () => {
  const project = mkdtempSync(join(tmpdir(), "sb-hook-init-codex-"));
  const dir = join(project, ".scopebond");
  const stdout = execFileSync(process.execPath, [cli, "init", "--codex", "--yes"], { encoding: "utf8", cwd: project, env: { ...process.env, SCOPEBOND_HOOK_DIR: dir } });
  const hooks = join(project, ".codex", "hooks.json");
  assert.ok(existsSync(hooks));
  const cfg = JSON.parse(readFileSync(hooks, "utf8"));
  const command = cfg.hooks.PreToolUse[0].hooks[0].command;
  assert.match(command, /\scodex$/, `hook command targets Codex: ${command}`);
  assert.ok(hookCommandResolves(command), `hook command must be startable: ${command}`);
  assert.match(stdout, /run `\/hooks`/i);
});

test("first-run smoke: init records by default, a rule turned on blocks, and the receipts show in log and verify", () => {
  const project = mkdtempSync(join(tmpdir(), "sb-hook-e2e-"));
  const dir = join(project, ".scopebond");
  const env = { ...process.env, SCOPEBOND_HOOK_DIR: dir };
  execFileSync(process.execPath, [cli, "init", "--no-install", "--yes"], { encoding: "utf8", cwd: project, env });
  // Monitor is the default: a destructive command runs (exit 0) and is recorded.
  const recorded = run(dir, ["claude"], JSON.stringify({ tool_name: "Bash", tool_input: { command: "rm -rf /tmp/x" }, cwd: project }));
  assert.equal(recorded.status, 0, `recorded, not blocked: ${recorded.stdout}`);
  // Once the person turns the rule on, the same command is blocked (exit 2) and recorded.
  execFileSync(process.execPath, [cli, "rules", "enforce", "safe-shell", "--yes"], { encoding: "utf8", cwd: project, env });
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
  execFileSync(process.execPath, [cli, "rules", "enforce", "safe-shell", "--yes"], { encoding: "utf8", cwd: project, env });
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
  scaffold(dir, ENFORCE);
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
    // Assert the actionable content, not the prose: the refusal has to tell the reader
    // how to proceed deliberately, which is the `--yes` flag.
    assert.match(stderr, /--yes/, `${args[0]} must point at --yes`);
    assert.ok(stderr.includes(`scopebond ${args[0]}`), `${args[0]} must name itself`);
  }
  assert.ok(!existsSync(join(dir, "policy.json")), "a refused init writes nothing");
});

test("connect without arguments says where an enrollment comes from", () => {
  const project = mkdtempSync(join(tmpdir(), "sb-hook-connect-usage-"));
  let stderr = "";
  try {
    execFileSync(process.execPath, [cli, "connect"], {
      encoding: "utf8", cwd: project, input: "", stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, SCOPEBOND_HOOK_DIR: join(project, ".scopebond") },
    });
  } catch (error) { stderr = String(error.stderr ?? ""); }
  assert.match(stderr, /usage:/);
  assert.match(stderr, /Scopebond workspace/, "points at the workspace");
});

test("verify does not print Node's experimental SQLite warning", () => {
  const project = mkdtempSync(join(tmpdir(), "sb-hook-quiet-"));
  const dir = join(project, ".scopebond");
  const env = { ...process.env, SCOPEBOND_HOOK_DIR: dir };
  execFileSync(process.execPath, [cli, "init", "--no-install", "--yes"], { encoding: "utf8", cwd: project, env });
  run(dir, ["claude"], JSON.stringify({ tool_name: "Bash", tool_input: { command: "rm -rf /" }, cwd: project }));
  const result = spawnSync(process.execPath, [cli, "verify"], { encoding: "utf8", cwd: project, env });
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stderr, /ExperimentalWarning/);
});

test("monitor is the default; Scopebond's own protection blocks whatever the rules say", () => {
  const project = mkdtempSync(join(tmpdir(), "sb-hook-monitor-"));
  const dir = join(project, ".scopebond");
  const env = { ...process.env, SCOPEBOND_HOOK_DIR: dir };
  execFileSync(process.execPath, [cli, "init", "--no-install", "--yes"], { encoding: "utf8", cwd: project, env });
  const call = (command) => run(dir, ["claude"], JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: project }));
  assert.equal(call("git push origin main").status, 0, "a push to main is recorded, not blocked");
  assert.equal(call("rm -rf build").status, 0, "a destructive program is recorded, not blocked");
  // Self-protection: the coding agent can never switch Scopebond off or change its settings.
  for (const command of ["npx -y @scopebond/hook@latest uninstall --yes", "npm uninstall -g @scopebond/agent", "scopebond-agent stop",
    "scopebond-agent autostart off", "npx -y @scopebond/hook rules monitor safe-shell", "echo x > .scopebond/policy.json"]) {
    const r = call(command);
    assert.equal(r.status, 2, `${command} is always blocked: ${r.stdout}`);
  }
  assert.equal(call("npx -y @scopebond/hook rules show").status, 0, "showing the rules is allowed");
});


test("D140: on a computer its workspace manages, rules enforce|monitor applies only where the workspace allows changes on computers", async () => {
  const { digestRules } = await import("../dist/index.js");
  const project = mkdtempSync(join(tmpdir(), "sb-hook-local-"));
  const dir = join(project, ".scopebond");
  const env = { ...process.env, SCOPEBOND_HOOK_DIR: dir };
  execFileSync(process.execPath, [cli, "init", "--no-install", "--yes"], { encoding: "utf8", cwd: project, env });
  const rules = { "force-push-protected": { mode: "monitor" }, "push-protected": { mode: "monitor" }, "destructive-shell": { mode: "block" },
    "secret-read": { mode: "monitor" }, "ci-config-write": { mode: "monitor" }, "network-egress": { mode: "monitor" } };
  const managed = (extra) => writeFileSync(join(dir, "managed-rules.json"), JSON.stringify({ type: "scopebond:managed-rules", version: 1, revision: 1,
    export_id: "rev-1-gw-1", environment_id: "env-1", agent_id: "agent-1", installation_id: "gw-1", rules, rules_digest: digestRules(rules), ...extra }));
  const rulesCli = (...args) => spawnSync(process.execPath, [cli, "rules", ...args, "--yes"], { encoding: "utf8", cwd: project, env });
  managed({});
  const refused = rulesCli("monitor", "safe-shell");
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /does not allow changing them here/);
  managed({ local_changes: true });
  const ok = rulesCli("monitor", "safe-shell");
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /safe-shell now records on this computer/);
  const saved = JSON.parse(readFileSync(join(dir, "rules.json"), "utf8"));
  assert.deepEqual(saved.local_overrides, { "safe-shell": "monitor" });
  const policy = JSON.parse(readFileSync(join(dir, "policy.json"), "utf8"));
  assert.equal(policy.clauses.find((c) => c.id === "safe-shell").mode, "monitor", "the person's choice applies");
  assert.equal(policy.clauses.find((c) => c.id === "protect-scopebond-write").mode, "enforce");
});

test("two agents at once: a dozen simultaneous checks on one computer never fail closed on a busy local log", async () => {
  const { spawn } = await import("node:child_process");
  const project = mkdtempSync(join(tmpdir(), "sb-hook-busy-"));
  const dir = join(project, ".scopebond");
  const env = { ...process.env, SCOPEBOND_HOOK_DIR: dir };
  execFileSync(process.execPath, [cli, "init", "--no-install", "--yes"], { encoding: "utf8", cwd: project, env });
  const one = (i) => new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, "claude"], { cwd: project, env });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.end(JSON.stringify({ tool_name: "Read", tool_input: { file_path: join(project, `f${i}.ts`) }, cwd: project }));
  });
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => one(i)));
  for (const r of results) {
    assert.doesNotMatch(r.out, /database is locked|failed closed/, r.out);
    assert.equal(r.code, 0, r.out);
  }
});
