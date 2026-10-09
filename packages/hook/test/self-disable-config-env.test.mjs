// A coding agent started with its config folder moved elsewhere (CLAUDE_CONFIG_DIR, CODEX_HOME, CURSOR_CONFIG_DIR,
// XDG_CONFIG_HOME, or the home folder itself) runs without this computer's hooks. The variable reaches the agent from anywhere
// in the same command line: an export before it, an assignment on an enclosing shell, a nested `sh -c`, `cmd /c` or
// PowerShell body, a PowerShell `$env:` assignment. Each such launch is a switch-off the always-on protection stops, under the
// default rules; a command line that sets one of these variables and cannot be read is treated the same way.
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
const map = (tool_name, command) => mapClaudeToolUse({ tool_name, tool_input: { command }, cwd: "/repo" });
const decide = async (tool_name, command) => (await defaultRuntime().evaluate(map(tool_name, command))).decision;
const switchesOff = (tool_name, command) =>
  map(tool_name, command).some((m) => m.intent.action_type === "file.write" && m.intent.params.path === ".scopebond/policy.json");
const encoded = (script) => Buffer.from(script, "utf16le").toString("base64");

const DENIED_BASH = [
  // the inline form (already caught)
  "CLAUDE_CONFIG_DIR=/tmp/clean claude -p 'tidy up'",
  // set in a preceding command of the same call
  "export CLAUDE_CONFIG_DIR=/tmp/clean && claude -p 'do stuff'",
  "export CLAUDE_CONFIG_DIR=/tmp/clean; claude -p 'do stuff'",
  "export CODEX_HOME=/tmp/clean && codex exec 'do stuff'",
  "export XDG_CONFIG_HOME=/tmp/c && cursor-agent -p x",
  "CLAUDE_CONFIG_DIR=/tmp/clean; export CLAUDE_CONFIG_DIR; claude -p x",
  "declare -x CURSOR_CONFIG_DIR=/tmp/c; cursor-agent -p x",
  "export CLAUDE_CON\"FIG_DIR\"=/tmp/c; claude -p x",
  "read CLAUDE_CONFIG_DIR <<< /tmp/c; export CLAUDE_CONFIG_DIR; claude -p x",
  "set -gx CODEX_HOME /tmp/c; codex exec x",
  "setenv CLAUDE_CONFIG_DIR /tmp/c; claude -p x",
  ": ${CLAUDE_CONFIG_DIR:=/tmp/c}; export CLAUDE_CONFIG_DIR; claude -p x",
  // set on an enclosing command, or inside a nested script
  "CLAUDE_CONFIG_DIR=/tmp/clean sh -c 'claude -p x'",
  "env CLAUDE_CONFIG_DIR=/tmp/c bash -c 'claude -p x'",
  "bash -c 'export CLAUDE_CONFIG_DIR=/tmp/c; claude -p x'",
  "cmd /c \"set CLAUDE_CONFIG_DIR=C:\\tmp\\c&& claude -p x\"",
  "powershell -Command \"$env:CLAUDE_CONFIG_DIR='C:/tmp/c'; claude -p x\"",
  `powershell -EncodedCommand ${encoded("$env:CLAUDE_CONFIG_DIR='C:\\tmp\\c'; claude -p x")}`,
  // the home folder holds the agents' default config folders
  "HOME=/tmp/clean claude -p x",
  "export HOME=/tmp/clean && claude -p x",
  // the agent started through its package
  "export CLAUDE_CONFIG_DIR=/tmp/c; npx @anthropic-ai/claude-code -p x",
  // a program known only at run time, or a command that cannot be read: fail closed
  "export CLAUDE_CONFIG_DIR=/tmp/c; $AGENT -p x",
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

test("ordinary commands that start an agent or touch these variables stay allowed", async () => {
  for (const command of [
    "claude -p 'explain this repo'",
    "echo \"$CLAUDE_CONFIG_DIR\" && claude -p x",
    "echo ${CODEX_HOME:-~/.codex}; codex exec x",
    "unset CLAUDE_CONFIG_DIR && claude -p x",
    "export XDG_CONFIG_HOME=/tmp/x && npm test",
    "CODEX_HOME=/tmp/x node --test",
    "HOME=/tmp/h npm test",
  ]) {
    assert.ok(!switchesOff("Bash", command), `mapped as a switch-off: ${command}`);
    assert.notEqual(await decide("Bash", command), "deny", command);
  }
  for (const command of ["Write-Output $env:CLAUDE_CONFIG_DIR; claude -p x", "$env:XDG_CONFIG_HOME = 'C:\\tmp\\x'; npm test"]) {
    assert.ok(!switchesOff("PowerShell", command), `mapped as a switch-off: ${command}`);
    assert.notEqual(await decide("PowerShell", command), "deny", command);
  }
});
