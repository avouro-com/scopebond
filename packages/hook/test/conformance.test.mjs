import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mapClaudeToolUse, mapCursorEvent, createHookRuntime, scaffold } from "../dist/index.js";

// A representative coding-agent policy exercising each connector path.
const conformancePolicy = {
  vocabulary_version: "1.0", policy_id: "conf", version: 1,
  clauses: [
    { id: "branch", type: "action_allowlist", mode: "enforce", action_types: ["git.push"], param_bounds: { ref: { pattern: "^(?!(?:main|master)$)(?!release/).+" } } },
    { id: "shell", type: "action_allowlist", mode: "enforce", action_types: ["shell.exec"], param_bounds: { program: { pattern: "^(?!(?:rm|sudo)$).+" } } },
    { id: "files", type: "action_allowlist", mode: "enforce", action_types: ["file.write", "file.read"] },
    { id: "mcp", type: "action_allowlist", mode: "enforce", action_types: ["mcp.tool.call"], param_bounds: { server: { pattern: "^(?:filesystem|github)$" } } },
  ],
};

function freshRuntime() {
  const dir = mkdtempSync(join(tmpdir(), "sb-hook-"));
  scaffold(dir);
  writeFileSync(join(dir, "policy.json"), JSON.stringify(conformancePolicy));
  return createHookRuntime({
    policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"),
    attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db"),
  });
}

const claude = (tool_name, tool_input, cwd) => ({ tool_name, tool_input, cwd });

test("conformance: destructive rm outside the workspace is denied", async () => {
  const d = await freshRuntime().evaluate(mapClaudeToolUse(claude("Bash", { command: "rm -rf /tmp/other" })));
  assert.equal(d.decision, "deny");
  assert.equal(d.receipt.payload.realtime_result, "deny");
  assert.equal(d.receipt.payload.executed, false);
});

test("conformance: git push to a protected branch is denied", async () => {
  const d = await freshRuntime().evaluate(mapClaudeToolUse(claude("Bash", { command: "git push origin main" })));
  assert.equal(d.decision, "deny");
});

test("conformance: a write inside the workspace is a cooperative allow", async () => {
  const d = await freshRuntime().evaluate(mapClaudeToolUse(claude("Write", { file_path: "src/app.ts" })));
  assert.equal(d.decision, "allow");
  assert.equal(d.receipt.payload.execution.state, "cooperative_allow");
  assert.equal(d.receipt.payload.executed, false);
});

test("conformance: an MCP tool from a non-allowlisted server is denied; an allowlisted one passes", async () => {
  const rt = freshRuntime();
  const bad = await rt.evaluate(mapClaudeToolUse(claude("mcp__evilserver__do", { x: 1 })));
  assert.equal(bad.decision, "deny");
  const ok = await rt.evaluate(mapClaudeToolUse(claude("mcp__github__create_issue", { title: "x" })));
  assert.equal(ok.decision, "allow");
});

test("conformance: an unknown tool is not evaluated and grants nothing", async () => {
  const d = await freshRuntime().evaluate(mapClaudeToolUse(claude("Glob", { pattern: "**/*" })));
  assert.equal(d.decision, "not_evaluated");
  assert.equal(d.receipt.payload.execution.state, "observed_not_evaluated");
});

test("conformance: the same policy applies to Cursor events", async () => {
  const rt = freshRuntime();
  assert.equal((await rt.evaluate(mapCursorEvent("beforeShellExecution", { command: "git push origin main" }))).decision, "deny");
  assert.equal((await rt.evaluate(mapCursorEvent("beforeReadFile", { path: "src/x.ts" }))).decision, "allow");
});

test("fail-closed: a runtime with an unparseable policy cannot be built", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-hook-"));
  scaffold(dir);
  writeFileSync(join(dir, "policy.json"), "{ not valid json");
  assert.throws(() => createHookRuntime({
    policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"),
    attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db"),
  }));
});

test("latency: a decision stays well under a 200ms p95 budget", async () => {
  const rt = freshRuntime();
  const samples = [];
  for (let i = 0; i < 30; i += 1) {
    const t0 = performance.now();
    await rt.evaluate(mapClaudeToolUse(claude("Read", { file_path: `src/f${i}.ts` })));
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const p95 = samples[Math.floor(samples.length * 0.95)];
  console.log(`hook decision p95 ≈ ${p95.toFixed(2)}ms over ${samples.length} samples`);
  assert.ok(p95 < 200, `p95 ${p95.toFixed(2)}ms exceeds the 200ms budget`);
});
