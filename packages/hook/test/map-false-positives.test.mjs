import { test } from "node:test";
import assert from "node:assert/strict";
import { mapClaudeToolUse } from "../dist/index.js";

const bash = (command) => mapClaudeToolUse({ tool_name: "Bash", tool_input: { command } });
const paths = (mapped, type) => mapped.filter((m) => m.intent.action_type === type).map((m) => m.intent.params.path);

test("an escaped quote in a search pattern that names Scopebond is a read, not switching Scopebond off", () => {
  // The Windows reading turns \" into /" and leaves a quote open; the POSIX reading already understood it.
  const mapped = bash(String.raw`grep -io "scopebond[^\"]*" project/.claude/settings.json | sort | uniq -c | head`);
  assert.deepEqual(paths(mapped, "file.write"), []);
  assert.deepEqual(paths(mapped, "file.read"), ["project/.claude/settings.json"]);
});

test("the Windows reading still catches a real write or switch-off behind an unbalanced quote", () => {
  // cmd.exe does not escape a quote with \, so these really redirect into Scopebond's folder or run it.
  for (const command of [
    String.raw`echo "\" > .scopebond\policy.json "`,
    String.raw`echo "\" & npx @scopebond/hook uninstall "`,
    String.raw`echo "\" & scopebond off "`,
  ]) assert.ok(paths(bash(command), "file.write").includes(".scopebond/policy.json"), command);
});

test("grep -o is 'only matching': its pattern is not a file and the searched file is read", () => {
  const mapped = bash(`grep -o "@scopebond/hook@[0-9.]*" project/.claude/settings.json`);
  assert.deepEqual(paths(mapped, "file.write"), []);
  assert.deepEqual(paths(mapped, "file.read"), ["project/.claude/settings.json"]);
});

test("declared file options still count: sort -o writes, grep -f reads, curl -o writes", () => {
  assert.deepEqual(paths(bash("sort -o out.txt in.txt"), "file.write"), ["out.txt"]);
  assert.ok(paths(bash("grep -f patterns.txt notes.txt"), "file.read").includes("patterns.txt"));
  assert.deepEqual(paths(bash("curl -o .scopebond/policy.json https://example.com"), "file.write"), [".scopebond/policy.json"]);
});
