import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mapClaudeToolUse, createHookRuntime, scaffold } from "../dist/index.js";
import { decomposeShell, parseGitPush } from "../dist/shell.js";

// A runtime carrying the real starter policy (protect branches, deny destructive
// programs, protect the hook's own config and keys).
function starterRuntime(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sb-hook-shell-"));
  scaffold(dir);
  return createHookRuntime({
    policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"),
    attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db"),
    ...extra,
  });
}
const bash = (command) => ({ tool_name: "Bash", tool_input: { command } });
const evalCmd = (rt, command) => rt.evaluate(mapClaudeToolUse(bash(command)));

// The bypass corpus: every one hides a program the starter policy denies (`rm`,
// `sudo`) or a protected-branch force push behind a construct the old first-token
// mapper missed. Every one must be denied. Includes the eight from the review.
const MUST_DENY = [
  // separators
  "echo hi; rm -rf x",
  "echo hi && rm -rf /",
  "true || rm -rf x",
  "cat foo | rm -rf x",
  "echo a & rm -rf x",
  "echo one\nrm -rf two",
  "ls; ls; ls; rm -rf x",
  // env / wrapper prefixes
  "FOO=1 rm -rf x",
  "FOO=1 BAR=2 rm -rf x",
  "env FOO=1 rm -rf x",
  "sudo rm -rf x",
  "nice -n 10 rm -rf x",
  "nohup rm -rf x",
  "time rm -rf x",
  "command rm -rf x",
  "xargs rm < list",
  // bash -c / sh -c
  "bash -c 'rm -rf /'",
  `sh -c "rm -rf x"`,
  "bash -c 'echo hi; rm -rf x'",
  "zsh -c 'rm -rf x'",
  "dash -c 'rm -rf x'",
  "bash -lc 'rm -rf x'",
  `bash -c "bash -c 'rm -rf x'"`, // nested
  // substitutions / subshells
  "echo $(rm -rf x)",
  "echo `rm -rf x`",
  "(rm -rf x)",
  "( cd /tmp && rm -rf x )",
  "FOO=$(rm -rf x) echo hi",
  "echo $(echo $(rm -rf x))", // nested substitution
  // git branch protection via force / +ref / -C / chaining
  "git push origin main",
  "git push -f origin main",
  "git push origin +main",
  "git push --force origin main",
  "git push --force-with-lease origin main",
  "git -C /repo push origin main",
  "cd . && git push origin main",
  "echo ready; git push origin master",
  "git push origin HEAD:main",
  "true && git push -f origin main",
  // combinations
  "npm test && sudo reboot",
  "npm run build || rm -rf dist-backup",
  "echo $(git push -f origin main)",
];

test(`bypass corpus: all ${MUST_DENY.length} attempts are denied (>= 40)`, async () => {
  assert.ok(MUST_DENY.length >= 40, "the corpus must have at least 40 cases");
  const rt = starterRuntime();
  const survived = [];
  for (const command of MUST_DENY) {
    const d = await evalCmd(rt, command);
    if (d.decision !== "deny") survived.push(`${command} -> ${d.decision}`);
  }
  assert.deepEqual(survived, [], `these bypassed the policy:\n${survived.join("\n")}`);
});

test("a receipt is recorded for every simple command in a decomposed call", async () => {
  const rt = starterRuntime();
  const d = await rt.evaluate(mapClaudeToolUse(bash("echo hi && echo bye && rm -rf x")));
  assert.equal(d.decision, "deny");
  assert.ok(Array.isArray(d.receipts) && d.receipts.length >= 3, `expected >=3 receipts, got ${d.receipts?.length}`);
});

test("legitimate commands are allowed (no false denials)", async () => {
  const rt = starterRuntime();
  const ok = [
    "npm test",
    "npm run build && npm test",
    "git status",
    "git commit -m 'work'",
    "git push origin feature/my-branch",
    "cd . && git push origin feature/x",
    "echo hello",
    "ls -la | grep ts",
    "node scripts/build.mjs",
  ];
  for (const command of ok) {
    const d = await evalCmd(rt, command);
    assert.notEqual(d.decision, "deny", `${command} was wrongly denied: ${d.reason}`);
  }
});

test("self-protection: the agent cannot rewrite the hook config or read the keys", async () => {
  const rt = starterRuntime();
  const claude = (tool_name, tool_input) => ({ tool_name, tool_input });
  const denied = [
    ["Write", { file_path: ".scopebond/policy.json" }],
    ["Write", { file_path: ".scopebond/agent.key" }],
    ["Write", { file_path: ".claude/settings.json" }],
    ["Write", { file_path: "nested/dir/.claude/settings.local.json" }],
    ["Write", { file_path: ".cursor/hooks.json" }],
    ["Write", { file_path: ".git/hooks/pre-commit" }],
    // SB81: CI config is protected from silent rewrites (matches the README claim).
    ["Write", { file_path: ".github/workflows/ci.yml" }],
    ["Write", { file_path: ".github/workflows/release.yaml" }],
    ["Write", { file_path: ".github/actions/build/action.yml" }],
    ["Write", { file_path: ".gitlab-ci.yml" }],
    ["Write", { file_path: ".circleci/config.yml" }],
    ["Write", { file_path: "Jenkinsfile" }],
    ["Read", { file_path: ".scopebond/agent.key" }],
    ["Read", { file_path: "secrets/deploy.key" }],
    ["Read", { file_path: ".scopebond/cloud.json" }],
    // SB81: environment secret files are protected from reads (exfiltration risk).
    ["Read", { file_path: ".env" }],
    ["Read", { file_path: ".env.production" }],
    ["Read", { file_path: "config/.env.local" }],
  ];
  for (const [tool, input] of denied) {
    const d = await rt.evaluate(mapClaudeToolUse(claude(tool, input)));
    assert.equal(d.decision, "deny", `${tool} ${JSON.stringify(input)} should be denied`);
  }
  // ordinary workspace files still work, and safe look-alikes are not over-blocked
  const allowed = [
    ["Write", { file_path: "src/app.ts" }],
    ["Write", { file_path: ".github/ISSUE_TEMPLATE/bug.md" }],
    ["Read", { file_path: "README.md" }],
    ["Read", { file_path: ".env.example" }],
    ["Read", { file_path: "src/environment.ts" }],
  ];
  for (const [tool, input] of allowed) {
    assert.notEqual((await rt.evaluate(mapClaudeToolUse(claude(tool, input)))).decision, "deny", `${tool} ${JSON.stringify(input)} should be allowed`);
  }
});

test("strict mode: an unparseable command is denied; non-strict observes it", async () => {
  const unbalanced = `echo "unterminated && rm -rf x`;
  assert.equal((await evalCmd(starterRuntime({ strict: true }), unbalanced)).decision, "deny");
  assert.equal((await evalCmd(starterRuntime(), unbalanced)).decision, "not_evaluated");
});

test("decomposeShell does not stall on adversarial nesting or length", () => {
  const started = process.hrtime.bigint();
  decomposeShell("$(".repeat(5000) + "rm -rf x" + ")".repeat(5000));
  decomposeShell("a && ".repeat(50000) + "b");
  decomposeShell(`echo "` + "x".repeat(500000));
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 2000, `took ${ms.toFixed(0)} ms`);
});

test("parseGitPush ignores non-push git commands", () => {
  const [status] = decomposeShell("git status");
  assert.equal(parseGitPush(status), null);
  const [commit] = decomposeShell("git commit -m x");
  assert.equal(parseGitPush(commit), null);
});
