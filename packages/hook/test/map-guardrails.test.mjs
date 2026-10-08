// The always-on floors hold through every way a coding agent can name Scopebond's controls or its files: the signed
// executable and its subcommands, the installers, NTFS stream suffixes, PowerShell's .NET file calls, Claude's Grep tool
// and deleting the files outright.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapClaudeToolUse } from "../dist/index.js";

const intents = (tool_name, tool_input) => [mapClaudeToolUse({ tool_name, tool_input, cwd: "/repo" })].flat();
const writes = (tool_name, tool_input) => intents(tool_name, tool_input).filter((m) => m.intent.action_type === "file.write").map((m) => m.intent.params.path);
const reads = (tool_name, tool_input) => intents(tool_name, tool_input).filter((m) => m.intent.action_type === "file.read").map((m) => m.intent.params.path);
const switchesOff = (tool_name, command) => writes(tool_name, { command }).includes(".scopebond/policy.json");

test("the signed executable's control commands switch Scopebond off, like the npm commands", () => {
  for (const command of [
    "scopebond-agent.exe hook uninstall",
    "scopebond-agent.exe hook init --force",
    "scopebond-agent.exe hook rules allow rm",
    "scopebond-agent.exe hook login https://other.example",
    "\"D:/Apps/Scopebond/scopebond-agent.exe\" hook connect https://other.example",
    "scopebond-agent uninstall",
    "scopebond-agent uninstall --purge",
    "scopebond-agent setup https://other.example",
    "taskkill /F /IM scopebond-tray.exe",
    "msiexec /x scopebond-agent-0.5.3-x64.msi /qn",
    "winget uninstall Avouro.Scopebond",
    "powershell -NoProfile -File D:/Apps/data/.scopebond/uninstall-agent.ps1",
    "reg delete HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run /v ScopebondAgent /f",
  ]) assert.ok(switchesOff("Bash", command), command);
  assert.ok(switchesOff("PowerShell", "Remove-ItemProperty -Path HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run -Name Scopebond"));
  for (const command of [
    "scopebond-agent.exe status", "scopebond-agent.exe hook status", "scopebond-agent.exe hook rules show", "scopebond-agent.exe hook log",
    "scopebond-agent.exe flush", "scopebond-agent.exe autostart on", "msiexec /i other.msi", "winget uninstall Some.Other",
    "reg query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run /v ScopebondAgent", "tasklist /FI \"IMAGENAME eq scopebond-tray.exe\"",
  ]) assert.ok(!switchesOff("Bash", command), `${command} must stay allowed`);
});

test("an NTFS stream or index suffix does not hide Scopebond's folder or the agents' settings", () => {
  assert.deepEqual(writes("Write", { file_path: "/repo/.scopebond::$INDEX_ALLOCATION/policy.json", content: "{}" }), [".scopebond/policy.json"]);
  assert.deepEqual(reads("Read", { file_path: "/repo/.scopebond::$INDEX_ALLOCATION/agent.key" }), [".scopebond/agent.key"]);
  assert.deepEqual(writes("Write", { file_path: "/repo/.scopebond/policy.json:hidden", content: "{}" }), [".scopebond/policy.json"]);
  assert.deepEqual(writes("Write", { file_path: "/repo/.claude::$INDEX_ALLOCATION/settings.json", content: "{}" }), [".claude/settings.json"]);
  assert.ok(writes("Write", { file_path: "C:\\repo\\.git::$INDEX_ALLOCATION\\hooks\\pre-commit", content: "" }).some((p) => /(?:^|\/)\.git\/hooks\/pre-commit$/.test(p)));
  // A drive letter is not a stream.
  assert.deepEqual(reads("Read", { file_path: "C:\\work\\notes.txt" }).length, 1);
});

test("PowerShell's .NET file calls are read as reads and writes of the paths they name", () => {
  assert.ok(writes("PowerShell", { command: "[IO.File]::WriteAllText('.scopebond\\policy.json', '{}')" }).some((p) => /\.scopebond\/policy\.json$/.test(p)));
  assert.ok(reads("PowerShell", { command: "[System.IO.File]::ReadAllText('.scopebond\\agent.key')" }).some((p) => /\.scopebond\/agent\.key$/.test(p)));
  assert.ok(writes("PowerShell", { command: "[IO.File]::AppendAllText('.claude\\settings.json', 'x')" }).some((p) => /\.claude\/settings\.json$/.test(p)));
  assert.ok(writes("Bash", { command: "pwsh -c \"[IO.File]::WriteAllText('.git/hooks/pre-commit', 'x')\"" }).some((p) => /\.git\/hooks\/pre-commit$/.test(p)));
  assert.ok(writes("PowerShell", { command: "Tee-Object -FilePath .scopebond\\policy.json" }).some((p) => /\.scopebond\/policy\.json$/.test(p)));
  assert.ok(writes("PowerShell", { command: "Expand-Archive x.zip -DestinationPath .scopebond" }).some((p) => /\.scopebond$/.test(p)));
  // An ordinary .NET file call names no protected path: nothing extra is recorded.
  assert.deepEqual(writes("PowerShell", { command: "[IO.File]::WriteAllText('out.txt', 'x')" }), []);
});

test("Claude's Grep tool reads what it searches, so Scopebond's folder is refused like a Read", () => {
  assert.deepEqual(reads("Grep", { pattern: "x", path: "/repo/.scopebond", output_mode: "content" }), [".scopebond"]);
  assert.deepEqual(reads("Grep", { pattern: "x", path: "/repo/src" }), ["src"]);
  assert.ok(reads("Grep", { pattern: "x", glob: ".scopebond/**" }).includes(".scopebond/"));
  assert.equal(intents("Grep", { pattern: "x" })[0].intent.action_type, "file.read");
});

test("deleting Scopebond's own files or the agents' hook settings is a protected write; other deletes stay plain", () => {
  for (const command of ["rm .scopebond/policy.json", "rm -rf .scopebond", "rm -f .scopebond/receipts.db-wal", "find .scopebond -delete", "rmdir /s /q .scopebond"]) {
    assert.ok(writes("Bash", { command }).some((p) => p.startsWith(".scopebond")), command);
  }
  assert.ok(writes("PowerShell", { command: "Remove-Item -Recurse -Force .scopebond" }).some((p) => p.startsWith(".scopebond")));
  assert.ok(writes("PowerShell", { command: "Remove-Item -Path .claude\\settings.json" }).some((p) => /\.claude\/settings\.json$/.test(p)));
  assert.deepEqual(writes("Bash", { command: "rm -rf node_modules dist" }), []);
  assert.deepEqual(writes("Bash", { command: "rm -rf packages/scopebond-notes" }), []);
});

test("with the default setup, the hook refuses each of these, whatever rules the workspace sets", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { scaffold, createHookRuntime } = await import("../dist/index.js");
  const dir = mkdtempSync(join(tmpdir(), "scopebond-guard-"));
  scaffold(dir);
  const runtime = createHookRuntime({
    policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"), attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db"), cwd: "/repo",
  });
  try {
    const decide = async (tool_name, tool_input) => (await runtime.evaluate(mapClaudeToolUse({ tool_name, tool_input, cwd: "/repo" }))).decision;
    assert.equal(await decide("Bash", { command: "scopebond-agent.exe hook uninstall" }), "deny");
    assert.equal(await decide("Bash", { command: "scopebond-agent uninstall --purge" }), "deny");
    assert.equal(await decide("Write", { file_path: "/repo/.scopebond::$INDEX_ALLOCATION/policy.json", content: "{}" }), "deny");
    assert.equal(await decide("Read", { file_path: "/repo/.scopebond::$INDEX_ALLOCATION/agent.key" }), "deny");
    assert.equal(await decide("Grep", { pattern: "PRIVATE", path: "/repo/.scopebond", output_mode: "content" }), "deny");
    assert.equal(await decide("Bash", { command: "rm -rf .scopebond" }), "deny");
    assert.equal(await decide("Grep", { pattern: "TODO", path: "/repo/src" }), "allow");
  } finally { runtime.close(); }
});
