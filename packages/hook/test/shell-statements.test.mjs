// Statements are not commands. A PowerShell assignment, a `foreach`/`if`/`while`/`switch` statement, a script block and a bare
// variable expression run no program of their own: they are read for the commands inside them, which are judged as usual
// (a Remove-Item inside a ForEach-Object block is still seen). Only a program known at run time (`& $x`, `iex $cmd`, `. $x`)
// stays an empty program, which the starter policy denies. Bash loops, tests and environment prefixes read the same way.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mapClaudeToolUse, createHookRuntime, scaffold } from "../dist/index.js";
import { ENFORCE } from "./enforce-all.mjs";

const dir = mkdtempSync(join(tmpdir(), "sb-hook-statements-"));
scaffold(dir, ENFORCE);
const rt = createHookRuntime({ policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"), attesterPath: join(dir, "attester.key"), dbPath: ":memory:" });
after(() => rt.close());

const map = (tool, command) => mapClaudeToolUse({ tool_name: tool, tool_input: { command } });
const decide = async (tool, command) => (await rt.evaluate(map(tool, command))).decision;
// The programs a rule judges (a line of statements alone is also recorded, unevaluated, with nothing to grant).
const programs = (tool, command) => map(tool, command).filter((m) => m.intent.action_type === "shell.exec" && m.evaluated).map((m) => m.intent.params.program);

const ORDINARY_POWERSHELL = [
  `$env:NODE_ENV="development"; npm run dev`,
  `foreach ($f in Get-ChildItem *.log) { Write-Output $f.Name }`,
  `$x = npm view react version`,
  `npm test; if ($?) { Write-Output ok }`,
  `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' } | ForEach-Object { $_.ProcessId }`,
  `$_.ProcessId`,
  `$x`,
  `$env:PATH = "C:/tools;$env:PATH"`,
  `$n = 0; while ($n -lt 3) { $n++ }`,
  `for ($i = 0; $i -lt 3; $i++) { Write-Output $i }`,
  `if (Test-Path x) { Write-Output yes } elseif ($y) { Write-Output maybe } else { Write-Output no }`,
  `switch ($x) { 'a' { Write-Output one } default { Write-Output other } }`,
  `try { npm test } catch { Write-Output $_.Exception.Message } finally { Write-Output done }`,
  `$items = @(1, 2, 3); $items | ForEach-Object { $_ * 2 }`,
  `"build finished"`,
  `& "C:/Program Files/Git/cmd/git.exe" status`,
  "${env:NODE_ENV} = 'test'; npm test",
];

for (const command of ORDINARY_POWERSHELL) {
  test(`an ordinary PowerShell line is not an empty program: ${command}`, async () => {
    assert.ok(!programs("PowerShell", command).includes(""), JSON.stringify(programs("PowerShell", command)));
    assert.notEqual(await decide("PowerShell", command), "deny", command);
  });
}

test("the commands inside statements are the ones recorded", () => {
  assert.deepEqual(programs("PowerShell", `$env:NODE_ENV="development"; npm run dev`), ["npm"]);
  assert.deepEqual(programs("PowerShell", `$x = npm view react version`), ["npm"]);
  assert.deepEqual(programs("PowerShell", `foreach ($f in Get-ChildItem *.log) { Write-Output $f.Name }`).sort(), ["Get-ChildItem", "Write-Output"]);
  assert.deepEqual(programs("PowerShell", `npm test; if ($?) { Write-Output ok }`), ["npm", "Write-Output"]);
  assert.deepEqual(programs("PowerShell", `& "C:/Program Files/Git/cmd/git.exe" status`), ["git.exe"]);
});

// A command inside a script block, a statement or an assignment is judged like any other; a program known only at run time
// fails closed.
const STILL_DENIED_POWERSHELL = [
  `Get-ChildItem *.tmp | ForEach-Object { Remove-Item $_ }`,
  `Get-ChildItem *.tmp | % { rm $_ }`,
  `Get-ChildItem | ForEach-Object -Process { Remove-Item $_.FullName -Recurse }`,
  `if ($true) { Remove-Item -Recurse build }`,
  `foreach ($f in Get-ChildItem) { Remove-Item $f }`,
  `while ($true) { Remove-Item x; break }`,
  `try { Remove-Item x } catch { }`,
  `$x = Remove-Item -Recurse build`,
  `return Remove-Item x`,
  `1..3 | ForEach-Object { git push origin main }`,
  `Invoke-Command -ScriptBlock { Remove-Item x }`,
  `& $x`,
  `& "$tool" -rf build`,
  `& (Get-Command Remove-Item) x`,
  `$y = & $cmd`,
  `iex $cmd`,
  `Invoke-Expression $cmd`,
  `Invoke-Expression -Command $cmd`,
  `$cmd | iex`,
  `"Remove-Item x" | Invoke-Expression`,
  `. $script`,
  `$block.Invoke()`,
];

for (const command of STILL_DENIED_POWERSHELL) {
  test(`still denied in PowerShell: ${command}`, async () => {
    assert.equal(await decide("PowerShell", command), "deny", `${command} -> ${JSON.stringify(programs("PowerShell", command))}`);
  });
}

const ORDINARY_BASH = [
  `for f in *; do echo $f; done`,
  `if [ -f x ]; then echo y; fi`,
  `X=1 npm test`,
  `export X=1`,
  `export X=1 && npm test`,
  `while read -r line; do echo "$line"; done < list.txt`,
  `case "$1" in a) echo one ;; *) echo other ;; esac`,
];

for (const command of ORDINARY_BASH) {
  test(`an ordinary bash line is not an empty program: ${command}`, async () => {
    assert.ok(!programs("Bash", command).includes(""), JSON.stringify(programs("Bash", command)));
    assert.notEqual(await decide("Bash", command), "deny", command);
  });
}

const STILL_DENIED_BASH = [
  `for f in *; do rm $f; done`,
  `if [ -f x ]; then rm -rf x; fi`,
  // In bash a word that starts with `$` names the program at run time: these are not PowerShell statements there.
  `$x = echo hi`,
  `$_.ProcessId`,
  `$cmd`,
];

for (const command of STILL_DENIED_BASH) {
  test(`still denied in bash: ${command}`, async () => {
    assert.equal(await decide("Bash", command), "deny", `${command} -> ${JSON.stringify(programs("Bash", command))}`);
  });
}
