// A coding agent started with its config folder moved elsewhere (CLAUDE_CONFIG_DIR, CODEX_HOME, CURSOR_CONFIG_DIR,
// XDG_CONFIG_HOME, or the home folder itself) runs without this computer's hooks. The variable reaches the agent from its own
// prefix, from an enclosing command (`X=… sh -c 'claude'`), or from an earlier command of the same call (`export X=… &&
// claude`, cmd `set`, PowerShell `$env:`). Each such launch is a switch-off the always-on protection stops under the default
// rules. Only an agent actually started counts — the agent is the program of a parsed command, or the package a runner starts —
// and only a variable set by a command (not a word in a message), before or with that start: an agent's name in a commit
// message, a grep pattern or a folder, a HOME set for a test run, or a variable set after the agent ran is ordinary work.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mapClaudeToolUse, createHookRuntime, scaffold } from "../dist/index.js";

function defaultRuntime() {
  const dir = mkdtempSync(join(tmpdir(), "sb-cfgenv-"));
  scaffold(dir);
  return createHookRuntime({
    policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"),
    attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db"),
  });
}
const runtime = defaultRuntime();
const map = (tool_name, command) => mapClaudeToolUse({ tool_name, tool_input: { command }, cwd: "/repo" });
const decide = async (tool_name, command) => (await runtime.evaluate(map(tool_name, command))).decision;
const switchesOff = (tool_name, command) =>
  map(tool_name, command).some((m) => m.intent.action_type === "file.write" && m.intent.params.path === ".scopebond/policy.json");
const encoded = (script) => Buffer.from(script, "utf16le").toString("base64");

const DENIED_BASH = [
  // the agent's own prefix
  "CLAUDE_CONFIG_DIR=/tmp/clean claude -p 'tidy up'",
  "HOME=/tmp/clean claude -p x",
  "env CLAUDE_CONFIG_DIR=/tmp/c claude -p x",
  // set by an earlier command of the same call
  "export CLAUDE_CONFIG_DIR=/tmp/clean && claude -p 'do stuff'",
  "export CLAUDE_CONFIG_DIR=/tmp/clean; claude -p 'do stuff'",
  "export CODEX_HOME=/tmp/clean && codex exec 'do stuff'",
  "export XDG_CONFIG_HOME=/tmp/c && cursor-agent -p x",
  "export HOME=/tmp/clean && claude -p x",
  "CLAUDE_CONFIG_DIR=/tmp/clean; export CLAUDE_CONFIG_DIR; claude -p x",
  "declare -x CURSOR_CONFIG_DIR=/tmp/c; cursor-agent -p x",
  "export CLAUDE_CON\"FIG_DIR\"=/tmp/c; claude -p x",
  "read CLAUDE_CONFIG_DIR <<< /tmp/c; export CLAUDE_CONFIG_DIR; claude -p x",
  "set -gx CODEX_HOME /tmp/c; codex exec x",
  "setenv CLAUDE_CONFIG_DIR /tmp/c; claude -p x",
  // set on an enclosing command, or inside a nested script
  "CLAUDE_CONFIG_DIR=/tmp/clean sh -c 'claude -p x'",
  "env CLAUDE_CONFIG_DIR=/tmp/c bash -c 'claude -p x'",
  "bash -c 'export CLAUDE_CONFIG_DIR=/tmp/c; claude -p x'",
  "cmd /c \"set CLAUDE_CONFIG_DIR=C:\\tmp\\c&& claude -p x\"",
  "powershell -Command \"$env:CLAUDE_CONFIG_DIR='C:/tmp/c'; claude -p x\"",
  `powershell -EncodedCommand ${encoded("$env:CLAUDE_CONFIG_DIR='C:\\tmp\\c'; claude -p x")}`,
  // the agent started through its package or its package's script
  "export CLAUDE_CONFIG_DIR=/tmp/c; npx @anthropic-ai/claude-code -p x",
  "CODEX_HOME=/tmp/c pnpm dlx @openai/codex exec x",
  "env CLAUDE_CONFIG_DIR=/tmp/c node ./node_modules/@anthropic-ai/claude-code/cli.js -p x",
  "CLAUDE_CONFIG_DIR=/tmp/c node $(npm root -g)/@anthropic-ai/claude-code/cli.js -p x",
  // a command that does not parse is read with its quote closed: the agent is still seen
  "export CLAUDE_CONFIG_DIR=/tmp/c; claude -p \"unclosed",
];

const DENIED_POWERSHELL = [
  "$env:CLAUDE_CONFIG_DIR = 'C:\\tmp\\clean'; claude -p x",
  "$env:CODEX_HOME='C:\\tmp\\c'; codex exec x",
  "${env:CLAUDE_CONFIG_DIR} = 'C:\\tmp\\c'; claude -p x",
  "Set-Item -Path Env:CLAUDE_CONFIG_DIR -Value C:\\tmp\\c; claude -p x",
  "[Environment]::SetEnvironmentVariable('CLAUDE_CONFIG_DIR', 'C:\\tmp\\c', 'Process'); claude -p x",
  "$env:USERPROFILE = 'C:\\tmp\\c'; claude -p x",
];

for (const command of DENIED_BASH) {
  test(`an agent started with its config folder moved is a switch-off (Bash): ${command}`, async () => {
    assert.ok(switchesOff("Bash", command), `not mapped as a switch-off: ${command}`);
    assert.equal(await decide("Bash", command), "deny", command);
  });
}

for (const command of DENIED_POWERSHELL) {
  test(`an agent started with its config folder moved is a switch-off (PowerShell): ${command}`, async () => {
    assert.ok(switchesOff("PowerShell", command), `not mapped as a switch-off: ${command}`);
    assert.equal(await decide("PowerShell", command), "deny", command);
  });
}

const TRAILER = "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>";
const ALLOWED_BASH = [
  "claude -p 'explain this repo'",
  "echo \"$CLAUDE_CONFIG_DIR\" && claude -p x",
  "echo ${CODEX_HOME:-~/.codex}; codex exec x",
  "unset CLAUDE_CONFIG_DIR && claude -p x",
  "export XDG_CONFIG_HOME=/tmp/x && npm test",
  "export XDG_CONFIG_HOME=$PWD/.config && npm test",
  "CODEX_HOME=/tmp/x node --test",
  "CODEX_HOME=/tmp/x cargo build",
  "export CLAUDE_CONFIG_DIR=/tmp/c ; ls",
  "XDG_CONFIG_HOME=/tmp/x git status",
  "HOME=/tmp/h npm test",
  "docker run --rm -e HOME=/tmp node:20 npm test",
  "env -u HOME npm test",
  // an agent's name in a commit message, next to text about HOME (the trailer the agent itself writes)
  `git commit -m "$(cat <<'EOF'\ntest: tests now set HOME to a temp folder\n\n${TRAILER}\nEOF\n)"`,
  `git commit -m "$(cat <<'EOF'\nfix: isolate XDG_CONFIG_HOME=\\$TMP in installer tests\n\n${TRAILER}\nEOF\n)"`,
  `git commit -m "chore: read HOME from env" -m "${TRAILER}"`,
  `git commit -m "docs: explain the home = landing page" -m "${TRAILER}"`,
  "gh pr create --title \"Isolate USERPROFILE in tests\" --body \"Set USERPROFILE=%TEMP% for the Windows tests. Generated with Claude Code\"",
  // an agent's name as data, HOME isolation for tests
  "export HOME=/tmp/h && grep -rn claude src/",
  "HOME=/tmp/h npm test -- --grep codex",
  "export HOME=$(mktemp -d) && cd codex && cargo test",
  "export XDG_CONFIG_HOME=/tmp/x && npm run lint && echo \"done with gemini\"",
  // the variable set after the agent ran
  "claude --version && export HOME=/tmp/h",
  "claude mcp list; export XDG_CONFIG_HOME=/tmp/x; npm test",
  // not assignments: a URL query and another program's flag
  "curl \"https://api.example.com/x?home=1\" && echo claude",
  "pip install --home=/opt/x aider-chat && aider --version",
  // a program known only at run time is not taken for an agent (it is recorded with an empty program)
  "export HOME=/tmp/h && $SHELL -c 'npm test'",
  "export HOME=/tmp/h && eval \"$BUILD_CMD\"",
  "export HOME=/tmp/h && \"$NODE\" script.js",
  "export CLAUDE_CONFIG_DIR=/tmp/c; $AGENT -p x",
];

for (const command of ALLOWED_BASH) {
  test(`ordinary work stays allowed (Bash): ${command.split("\n")[0]}`, async () => {
    assert.ok(!switchesOff("Bash", command), `mapped as a switch-off: ${command}`);
    assert.notEqual(await decide("Bash", command), "deny", command);
  });
}

test("ordinary work stays allowed (PowerShell)", async () => {
  for (const command of ["Write-Output $env:CLAUDE_CONFIG_DIR; claude -p x", "$env:XDG_CONFIG_HOME = 'C:\\tmp\\x'; npm test", "claude --version; $env:USERPROFILE = 'C:\\tmp\\c'"]) {
    assert.ok(!switchesOff("PowerShell", command), `mapped as a switch-off: ${command}`);
    assert.notEqual(await decide("PowerShell", command), "deny", command);
  }
});

test("a program known only at run time is recorded with an empty program, which safe-shell judges", () => {
  const programs = map("Bash", "export CLAUDE_CONFIG_DIR=/tmp/c; $AGENT -p x")
    .filter((m) => m.intent.action_type === "shell.exec").map((m) => m.intent.params.program);
  assert.ok(programs.includes(""), JSON.stringify(programs));
});
