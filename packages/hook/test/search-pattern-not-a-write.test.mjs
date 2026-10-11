// A search whose pattern names Scopebond is a read-only command. Read with `\` as a path separator (the Windows reading of a
// "Bash" command) or as PowerShell, `\"` closes a quote and leaves one open; the whole text then used to count as switching
// Scopebond off (`file.write .scopebond/policy.json`). Only a mention in a search's pattern is let through: a redirect, a
// second command cmd or PowerShell would run, code in an argument, or Scopebond's own folder still count.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mapClaudeToolUse, createHookRuntime, scaffold } from "../dist/index.js";

function defaultRuntime() {
  const dir = mkdtempSync(join(tmpdir(), "sb-search-"));
  scaffold(dir);
  return createHookRuntime({
    policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"),
    attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db"),
  });
}
const runtime = defaultRuntime();
const map = (tool, command) => mapClaudeToolUse({ tool_name: tool, tool_input: { command }, cwd: "/repo" });
const writes = (tool, command) => map(tool, command).filter((m) => m.intent.action_type === "file.write").map((m) => m.intent.params.path);
const decide = async (tool, command) => (await runtime.evaluate(map(tool, command))).decision;

const SEARCHES = [
  String.raw`grep -rhoE "scopebond-agent(\.cmd)? (setup|status)[^\"]*" docs/`,
  String.raw`grep -rhoE "npx(\.cmd)? -y @scopebond/agent@[^ \"]+ (setup|status)|scopebond-agent(\.cmd)? (setup|status)[^\"]*" docs/ | sort -u`,
  String.raw`git grep 'avouro.\{1,4\}scopebond'`,
  String.raw`git grep -n "avouro.\{1,4\}scopebond[^\"]*" -- docs/`,
  String.raw`git -C packages grep -nE "@scopebond/hook@[^\"]+" -- '*.md'`,
  String.raw`rg -n "scopebond-agent(\.exe)?[^\"]*" packages/native`,
  String.raw`findstr /s /i "scopebond-agent[^\"]*" *.md`,
  String.raw`Select-String -Path docs\*.md -Pattern "scopebond-agent[^\"]*"`,
];

for (const command of SEARCHES) {
  for (const tool of ["Bash", "PowerShell"]) {
    test(`${tool}: a search whose pattern names Scopebond is allowed: ${command}`, async () => {
      assert.deepEqual(writes(tool, command), [], "no write");
      assert.equal(await decide(tool, command), "allow");
    });
  }
}

const REAL_WRITES = [
  ["Bash", "echo x > .scopebond/policy.json"],
  ["PowerShell", "echo x > .scopebond/policy.json"],
  ["PowerShell", String.raw`Set-Content .scopebond\policy.json x`],
  ["PowerShell", String.raw`Set-Content -Path .scopebond\policy.json -Value x`],
  ["Bash", "cp x .scopebond/"],
  ["PowerShell", "cp x .scopebond/"],
  // a second command behind a quote cmd or PowerShell closes
  ["Bash", String.raw`grep "\" & copy x .scopebond\policy.json & rem "`],
  ["Bash", String.raw`grep "\" & npx -y @scopebond/hook uninstall & rem "`],
  ["Bash", String.raw`grep "\" & scopebond-agent uninstall & rem \"` + "`x\""],
  // a PowerShell backtick-escaped quote, which the reading cannot follow
  ["PowerShell", "grep \"`\"\" ; Remove-Item -Recurse .scopebond"],
  ["PowerShell", "grep \"`\"\" ; scopebond-agent uninstall"],
  // code run inside the pattern
  ["PowerShell", String.raw`grep "$(scopebond-agent uninstall)[^\"]*" "`],
  // Scopebond's folder in the searched files
  ["Bash", String.raw`grep -o "a\"b" .scopebond\cloud.json`],
  ["PowerShell", String.raw`grep -o "a\"b" .scopebond\cloud.json`],
];

for (const [tool, command] of REAL_WRITES) {
  test(`${tool}: a real write or switch-off is still denied: ${command}`, async () => {
    assert.equal(await decide(tool, command), "deny");
  });
}
