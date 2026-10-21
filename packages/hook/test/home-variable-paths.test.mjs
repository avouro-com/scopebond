// A path that names the home folder through a variable (`$HOME`, `${HOME}`, `~`, `%USERPROFILE%`, `$env:USERPROFILE`,
// `$env:HOME`) is read as a path in the home folder (`~/…`), wherever the command stands. A path that still holds a variable
// is never joined to the folder an earlier `cd` moved to. And after `cd <dir>`, a relative file a later program is given is
// read inside <dir>, so reading Scopebond's own folder that way is caught.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mapClaudeToolUse, createHookRuntime, scaffold } from "../dist/index.js";
import { ENFORCE } from "./enforce-all.mjs";

const dir = mkdtempSync(join(tmpdir(), "sb-hook-home-vars-"));
scaffold(dir, ENFORCE);
const rt = createHookRuntime({ policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"), attesterPath: join(dir, "attester.key"), dbPath: ":memory:" });
after(() => rt.close());

const map = (tool, command) => mapClaudeToolUse({ tool_name: tool, tool_input: { command } });
const reads = (tool, command) => map(tool, command).filter((m) => m.intent.action_type === "file.read").map((m) => m.intent.params.path);
const decide = async (tool, command) => (await rt.evaluate(map(tool, command))).decision;

test("the reported command reads <home>/.scopebond/receipts.db, not a folder inside the one cd moved to", async () => {
  const command = `cd ~/.scopebond && node probe.mjs "$HOME/.scopebond/receipts.db"`;
  const got = reads("Bash", command);
  assert.ok(got.includes("~/.scopebond/receipts.db"), JSON.stringify(got));
  assert.ok(!got.some((p) => p.includes(".scopebond/.scopebond")), JSON.stringify(got));
  assert.equal(await decide("Bash", command), "deny");
});

test("every spelling of the home folder is the home folder, after a cd or not", () => {
  for (const [tool, word] of [
    ["Bash", "$HOME/.scopebond/receipts.db"], ["Bash", `"$HOME/.scopebond/receipts.db"`], ["Bash", "${HOME}/.scopebond/receipts.db"],
    ["Bash", "~/.scopebond/receipts.db"], ["Bash", "%USERPROFILE%/.scopebond/receipts.db"],
    ["PowerShell", "$env:USERPROFILE/.scopebond/receipts.db"], ["PowerShell", "$env:HOME/.scopebond/receipts.db"],
    ["PowerShell", "${env:USERPROFILE}/.scopebond/receipts.db"], ["PowerShell", "$HOME/.scopebond/receipts.db"],
  ]) {
    const sep = tool === "PowerShell" ? ";" : " &&";
    for (const command of [`cat ${word}`, `cd src${sep} cat ${word}`, `cd ~/.scopebond${sep} cat ${word}`]) {
      const program = tool === "PowerShell" ? command.replace("cat ", "Get-Content ") : command;
      // A program run after a cd into Scopebond's folder also reads the folder itself (cd-protected-read.test.mjs).
      const inFolder = command.startsWith("cd ~/.scopebond") ? ["~/.scopebond"] : [];
      assert.deepEqual(reads(tool, program), ["~/.scopebond/receipts.db", ...inFolder], `${tool}: ${program}`);
    }
  }
});

test("an interpreter given a home path through a variable reads it in the home folder", () => {
  assert.ok(reads("Bash", `cd src && python3 tool.py "$HOME/.scopebond/receipts.db"`).includes("~/.scopebond/receipts.db"));
  assert.ok(reads("Bash", `cd src && node -e "require('fs').readFileSync(process.env.HOME + '/x')" ~/.scopebond/receipts.db`).includes("~/.scopebond/receipts.db"));
  assert.ok(reads("Bash", `node -e "new (require('node:sqlite').DatabaseSync)('D:/work/.scopebond/receipts.db')"`).includes("D:/work/.scopebond/receipts.db"));
});

test("a path that still holds a variable is never joined to the folder cd moved to", () => {
  assert.deepEqual(reads("Bash", "cd src && cat $FOO/notes.txt"), ["$FOO/notes.txt"]);
  assert.deepEqual(reads("Bash", "cd src && cat %FOO%/notes.txt"), ["%FOO%/notes.txt"]);
  assert.deepEqual(reads("PowerShell", "cd src; Get-Content $env:FOO/notes.txt"), ["$env:FOO/notes.txt"]);
  assert.ok(!reads("Bash", `cd src && node tool.mjs "$DATA/.scopebond/receipts.db"`).some((p) => p.startsWith("src/")));
});

test("a variable path that could name a protected file is still read as that file", async () => {
  for (const [tool, command] of [
    ["Bash", "cd src && cat %KEYS%/agent.key"],
    ["PowerShell", "cd src; Get-Content $env:KEYS/agent.key"],
    ["Bash", "cd src && cat $KEYS/.scopebond/policy.json"],
  ]) assert.equal(await decide(tool, command), "deny", command);
});

test("after cd into Scopebond's folder, a relative file given to any later program is read there", async () => {
  for (const command of [
    "cd ~/.scopebond && node probe.mjs receipts.db",
    "cd ~/.scopebond && python3 inspect.py",
    "cd ~/.scopebond && some-tool receipts.db",
    "cd .scopebond && node ../probe.mjs receipts.db",
    "cd $HOME/.scopebond && node probe.mjs receipts.db",
    "cd ~ && node probe.mjs .scopebond/receipts.db",
  ]) {
    assert.ok(reads("Bash", command).some((p) => /(?:^|\/)\.scopebond\/(?:receipts\.db|inspect\.py)$/.test(p)), `${command} -> ${JSON.stringify(reads("Bash", command))}`);
    assert.equal(await decide("Bash", command), "deny", command);
  }
  assert.ok(reads("Bash", "cd ~/.scopebond && node probe.mjs receipts.db").includes("~/.scopebond/receipts.db"));
});

test("an ordinary relative argument after an ordinary cd adds no read", async () => {
  assert.deepEqual(reads("Bash", "cd src && node tool.mjs data.json"), []);
  assert.deepEqual(reads("Bash", "cd packages/hook && node --test test/x.test.mjs"), []);
  assert.notEqual(await decide("Bash", "cd src && node tool.mjs data.json"), "deny");
  assert.notEqual(await decide("Bash", "cd ~/.scopebond-notes && node tool.mjs data.json"), "deny");
});
