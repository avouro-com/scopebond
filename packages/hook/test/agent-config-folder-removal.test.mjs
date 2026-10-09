// Removing or renaming a folder takes what is inside it. Under the default rules the always-on protection stops the coding
// agent removing or renaming a folder that is, or holds, a protected place: an agent's own settings folder (.claude, .cursor,
// .codex, where its hook settings sit), a .git folder (its hooks and config), the working folder or a folder above it (the
// project's .scopebond), and a home folder or above. A wildcard that could name one of these counts as naming it. Removing
// ordinary folders, and changing ordinary files inside an agent's folder, stay allowed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mapClaudeToolUse, createHookRuntime, scaffold } from "../dist/index.js";

function defaultRuntime() {
  const dir = mkdtempSync(join(tmpdir(), "sb-rmdir-"));
  scaffold(dir);
  return createHookRuntime({
    policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"),
    attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db"),
  });
}
const map = (tool_name, command, cwd = "/repo") => mapClaudeToolUse({ tool_name, tool_input: { command }, cwd });
const decide = async (tool_name, command, cwd) => (await defaultRuntime().evaluate(map(tool_name, command, cwd))).decision;
const writes = (tool_name, command, cwd) =>
  map(tool_name, command, cwd).filter((m) => m.intent.action_type === "file.write").map((m) => m.intent.params.path);

const DENIED_BASH = [
  // the agent's own folder, by name
  "rm -rf .claude",
  "rm -rf ~/.claude",
  "rm -rf .cursor",
  "rm -rf .codex",
  "rm -rf ~/.codex",
  "rm -rf .claude/",
  "rm -r -- .claude",
  "rm -rf \"$HOME/.claude\"",
  "cd ~ && rm -rf .claude",
  "rmdir /s /q .claude",
  "find .claude -delete",
  "git rm -r .claude",
  // renamed or moved away
  "mv .claude .claude.off",
  "mv ~/.claude ~/.claude.bak",
  "mv .cursor .cursor.off",
  "git mv .codex codex-old",
  // a wildcard that could name a protected folder
  "rm -rf .c*",
  "rm -rf .scope*",
  "rm -rf ~/.cl*",
  "rm -rf ./.[!.]*",
  // a folder that holds protected places
  "rm -rf .git",
  "rm -rf ~",
  "rm -rf $HOME",
  "rm -rf /",
  "rm -rf .",
  "rm -rf ./",
  "rm -rf ..",
  "rm -rf /repo",
  "cd .. && rm -rf repo",
  "mv . ../elsewhere",
  "git clean -fdx",
];

const DENIED_POWERSHELL = [
  "Remove-Item -Recurse -Force .claude",
  "Remove-Item -Recurse -Force ~/.codex",
  "Remove-Item -Path .cursor -Recurse -Force",
  "Remove-Item -LiteralPath $env:USERPROFILE\\.claude -Recurse",
  "Remove-Item -Recurse -Force $env:USERPROFILE",
  "Rename-Item .claude claude-off",
  "Rename-Item -Path .claude -NewName claude-off",
  "Move-Item -Path ~/.claude -Destination ~/claude-off",
  "Move-Item .codex C:\\temp\\codex",
];

for (const command of DENIED_BASH) {
  test(`removing or renaming a protected folder is denied (Bash): ${command}`, async () => {
    assert.equal(await decide("Bash", command), "deny", `${command} -> writes ${JSON.stringify(writes("Bash", command))}`);
  });
}

for (const command of DENIED_POWERSHELL) {
  test(`removing or renaming a protected folder is denied (PowerShell): ${command}`, async () => {
    assert.equal(await decide("PowerShell", command), "deny", `${command} -> writes ${JSON.stringify(writes("PowerShell", command))}`);
  });
}

test("ordinary removals and renames stay allowed", async () => {
  for (const command of [
    "rm -rf build",
    "rm -rf node_modules dist",
    "rm -rf ./dist",
    "rm -rf *",
    "rm -f .claude/commands/old.md",
    "rm -rf .claude/commands",
    "mv .claude/commands/a.md .claude/commands/b.md",
    "cd build && rm -rf .",
    "rm -rf ../other-project",
    "find . -name '*.tmp' -delete",
    "git clean -fd build",
    "git clean -fd",
    "git rm --cached -r .",
    "rm -rf .github/old-docs",
    "rm -rf .cache",
  ]) {
    assert.notEqual(await decide("Bash", command), "deny", `${command} -> writes ${JSON.stringify(writes("Bash", command))}`);
  }
  for (const command of ["Remove-Item -Recurse -Force build", "Rename-Item notes.md notes-old.md", "Move-Item -Path dist -Destination out"]) {
    assert.notEqual(await decide("PowerShell", command), "deny", command);
  }
});

test("writing ordinary files inside an agent's folder stays allowed", async () => {
  const write = (file_path) => mapClaudeToolUse({ tool_name: "Write", tool_input: { file_path, content: "x" }, cwd: "/repo" });
  for (const path of [".claude/commands/review.md", ".claude/CLAUDE.md", ".cursor/rules/style.mdc", ".codex/prompts/x.md"]) {
    assert.notEqual((await defaultRuntime().evaluate(write(path))).decision, "deny", path);
  }
});
