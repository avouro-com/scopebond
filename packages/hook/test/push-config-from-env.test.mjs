// Git reads configuration from the environment as well as from `-c`: GIT_CONFIG_COUNT with GIT_CONFIG_KEY_<n> and
// GIT_CONFIG_VALUE_<n>, GIT_CONFIG_PARAMETERS, and config files named by GIT_CONFIG_GLOBAL, GIT_CONFIG_SYSTEM, GIT_CONFIG, HOME
// or XDG_CONFIG_HOME. An alias or push refspec given that way hides the push destination exactly as `git -c alias.x=…` does, so
// with protect-branches enforced it is an unreadable push and denied, wherever in the command line the variable is set.
// Configuration that cannot define a push (another key, a built-in subcommand, an empty config file) changes nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mapClaudeToolUse, createHookRuntime, scaffold } from "../dist/index.js";

function enforcedRuntime() {
  const dir = mkdtempSync(join(tmpdir(), "sb-gitenv-"));
  scaffold(dir, { enforce: ["protect-branches", "safe-shell", "protect-write", "protect-read"] });
  return createHookRuntime({
    policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"),
    attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db"),
  });
}
const map = (tool_name, command) => mapClaudeToolUse({ tool_name, tool_input: { command }, cwd: "/repo" });
const decide = async (tool_name, command) => (await enforcedRuntime().evaluate(map(tool_name, command))).decision;
const pushes = (tool_name, command) => map(tool_name, command).filter((m) => m.intent.action_type === "git.push").map((m) => m.intent.params.ref);

const DENIED_BASH = [
  // the command-line form (already denied)
  "git -c alias.ship='push --force origin main' ship",
  // the same alias through the environment
  "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.sync GIT_CONFIG_VALUE_0='push --force origin main' git sync",
  "GIT_CONFIG_PARAMETERS=\"'alias.yolo=push --force origin main'\" git yolo",
  "GIT_CONFIG_PARAMETERS=\"'alias.yolo'='push --force origin main'\" git yolo",
  "env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.sync GIT_CONFIG_VALUE_0='push -f origin main' git sync",
  "export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.sync GIT_CONFIG_VALUE_0='push --force origin main'; git sync",
  "export GIT_CONFIG_PARAMETERS=\"'alias.yolo=push --force origin main'\" && git yolo",
  "GIT_CONFIG_PARAMETERS=\"'alias.yolo=push --force origin main'\" sh -c 'git yolo'",
  "GIT_CONFIG_PARAMETERS=\"'alias.yolo=push --force origin main'\"; export GIT_CONFIG_PARAMETERS; git yolo",
  // a push refspec through the environment
  "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.origin.push GIT_CONFIG_VALUE_0=+HEAD:refs/heads/main git push",
  // keys the command does not show
  "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=\"$K\" GIT_CONFIG_VALUE_0=\"$V\" git sync",
  "GIT_CONFIG_COUNT=1 git sync",
  // a config file the command points git at (its aliases are not in the command)
  "git -c include.path=/tmp/g sync",
  "GIT_CONFIG_GLOBAL=/tmp/g git sync",
  "HOME=/tmp/h git sync",
  "XDG_CONFIG_HOME=/tmp/x git sync",
  "GIT_CONFIG_GLOBAL=/tmp/g git push",
];

const DENIED_POWERSHELL = [
  "$env:GIT_CONFIG_PARAMETERS = \"'alias.yolo=push --force origin main'\"; git yolo",
  "$env:GIT_CONFIG_COUNT=1; $env:GIT_CONFIG_KEY_0='alias.sync'; $env:GIT_CONFIG_VALUE_0='push --force origin main'; git sync",
];

for (const command of DENIED_BASH) {
  test(`a push hidden behind configuration from the environment is denied (Bash): ${command}`, async () => {
    assert.ok(pushes("Bash", command).includes("--unknown"), `not an unreadable push: ${command} -> ${JSON.stringify(pushes("Bash", command))}`);
    assert.equal(await decide("Bash", command), "deny", `${command} -> pushes ${JSON.stringify(pushes("Bash", command))}`);
  });
}

for (const command of DENIED_POWERSHELL) {
  test(`a push hidden behind configuration from the environment is denied (PowerShell): ${command}`, async () => {
    assert.ok(pushes("PowerShell", command).includes("--unknown"), `not an unreadable push: ${command} -> ${JSON.stringify(pushes("PowerShell", command))}`);
    assert.equal(await decide("PowerShell", command), "deny", `${command} -> pushes ${JSON.stringify(pushes("PowerShell", command))}`);
  });
}

test("configuration from the environment that cannot define a push changes nothing", async () => {
  for (const command of [
    "git push origin feature",
    "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.name GIT_CONFIG_VALUE_0=bot git commit -m x",
    "GIT_CONFIG_PARAMETERS=\"'core.quotepath=false'\" git log",
    "GIT_CONFIG_GLOBAL=/dev/null git status",
    "HOME=/tmp/h git status",
    "XDG_CONFIG_HOME=/tmp/x git diff",
    "echo $HOME && git status",
  ]) {
    assert.deepEqual(pushes("Bash", command).filter((r) => r === "--unknown"), [], command);
    assert.equal(await decide("Bash", command), "allow", command);
  }
});
