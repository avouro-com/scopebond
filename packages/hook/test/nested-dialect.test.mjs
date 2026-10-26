// A nested script is read in the language of the program that runs it: PowerShell for `pwsh`/`powershell -Command` (and a
// decoded `-EncodedCommand`), cmd's own for `cmd /c` and `cmd /k`, POSIX for a shell's `-c`. Read with POSIX rules, a
// PowerShell backtick or a cmd `^` escape hid the word the program really runs or the file it really names, and a cmd
// variable (`%NAME%`, `!NAME!`) read as plain text instead of a value only known at run time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mapClaudeToolUse, createHookRuntime, scaffold, useDigestKey } from "../dist/index.js";
import { decomposeShell } from "../dist/shell.js";
import { ENFORCE } from "./enforce-all.mjs";

useDigestKey("55".repeat(32));
const dir = mkdtempSync(join(tmpdir(), "sb-nested-dialect-"));
scaffold(dir, ENFORCE);
const rt = createHookRuntime({ policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"), attesterPath: join(dir, "attester.key"), dbPath: ":memory:", cwd: "/repo" });
test.after(() => { rt.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });

const encoded = (script) => Buffer.from(script, "utf16le").toString("base64");
// The programs a command line runs (a PowerShell statement runs none: it is recorded with an empty program).
const programs = (command) => decomposeShell(command).filter((c) => !c.opaque && c.program !== "").map((c) => c.program);
const opaque = (command) => decomposeShell(command).some((c) => c.opaque);
const decide = async (command, tool = "Bash") => (await rt.evaluate(mapClaudeToolUse({ cwd: "/repo", tool_name: tool, tool_input: { command } }))).decision;

test("pwsh -Command is read as PowerShell: the backtick escape and statements", () => {
  assert.deepEqual(programs("pwsh -c 'Re`move-Item x'"), ["pwsh", "Remove-Item"]);
  assert.deepEqual(programs("powershell.exe -Command '$x = 5; Get-Item a'"), ["powershell.exe", "Get-Item"]);
  assert.equal(opaque("powershell.exe -Command '$x = 5; Get-Item a'"), false, "a PowerShell assignment is a statement, not a program known only at run time");
  assert.deepEqual(programs(`pwsh -EncodedCommand ${encoded("Re`move-Item x")}`), ["pwsh", "Remove-Item"]);
  assert.deepEqual(programs("iex 'Re`move-Item x'"), ["iex", "Remove-Item"]);
});

test("an encoded command that does not decode is opaque", () => {
  assert.ok(opaque("pwsh -EncodedCommand AAAAAAAA"));
  assert.ok(opaque("powershell -enc not*base64"));
});

test("cmd /c is read as cmd: ^ escapes, & && || | separate, \\ separates paths", () => {
  assert.deepEqual(programs("cmd /c ty^pe a.txt"), ["cmd", "type"]);
  assert.deepEqual(programs("cmd /c \"echo a & del b && rd /s /q c || dir | more\""), ["cmd", "echo", "del", "rd", "dir", "more"]);
  assert.deepEqual(programs("cmd /c \"echo a ^& del b\""), ["cmd", "echo"], "an escaped & is a plain character");
  assert.deepEqual(programs("cmd /c 'echo \"a & b\" & del c'"), ["cmd", "echo", "del"], "an & in quotes is a plain character");
  assert.deepEqual(programs("cmd.exe /K \"@del x\""), ["cmd.exe", "del"]);
  assert.deepEqual(programs("cmd //c ty^pe a"), ["cmd", "type"], "the switch as Git Bash has it written");
  assert.deepEqual(programs("cmd /cty^pe a"), ["cmd", "type"], "the script right after the switch");
  assert.deepEqual(programs("pwsh -c \"cmd /c ty^pe a\""), ["pwsh", "cmd", "type"], "cmd run from PowerShell is read as cmd too");
  const del = decomposeShell("cmd /c \"del D:\\work\\.cla^ude\\settings.json\"").find((c) => c.program === "del");
  assert.deepEqual(del.argv, ["D:/work/.claude/settings.json"]);
  const echo = decomposeShell("cmd /c \"echo x 2>&1 >> out.txt\"").find((c) => c.program === "echo");
  assert.deepEqual(echo.redirects, [{ op: ">>", target: "out.txt" }]);
});

test("a cmd variable makes its command opaque (%NAME% and !NAME!), and is still read as written", () => {
  for (const command of ["cmd /c type %X%", "cmd /c \"%TOOL% push -f origin main\"", "cmd /v:on /c \"set x=a& del !x!\""]) {
    assert.ok(opaque(command), command);
  }
  const parts = decomposeShell("cmd /c \"echo ok & del %X%\"");
  assert.equal(parts.filter((c) => c.opaque).length, 1, "only the command holding the variable is opaque");
  assert.ok(parts.some((c) => c.program === "del" && c.argv[0] === "%X%"), "and it is read as written as well");
  assert.equal(opaque("cmd /c echo 100%"), false, "a lone % names no variable");
});

test("ordinary nested commands map as before", () => {
  assert.deepEqual(programs("bash -c 'git status && ls'"), ["bash", "git", "ls"]);
  assert.deepEqual(programs("cmd /c \"git push -f origin main\""), ["cmd", "git"]);
  assert.deepEqual(programs("pwsh -c 'git status; Remove-Item x'"), ["pwsh", "git", "Remove-Item"]);
  assert.deepEqual(programs("cmd /c pwsh -c 'Get-Item a'"), ["cmd", "pwsh", "Get-Item"]);
  assert.equal(opaque("cmd /c \"git status & dir\""), false);
  assert.equal(opaque("pwsh -c 'git status'"), false);
});

test("with the rules blocking, a hidden nested action is denied", async () => {
  assert.equal(await decide("cmd /c ty^pe .e^nv"), "deny");
  assert.equal(await decide("pwsh -c 'Get-Content .en`v'"), "deny");
  assert.equal(await decide("cmd /c \"%TOOL% status\""), "deny", "a program only known at run time fails closed");
  assert.equal(await decide("cmd /c \"git status & dir\""), "allow");
  assert.equal(await decide("pwsh -c 'git status'"), "allow");
});
