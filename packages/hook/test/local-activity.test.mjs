// The tray's "Today" row and "Recently blocked" list come from the computer's own receipts: counts since
// local midnight, the newest blocks as the one-line summary `log` prints (never raw arguments) and in plain words as the
// Scopebond window shows them (secrets masked), monitored matches excluded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { localActivity, plainAction, ruleTitle } from "../dist/index.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function project() {
  const dir = mkdtempSync(join(tmpdir(), "sb-activity-"));
  const config = join(dir, "sb-config");
  const env = { ...process.env, SCOPEBOND_HOOK_DIR: config };
  execFileSync(process.execPath, [cli, "init", "--no-install", "--yes"], { cwd: dir, encoding: "utf8", env });
  execFileSync(process.execPath, [cli, "rules", "enforce", "safe-shell", "--yes"], { cwd: dir, encoding: "utf8", env });
  const tool = (tool_name, tool_input) => {
    try {
      execFileSync(process.execPath, [cli, "claude"], { cwd: dir, env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], input: JSON.stringify({ cwd: dir, hook_event_name: "PreToolUse", tool_name, tool_input }) });
    } catch { /* a deny exits 2 */ }
  };
  const call = (command) => tool("Bash", { command });
  const enforce = (rule) => execFileSync(process.execPath, [cli, "rules", "enforce", rule, "--yes"], { cwd: dir, encoding: "utf8", env });
  return { dir, config, call, tool, enforce };
}

test("today's counts and the newest blocks, newest first, summarised without arguments", () => {
  const { config, call } = project();
  call("git status");
  call("rm -rf ./build --no-preserve-root SECRET-ARG-123");
  call("ls");
  call("dd if=/dev/zero of=/tmp/x");
  const activity = localActivity(config);
  assert.ok(activity, "the store is readable");
  assert.ok(activity.today.actions >= 4, `actions ${activity.today.actions}`);
  assert.equal(activity.today.blocked, 2);
  assert.deepEqual(activity.recent_blocks.map((b) => b.summary), ["shell.exec dd", "shell.exec rm"]);
  assert.ok(!activity.recent_blocks.some((b) => b.summary.includes("SECRET-ARG-123")), "the log's summary never carries arguments");
  assert.equal(localActivity(join(config, "nowhere")), null);
});

test("each block in plain words, as the Scopebond window shows the action (secrets masked), with the coding tool", () => {
  const { dir, config, call, tool, enforce } = project();
  enforce("protect-read");
  enforce("protect-branches");
  call("rm -rf ./build --token=SECRET-ARG-123");
  call("git push --force origin main");
  tool("Read", { file_path: join(dir, ".env.production") });
  const activity = localActivity(config, { limit: 20 });
  const [read, push, rm] = activity.recent_blocks;
  assert.equal(read.what, "Read .env.production");
  assert.equal(read.action_text, ".env.production");
  assert.equal(push.what, "git push --force origin main");
  assert.equal(rm.what, "rm -rf ./build --token=***", "a secret is masked as the window masks it");
  assert.equal(rm.action_text, rm.what);
  assert.equal(rm.summary, "shell.exec rm", "the older summary stays for older trays");
  for (const b of activity.recent_blocks) assert.equal(b.harness, "claude");
  assert.ok(!JSON.stringify(activity).includes("SECRET-ARG-123"), "arguments never appear");
});

test("plain words for each kind of action, and the rule names a person reads", () => {
  assert.equal(plainAction({ action_type: "file.write", params: { path: ".github/workflows/release.yml" } }), "Edit .github/workflows/release.yml");
  assert.equal(plainAction({ action_type: "git.push", params: { remote: "origin", ref: "release/1.2" } }), "git push origin release/1.2");
  assert.equal(plainAction({ action_type: "net.fetch", params: { url: "https://pastebin.com/raw/x" } }), "Reach https://pastebin.com/raw/x");
  assert.equal(plainAction({ action_type: "mcp.tool.call", params: { server: "github", tool: "delete_repository" } }), "Use github: delete_repository");
  assert.equal(plainAction({ action_type: "shell.exec", params: { command: "curl -H x (hmac-sha256:" + "a".repeat(64) + ")" } }), "curl -H x");
  assert.equal(plainAction({ action_type: "file.read", params: { path: "a\u202eb" } }), "Read a⟨U+202E⟩b", "hidden characters are written out");
  assert.equal(plainAction({ action_type: "cloud.resource.delete", params: {} }), "cloud.resource.delete");
  assert.ok(plainAction({ action_type: "file.read", params: { path: "x".repeat(400) } }).length <= 200);
  assert.equal(ruleTitle("secret-read"), "Reading a secret file");
  assert.equal(ruleTitle("not-a-rule"), null);
  assert.equal(ruleTitle("constructor"), null);
  assert.equal(ruleTitle(null), null);
});
