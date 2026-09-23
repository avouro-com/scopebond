import { test } from "node:test";
import assert from "node:assert/strict";
import { mapClaudeToolUse, mapCodexToolUse, mapCursorEvent, redactCommand, scrubSecrets, fillPushBranch } from "../dist/index.js";

// The mapper returns one intent per simple command. These helpers keep the common
// single-command assertions readable.
const only = (mapped) => { assert.equal(mapped.length, 1, `expected one intent, got ${mapped.length}`); return mapped[0]; };
const types = (mapped) => mapped.map((m) => m.intent.action_type);
// Programs of the shell.exec intents only (a reader/redirect also emits file.read/write).
const shellProgs = (mapped) => mapped.filter((m) => m.intent.action_type === "shell.exec").map((m) => m.intent.params.program);
// The path of every file.read / file.write intent the call implies.
const readPaths = (mapped) => mapped.filter((m) => m.intent.action_type === "file.read").map((m) => m.intent.params.path);
const writePaths = (mapped) => mapped.filter((m) => m.intent.action_type === "file.write").map((m) => m.intent.params.path);

test("Bash maps to shell.exec with the program basename and a redacted command", () => {
  const m = only(mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "rm -rf /tmp/other" } }));
  assert.equal(m.intent.action_type, "shell.exec");
  assert.equal(m.intent.params.program, "rm");
  assert.equal(m.evaluated, true);
  assert.match(String(m.intent.params.command), /sha256:[0-9a-f]{64}/, "command carries a digest");
  assert.equal(String(m.intent.params.command).includes("/tmp/other"), true, "short commands keep a readable head");
});

test("sudo and env prefixes are stripped when resolving the program", () => {
  assert.equal(only(mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "sudo rm -rf /" } })).intent.params.program, "rm");
  assert.equal(only(mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "env FOO=1 /usr/bin/node app.js" } })).intent.params.program, "node");
  assert.equal(only(mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "FOO=1 BAR=2 python run.py" } })).intent.params.program, "python");
});

test("a git push command derives a git.push action, including -C and +ref force", () => {
  const main = only(mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "git push origin main" } }));
  assert.equal(main.intent.action_type, "git.push");
  assert.deepEqual(main.intent.params, { force: false, remote: "origin", ref: "main" });

  const force = only(mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "git push -f origin feature/x" } }));
  assert.equal(force.intent.params.force, true);
  assert.equal(force.intent.params.ref, "feature/x");

  const dashC = only(mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "git -C /repo push origin main" } }));
  assert.equal(dashC.intent.action_type, "git.push");
  assert.equal(dashC.intent.params.ref, "main");

  const plus = only(mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "git push origin +main" } }));
  assert.equal(plus.intent.action_type, "git.push");
  assert.equal(plus.intent.params.force, true, "+ref is a force push");
  assert.equal(plus.intent.params.ref, "main");
});

test("file tools map to file.write / file.read, relative to cwd", () => {
  const w = only(mapClaudeToolUse({ tool_name: "Write", tool_input: { file_path: "/work/src/app.ts" }, cwd: "/work" }));
  assert.equal(w.intent.action_type, "file.write");
  assert.equal(w.intent.params.path, "src/app.ts");
  const r = only(mapClaudeToolUse({ tool_name: "Read", tool_input: { file_path: "/work/.env" }, cwd: "/work" }));
  assert.equal(r.intent.action_type, "file.read");
  assert.equal(r.intent.params.path, ".env");
});

test("an MCP tool name maps to mcp.tool.call with a digested arg set", () => {
  const m = only(mapClaudeToolUse({ tool_name: "mcp__github__create_issue", tool_input: { title: "x" } }));
  assert.equal(m.intent.action_type, "mcp.tool.call");
  assert.equal(m.intent.params.server, "github");
  assert.equal(m.intent.params.tool, "create_issue");
  assert.match(String(m.intent.params.args_digest), /^sha256:[0-9a-f]{64}$/);
});

test("WebFetch maps to net.fetch; an unknown tool falls back to tool.<name>, not evaluated", () => {
  const f = only(mapClaudeToolUse({ tool_name: "WebFetch", tool_input: { url: "https://api.example/x?q=1" } }));
  assert.equal(f.intent.action_type, "net.fetch");
  assert.equal(f.intent.params.host, "api.example");
  const u = only(mapClaudeToolUse({ tool_name: "Glob", tool_input: { pattern: "**/*.ts" } }));
  assert.equal(u.intent.action_type, "tool.glob");
  assert.equal(u.evaluated, false);
});

test("secrets are scrubbed before a command is stored", () => {
  const ghToken = "ghp_" + "A".repeat(36);
  const redacted = redactCommand(`gh auth login --token=${ghToken}`);
  assert.equal(redacted.includes(ghToken), false, "the token is not retained");
  const skKey = "sk-" + "b".repeat(32);
  assert.equal(scrubSecrets(`curl -H 'Authorization: Bearer ${skKey}'`).includes(skKey), false);
});

test("Cursor events map the same way as Claude tools", () => {
  assert.equal(only(mapCursorEvent("beforeShellExecution", { command: "git push origin main" })).intent.action_type, "git.push");
  assert.equal(only(mapCursorEvent("beforeReadFile", { path: "/w/x.ts", cwd: "/w" })).intent.params.path, "x.ts");
  assert.equal(only(mapCursorEvent("beforeMCPExecution", { server: "github", tool: "merge_pr" })).intent.action_type, "mcp.tool.call");
  assert.equal(only(mapCursorEvent("somethingElse", {})).evaluated, false);
});

test("Codex Bash and MCP calls use the shared action mapping", () => {
  assert.equal(only(mapCodexToolUse({ tool_name: "Bash", tool_input: { command: "git push origin main" } })).intent.action_type, "git.push");
  const mcp = only(mapCodexToolUse({ tool_name: "mcp__github__create_issue", tool_input: { title: "x" } }));
  assert.equal(mcp.intent.action_type, "mcp.tool.call");
  assert.equal(mcp.intent.params.server, "github");
  assert.equal(mcp.intent.params.tool, "create_issue");
});

test("Codex apply_patch maps every changed path, including moves", () => {
  const patch = `*** Begin Patch
*** Update File: src/app.ts
@@
-old
+new
*** Add File: src/new.ts
+export {};
*** Update File: src/old.ts
*** Move to: src/moved.ts
@@
-old
+moved
*** Delete File: src/gone.ts
*** End Patch`;
  const mapped = mapCodexToolUse({ tool_name: "apply_patch", tool_input: { command: patch }, cwd: "/work" });
  assert.deepEqual(writePaths(mapped), ["src/app.ts", "src/new.ts", "src/old.ts", "src/moved.ts", "src/gone.ts"]);
  assert.ok(mapped.every((m) => m.evaluated));
});

test("Codex apply_patch with no recognizable path is not trusted", () => {
  const mapped = mapCodexToolUse({ tool_name: "apply_patch", tool_input: { command: "not a patch" } });
  assert.equal(mapped.length, 1);
  assert.equal(mapped[0].intent.action_type, "file.write");
  assert.equal(mapped[0].evaluated, false);
});

// ---- Decomposition: a shell call is split into every simple command it runs ----

test("chained commands each become their own intent", () => {
  assert.deepEqual(types(mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "echo hi && rm -rf x" } })), ["shell.exec", "shell.exec"]);
  const progs = mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "echo hi && rm -rf x" } }).map((m) => m.intent.params.program);
  assert.deepEqual(progs, ["echo", "rm"]);
});

test("every separator splits: ; | && || & and newline", () => {
  for (const sep of ["; ", " | ", " && ", " || ", " & ", "\n"]) {
    const progs = shellProgs(mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: `cat a${sep}rm -rf b` } }));
    assert.deepEqual(progs, ["cat", "rm"], `separator ${JSON.stringify(sep)}`);
  }
});

// ---- SB111: self-protection completeness (the holes reproduced in published 0.3.0) ----

test("a shell read of the signing key / a secret file emits a file.read the read-guard sees", () => {
  // `cat .scopebond/attester.key` used to map to shell.exec(cat) only, bypassing the
  // file.read protection entirely — the agent could exfiltrate the key and forge receipts.
  assert.deepEqual(readPaths(mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "cat .scopebond/attester.key" } })), [".scopebond/attester.key"]);
  assert.ok(readPaths(mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "head -n 5 .env" } })).includes(".env"), "flag values (5) are not treated as files");
  assert.deepEqual(readPaths(mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "cat /work/.scopebond/agent.key" }, cwd: "/work" })), [".scopebond/agent.key"]);
});

test("a Windows backslash path is normalized so the .scopebond / settings guards still match", () => {
  const w = mapClaudeToolUse({ tool_name: "Write", tool_input: { file_path: "C:\\work\\.scopebond\\policy.json" }, cwd: "C:\\work" });
  assert.deepEqual(writePaths(w), [".scopebond/policy.json"]);
  const s = mapClaudeToolUse({ tool_name: "Edit", tool_input: { file_path: "C:\\work\\.claude\\settings.json" }, cwd: "C:\\work" });
  assert.deepEqual(writePaths(s), [".claude/settings.json"]);
  const r = mapClaudeToolUse({ tool_name: "Read", tool_input: { file_path: "C:\\work\\secret.key" }, cwd: "C:\\work" });
  assert.deepEqual(readPaths(r), ["secret.key"]);
});

test("a shell redirection target emits a file.write the write-guard sees", () => {
  assert.ok(writePaths(mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "echo x > .scopebond/policy.json" } })).includes(".scopebond/policy.json"));
  assert.ok(writePaths(mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "printf pwned >>.claude/settings.json" } })).includes(".claude/settings.json"));
});

test("PowerShell and a generic Shell tool decompose like Bash (not an un-evaluated tool.<name>)", () => {
  const ps = mapClaudeToolUse({ tool_name: "PowerShell", tool_input: { command: "Remove-Item -Recurse -Force ." } });
  assert.equal(ps[0].intent.action_type, "shell.exec");
  assert.equal(ps[0].intent.params.program, "Remove-Item");
  assert.equal(ps[0].evaluated, true, "a mapped shell.exec is evaluated, not observed-and-allowed");
  const sh = mapClaudeToolUse({ tool_name: "Shell", tool_input: { command: "rm -rf /" } });
  assert.equal(sh[0].intent.params.program, "rm");
});

test("bash -c and sh -c recurse into the inner script", () => {
  const progs = mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "bash -c 'rm -rf /'" } }).map((m) => m.intent.params.program);
  assert.ok(progs.includes("rm"), "the inner rm is exposed");
  const sh = mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: `sh -c "echo hi; rm -rf x"` } }).map((m) => m.intent.params.program);
  assert.ok(sh.includes("rm"));
});

test("command substitution and subshells are decomposed", () => {
  assert.ok(mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "echo $(rm -rf x)" } }).map((m) => m.intent.params.program).includes("rm"));
  assert.ok(mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "echo `rm -rf x`" } }).map((m) => m.intent.params.program).includes("rm"));
  assert.ok(mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "(rm -rf x)" } }).map((m) => m.intent.params.program).includes("rm"));
});

test("an env-prefixed destructive command still resolves the real program", () => {
  const progs = mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "FOO=1 rm -rf x" } }).map((m) => m.intent.params.program);
  assert.deepEqual(progs, ["rm"]);
});

test("a separator inside quotes is not a split point", () => {
  const m = only(mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: `echo "a; b && c"` } }));
  assert.equal(m.intent.params.program, "echo");
});

test("an unbalanced command is opaque and not evaluated (fails closed at the runtime)", () => {
  const m = only(mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: `echo "unterminated` } }));
  assert.equal(m.intent.action_type, "shell.exec");
  assert.equal(m.evaluated, false, "opaque commands are not trusted");
  assert.equal(m.intent.params.program, "");
});

test("fillPushBranch fills a bare git push with the current branch, and leaves explicit refs alone", () => {
  const bare = mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "git push" } });
  assert.equal(bare[0].intent.params.ref, undefined);
  const filled = fillPushBranch(bare, "feature/x");
  assert.equal(filled[0].intent.params.ref, "feature/x");
  // explicit ref untouched
  const explicit = fillPushBranch(mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "git push origin main" } }), "feature/x");
  assert.equal(explicit[0].intent.params.ref, "main");
  // no branch resolved → left absent (fail-closed at the policy)
  assert.equal(fillPushBranch(bare, null)[0].intent.params.ref, undefined);
  // non-git intents untouched
  const read = fillPushBranch(mapClaudeToolUse({ tool_name: "Read", tool_input: { file_path: "a.ts" } }), "feature/x");
  assert.equal(read[0].intent.action_type, "file.read");
});
