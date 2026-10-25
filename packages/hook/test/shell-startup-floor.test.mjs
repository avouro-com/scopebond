// A coding agent that changes what every later session starts with can switch Scopebond off for the next one: a line in a shell
// startup file (`export SCOPEBOND_HOOK_DIR=…` in ~/.zshrc), or a variable set for every later session (`setx`, `launchctl
// setenv`, a User or Machine `SetEnvironmentVariable`). The always-on floor stops writes to the startup files, and a command that
// sets a variable moving Scopebond's or a coding agent's folder for later sessions is a switch-off. Once a person's own install
// exists, a hook call honours SCOPEBOND_HOOK_DIR only for that install or a folder whose policy the person trusted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mapClaudeToolUse, createHookRuntime, scaffold } from "../dist/index.js";
import { resolveConfigDir, trustProjectPolicy } from "../dist/install.js";

function defaultRuntime() {
  const dir = mkdtempSync(join(tmpdir(), "sb-startup-"));
  scaffold(dir);
  return createHookRuntime({
    policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"),
    attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db"),
  });
}
const runtime = defaultRuntime();
// The person's home folder as the coding agent reports it: an absolute path.
const home = homedir().replace(/\\/g, "/");
const decide = async (tool_name, tool_input) => (await runtime.evaluate(mapClaudeToolUse({ tool_name, tool_input, cwd: "/repo" }))).decision;

test("the floor stops writes to shell startup files, through the file tools and the shell", async () => {
  for (const file_path of [
    `${home}/.zshrc`, `${home}/.bashrc`, `${home}/.profile`, `${home}/.bash_profile`, `${home}/.zshenv`, `${home}/.zprofile`,
    `${home}/.config/fish/config.fish`, `${home}/.config/fish/conf.d/env.fish`, `${home}/.config/environment.d/50-x.conf`,
    "/etc/profile.d/x.sh", "/etc/environment",
    "D:/Profiles/dev/Documents/PowerShell/Microsoft.PowerShell_profile.ps1", "D:/Profiles/dev/Documents/WindowsPowerShell/profile.ps1",
  ]) {
    assert.equal(await decide("Write", { file_path, content: "export SCOPEBOND_HOOK_DIR=/tmp/x\n" }), "deny", file_path);
  }
  assert.equal(await decide("Edit", { file_path: `${home}/.zshrc`, old_string: "a", new_string: "b" }), "deny");
  for (const command of [
    "echo 'export SCOPEBOND_HOOK_DIR=/tmp/x' >> ~/.zshrc",
    "printf 'export HOME=/tmp/c\\n' >> $HOME/.bashrc",
    "echo 'export SCOPEBOND_HOME=/tmp/x' | tee -a ~/.profile",
    "cp /tmp/evil ~/.zshenv",
  ]) {
    assert.equal(await decide("Bash", { command }), "deny", command);
  }
});

test("ordinary files that only look like startup files stay writable", async () => {
  for (const file_path of ["/repo/src/profile.ts", "/repo/docs/bashrc.md", "/repo/.zshrc.example", "/repo/config/environment.ts", "/repo/etc/profile.json"]) {
    assert.equal(await decide("Write", { file_path, content: "x" }), "allow", file_path);
  }
  assert.equal(await decide("Bash", { command: "cat ~/.zshrc" }), "allow");
});

test("setting a variable that moves Scopebond's or an agent's folder for every later session is a switch-off", async () => {
  for (const command of [
    "setx SCOPEBOND_HOME C:\\tmp\\x",
    "setx SCOPEBOND_HOOK_DIR C:\\tmp\\x",
    "setx CLAUDE_CONFIG_DIR C:\\tmp\\c",
    "launchctl setenv SCOPEBOND_HOOK_DIR /tmp/x",
    "powershell -Command \"[Environment]::SetEnvironmentVariable('SCOPEBOND_HOME', 'C:\\tmp\\x', 'User')\"",
    "powershell -Command \"[System.Environment]::SetEnvironmentVariable('CODEX_HOME', 'C:\\tmp\\c', [System.EnvironmentVariableTarget]::Machine)\"",
  ]) {
    assert.equal(await decide("Bash", { command }), "deny", command);
  }
  // Started with Scopebond's folder moved, a coding agent runs under rules of the agent's choosing.
  for (const command of ["SCOPEBOND_HOME=/tmp/x claude -p hi", "export SCOPEBOND_HOOK_DIR=/tmp/x && codex exec x"]) {
    assert.equal(await decide("Bash", { command }), "deny", command);
  }
});

test("other variables, and Scopebond's set only for this call, are ordinary work", async () => {
  for (const command of [
    "setx PATH \"%PATH%;C:\\tools\"",
    "launchctl setenv EDITOR vim",
    "powershell -Command \"[Environment]::SetEnvironmentVariable('SCOPEBOND_HOME', 'C:\\tmp\\x')\"",
    "SCOPEBOND_HOOK_DIR=/tmp/x node dist/cli.js doctor",
  ]) {
    assert.equal(await decide("Bash", { command }), "allow", command);
  }
});

test("a hook call honours SCOPEBOND_HOOK_DIR only for the person's install or a folder they trusted", () => {
  const saved = { home: process.env.SCOPEBOND_HOME, dir: process.env.SCOPEBOND_HOOK_DIR, project: process.env.CLAUDE_PROJECT_DIR };
  const root = mkdtempSync(join(tmpdir(), "sb-override-"));
  const home = join(root, "home");
  const planted = join(root, "planted");
  const trusted = join(root, "trusted", ".scopebond");
  try {
    delete process.env.CLAUDE_PROJECT_DIR;
    process.env.SCOPEBOND_HOME = home;
    mkdirSync(planted, { recursive: true });
    writeFileSync(join(planted, "policy.json"), JSON.stringify({ clauses: [] }));
    // No install of the person's own yet: the override names the folder (a project-only setup, a test run).
    process.env.SCOPEBOND_HOOK_DIR = planted;
    assert.equal(resolveConfigDir(undefined), planted);
    // Once the person's install exists, a folder the agent named is not taken: their own rules govern.
    scaffold(home);
    assert.equal(resolveConfigDir(undefined), home);
    // The install itself, and a folder whose policy the person trusted, still are.
    process.env.SCOPEBOND_HOOK_DIR = home;
    assert.equal(resolveConfigDir(undefined), home);
    scaffold(trusted);
    trustProjectPolicy(trusted);
    process.env.SCOPEBOND_HOOK_DIR = trusted;
    assert.equal(resolveConfigDir(undefined), trusted);
  } finally {
    for (const [key, value] of [["SCOPEBOND_HOME", saved.home], ["SCOPEBOND_HOOK_DIR", saved.dir], ["CLAUDE_PROJECT_DIR", saved.project]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
