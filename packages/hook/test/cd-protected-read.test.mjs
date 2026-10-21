// A program run after a `cd` into a protected folder reads there, whatever its arguments: it is recorded as a read of the
// folder, which the read rules judge (Scopebond's own folder always; credentials when secret reads block). A folder that holds
// nothing protected adds nothing.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENFORCE } from "./enforce-all.mjs";
import { scaffold, createHookRuntime, mapClaudeToolUse } from "../dist/index.js";

const temps = [];
after(() => { for (const d of temps) { try { rmSync(d, { recursive: true, force: true, maxRetries: 5 }); } catch { /* a handle still open on Windows */ } } });
function runtime(enforce) {
  const dir = mkdtempSync(join(tmpdir(), "sb-cdread-"));
  temps.push(dir);
  scaffold(dir, enforce);
  return createHookRuntime({ policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"), attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db"), cwd: "/repo" });
}
const call = (command, tool = "Bash") => mapClaudeToolUse({ tool_name: tool, tool_input: { command }, cwd: "/repo" });
const reads = (command, tool) => [call(command, tool)].flat().filter((m) => m.intent.action_type === "file.read").map((m) => m.intent.params.path);

test("a program after a cd into a protected folder reads the folder", () => {
  assert.ok(reads("cd ~/.scopebond && ls").includes("~/.scopebond"));
  assert.ok(reads("cd ~/.ssh && cat config").includes("~/.ssh"));
  assert.ok(reads("cd ~/.ssh/keys && ls").includes("~/.ssh"), "inside it, the protected folder itself is read");
  assert.ok(reads("cd ~/.config/gh && ls").includes("~/.config/gh"));
  assert.ok(reads("cd /srv/app && cd .kube && ls").some((p) => /\.kube$/.test(p)));
  assert.ok(reads("Set-Location ~/.aws; Get-ChildItem", "PowerShell").includes("~/.aws"));
  for (const command of ["cd src && ls", "cd .git && ls", "cd ~/.ssh", "cd ~/.ssh/.. && ls", "ls ~/projects"]) {
    assert.ok(!reads(command).some((p) => /\.(?:ssh|scopebond|git)$/.test(p)), command);
  }
});

test("judged: Scopebond's folder always, credentials when secret reads block", async () => {
  const monitor = runtime({ enforce: [] });
  const enforced = runtime(ENFORCE);
  try {
    const decide = async (rt, command) => (await rt.evaluate(call(command))).decision;
    assert.equal(await decide(monitor, "cd ~/.scopebond && ls"), "deny");
    assert.equal(await decide(monitor, "cd ~/.ssh && cat config"), "allow");
    assert.equal(await decide(enforced, "cd ~/.scopebond && ls"), "deny");
    assert.equal(await decide(enforced, "cd ~/.ssh && cat config"), "deny");
    assert.equal(await decide(enforced, "cd ~/.ssh && ls"), "deny");
    assert.equal(await decide(enforced, "cd src && ls"), "allow");
    assert.equal(await decide(enforced, "cat ~/.ssh/config"), "allow", "a named file the rules allow stays allowed without a cd");
  } finally { monitor.close(); enforced.close(); }
});
