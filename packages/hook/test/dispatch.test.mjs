import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { budgetDigest, defaultBudgetTemplate, scopeDigest } from "@scopebond/gateway";
import { DispatchStore } from "@scopebond/gateway/node";
import { createHookRuntime, mapClaudeToolUse, scaffold } from "../dist/index.js";
import { ENFORCE } from "./enforce-all.mjs";

function home() {
  const dir = join(mkdtempSync(join(tmpdir(), "sb-hook-dispatch-")), ".scopebond");
  scaffold(dir, ENFORCE);
  return dir;
}
const open = (dir) => createHookRuntime({ policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"), attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db") });
const kidOf = (dir) => { const rt = open(dir); const kid = rt.agentKid; rt.close(); return kid; };
const shell = (command) => mapClaudeToolUse({ tool_name: "Bash", tool_input: { command } });

function writeBudget(dir, over = {}) {
  const b = { ...defaultBudgetTemplate(kidOf(dir), ["shell.exec"]), max: 2, window_seconds: 3600, mode: "enforce", expires_at: "2099-01-01T00:00:00.000Z", ...over };
  b.acknowledgement = over.acknowledgement === undefined ? { digest: budgetDigest(b), acknowledged_at: new Date().toISOString() } : over.acknowledgement;
  writeFileSync(join(dir, "dispatch.json"), JSON.stringify({ budgets: [b] }));
  return b;
}

test("without dispatch settings the hook behaves as before", async () => {
  const dir = home();
  const rt = open(dir);
  for (let i = 0; i < 5; i++) assert.notEqual((await rt.evaluate(shell("git status"), { groupKey: `c${i}` })).decision, "deny");
  rt.close();
});

test("an enforced budget persists across hook processes: the third call in a window is blocked before it runs", async () => {
  const dir = home();
  writeBudget(dir);
  const outcomes = [];
  for (let i = 0; i < 3; i++) {
    const rt = open(dir); // a new runtime per call, as a new hook process would be
    outcomes.push(await rt.evaluate(shell("git status"), { groupKey: `call-${i}` }));
    rt.close();
  }
  assert.deepEqual(outcomes.map((d) => d.decision), ["allow", "allow", "deny"]);
  assert.match(outcomes[2].reason, /budget_exceeded/);
  assert.equal(outcomes[2].dispatch.budgets[0].count, 0 + 2, "the refused call is not added to the count");
});

test("a retried tool call (same call id) does not consume a second slot; a new invocation does", async () => {
  const dir = home();
  writeBudget(dir, { max: 2 });
  const rt = open(dir);
  assert.equal((await rt.evaluate(shell("git status"), { groupKey: "same" })).decision, "allow");
  assert.equal((await rt.evaluate(shell("git status"), { groupKey: "same" })).decision, "allow");
  assert.equal((await rt.evaluate(shell("git status"), { groupKey: "same" })).decision, "allow");
  assert.equal((await rt.evaluate(shell("git status"), { groupKey: "other" })).decision, "allow");
  assert.equal((await rt.evaluate(shell("git status"), { groupKey: "third" })).decision, "deny");
  rt.close();
});

test("a decomposed call counts as one parent action, and a policy denial consumes no slot", async () => {
  const dir = home();
  writeBudget(dir, { max: 1 });
  const rt = open(dir);
  const denied = await rt.evaluate(shell("git status && rm -rf /tmp/x"), { groupKey: "bad" });
  assert.equal(denied.decision, "deny", "policy denies the destructive part");
  assert.equal(denied.dispatch, undefined, "denied before the boundary");
  const multi = await rt.evaluate(shell("git status && git log && git diff"), { groupKey: "multi" });
  assert.equal(multi.decision, "allow");
  assert.equal(multi.dispatch.budgets[0].count, 1, "three mapped commands are one parent action");
  assert.equal((await rt.evaluate(shell("git status"), { groupKey: "next" })).decision, "deny");
  rt.close();
});

test("an unacknowledged or unreadable enforce policy does not grant unlimited dispatch", async () => {
  const dir = home();
  writeBudget(dir, { acknowledgement: null });
  const rt = open(dir);
  const d = await rt.evaluate(shell("git status"), { groupKey: "a" });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /budget_unacknowledged/);
  rt.close();
  writeFileSync(join(dir, "dispatch.json"), "{ not json");
  assert.throws(() => open(dir).evaluate(shell("git status")).then(() => {}), Error);
});

test("the suggested template is monitor-only: it never blocks", async () => {
  const dir = home();
  const b = { ...defaultBudgetTemplate(kidOf(dir), ["shell.exec"]), max: 1 };
  assert.equal(b.mode, "monitor");
  writeFileSync(join(dir, "dispatch.json"), JSON.stringify({ budgets: [b] }));
  const rt = open(dir);
  for (let i = 0; i < 3; i++) assert.equal((await rt.evaluate(shell("git status"), { groupKey: `m${i}` })).decision, "allow");
  rt.close();
});

test("a delegated session is limited to its scope and refused once its delegation is revoked", async () => {
  const dir = home();
  writeFileSync(join(dir, "dispatch.json"), JSON.stringify({}));
  const kid = kidOf(dir);
  const store = new DispatchStore(join(dir, "dispatch.db"));
  const scope = { action_types: ["shell.exec"] };
  const now = Date.now();
  const grant = { delegation_id: "deleg:hook-child-01", parent_id: null, actor: kid, scope, scope_digest: scopeDigest(scope), issued_at: new Date(now).toISOString(), expires_at: new Date(now + 3_600_000).toISOString() };
  assert.equal(store.addDelegation(grant).ok, true);
  process.env.SCOPEBOND_DELEGATION = grant.delegation_id;
  try {
    const rt = open(dir);
    assert.equal((await rt.evaluate(shell("git status"), { groupKey: "d1" })).decision, "allow");
    const write = await rt.evaluate(mapClaudeToolUse({ tool_name: "Write", tool_input: { file_path: "a.txt", content: "x" } }), { groupKey: "d2" });
    assert.equal(write.decision, "deny", "file.write is outside the delegated scope");
    assert.match(write.reason, /delegation_out_of_scope/);
    store.revoke(grant.delegation_id);
    const revoked = await rt.evaluate(shell("git status"), { groupKey: "d3" });
    assert.equal(revoked.decision, "deny");
    assert.match(revoked.reason, /delegation_revoked/);
    rt.close();
  } finally { delete process.env.SCOPEBOND_DELEGATION; store.close(); }
});

test("a shared_gateway budget is refused by an independent hook", async () => {
  const dir = home();
  writeBudget(dir, { authority_scope: "shared_gateway" });
  const rt = open(dir);
  const d = await rt.evaluate(shell("git status"), { groupKey: "s" });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /budget_capability_unsupported/);
  rt.close();
});
