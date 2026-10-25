// The signed Windows installer's folder holds the program every coding agent runs as its hook. The always-on protection
// refuses a coding agent's write or delete there (per user under %LOCALAPPDATA%\Programs\Scopebond, for every user under
// %ProgramFiles%\Scopebond), in any spelling, and still lets it read there. Policies compiled by an earlier version get the
// new pattern on load.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mapClaudeToolUse, createHookRuntime, scaffold } from "../dist/index.js";
import { GUARDRAIL_WRITE_PATTERN, INSTALL_FOLDER, SHELL_STARTUP_FLOOR, upgradeStarterPolicy } from "../dist/runtime.js";

function runtimeIn(dir) {
  return createHookRuntime({
    policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"),
    attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db"),
  });
}
const home = mkdtempSync(join(tmpdir(), "sb-installdir-"));
scaffold(home);
const runtime = runtimeIn(home);
const WIN = "C:\\Users\\dev\\project";
const decide = async (tool_name, tool_input) => {
  const d = await runtime.evaluate(mapClaudeToolUse({ tool_name, tool_input, cwd: WIN }));
  return { decision: d.decision, clause: d.clauseId ?? null };
};

const PER_USER = "C:\\Users\\dev\\AppData\\Local\\Programs\\Scopebond";
const PER_MACHINE = "C:\\Program Files\\Scopebond";

const DENIED = [
  ["Write", { file_path: `${PER_USER}\\scopebond-agent.exe`, content: "x" }],
  ["Edit", { file_path: `${PER_MACHINE}\\scopebond-agent.exe`, old_string: "a", new_string: "b" }],
  ["PowerShell", { command: `Copy-Item .\\evil.exe "${PER_USER}\\scopebond-agent.exe" -Force` }],
  ["PowerShell", { command: `Remove-Item -Recurse -Force "$env:LOCALAPPDATA\\Programs\\Scopebond"` }],
  ["PowerShell", { command: `Remove-Item "\${env:ProgramFiles}\\Scopebond\\scopebond-tray.exe"` }],
  ["PowerShell", { command: `Set-Content "$env:ProgramFiles\\Scopebond\\scopebond-agent.exe" x` }],
  ["Bash", { command: `rm -rf "/d/work/dev/AppData/Local/Programs/Scopebond"` }],
  ["Bash", { command: `cp evil.exe "C:/Program Files/Scopebond/scopebond-agent.exe"` }],
  ["Bash", { command: `mv "C:/PROGRA~1/SCOPEB~1/scopebond-agent.exe" /tmp/x.exe` }],
  ["Bash", { command: `echo x > "%LOCALAPPDATA%\\programs\\SCOPEBOND\\scopebond-agent.exe"` }],
];
for (const [tool, input] of DENIED) {
  test(`a write or delete in the install folder is denied by the always-on rule: ${tool} ${JSON.stringify(input).slice(0, 90)}`, async () => {
    const { decision, clause } = await decide(tool, input);
    assert.equal(decision, "deny");
    // A short name such as SCOPEB~1 could also be `.scopebond`, whose read rule may be the one that decides first.
    assert.match(clause, /^protect-scopebond-(?:write|read)$/);
    if (!input.command?.includes("~1")) assert.equal(clause, "protect-scopebond-write");
  });
}

const ALLOWED = [
  ["Read", { file_path: `${PER_USER}\\scopebond-agent.exe` }],
  ["PowerShell", { command: `Get-ChildItem "$env:LOCALAPPDATA\\Programs\\Scopebond"` }],
  ["PowerShell", { command: `Get-Item "${PER_MACHINE}\\scopebond-agent.exe" | Select-Object VersionInfo` }],
  ["Bash", { command: `ls "/d/work/dev/AppData/Local/Programs/Scopebond"` }],
  ["Bash", { command: `"${PER_USER.replace(/\\/g, "/")}/scopebond-agent.exe" status` }],
  // other programs' folders and a project folder that only looks alike
  ["Write", { file_path: "C:\\Users\\dev\\AppData\\Local\\Programs\\Other\\x.txt", content: "x" }],
  ["Write", { file_path: "C:\\Users\\dev\\project\\scopebond-notes\\x.md", content: "x" }],
];
for (const [tool, input] of ALLOWED) {
  test(`reading the install folder, or writing elsewhere, is allowed: ${tool} ${JSON.stringify(input).slice(0, 90)}`, async () => {
    assert.equal((await decide(tool, input)).decision, "allow");
  });
}

test("the pattern matches the folder's spellings case-insensitively and nothing else", () => {
  // eslint-disable-next-line security/detect-non-literal-regexp -- the exported constant pattern
  const re = new RegExp(`^${INSTALL_FOLDER}.+`);
  for (const p of [
    "D:/Work/dev/AppData/Local/Programs/Scopebond/scopebond-agent.exe", "d:/work/dev/appdata/local/programs/scopebond",
    "C:/Program Files/Scopebond/x", "C:/Program Files (x86)/Scopebond/x", "%ProgramFiles%/Scopebond/x", "$env:ProgramFiles/Scopebond",
    "${env:ProgramFiles}/Scopebond/x", "C:/PROGRA~1/Scopebond/x", "C:/Program Files/SCOPEB~1/x",
  ]) assert.equal(re.test(p), false, p);
  for (const p of ["C:/Program Files/Other/x", "src/scopebond/x", "D:/Work/dev/Programs-Scopebond/x", "C:/Program Files/Scopebondish/x"]) {
    assert.equal(re.test(p), true, p);
  }
});

test("a policy compiled before the install folder was protected gets the new pattern on load", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-installdir-old-"));
  scaffold(dir);
  const file = join(dir, "policy.json");
  const policy = JSON.parse(readFileSync(file, "utf8"));
  const clause = policy.clauses.find((c) => c.id === "protect-scopebond-write");
  assert.equal(clause.param_bounds.path.pattern, GUARDRAIL_WRITE_PATTERN);
  clause.param_bounds.path.pattern = GUARDRAIL_WRITE_PATTERN.replace(INSTALL_FOLDER, "").replace(SHELL_STARTUP_FLOOR, "");
  writeFileSync(file, JSON.stringify(policy));
  const upgraded = upgradeStarterPolicy(JSON.parse(readFileSync(file, "utf8")));
  assert.equal(upgraded.clauses.find((c) => c.id === "protect-scopebond-write").param_bounds.path.pattern, GUARDRAIL_WRITE_PATTERN);
});
