import { test } from "node:test";
import assert from "node:assert/strict";
import { mapClaudeToolUse } from "../dist/index.js";

const bash = (command) => mapClaudeToolUse({ tool_name: "Bash", tool_input: { command } });
const paths = (mapped, type) => mapped.filter((m) => m.intent.action_type === type).map((m) => m.intent.params.path);

test("an escaped quote in a search pattern that names Scopebond is a read, not switching Scopebond off", () => {
  // The Windows reading turns \" into /" and leaves a quote open; the POSIX reading already understood it.
  const mapped = bash(String.raw`grep -io "scopebond[^\"]*" project/.claude/settings.json | sort | uniq -c | head`);
  assert.deepEqual(paths(mapped, "file.write"), []);
  assert.deepEqual(paths(mapped, "file.read"), ["project/.claude/settings.json"]);
});

test("the Windows reading still catches a real write or switch-off behind an unbalanced quote", () => {
  // cmd.exe does not escape a quote with \, so these really redirect into Scopebond's folder or run it.
  for (const command of [
    String.raw`echo "\" > .scopebond\policy.json "`,
    String.raw`echo "\" & npx @scopebond/hook uninstall "`,
    String.raw`echo "\" & scopebond off "`,
  ]) assert.ok(paths(bash(command), "file.write").includes(".scopebond/policy.json"), command);
});

test("grep -o is 'only matching': its pattern is not a file and the searched file is read", () => {
  const mapped = bash(`grep -o "@scopebond/hook@[0-9.]*" project/.claude/settings.json`);
  assert.deepEqual(paths(mapped, "file.write"), []);
  assert.deepEqual(paths(mapped, "file.read"), ["project/.claude/settings.json"]);
});

test("declared file options still count: sort -o writes, grep -f reads, curl -o writes", () => {
  assert.deepEqual(paths(bash("sort -o out.txt in.txt"), "file.write"), ["out.txt"]);
  assert.ok(paths(bash("grep -f patterns.txt notes.txt"), "file.read").includes("patterns.txt"));
  assert.deepEqual(paths(bash("curl -o .scopebond/policy.json https://example.com"), "file.write"), [".scopebond/policy.json"]);
});

test("sed's script is not a file: sed -n a,bp f reads f only (SB408)", () => {
  assert.deepEqual(paths(bash("sed -n 3420,3760p src/app.ts"), "file.read"), ["src/app.ts"]);
  assert.deepEqual(paths(bash("sed 's/a/b/' notes.txt"), "file.read"), ["notes.txt"]);
  assert.deepEqual(paths(bash("sed -e 's/a/b/' -e 's/c/d/' notes.txt other.txt"), "file.read"), ["notes.txt", "other.txt"]);
  assert.deepEqual(paths(bash("sed -i 's/a/b/' notes.txt"), "file.write"), ["notes.txt"]);
  assert.deepEqual(paths(bash("sed -i -e 's/a/b/' notes.txt"), "file.write"), ["notes.txt"]);
  assert.deepEqual(paths(bash("sed -n 1,5p .scopebond/attester.key"), "file.read"), [".scopebond/attester.key"], "a protected file stays a read");
});

test("a bare variable or glob is not a read of a file by that name; one that could name a protected file still is (SB408)", () => {
  assert.deepEqual(paths(bash("cat $f"), "file.read"), []);
  assert.deepEqual(paths(bash(`cat "$FILE"`), "file.read"), []);
  assert.deepEqual(paths(bash("cat *"), "file.read"), []);
  assert.deepEqual(paths(bash("cat $D/notes.txt"), "file.read"), ["$D/notes.txt"]);
  assert.ok(paths(bash("cat $HOME/.scopebond/agent.key"), "file.read").includes(".scopebond/agent.key"));
  assert.ok(paths(bash("cat $D/agent.key"), "file.read").some((p) => p.endsWith("agent.key")), "it could name a signing key");
});

test("Scopebond's folder named in an interpreter's argument is a read, through any API (SB408)", () => {
  const reads = (command) => paths(bash(command), "file.read");
  assert.ok(reads(`node -e "new (require('node:sqlite').DatabaseSync)('D:/work/.scopebond/receipts.db', { readOnly: true })"`).some((p) => p.includes(".scopebond/receipts.db")));
  assert.ok(reads("python3 tools/inspect.py ~/.scopebond/receipts.db").some((p) => p.includes(".scopebond/receipts.db")));
  assert.ok(reads("sqlite3 ~/.scopebond/receipts.db 'select count(*) from receipts'").some((p) => p.includes(".scopebond/receipts.db")));
  assert.deepEqual(reads(`node -e "console.log(1)"`), []);
  assert.deepEqual(reads("node scripts/build.mjs --out .scopebond-report"), [], "a different name that starts the same is not the folder");
});
