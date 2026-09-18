import { test } from "node:test";
import assert from "node:assert/strict";
import { mapClaudeToolUse, mapCursorEvent, redactCommand, scrubSecrets } from "../dist/index.js";

test("Bash maps to shell.exec with the program basename and a redacted command", () => {
  const m = mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "rm -rf /tmp/other" } });
  assert.equal(m.intent.action_type, "shell.exec");
  assert.equal(m.intent.params.program, "rm");
  assert.equal(m.evaluated, true);
  assert.match(String(m.intent.params.command), /sha256:[0-9a-f]{64}/, "command carries a digest");
  assert.equal(String(m.intent.params.command).includes("/tmp/other"), true, "short commands keep a readable head");
});

test("sudo and env prefixes are stripped when resolving the program", () => {
  assert.equal(mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "sudo rm -rf /" } }).intent.params.program, "rm");
  assert.equal(mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "env FOO=1 /usr/bin/node app.js" } }).intent.params.program, "node");
});

test("a git push command derives a git.push action", () => {
  const main = mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "git push origin main" } });
  assert.equal(main.intent.action_type, "git.push");
  assert.deepEqual(main.intent.params, { force: false, remote: "origin", ref: "main" });

  const force = mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "git push -f origin feature/x" } });
  assert.equal(force.intent.params.force, true);
  assert.equal(force.intent.params.ref, "feature/x");
});

test("file tools map to file.write / file.read, relative to cwd", () => {
  const w = mapClaudeToolUse({ tool_name: "Write", tool_input: { file_path: "/work/src/app.ts" }, cwd: "/work" });
  assert.equal(w.intent.action_type, "file.write");
  assert.equal(w.intent.params.path, "src/app.ts");
  const r = mapClaudeToolUse({ tool_name: "Read", tool_input: { file_path: "/work/.env" }, cwd: "/work" });
  assert.equal(r.intent.action_type, "file.read");
  assert.equal(r.intent.params.path, ".env");
});

test("an MCP tool name maps to mcp.tool.call with a digested arg set", () => {
  const m = mapClaudeToolUse({ tool_name: "mcp__github__create_issue", tool_input: { title: "x" } });
  assert.equal(m.intent.action_type, "mcp.tool.call");
  assert.equal(m.intent.params.server, "github");
  assert.equal(m.intent.params.tool, "create_issue");
  assert.match(String(m.intent.params.args_digest), /^sha256:[0-9a-f]{64}$/);
});

test("WebFetch maps to net.fetch; an unknown tool falls back to tool.<name>, not evaluated", () => {
  const f = mapClaudeToolUse({ tool_name: "WebFetch", tool_input: { url: "https://api.example/x?q=1" } });
  assert.equal(f.intent.action_type, "net.fetch");
  assert.equal(f.intent.params.host, "api.example");
  const u = mapClaudeToolUse({ tool_name: "Glob", tool_input: { pattern: "**/*.ts" } });
  assert.equal(u.intent.action_type, "tool.glob");
  assert.equal(u.evaluated, false);
});

test("secrets are scrubbed before a command is stored", () => {
  // Build secret-shaped values at runtime so no token literal sits in this source.
  const ghToken = "ghp_" + "A".repeat(36);
  const redacted = redactCommand(`gh auth login --token=${ghToken}`);
  assert.equal(redacted.includes(ghToken), false, "the token is not retained");
  const skKey = "sk-" + "b".repeat(32);
  assert.equal(scrubSecrets(`curl -H 'Authorization: Bearer ${skKey}'`).includes(skKey), false);
});

test("Cursor events map the same way as Claude tools", () => {
  assert.equal(mapCursorEvent("beforeShellExecution", { command: "git push origin main" }).intent.action_type, "git.push");
  assert.equal(mapCursorEvent("beforeReadFile", { path: "/w/x.ts", cwd: "/w" }).intent.params.path, "x.ts");
  assert.equal(mapCursorEvent("beforeMCPExecution", { server: "github", tool: "merge_pr" }).intent.action_type, "mcp.tool.call");
  assert.equal(mapCursorEvent("somethingElse", {}).evaluated, false);
});
