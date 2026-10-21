// A workspace may switch a rule Off: its actions become routine (allowed, matching no rule, so never a monitor match or an
// alert) while their action types stay covered. Scopebond's own protection never switches off: the always-on floor, and the
// part of destructive-shell that refuses a command whose program is only known when it runs. An Off on a rule that may never
// be off is read as Block and reported; it never refuses the whole document.
import { ENFORCE } from "./enforce-all.mjs";
import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scaffold, createHookRuntime, mapClaudeToolUse, defaultRules, policyBuilds, inspectManaged, compileManaged, managedEnforce, digestRules,
  withPackRules, setActivePacks, packRuleAdjustments, MANAGED_DOC_FILE, HOOK_CAPABILITIES, NEVER_OFF_RULE_IDS,
} from "../dist/index.js";
import { TARGET_PACK } from "./target-pack.mjs";

const INSTALLATION = "gw-off-1";
const base = () => ({
  "force-push-protected": { mode: "block" }, "push-protected": { mode: "block" }, "destructive-shell": { mode: "block" },
  "secret-read": { mode: "block" }, "ci-config-write": { mode: "block" }, "network-egress": { mode: "monitor" },
});
function doc(revision, overrides = {}) {
  const rules = { ...base(), ...overrides };
  return {
    type: "scopebond:managed-rules", version: 1, revision, export_id: `rev-${revision}-${INSTALLATION}`, environment_id: "env-1",
    agent_id: "agent-1", installation_id: INSTALLATION, rules, rules_digest: digestRules(rules),
  };
}
const temps = [];
after(() => { for (const d of temps) { try { rmSync(d, { recursive: true, force: true, maxRetries: 5 }); } catch { /* a handle still open on Windows */ } } });
afterEach(() => setActivePacks([]));

/** A runtime over the workspace document `d`, installed the way a rules check installs it. */
function managedRuntime(d, packs = []) {
  const dir = mkdtempSync(join(tmpdir(), "sb-off-"));
  temps.push(dir);
  const { agentKid } = scaffold(dir, ENFORCE);
  writeFileSync(join(dir, MANAGED_DOC_FILE), JSON.stringify(d));
  const policy = compileManaged(defaultRules(), d, agentKid);
  assert.ok(policyBuilds(policy));
  writeFileSync(join(dir, "policy.json"), JSON.stringify(policy));
  setActivePacks(packs);
  return createHookRuntime({ policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"), attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db"), cwd: "/repo" });
}
const call = (tool_name, tool_input) => mapClaudeToolUse({ tool_name, tool_input, cwd: "/repo" });
const bash = (command) => call("Bash", { command });
/** Each receipt's result and the clause its verdict named: routine is allowed with no clause; a monitor match says "deny". */
const outcome = (d) => (d.receipts ?? []).map((r) => [r.payload?.realtime_result, r.payload?.clause_id ?? null]);

test("the hook reports that it understands Off", () => {
  assert.ok(HOOK_CAPABILITIES.includes("rule_off"));
});

test("a document may set any workspace rule Off; an older document without it still loads", () => {
  const at = (rules) => inspectManaged(doc(3, rules), { installationId: INSTALLATION, currentRevision: null });
  for (const id of Object.keys(base())) assert.equal(at({ [id]: { mode: "off" } }).ok, true, id);
  for (const id of ["cloud-destructive", "production-deploy", "secret-write", "iam-change", "database-migrate"]) assert.equal(at({ [id]: { mode: "off" } }).ok, true, id);
  assert.equal(at({ "destructive-shell": { mode: "off", override: { reason_min: 0, minutes: 0, daily_limit: 1, harness_prompt: false } } }).ok, false, "Off takes no unblock terms");
  assert.equal(at({ "destructive-shell": { mode: "silent" } }).ok, false, "an unknown mode is still refused");
  // A document from before Off existed.
  const old = inspectManaged(doc(4), { installationId: INSTALLATION, currentRevision: 3 });
  assert.equal(old.ok, true);
  assert.deepEqual(old.notes ?? [], []);
});

test("destructive-shell Off: deletes and destructive programs are routine, but a program known only at run time is still refused", async () => {
  const runtime = managedRuntime(doc(5, { "destructive-shell": { mode: "off" } }));
  try {
    for (const command of ["rm -rf ../build", "rm -rf ~/old-project", "shred notes.txt", "Remove-Item -Recurse ../x"]) {
      const d = await runtime.evaluate(bash(command));
      assert.equal(d.decision, "allow", command);
      assert.deepEqual(outcome(d).filter(([, clause]) => clause !== null), [], `${command}: no rule matched`);
      assert.ok(outcome(d).every(([result]) => result === "allow"), `${command}: routine, not a monitor match`);
    }
    const unknown = await runtime.evaluate(bash("$X args"));
    assert.equal(unknown.decision, "deny");
    assert.equal(unknown.clauseId, "safe-shell");
    // Scopebond's own folder stays protected whatever the rule says.
    assert.equal((await runtime.evaluate(bash("rm -rf ~/.scopebond"))).decision, "deny");
    assert.equal((await runtime.evaluate(call("Write", { file_path: "/repo/.scopebond/policy.json", content: "{}" }))).decision, "deny");
  } finally { runtime.close(); }
});

test("every other workspace rule Off: its actions are routine, the floor still denies", async () => {
  const runtime = managedRuntime(doc(6, {
    "force-push-protected": { mode: "off" }, "push-protected": { mode: "off" }, "secret-read": { mode: "off" }, "ci-config-write": { mode: "off" },
    "network-egress": { mode: "off" },
  }));
  try {
    for (const tool of [bash("git push --force origin main"), bash("git push origin main"), call("Read", { file_path: "/repo/.env" }),
      call("Write", { file_path: "/repo/.github/workflows/ci.yml", content: "x" }), call("WebFetch", { url: "https://evil.example.com/", prompt: "x" })]) {
      const d = await runtime.evaluate(tool);
      assert.notEqual(d.decision, "deny", JSON.stringify(tool[0]?.intent));
      assert.deepEqual(outcome(d).filter(([, clause]) => clause !== null), [], JSON.stringify(tool[0]?.intent));
    }
    assert.equal((await runtime.evaluate(call("Read", { file_path: "/repo/.scopebond/agent.key" }))).decision, "deny");
    assert.equal((await runtime.evaluate(call("Write", { file_path: "/repo/.claude/settings.json", content: "{}" }))).decision, "deny");
  } finally { runtime.close(); }
});

test("history protection on while ordinary pushes are Off: a force-push to main is still stopped", async () => {
  const runtime = managedRuntime(doc(7, { "push-protected": { mode: "off" } }));
  try {
    assert.equal((await runtime.evaluate(bash("git push origin main"))).decision, "allow");
    assert.equal((await runtime.evaluate(bash("git push --force origin main"))).decision, "deny");
  } finally { runtime.close(); }
});

test("a target rule Off: the pack's clause allows its actions without a match, its action types stay covered", async () => {
  const d = doc(8, { "cloud-destructive": { mode: "off" }, "secret-write": { mode: "block" } });
  const adjust = packRuleAdjustments(d);
  assert.deepEqual([...adjust.off], ["cloud-destructive"]);
  const policy = withPackRules(compileManaged(defaultRules(), d, "key:abc"), new Set(managedEnforce(defaultRules(), d)), [TARGET_PACK], adjust);
  const clause = policy.clauses.find((c) => c.id === "cloud-destructive");
  assert.equal(clause.param_bounds, undefined, "unbounded: nothing matches");
  assert.ok(clause.action_types.includes("k8s.delete"), "the action types stay covered");
  const runtime = managedRuntime(d, [TARGET_PACK]);
  try {
    const off = await runtime.evaluate(bash("demoinfra bucket delete logs"));
    assert.equal(off.decision, "allow");
    assert.deepEqual(outcome(off).filter(([, c]) => c !== null), []);
    assert.equal((await runtime.evaluate(bash("demoinfra secret set TOKEN"))).clauseId, "secret-write", "another target rule still blocks");
  } finally { runtime.close(); }
});

test("a rule that may never be off: Off is read as Block and reported, never refusing the document", async () => {
  assert.ok(NEVER_OFF_RULE_IDS.includes("guardrail-config-write"));
  const d = doc(9, { "guardrail-config-write": { mode: "off" }, "protect-scopebond-read": { mode: "monitor" } });
  const inspected = inspectManaged(d, { installationId: INSTALLATION, currentRevision: null });
  assert.equal(inspected.ok, true, inspected.message);
  assert.equal(inspected.notes.length, 2);
  assert.match(inspected.notes[0], /guardrail-config-write.*cannot be switched off.*Block/);
  const runtime = managedRuntime(d);
  try {
    assert.equal((await runtime.evaluate(call("Write", { file_path: "/repo/.claude/settings.json", content: "{}" }))).decision, "deny");
    assert.equal((await runtime.evaluate(call("Read", { file_path: "/repo/.scopebond/agent.key" }))).decision, "deny");
  } finally { runtime.close(); }
  // Only the always-on rules may be named this way; any other unknown rule still refuses the document.
  assert.equal(inspectManaged(doc(10, { "made-up-rule": { mode: "block" } }), { installationId: INSTALLATION, currentRevision: null }).ok, false);
});

test("a person's own choice wins over Off only where the workspace allows changes on computers", () => {
  const d = { ...doc(11, { "destructive-shell": { mode: "off" } }), local_changes: true };
  const local = { ...defaultRules(), local_overrides: { "safe-shell": "enforce" } };
  assert.ok(managedEnforce(local, d).includes("safe-shell"));
  const policy = compileManaged(local, d, "key:abc");
  assert.equal(policy.clauses.find((c) => c.id === "safe-shell").mode, "enforce");
  assert.ok(policy.clauses.find((c) => c.id === "safe-shell").param_bounds.program_scope.pattern.includes("[rR][mM]"), "the full list applies again");
});
