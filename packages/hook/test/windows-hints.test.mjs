// What the CLI tells a person to do next is in the form their system runs (PowerShell blocks
// the plain npx, npm and scopebond-agent shims).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agentCommand, npmGlobalInstall, nodeTooOldLines, loginAgainCommand, executionPolicyAdvice, explainPowerShellError, overrideHint,
} from "../dist/index.js";

test("agent and npm commands use the .cmd form on Windows only", () => {
  assert.equal(agentCommand("autostart on", "win32"), "scopebond-agent.cmd autostart on");
  assert.equal(agentCommand("autostart on", "linux"), "scopebond-agent autostart on");
  assert.equal(npmGlobalInstall("@scopebond/agent", "win32"), "npm.cmd install -g @scopebond/agent");
  assert.equal(npmGlobalInstall("@scopebond/agent", "darwin"), "npm install -g @scopebond/agent");
});

test("Node too old: Windows gets the winget command and how to find a second Node on PATH", () => {
  const win = nodeTooOldLines("22.12.0", "win32").join("\n");
  assert.match(win, /22\.13 or later; this is Node 22\.12\.0/);
  assert.match(win, /winget install --id OpenJS\.NodeJS\.LTS -e/);
  assert.match(win, /where\.exe node/);
  const mac = nodeTooOldLines("20.1.0", "darwin").join("\n");
  assert.doesNotMatch(mac, /winget|where\.exe/);
  assert.match(mac, /nodejs\.org/);
});

test("a sign-in to repeat is printed exactly, with its flags", () => {
  assert.match(loginAgainCommand("https://cloud.scopebond.com", ["--cursor"], "win32"), /^npx\.cmd -y @scopebond\/hook@\S+ login https:\/\/cloud\.scopebond\.com --cursor$/);
  assert.match(loginAgainCommand("https://cloud.scopebond.com", [], "linux"), /^npx -y @scopebond\/hook@\S+ login https:\/\/cloud\.scopebond\.com$/);
});

test("PowerShell's script policy: explained when it blocks the shims, silent otherwise", () => {
  assert.match(executionPolicyAdvice("Restricted", "win32"), /type npx\.cmd, npm\.cmd and scopebond-agent\.cmd/);
  assert.match(executionPolicyAdvice("AllSigned\r\n", "win32"), /AllSigned/);
  assert.equal(executionPolicyAdvice("RemoteSigned", "win32"), null);
  assert.equal(executionPolicyAdvice("Restricted", "linux"), null);
});

test("a PowerShell refusal is explained in one line with the .cmd fix", () => {
  const ps = "npx : File C:\\Program Files\\nodejs\\npx.ps1 cannot be loaded because running scripts is disabled on this system.";
  assert.equal(explainPowerShellError(ps), "PowerShell's script policy blocked npx.ps1. Type npx.cmd instead (same command, no policy change needed).");
  assert.match(explainPowerShellError("File C:\\Users\\a\\AppData\\Roaming\\npm\\scopebond-agent.ps1 is not digitally signed."), /scopebond-agent\.cmd/);
  assert.equal(explainPowerShellError("ENOENT: no such file"), null);
});

test("an override the agent cannot show names the command that starts it", () => {
  const hint = overrideHint({ outcome: "unavailable", title: "x" });
  assert.ok(hint.includes(agentCommand("autostart on")), hint);
});
