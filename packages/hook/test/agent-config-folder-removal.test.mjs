// Removing or renaming a folder takes what is inside it. Under the default rules the always-on protection stops the coding
// agent removing or renaming a folder that holds what it protects: this project's own agent settings folders (.claude, .cursor,
// .codex), its .git (the git hooks) and .scopebond, the same in the home folder, and any folder above them (the working folder,
// a home folder). A wildcard or a brace list that could name one of these counts as naming it. The same names elsewhere — a test
// fixture, a vendored library's .git, a clone in /tmp — are someone else's and stay removable, as do brace-listed build
// folders, filtered deletes and a `git clean -x` that cannot reach Scopebond's folder or the personal hook settings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
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
const runtime = defaultRuntime();
const map = (tool_name, command, cwd = "/repo") => mapClaudeToolUse({ tool_name, tool_input: { command }, cwd });
const decide = async (tool_name, command, cwd) => (await runtime.evaluate(map(tool_name, command, cwd))).decision;
const writes = (tool_name, command, cwd) =>
  map(tool_name, command, cwd).filter((m) => m.intent.action_type === "file.write").map((m) => m.intent.params.path);

const DENIED_BASH = [
  // the project's own agent folders, by name
  "rm -rf .claude",
  "rm -rf .cursor",
  "rm -rf .codex",
  "rm -rf .claude/",
  "rm -r -- .claude",
  "rm -rf /repo/.claude",
  "rm -rf ../.claude",
  "rmdir /s /q .claude",
  "find .claude -delete",
  "find .claude -type f -delete",
  "find .claude -name 'settings*' -delete",
  "git rm -r .claude",
  "cd .claude && rm -rf *",
  "rm -rf .claude/*",
  "rm -rf .git",
  // the home folder's
  "rm -rf ~/.claude",
  "rm -rf ~/.codex",
  "rm -rf \"$HOME/.claude\"",
  "cd ~ && rm -rf .claude",
  "rsync -a --delete empty/ ~/.claude",
  // renamed or moved away
  "mv .claude .claude.off",
  "mv ~/.claude ~/.claude.bak",
  "mv .cursor .cursor.off",
  "git mv .codex codex-old",
  // a wildcard or brace list that could name a protected folder
  "rm -rf .c*",
  "rm -rf .scope*",
  "rm -rf ~/.cl*",
  "rm -rf ./.[!.]*",
  "rm -rf .{claude,cursor}",
  "rm -rf {build,.claude}",
  // a folder above them
  "rm -rf ~",
  "rm -rf $HOME",
  "rm -rf /",
  "rm -rf .",
  "rm -rf ./",
  "rm -rf ..",
  "rm -rf /repo",
  "cd .. && rm -rf repo",
  "mv . ../elsewhere",
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

const ALLOWED_BASH = [
  ["rm -rf build"], ["rm -rf node_modules dist"], ["rm -rf ./dist"], ["rm -rf *"], ["rm -rf .venv"], ["rm -rf .cache"],
  ["rm -f .claude/commands/old.md"], ["rm .claude/commands/foo.md"], ["rm -rf .claude/commands"], ["rm -rf .claude/worktrees/feature-x"],
  ["git worktree remove --force .claude/worktrees/feature-x"], ["mv .claude/commands/a.md .claude/commands/b.md"],
  ["cd build && rm -rf ."], ["rm -rf ../other-project"], ["rm -rf .github/old-docs"], ["rm -rf .git/index.lock"],
  ["find . -name '*.tmp' -delete"], ["find . -name .claude -prune"], ["git clean -fd build"], ["git clean -fd"],
  ["git rm --cached -r ."], ["cp -r .claude backup"],
  // brace lists are fixed words
  ["rm -rf {build,dist}"], ["rm -rf {node_modules,package-lock.json}"], ["rm -rf dist/{esm,cjs}"], ["rm -rf build/{a,b}"],
  ["rm -rf packages/{hook,mcp}/dist"], ["rm -rf {1..3}"],
  // another repository's .git: vendored, a temp clone, a template being re-initialised
  ["rm -rf vendor/lib/.git"], ["rm -rf third_party/foo/.git"], ["rm -rf /tmp/clone/.git"],
  ["git clone https://github.com/x/template app && cd app && rm -rf .git && git init"],
  // an agent folder that is not this project's or this person's
  ["rm -rf test/fixtures/sample-project/.claude"], ["rm -rf /tmp/x/.claude"],
  // filtered deletes under an agent folder that cannot reach its hook settings
  ["find .claude -name '*.log' -delete"], ["find ~/.claude -name '*.tmp' -delete"],
  // git clean -x where the project holds no .scopebond or personal hook settings to lose
  ["git clean -fdx"], ["git clean -fdx -e .scopebond"], ["git clean -ffdx --exclude=.scopebond"], ["git -C packages/foo clean -fdx"],
  // a working folder inside an agent folder (a worktree): ordinary cleanup there
  ["rm -rf node_modules dist", "/repo/.claude/worktrees/feat"], ["git clean -fd", "/repo/.claude/worktrees/feat"],
];

for (const [command, cwd] of ALLOWED_BASH) {
  test(`ordinary removal stays allowed (Bash): ${command}${cwd ? ` in ${cwd}` : ""}`, async () => {
    assert.notEqual(await decide("Bash", command, cwd), "deny", `${command} -> writes ${JSON.stringify(writes("Bash", command, cwd))}`);
  });
}

test("ordinary removal stays allowed (PowerShell)", async () => {
  for (const command of ["Remove-Item -Recurse -Force build", "Rename-Item notes.md notes-old.md", "Move-Item -Path dist -Destination out", "Remove-Item -Recurse -Force vendor\\lib\\.git"]) {
    assert.notEqual(await decide("PowerShell", command, "C:\\repo"), "deny", command);
  }
});

test("git clean -x is denied only where it would take the project's .scopebond or personal hook settings", async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), "sb-clean-")));
  mkdirSync(join(project, ".scopebond"));
  writeFileSync(join(project, ".scopebond", ".gitignore"), "*\n");
  assert.equal(await decide("Bash", "git clean -fdx", project), "deny");
  assert.equal(await decide("Bash", "git clean -fdX", project), "deny");
  assert.equal(await decide("Bash", "cd .. && git clean -fdx " + project.split(/[\\/]/).pop(), project), "deny");
  assert.notEqual(await decide("Bash", "git clean -fdx -e .scopebond", project), "deny");
  assert.notEqual(await decide("Bash", "git clean -fdx --exclude=/.scopebond/", project), "deny");
  assert.notEqual(await decide("Bash", "git clean -fd", project), "deny");
  assert.notEqual(await decide("Bash", "git clean -fdx build", project), "deny");
  assert.notEqual(await decide("Bash", "git -C packages/foo clean -fdx", project), "deny");
  // the personal hook registration a project keeps out of git
  mkdirSync(join(project, ".claude"));
  writeFileSync(join(project, ".claude", "settings.local.json"), "{}\n");
  assert.equal(await decide("Bash", "git clean -fdx -e .scopebond", project), "deny");
  assert.notEqual(await decide("Bash", "git clean -fdx -e .scopebond -e .claude", project), "deny");
});

test("writing ordinary files inside an agent's folder stays allowed", async () => {
  const write = (file_path) => mapClaudeToolUse({ tool_name: "Write", tool_input: { file_path, content: "x" }, cwd: "/repo" });
  for (const path of [".claude/commands/review.md", ".claude/CLAUDE.md", ".cursor/rules/style.mdc", ".codex/prompts/x.md"]) {
    assert.notEqual((await runtime.evaluate(write(path))).decision, "deny", path);
  }
});
