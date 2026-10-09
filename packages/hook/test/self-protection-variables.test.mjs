// A shell variable set earlier in the same call stands for its value: `x=.claude; rm -rf $x` removes the agent's settings
// folder as surely as `rm -rf .claude`. The always-on protection reads each variable an earlier command of the call sets (a
// plain assignment, `export`, a `for` loop, cmd `set`, PowerShell `$x =` and `$env:x =`, an enclosing command's prefix) and
// judges every word that uses it (`$x`, `${x}`, `${x:-…}`, `%x%`, `$env:x`) with each value it may hold. The values only
// add readings: a variable that holds an ordinary folder (a build output, a temporary folder, another project's fixture) is
// judged as that folder, so the routine deletes the protection must never refuse stay allowed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mapClaudeToolUse, createHookRuntime, scaffold } from "../dist/index.js";

function defaultRuntime() {
  const dir = mkdtempSync(join(tmpdir(), "sb-vars-"));
  scaffold(dir);
  return createHookRuntime({
    policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"),
    attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db"),
  });
}
const runtime = defaultRuntime();
const map = (tool_name, command, cwd = "/repo") => mapClaudeToolUse({ tool_name, tool_input: { command }, cwd });
const decide = async (tool_name, command, cwd) => (await runtime.evaluate(map(tool_name, command, cwd))).decision;
const files = (tool_name, command, cwd) =>
  map(tool_name, command, cwd).filter((m) => m.intent.action_type.startsWith("file.")).map((m) => `${m.intent.action_type} ${m.intent.params.path}`);

const DENIED_BASH = [
  // a plain assignment, in each spelling of the use
  "x=.claude; rm -rf $x",
  "x=.claude && rm -rf \"$x\"",
  "x=.claude; rm -rf ${x}",
  "x=.claude; rm -rf ./$x",
  "x=.claude; rm -rf \"${x}/\"",
  "x=.scopebond; rm -rf $x",
  "x=.git; rm -rf $x",
  "x=.cursor; mv $x /tmp/cursor-off",
  "d=.claude/settings.json; rm -f $d",
  "export x=.claude && rm -rf $x",
  "export x=.claude; rm -rf $x",
  "declare x=.codex; rm -rf $x",
  // in the home folder
  "x=~/.claude; rm -rf $x",
  "x=$HOME/.claude; rm -rf $x",
  "h=$HOME; rm -rf $h/.claude",
  "h=~; rm -rf $h",
  // one variable through another, and a value that splits into words
  "a=.claude; b=$a; rm -rf $b",
  "x=\".claude build\"; rm -rf $x",
  // the value it may hold whichever way the call goes
  "x=.claude || x=build; rm -rf $x",
  "x=.claude; true && rm -rf $x",
  // a default value
  "rm -rf ${UNSET_DIR:-.claude}",
  "rm -rf ${UNSET_DIR-.claude}",
  // into the folder, then everything in it
  "x=.claude; cd $x && rm -rf *",
  // a loop over the folders
  "for d in build .claude; do rm -rf $d; done",
  // an enclosing command's prefix, and a nested script
  "x=.claude sh -c 'rm -rf $x'",
  "env x=.claude bash -c 'rm -rf \"$x\"'",
  "sh -c 'x=.claude; rm -rf $x'",
  // writes and reads the floor stops by name
  "p=.claude/settings.json; echo '{}' > $p",
  "f=.scopebond/agent.key; cat $f",
  "d=.scopebond; cp -r $d /tmp/x",
  // cmd
  "set x=.claude & rd /s /q %x%",
  "cmd /c \"set x=.claude&& rmdir /s /q %x%\"",
  "set \"x=.claude\" && rmdir /s /q \"%x%\"",
  // the hook's own CLI through a variable
  "c=uninstall; npx @scopebond/hook $c",
];

const DENIED_POWERSHELL = [
  "$x = \".claude\"; Remove-Item -Recurse -Force $x",
  "$x = '.claude'; Remove-Item -Recurse $x",
  "$x='.claude'; ri -r -fo $x",
  "[string]$x = '.claude'; Remove-Item -Recurse $x",
  "$env:x = \".claude\"; Remove-Item -Recurse -Force $env:x",
  "$x = \"$env:USERPROFILE\\.claude\"; Remove-Item -Recurse -Force $x",
  "$x = \".claude\"; Rename-Item $x claude-off",
  "Set-Item Env:x .claude; Remove-Item -Recurse $env:x",
];

for (const command of DENIED_BASH) {
  test(`a protected folder named through a variable is protected (Bash): ${command}`, async () => {
    assert.equal(await decide("Bash", command), "deny", `${command} -> ${JSON.stringify(files("Bash", command))}`);
  });
}

for (const command of DENIED_POWERSHELL) {
  test(`a protected folder named through a variable is protected (PowerShell): ${command}`, async () => {
    assert.equal(await decide("PowerShell", command, "C:\\repo"), "deny", `${command} -> ${JSON.stringify(files("PowerShell", command, "C:\\repo"))}`);
  });
}

const ALLOWED_BASH = [
  // a variable that holds an ordinary folder
  "x=build; rm -rf $x",
  "dir=dist; rm -rf \"$dir\"/*",
  "export OUT=/tmp/out && rm -rf $OUT",
  "OUT=dist; rm -rf ${OUT:-build}",
  "for d in build dist node_modules; do rm -rf $d; done",
  "for f in src/*.ts; do echo $f; done",
  "D=.claude/commands; rm -f $D/old.md",
  "W=.claude/worktrees/feature-x; git worktree remove --force $W",
  "p=test/fixtures/sample-project/.claude; rm -rf $p",
  "v=vendor/lib/.git; rm -rf $v",
  "t=/tmp/clone; rm -rf $t/.git",
  "TMP=$(mktemp -d) && rm -rf \"$TMP\"",
  "d=$(pwd)/build; rm -rf $d",
  // a protected name held but not removed, written or read
  "x=.claude; echo $x",
  "x=.claude; ls -la $x",
  "x=.claude; cp -r $x backup",
  "x=.claude; cat $x/commands/review.md",
  "x=.claude; git add $x/commands",
  // the value is set after the command ran
  "rm -rf $x; x=.claude",
  // the L3R cases: routine cleanup, brace lists, vendored .git, fixtures and pushes with a temporary HOME
  "git clean -fdx",
  "rm -rf {build,dist}",
  "rm -rf vendor/lib/.git",
  "rm -rf test/fixtures/sample-project/.claude",
  "export HOME=$(mktemp -d) && git push origin feature",
  "export HOME=/tmp/h && git push origin feature",
  "HOME=/tmp/h git push origin feature",
  "export HOME=$(mktemp -d) && git lfs install && git lfs pull",
  "export HOME=/tmp/h && grep -rn claude src/",
  "HOME=/tmp/h npm test -- --grep codex",
  // cmd and PowerShell
  "set OUT=dist & rd /s /q %OUT%",
];

const ALLOWED_POWERSHELL = [
  "$x = \"build\"; Remove-Item -Recurse -Force $x",
  "$env:OUT = \"dist\"; Remove-Item -Recurse -Force $env:OUT",
  "$x = '.claude'; Get-ChildItem $x",
  "$x = 'vendor\\lib\\.git'; Remove-Item -Recurse -Force $x",
];

for (const command of ALLOWED_BASH) {
  test(`a variable naming an ordinary folder stays allowed (Bash): ${command}`, async () => {
    assert.notEqual(await decide("Bash", command), "deny", `${command} -> ${JSON.stringify(files("Bash", command))}`);
  });
}

for (const command of ALLOWED_POWERSHELL) {
  test(`a variable naming an ordinary folder stays allowed (PowerShell): ${command}`, async () => {
    assert.notEqual(await decide("PowerShell", command, "C:\\repo"), "deny", `${command} -> ${JSON.stringify(files("PowerShell", command, "C:\\repo"))}`);
  });
}

test("a credential-named variable's value is never recorded as a path", () => {
  const recorded = JSON.stringify(map("Bash", "API_TOKEN=s3cr3tvalue1; openssl enc -d -k $API_TOKEN -in x.enc").map((m) => m.intent.params));
  assert.ok(!recorded.includes("s3cr3tvalue1"), recorded);
});

test("the recorded command is the command as written, not with the values in place", () => {
  const exec = map("Bash", "x=.claude; ls $x").filter((m) => m.intent.action_type === "shell.exec").map((m) => m.intent.params.command);
  assert.ok(exec.some((c) => c.startsWith("ls $x ")), JSON.stringify(exec));
});

test("many variables and values stay linear in the command's length", () => {
  const n = 2_000;
  for (const text of [
    "x=a; ".repeat(n) + "rm -rf " + "$x ".repeat(n),
    Array.from({ length: n }, (_, i) => `v${i}=$v${i - 1}/a`).join("; ") + "; rm -rf $v1999",
    "x=.claude; " + "cd $x; ".repeat(n) + "rm -rf *",
    "rm -rf " + "${x:-a}".repeat(n),
  ]) {
    const started = performance.now();
    map("Bash", text);
    const ms = performance.now() - started;
    assert.ok(ms < 2000, `${text.slice(0, 40)}… took ${ms.toFixed(0)} ms`);
  }
});
