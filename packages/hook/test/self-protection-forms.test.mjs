// Scopebond's own protection holds under the default (monitor) rules for the forms below: code given on standard input or in a
// here-document, paths built from pieces or matched by a wildcard, deletion through find, git clean or SQL ATTACH, copying or
// archiving a home folder, the connection file read from a copy, a coding agent started with its hooks off, and Glob over the
// hook's folder. Each case was allowed before; the always-on rules now deny it. Ordinary commands stay allowed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mapClaudeToolUse, createHookRuntime, scaffold, databaseGuardActions, classifySql } from "../dist/index.js";

function defaultRuntime() {
  const dir = mkdtempSync(join(tmpdir(), "sb-self-"));
  scaffold(dir);
  return createHookRuntime({
    policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"),
    attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db"),
  });
}
const bash = (command) => mapClaudeToolUse({ tool_name: "Bash", tool_input: { command }, cwd: "/repo" });
const decide = async (mapped) => (await defaultRuntime().evaluate(mapped)).decision;

const DENIED = [
  ["code in a here-document", "python - <<EOF\nimport os\nos.remove(os.path.expanduser('~/.scopebond/receipts.db'))\nEOF"],
  ["node code in a here-document", "node - <<'EOF'\nconst fs = require('fs'); fs.rmSync(require('os').homedir() + '/.scopebond', { recursive: true });\nEOF"],
  ["code on standard input", "echo \"print(open('$HOME/.scopebond/cloud.json').read())\" | python3"],
  ["a path built from pieces", "node -e \"require('fs').readFileSync(require('os').homedir()+'/.scope'+'bond/receipts.db')\""],
  ["a wildcard that only matches the folder", "python3 -c \"import glob,os; [os.remove(p) for p in glob.glob(os.path.expanduser('~/.scope*/receipts.db*'))]\""],
  ["find -delete from the home folder", "find ~ -maxdepth 2 -name 'receipts.db*' -delete"],
  ["find -exec rm from the home folder", "find ~ -name 'receipts.db*' -exec rm {} +"],
  ["git clean of the folder", "git clean -fdx ~/.scopebond"],
  ["SQL ATTACH with a joined path", "sqlite3 :memory: \"ATTACH '/srv/agent/.scope' || 'bond/receipts.db.cloud-outbox.db' AS o; DELETE FROM o.cloud_outbox;\""],
  ["archiving the home folder", "tar czf /tmp/h.tgz -C ~ ."],
  ["copying the home folder", "cp -r ~ /tmp/h2"],
  ["reading a copied connection file", "cat /tmp/h/.sb/cloud.json"],
  ["a coding agent with its hooks off", "claude --settings '{\"disableAllHooks\":true}' -p 'tidy up'"],
  ["a coding agent with another config folder", "CLAUDE_CONFIG_DIR=/tmp/clean claude -p 'tidy up'"],
];

for (const [name, command] of DENIED) {
  test(`denied under the default rules: ${name}`, async () => {
    assert.equal(await decide(bash(command)), "deny", command);
  });
}

test("Glob over the hook's folder is a read of it and denied; Glob elsewhere is not", async () => {
  assert.equal(await decide(mapClaudeToolUse({ tool_name: "Glob", tool_input: { pattern: "*", path: "/srv/agent/.scopebond" }, cwd: "/repo" })), "deny");
  assert.equal(await decide(mapClaudeToolUse({ tool_name: "Glob", tool_input: { pattern: ".scopebond/*.json" }, cwd: "/srv/agent" })), "deny");
  assert.notEqual(await decide(mapClaudeToolUse({ tool_name: "Glob", tool_input: { pattern: "src/**/*.ts" }, cwd: "/repo" })), "deny");
});

test("ordinary commands stay allowed", async () => {
  for (const command of ["python3 -c \"print(1 + 2)\"", "echo hi | python3", "find . -name '*.tmp' -delete", "git clean -fd build", "tar czf out.tgz src", "cp -r src /tmp/x", "claude -p 'explain this repo'"]) {
    assert.notEqual(await decide(bash(command)), "deny", command);
  }
});

test("psql: SQL on standard input, a redirect or a here-document to a remote host, an inline PGHOST and a service are remote and unknown", () => {
  const guard = (command) => databaseGuardActions(command, "posix", { cwd: "/repo", env: () => undefined });
  for (const command of [
    "echo \"DROP TABLE users\" | psql -h db.example.com -d app",
    "psql -h db.example.com -d app < drop.sql",
    "psql -h db.example.com -d app <<'SQL'\nDROP TABLE users;\nSQL",
    "PGHOST=db.example.com psql -d app -c \"DROP TABLE users\"",
    "psql \"service=prod\" -c \"DROP TABLE users\"",
  ]) {
    const actions = guard(command);
    assert.ok(actions.length > 0 && actions.every((a) => a.scope !== "local"), `${command} -> ${JSON.stringify(actions)}`);
    assert.ok(actions.some((a) => a.risk === "unknown" || a.risk === "destructive" || a.verb === "drop"), `${command} -> ${JSON.stringify(actions)}`);
  }
  assert.deepEqual(guard("psql -h localhost -d app -c \"SELECT 1\""), []);
});

test("the SQL classifier refuses text the two dialects read differently, and keeps quoted names opaque", () => {
  assert.equal(classifySql("SELECT E'\\\\'' ; DROP TABLE users; --'"), null, "a backslash escape in a literal");
  assert.equal(classifySql("/* outer /* inner */ DROP TABLE users; */ SELECT 1"), null, "a nested block comment");
  assert.equal(classifySql("\\i drop.sql"), null, "a psql meta-command");
  assert.equal(classifySql("PRAGMA writable_schema(1)"), null, "a pragma that sets a value");
  const quoted = classifySql("DELETE FROM \"DROP\" WHERE \"id\" = 5");
  assert.equal(quoted?.verb, "delete");
  const into = classifySql("WITH t AS (SELECT 1) SELECT * INTO copy FROM t");
  assert.equal(into?.verb, "create");
});
