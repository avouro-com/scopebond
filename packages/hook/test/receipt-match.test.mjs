// The hook's receipts name the starter rule that matched (`clause_id`) and the bound that failed (`failed_bound`), whether
// the rule blocks or only records, so a workspace reads the rule from the receipt instead of working it out again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mapClaudeToolUse, createHookRuntime, scaffold } from "../dist/index.js";
import { ENFORCE } from "./enforce-all.mjs";

function runtime(opts) {
  const dir = mkdtempSync(join(tmpdir(), "sb-match-"));
  scaffold(dir, opts);
  return createHookRuntime({
    policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"),
    attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db"),
  });
}
const bash = (command) => mapClaudeToolUse({ tool_name: "Bash", tool_input: { command }, cwd: tmpdir() });
const shellReceipt = (d) => (d.receipts ?? [d.receipt]).find((r) => r?.payload?.intent?.action_type === "shell.exec");

test("a denied rm -rf / names safe-shell and a program bound", async () => {
  const rt = runtime(ENFORCE);
  try {
    const d = await rt.evaluate(bash("rm -rf /"));
    assert.equal(d.decision, "deny");
    const p = shellReceipt(d).payload;
    assert.equal(p.realtime_result, "deny");
    assert.equal(p.clause_id, "safe-shell");
    assert.match(p.failed_bound, /^program:/);
    assert.equal(JSON.stringify(p.failed_bound).includes("rm"), false, "the bound never carries the program");
  } finally { rt.close(); }
});

test("a monitored rm -rf / carries them too, with its monitor state", async () => {
  const rt = runtime({});
  try {
    const d = await rt.evaluate(bash("rm -rf /"));
    const p = shellReceipt(d).payload;
    assert.equal(p.realtime_result, "deny", "would have blocked");
    assert.equal(p.execution.state, "cooperative_allow", "safe-shell only records");
    assert.equal(p.clause_id, "safe-shell");
    assert.match(p.failed_bound, /^program:/);
    // Deleting / would delete the hook's own folder, which is always protected: that receipt names its own rule.
    assert.equal(d.decision, "deny");
    const own = d.receipts.find((r) => r.payload.clause_id === "protect-scopebond-write");
    assert.equal(own?.payload.failed_bound, "path:pattern");
  } finally { rt.close(); }
});

test("a monitored rm of a build folder is let through and still names the rule", async () => {
  const rt = runtime({});
  try {
    const d = await rt.evaluate(bash("rm -rf build"));
    assert.equal(d.decision, "allow");
    const p = shellReceipt(d).payload;
    assert.equal(p.realtime_result, "deny");
    assert.equal(p.clause_id, "safe-shell");
    assert.equal(p.failed_bound, "program:pattern");
  } finally { rt.close(); }
});

test("an allowed command carries neither", async () => {
  const rt = runtime(ENFORCE);
  try {
    const d = await rt.evaluate(bash("ls"));
    assert.equal(d.decision, "allow");
    const p = shellReceipt(d).payload;
    assert.equal(p.realtime_result, "allow");
    assert.equal("clause_id" in p, false);
    assert.equal("failed_bound" in p, false);
  } finally { rt.close(); }
});
