// The tray's "Today" row and "Recently blocked" list come from the computer's own receipts (SB387, SB389): counts since
// local midnight, the newest blocks as the one-line summary `log` prints (never raw arguments), monitored matches excluded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { localActivity } from "../dist/index.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function project() {
  const dir = mkdtempSync(join(tmpdir(), "sb-activity-"));
  const config = join(dir, "sb-config");
  const env = { ...process.env, SCOPEBOND_HOOK_DIR: config };
  execFileSync(process.execPath, [cli, "init", "--no-install", "--yes"], { cwd: dir, encoding: "utf8", env });
  execFileSync(process.execPath, [cli, "rules", "enforce", "safe-shell", "--yes"], { cwd: dir, encoding: "utf8", env });
  const call = (command) => {
    try {
      execFileSync(process.execPath, [cli, "claude"], { cwd: dir, env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], input: JSON.stringify({ cwd: dir, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }) });
    } catch { /* a deny exits 2 */ }
  };
  return { dir, config, call };
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
  assert.ok(!JSON.stringify(activity).includes("SECRET-ARG-123"), "arguments never appear");
  assert.equal(localActivity(join(config, "nowhere")), null);
});
