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
  // Options that take values, and SQL that attaches a file, do not hide it (review finding 5).
  assert.ok(reads(`sqlite3 -cmd ".tables" .scopebond/receipts.db`).some((p) => p.includes(".scopebond/receipts.db")));
  assert.ok(reads(`sqlite3 -separator , -init /dev/null .scopebond/receipts.db`).some((p) => p.includes(".scopebond/receipts.db")));
  assert.ok(reads(`sqlite3 :memory: "ATTACH '.scopebond/receipts.db' AS r; SELECT 1"`).some((p) => p.includes(".scopebond/receipts.db")));
  assert.deepEqual(reads(`node -e "console.log(1)"`), []);
  assert.deepEqual(reads("node scripts/build.mjs --out .scopebond-report"), [], "a different name that starts the same is not the folder");
});

test("a second here-document after a body with an apostrophe is still data: no false switch-off", () => {
  for (const command of [
    ["cat > a <<'EOF'", "it's", "EOF", "cat > b <<'EOF'", "it's", "EOF", "echo scopebond"].join("\n"),
    ["cd /c/GitHub/scopebond-native/packages && cat >> agent/test/x.test.mjs <<'EOF'", "// the agent's own check", "EOF",
      "cat > native/test/y.test.mjs <<'EOF'", `import { verifyManifest } from "@scopebond/agent";`, "// it's the workflow's", "EOF",
      `grep -n '"devDependencies"' -A4 native/package.json`].join("\n"),
    ["git commit -q -F - <<'EOF'", "It's the updater's key", "EOF", `gh pr create --body "$(cat <<'EOF'`, "Don't merge before @scopebond/hook", "EOF", `)"`].join("\n"),
  ]) assert.deepEqual(paths(bash(command), "file.write").filter((p) => p.includes(".scopebond")), [], command);
});

test("a search for an escaped quote next to a mention of Scopebond is not a switch-off in the Windows reading", () => {
  for (const command of [
    String.raw`grep -n "x\"" a.ts; echo scopebond`,
    String.raw`for f in a.ts b.ts; do c=$(grep -c "\bjoin\b" $f); [ "$c" = "1" ] && echo "$f"; done; grep -n "@scopebond/hook\"" a.ts b.ts`,
  ]) assert.deepEqual(paths(bash(command), "file.write"), [], command);
});

test("here-documents and the Windows reading still fail closed on a real switch-off or write", () => {
  const touches = (command) => ["file.write", "file.delete"].some((type) => paths(bash(command), type).some((p) => String(p).includes(".scopebond")));
  for (const command of [
    String.raw`eval "$X @scopebond/hook uninstall`,
    String.raw`echo hi > .scopebond\policy.json "x\""`,
    String.raw`echo "\" & npx @scopebond/hook uninstall & echo "\"\"`,
    ["cat > a <<'EOF'", "it's", "EOF", "cat > .scopebond/policy.json <<'EOF'", "{}", "EOF"].join("\n"),
    ["bash <<'EOF'", "npx @scopebond/hook uninstall", "EOF"].join("\n"),
    ["cat > a <<'EOF'", "it's", "EOF", "bash <<'EOF'", "npx @scopebond/hook uninstall", "EOF"].join("\n"),
  ]) assert.ok(touches(command), command);
  // A here-document with no terminator is no here-document: the lines after it are still commands.
  const unterminated = bash(["cat <<EOF", "no terminator here", "rm .scopebond/policy.json"].join("\n"));
  assert.ok(unterminated.some((m) => m.intent.action_type === "shell.exec" && m.intent.params.program === "rm"));
});
