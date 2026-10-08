// A package operation's URL keeps no credential: userinfo runs to the last "@" before the path, as URL parsers read it, so a
// password containing "@" leaves nothing in the package name or registry host.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const iso = mkdtempSync(join(tmpdir(), "sb-typed-url-"));
for (const k of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SCOPEBOND_HOME", "SCOPEBOND_HOOK_DIR"]) process.env[k] = iso;
const { bindingKeyFromHex, deriveTypedOperations, mapClaudeToolUse, redactCommand, useDigestKey, normalizeRemote } = await import("../dist/index.js").then(async (m) => ({ ...m, ...(await import("../dist/typed-ops.js")) }));

const KEY = bindingKeyFromHex("11".repeat(32));
useDigestKey("22".repeat(32));
const ctx = { key: KEY, cwd: iso, repositoryId: "sbr_repo", referenceSetVersion: "hook-1", env: () => undefined, packageManagerVersion: () => undefined, probe: { head: () => null, branch: () => null, remoteUrl: () => null, defaultRemote: () => "origin", revParse: () => null } };

function ops(command) {
  const mapped = mapClaudeToolUse({ tool_name: "Bash", tool_input: { command }, cwd: iso });
  const dispatched = mapped.map((m) => ({ action: { action_type: m.intent.action_type, params: m.intent.params } }));
  return [...deriveTypedOperations({ command, dialect: "posix", dispatched, redact: redactCommand }, ctx).values()];
}

test("a password containing '@' leaves nothing in the package operation", () => {
  const SECRET_TAIL = "Hunter2Tail";
  for (const command of [
    `npm install https://deploy:p4ss@${SECRET_TAIL}@registry.example.com/pkg-1.0.0.tgz`,
    `pip install https://deploy:p4ss@${SECRET_TAIL}@pypi.example.com/pkg-1.0-py3-none-any.whl`,
  ]) {
    const json = JSON.stringify(ops(command).map((o) => o.packages));
    assert.ok(!json.toLowerCase().includes(SECRET_TAIL.toLowerCase()), `no password tail in ${json}`);
    assert.ok(!json.includes("p4ss"), json);
  }
  // As a URL parser reads it: the host is the registry.
  assert.equal(normalizeRemote(`https://deploy:p4ss@${SECRET_TAIL}@registry.example.com/pkg-1.0.0.tgz`)?.host, "registry.example.com");
  // A password without '@' is stripped too.
  assert.ok(!JSON.stringify(ops("npm install https://deploy:p4ssword@registry.example.com/pkg-1.0.0.tgz").map((o) => o.packages)).includes("p4ss"));
});
