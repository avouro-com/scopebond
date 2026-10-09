// What the coding agent sends is read in time linear in its length: a long, adversarial command, spec or config file must
// not hold the hook past its time limit. Each case below took seconds to hours before its pattern was rewritten; each must
// now finish well inside a second, and still read the input the same way.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindingKeyFromHex, databaseGuardActions, deriveTypedOperations, mapClaudeToolUse, redactCommand, scrubSecrets, useDigestKey } from "../dist/index.js";

useDigestKey("22".repeat(32));

/** Run `fn` and fail when it takes a second or more. */
function fast(label, fn) {
  const started = performance.now();
  const result = fn();
  const ms = performance.now() - started;
  assert.ok(ms < 1000, `${label} took ${ms.toFixed(0)} ms`);
  return result;
}
const bash = (command) => mapClaudeToolUse({ tool_name: "Bash", tool_input: { command } });
const reads = (mapped) => mapped.filter((m) => m.intent.action_type === "file.read").map((m) => m.intent.params.path);

test("a glob operand of many wildcards is matched against the protected paths in linear time", () => {
  // As a regular expression the adjacent wildcards backtracked exponentially: 15 stars took seconds, 25 would take days.
  fast("cat with 40 stars", () => bash(`cat ${"*".repeat(40)}Q`));
  fast("cat with 2,000 wildcards", () => bash(`cat ${"*?".repeat(1000)}Q`));
  // The matcher still finds what a wildcard could name.
  assert.ok(reads(bash("cat .scope*/agent.k*")).includes(".scopebond/agent.key"));
  assert.ok(reads(bash("cat ~/.s*/id_*")).some((p) => p.startsWith(".ssh/")));
  assert.deepEqual(reads(bash("cat logs/*")), ["logs/*"], "no protected path behind it");
});

test("sqlite3 SQL with many blank lines before `.open` is read in linear time", () => {
  const blank = "\n".repeat(20000);
  const args = Array.from({ length: 10 }, () => `"${blank}x"`).join(" ");
  fast("ten arguments of 20,000 blank lines", () => bash(`sqlite3 db.sqlite ${args}`));
  assert.ok(reads(bash(`sqlite3 db.sqlite "${"\n".repeat(500)}  .open '.scopebond/receipts.db'"`)).includes(".scopebond/receipts.db"));
});

test("a command of very many words is mapped in linear time", () => {
  fast("50,000 characters of words", () => bash(`echo ${"A ".repeat(25000)}`));
  fast("50,000 characters after mysql", () => bash(`mysql ${"x ".repeat(25000)}`));
});

test("secret scrubbing is linear in the command's length", () => {
  fast("a long hyphenated run of a secret word", () => scrubSecrets("secret-".repeat(8000)));
  fast("many mentions of a password program", () => redactCommand("mysql ".repeat(10000)));
  fast("many commands that name one", () => scrubSecrets(`${"mysql;".repeat(10000)} -p x`));
  // ...and still masks what it did.
  assert.equal(scrubSecrets("mysql -h db -p hunter2 app"), "mysql -h db -p *** app");
  assert.equal(scrubSecrets("curl -H 'X-Custom-Secret: abc123' x"), "curl -H 'X-Custom-Secret: ***' x");
  assert.equal(scrubSecrets("curl -H \"My-Token:  zzz\""), "curl -H \"My-Token:  ***\"");
});

test("typed operations read a long package spec and packageManager field in linear time", () => {
  const key = bindingKeyFromHex("11".repeat(32));
  const cwd = mkdtempSync(join(tmpdir(), "sb-linear-"));
  const probe = { head: () => null, branch: () => null, remoteUrl: () => null, defaultRemote: () => null, revParse: () => null };
  const context = (over = {}) => ({ key, cwd, repositoryId: "sbr_repo", referenceSetVersion: "hook-1", probe, packageManagerVersion: () => undefined, ...over });
  const derive = (command, ctx = context()) => {
    const mapped = bash(command);
    const dispatched = mapped.map((m) => ({ action: { action_type: m.intent.action_type, params: m.intent.params } }));
    return [...deriveTypedOperations({ command, dialect: "posix", dispatched, redact: redactCommand }, ctx).values()];
  };
  fast("a pip spec of 50,000 '!' before a line end", () => derive(`pip install 'x==1${"!".repeat(50000)}\n'`));
  fast("a pip spec of 50,000 blanks", () => derive(`pip install 'A${"\t".repeat(50000)}\u0001'`));
  // The pattern reads ordinary specs as before.
  assert.deepEqual(derive("pip install Requests[security]==2.31.0")[0].packages, [{ name: "requests", integrity_status: "unknown", resolved_version: "2.31.0" }]);
  assert.deepEqual(derive("pip install 'x==1!a b'")[0].packages, [{ name: "x", integrity_status: "unknown", resolved_version: "1" }]);
  assert.deepEqual(derive("pip install 'django>=4'")[0].packages, [{ name: "django", integrity_status: "unknown" }]);

  writeFileSync(join(cwd, "package.json"), JSON.stringify({ packageManager: `pnpm@1${"+".repeat(50000)}\n` }));
  const own = context({ packageManagerVersion: undefined });
  fast("a packageManager field of 50,000 '+'", () => derive("pnpm add zod", own));
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ packageManager: "pnpm@9.15.0+sha512.abc" }));
  assert.equal(derive("pnpm add zod", own)[0].manager_version, "9.15.0");
});

test("a wrangler config of many blank lines is read in linear time", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-linear-toml-"));
  // Before: 40,000 blank lines took over five seconds; the 1 MiB the reader allows would have taken about an hour.
  writeFileSync(join(dir, "wrangler.toml"), `name = "w"\n${"\n".repeat(200000)}[env.prod]\n${"\n".repeat(200000)}name = "w-live"\n`);
  const actions = fast("400,000 blank lines", () => databaseGuardActions("npx wrangler d1 execute DB --remote --env prod --command 'DELETE FROM t'", "posix", { cwd: dir }));
  assert.deepEqual(actions, [{ provider: "cloudflare_d1", verb: "delete_all", scope: "remote", risk: "destructive" }]);
});
