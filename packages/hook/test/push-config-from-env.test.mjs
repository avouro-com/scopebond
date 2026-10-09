// Git reads configuration from the environment as well as from `-c`: GIT_CONFIG_COUNT with GIT_CONFIG_KEY_<n> and
// GIT_CONFIG_VALUE_<n>, and GIT_CONFIG_PARAMETERS. An alias or push refspec given that way hides the push destination exactly
// as `git -c alias.x=…` does, so with protect-branches enforced it is an unreadable push and denied, whether the variables sit
// on the git command, an enclosing command or an earlier `export` in the same call. Configuration that cannot change where a
// push goes changes nothing: other keys, git's own subcommands, an explicit refspec, and the config files HOME,
// XDG_CONFIG_HOME or GIT_CONFIG_GLOBAL point at (the person's own configuration).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mapClaudeToolUse, createHookRuntime, scaffold } from "../dist/index.js";

function runtimeWith(enforce) {
  const dir = mkdtempSync(join(tmpdir(), "sb-gitenv-"));
  scaffold(dir, enforce ? { enforce } : {});
  return createHookRuntime({
    policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"),
    attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db"),
  });
}
const enforced = runtimeWith(["protect-branches", "safe-shell", "protect-write", "protect-read"]);
const monitored = runtimeWith(null);
const map = (tool_name, command) => mapClaudeToolUse({ tool_name, tool_input: { command }, cwd: "/repo" });
const decide = async (tool_name, command) => (await enforced.evaluate(map(tool_name, command))).decision;
const pushes = (tool_name, command) => map(tool_name, command).filter((m) => m.intent.action_type === "git.push").map((m) => m.intent.params.ref);

const DENIED_BASH = [
  // the command-line form (already denied)
  "git -c alias.ship='push --force origin main' ship",
  // the same alias through the environment
  "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.sync GIT_CONFIG_VALUE_0='push --force origin main' git sync",
  "GIT_CONFIG_PARAMETERS=\"'alias.yolo=push --force origin main'\" git yolo",
  "GIT_CONFIG_PARAMETERS=\"'alias.yolo'='push --force origin main'\" git yolo",
  "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.p GIT_CONFIG_VALUE_0='!git push origin main' git p",
  "GIT_CONFIG_PARAMETERS=\"'alias.p=!git push -f origin main'\" git p",
  "GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=user.name GIT_CONFIG_VALUE_0=x GIT_CONFIG_KEY_1=alias.p GIT_CONFIG_VALUE_1='!git push origin main' git p",
  "env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.sync GIT_CONFIG_VALUE_0='push -f origin main' git sync",
  "export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.sync GIT_CONFIG_VALUE_0='push --force origin main'; git sync",
  "export GIT_CONFIG_PARAMETERS=\"'alias.yolo=push --force origin main'\" && git yolo",
  "GIT_CONFIG_PARAMETERS=\"'alias.yolo=push --force origin main'\" sh -c 'git yolo'",
  "GIT_CONFIG_PARAMETERS=\"'alias.yolo=push --force origin main'\"; export GIT_CONFIG_PARAMETERS; git yolo",
  // a push refspec through the environment, with no destination on the command line
  "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.origin.push GIT_CONFIG_VALUE_0=+HEAD:refs/heads/main git push",
  // keys the command does not show
  "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=\"$K\" GIT_CONFIG_VALUE_0=\"$V\" git sync",
  "GIT_CONFIG_COUNT=1 git sync",
  // an included config file named on the command line
  "git -c include.path=/tmp/g sync",
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

const ALLOWED = [
  "git push origin feature",
  "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.name GIT_CONFIG_VALUE_0=bot git commit -m x",
  "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0=* git status",
  "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0=* git push origin feature",
  "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraheader GIT_CONFIG_VALUE_0=\"AUTHORIZATION: basic xyz\" git fetch origin",
  "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.origin.push GIT_CONFIG_VALUE_0=+HEAD:refs/heads/main git push origin feature",
  "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.st GIT_CONFIG_VALUE_0=status git status",
  "GIT_CONFIG_NOSYSTEM=1 git push origin feature",
  "GIT_CONFIG_PARAMETERS=\"'core.quotepath=false'\" git log",
  "GIT_CONFIG_GLOBAL=/dev/null git status",
  "echo $HOME && git status",
  // config files the environment points git at are the person's own configuration: an explicit or ordinary push is unchanged
  "export HOME=/tmp/h && git push origin feature",
  "export XDG_CONFIG_HOME=$PWD/.config && npm test && git push origin feature",
  "docker run -e HOME=/root img make && git push origin feature",
  "echo \"HOME=/x\" >> .env.example && git push origin feature",
  "curl \"https://x.example/?home=1\" -o out.json && git push origin feature",
  "GIT_CONFIG_GLOBAL=~/.gitconfig-work git push origin feature",
  "HOME=/tmp/h git status",
  "XDG_CONFIG_HOME=/tmp/x git diff",
  // git extensions
  "HOME=/tmp/h git lfs push origin feature",
  "export HOME=$(mktemp -d) && git lfs install && git lfs pull",
  "XDG_CONFIG_HOME=/tmp/x git flow feature start x",
  "git -c include.path=/tmp/g lfs pull",
];

for (const command of ALLOWED) {
  test(`configuration that cannot hide a protected push changes nothing: ${command}`, async () => {
    assert.deepEqual(pushes("Bash", command).filter((r) => r === "--unknown"), [], `${command} -> ${JSON.stringify(pushes("Bash", command))}`);
    assert.equal(await decide("Bash", command), "allow", command);
    // and under the default (monitor) rules it records no protected-branch violation
    const receipts = (await monitored.evaluate(map("Bash", command))).receipts ?? [];
    assert.ok(!JSON.stringify(receipts).includes("--unknown"), command);
  });
}
