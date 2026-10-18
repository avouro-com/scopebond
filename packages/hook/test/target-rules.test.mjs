// The target rules: what a coding agent reaches through the tools a rule pack describes is classified (H06–H10), recorded by
// default and blocked once a rule is turned on, and the catalog and the policy in force agree on every vector. The engine
// carries no tool of its own: the pack here is made up (target-pack.mjs), and its rules join the policy when it is loaded
// (pack-rules.ts). With no pack in force nothing is derived and the policy holds only the starter rules.

import { ENFORCE } from "./enforce-all.mjs";
import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scaffold, createHookRuntime, mapClaudeToolUse, mapCodexToolUse, compile, defaultRules, classifyIntent, classificationBlocks, MONITORED_HIGH,
  TARGET_RULES, SWITCHABLE_RULES, starterPolicy, namedActionTypes, inspectManaged, compileManaged, managedEnforce, digestRules, RULE_OF_CLAUSE,
  describeRules, setActivePacks, packRuleClauses, switchablePackRules, withPackRules, createOverrideHandler, overrideHint, MANAGED_DOC_FILE,
} from "../dist/index.js";
import { TARGET_PACK, TARGET_PACK_RULES, TARGET_VECTORS as VECTORS } from "./target-pack.mjs";

const temps = [];
after(() => { for (const d of temps) { try { rmSync(d, { recursive: true, force: true, maxRetries: 5 }); } catch { /* a handle still open on Windows */ } } });
afterEach(() => setActivePacks([]));
const temp = () => { const d = mkdtempSync(join(tmpdir(), "sb-targets-")); temps.push(d); return d; };

/** A runtime over the given policy (or the one compiled from a rule set), with the made-up pack in force unless told otherwise. */
function runtimeWith(policyOf, opts = {}, { packs = [TARGET_PACK], enforce } = {}) {
  const dir = temp();
  const { agentKid } = scaffold(dir, ENFORCE);
  writeFileSync(join(dir, "policy.json"), JSON.stringify(policyOf(agentKid)));
  if (enforce) writeFileSync(join(dir, "rules.json"), JSON.stringify({ ...defaultRules(), enforce }));
  setActivePacks(packs);
  return createHookRuntime({ policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"), attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db"), cwd: "/repo", ...opts });
}
const bash = (command) => mapClaudeToolUse({ tool_name: "Bash", tool_input: { command }, cwd: "/repo" });

const classesOf = (mapped) => {
  const ids = new Set();
  let blocks = false;
  for (const m of mapped) {
    const c = classifyIntent(m.intent, defaultRules());
    c.ids.filter((id) => id in MONITORED_HIGH).forEach((id) => ids.add(id));
    if (classificationBlocks(c)) blocks = true;
  }
  return { ids: [...ids].sort(), blocks };
};

test("the target classes are monitored by default: never blocking in the catalog, recorded by the policy in force", async () => {
  const runtime = runtimeWith((kid) => compile({ ...defaultRules(), ...ENFORCE }, kid));
  try {
    for (const [command, classes] of VECTORS) {
      const mapped = bash(command);
      const { ids, blocks } = classesOf(mapped);
      assert.deepEqual(ids, classes, `${command}: classes`);
      assert.equal(blocks, false, `${command}: a target class never blocks by default`);
      const decision = await runtime.evaluate(mapped);
      assert.equal(decision.decision, "allow", `${command}: ${decision.reason}`);
      // Every derived intent was evaluated (the pack's rules name its type), and recorded.
      assert.equal(decision.receipts.length, mapped.length);
    }
  } finally { runtime.close(); }
});

test("with the target rules on, the policy in force denies exactly what the catalog classes name", async () => {
  const enforce = [...ENFORCE.enforce, ...TARGET_RULES];
  const runtime = runtimeWith((kid) => compile({ ...defaultRules(), enforce }, kid), {}, { enforce });
  try {
    for (const [command, classes] of VECTORS) {
      const decision = await runtime.evaluate(bash(command));
      assert.equal(decision.decision === "deny", classes.length > 0, `${command}: ${decision.reason}`);
      if (classes.length) assert.equal(decision.clauseId, MONITORED_HIGH[classes[0]], `${command}: the rule named for its class decided`);
    }
  } finally { runtime.close(); }
});

test("each rule blocks only its own class", async () => {
  for (const rule of TARGET_RULES) {
    const runtime = runtimeWith((kid) => compile({ ...defaultRules(), enforce: [rule] }, kid), {}, { enforce: [rule] });
    try {
      for (const [command, classes] of VECTORS) {
        const denied = (await runtime.evaluate(bash(command))).decision === "deny";
        assert.equal(denied, classes.some((id) => MONITORED_HIGH[id] === rule), `${rule}: ${command}`);
      }
    } finally { runtime.close(); }
  }
});

test("with no pack in force, nothing is derived and every call is decided by the starter rules alone", async () => {
  const runtime = runtimeWith((kid) => compile({ ...defaultRules(), enforce: [...ENFORCE.enforce, ...TARGET_RULES] }, kid), {}, { packs: [] });
  try {
    for (const [command] of VECTORS) {
      const mapped = bash(command);
      assert.deepEqual(mapped.filter((m) => m.derived), [], `${command}: nothing derived`);
      assert.equal((await runtime.evaluate(mapped)).decision, "allow", command);
    }
    assert.equal((await runtime.evaluate(bash("rm -rf build"))).decision, "deny", "the starter rules still block");
  } finally { runtime.close(); }
});

test("a pack that derives actions but brings no rules: the policy does not opt in, so they are recorded, never decided", async () => {
  const noRules = { ...TARGET_PACK, id: "demo-no-rules", rules: [] };
  for (const strict of [false, true]) {
    const runtime = runtimeWith((kid) => starterPolicy(kid, ENFORCE), { strict }, { packs: [noRules] });
    try {
      for (const command of ["demoinfra bucket delete logs", "demoinfra deploy", "demoinfra migrate down"]) {
        const decision = await runtime.evaluate(bash(command));
        assert.equal(decision.decision, "allow", `${command} (strict ${strict}): ${decision.reason}`);
        const derived = decision.receipts.map((r) => r.payload).filter((p) => p.intent.params.derived_from === "shell.exec");
        assert.ok(derived.length > 0, "the derived action is recorded");
        for (const p of derived) assert.equal(p.realtime_result, "not_evaluated", `${command}: recorded, not decided`);
      }
      assert.equal((await runtime.evaluate(bash("rm -rf build"))).decision, "deny");
    } finally { runtime.close(); }
  }
});

test("an MCP call's derived push is evaluated by the push rule, under a policy that opts in", async () => {
  const runtime = runtimeWith((kid) => compile({ ...defaultRules(), ...ENFORCE }, kid));
  try {
    const call = (branch) => mapCodexToolUse({ tool_name: "mcp__demorepo__push_change", tool_input: { branch }, cwd: "/repo" });
    assert.equal((await runtime.evaluate(call("main"))).decision, "deny");
    assert.equal((await runtime.evaluate(call("agent/fix"))).decision, "allow");
  } finally { runtime.close(); }
});

test("the starter policy and the compiled rules carry no target clauses: the packs in force add them, on monitor", () => {
  const compiled = compile({ ...defaultRules(), ...ENFORCE }, "key:abc");
  const shipped = starterPolicy("key:abc", ENFORCE);
  const targets = (p) => p.clauses.filter((c) => TARGET_RULES.includes(c.id) || c.id === "observe-targets");
  assert.deepEqual(targets(compiled), []);
  assert.deepEqual(targets(shipped), []);
  const joined = withPackRules(compiled, new Set(), [TARGET_PACK]);
  assert.deepEqual(targets(joined).map((c) => [c.id, c.mode]), TARGET_PACK_RULES.map((r) => [r.id, "monitor"]));
  // Placed after the starter rules and before the key policy, as the built-in rules were.
  const ids = joined.clauses.map((c) => c.id);
  assert.ok(ids.indexOf("observe-net-mcp") < ids.indexOf("cloud-destructive") && ids.indexOf("observe-targets") < ids.indexOf("keys"));
  const types = namedActionTypes(joined);
  for (const t of ["cloud.resource.delete", "cloud.resource.create", "cloud.resource.modify", "k8s.apply", "k8s.delete", "k8s.exec", "db.migrate", "deploy.release", "secret.write", "iam.change", "communication.send", "work.item.create", "work.item.update"]) {
    assert.ok(types.has(t), `${t} is named once the pack is in force`);
  }
  assert.equal(withPackRules(compiled, new Set(), []), compiled, "no pack: the same policy");
  assert.ok(SWITCHABLE_RULES.includes("production-deploy"));
  setActivePacks([]);
  assert.doesNotMatch(describeRules(defaultRules()), /\[records\] production-deploy/);
  assert.match(describeRules(defaultRules()), /rule packs from Scopebond Cloud/);
  setActivePacks([TARGET_PACK]);
  assert.match(describeRules(defaultRules()), /\[records\] production-deploy/);
  assert.match(describeRules({ ...defaultRules(), enforce: ["production-deploy"] }), /\[blocks\] production-deploy/);
});

test("only a target rule with bounds can be turned on; a pack's other rules always record", () => {
  const extra = { ...TARGET_PACK, id: "demo-extra", rules: [
    { id: "demo-other", type: "action_allowlist", mode: "monitor", action_types: ["cloud.resource.delete"], param_bounds: { risk_class: { pattern: "^(?!destructive$).+" } } },
    { id: "cloud-destructive", type: "action_allowlist", mode: "monitor", action_types: ["cloud.resource.delete"] },
  ] };
  const modes = Object.fromEntries(packRuleClauses(new Set(["demo-other", "cloud-destructive", "observe-targets"]), [extra, TARGET_PACK].sort((a, b) => (a.id < b.id ? -1 : 1))).map((c) => [c.id, c.mode]));
  assert.equal(modes["demo-other"], "monitor", "not a target rule");
  assert.equal(modes["cloud-destructive"], "monitor", "the first pack by id defines it, without bounds");
  assert.equal(modes["observe-targets"], "monitor", "no bounds");
  assert.deepEqual(switchablePackRules([TARGET_PACK]), [...TARGET_RULES]);
  assert.deepEqual(switchablePackRules([]), []);
});

test("a clause the policy already carries is kept as it is (a policy compiled when the rule was built in)", () => {
  const old = compile({ ...defaultRules(), ...ENFORCE }, "key:abc");
  const legacy = { id: "cloud-destructive", type: "action_allowlist", mode: "enforce", action_types: ["cloud.resource.delete"], param_bounds: { risk_class: { pattern: "^(?!destructive$).+" } }, description: "an earlier wording" };
  old.clauses.splice(old.clauses.length - 1, 0, legacy);
  const joined = withPackRules(old, new Set(), [TARGET_PACK]);
  assert.deepEqual(joined.clauses.filter((c) => c.id === "cloud-destructive"), [legacy]);
});

const INSTALLATION = "gw-target-1";
const base = () => ({
  "force-push-protected": { mode: "monitor" }, "push-protected": { mode: "monitor" }, "destructive-shell": { mode: "monitor" },
  "secret-read": { mode: "monitor" }, "ci-config-write": { mode: "monitor" }, "network-egress": { mode: "monitor" },
});
const doc = (rules) => ({
  type: "scopebond:managed-rules", version: 1, revision: 1, export_id: `rev-1-${INSTALLATION}`, environment_id: "env-1", agent_id: "agent-1",
  installation_id: INSTALLATION, rules, rules_digest: digestRules(rules),
});

test("a workspace document may set the target rules, may leave them out, and may not name rules this version does not know", () => {
  const check = (rules) => inspectManaged(doc(rules), { installationId: INSTALLATION, currentRevision: null });
  assert.equal(check(base()).ok, true, "a document without them is accepted, as before");
  assert.equal(check({ ...base(), "production-deploy": { mode: "block" }, "cloud-destructive": { mode: "monitor" } }).ok, true);
  const unknown = check({ ...base(), "quantum-rule": { mode: "block" } });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, "unsupported");
  assert.equal(check({ ...base(), "secret-write": { mode: "block", protected_branches: ["main"] } }).ok, false, "a target rule takes no lists");
  assert.equal(check({ ...base(), "iam-change": { mode: "sometimes" } }).ok, false);
});

test("a workspace turns a target rule on, and a rule it leaves out records", () => {
  const modes = (rules) => {
    const d = doc(rules);
    const policy = withPackRules(compileManaged(defaultRules(), d, "key:abc"), new Set(managedEnforce(defaultRules(), d)), [TARGET_PACK]);
    return Object.fromEntries(policy.clauses.map((c) => [c.id, c.mode]));
  };
  const on = modes({ ...base(), "production-deploy": { mode: "block" }, "iam-change": { mode: "monitor" } });
  assert.equal(on["production-deploy"], "enforce");
  assert.equal(on["iam-change"], "monitor");
  assert.equal(on["cloud-destructive"], "monitor", "left out: records");
  const off = modes(base());
  for (const id of TARGET_RULES) assert.equal(off[id], "monitor", id);
  for (const id of TARGET_RULES) assert.equal(RULE_OF_CLAUSE[id], id, `${id}: a denial names its workspace rule`);
});

test("on a computer its workspace manages, the runtime takes each pack rule's mode from the workspace document", async () => {
  const dir = temp();
  const { agentKid } = scaffold(dir, ENFORCE);
  const d = doc({ ...base(), "secret-write": { mode: "block" } });
  writeFileSync(join(dir, MANAGED_DOC_FILE), JSON.stringify(d));
  writeFileSync(join(dir, "policy.json"), JSON.stringify(compileManaged(defaultRules(), d, agentKid)));
  setActivePacks([TARGET_PACK]);
  const runtime = createHookRuntime({ policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"), attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db"), cwd: "/repo" });
  try {
    const denied = await runtime.evaluate(bash("demoinfra secret set TOKEN"));
    assert.equal(denied.decision, "deny");
    assert.equal(denied.clauseId, "secret-write");
    assert.equal((await runtime.evaluate(bash("demoinfra bucket delete logs"))).decision, "allow", "cloud-destructive records");
  } finally { runtime.close(); }
});

test("a person may allow an action a pack's rule blocks when the workspace lets them (the floor carries the pack's rules)", async () => {
  const dir = temp();
  const { agentKid } = scaffold(dir, ENFORCE);
  const terms = { reason_min: 10, minutes: 0, daily_limit: 5, harness_prompt: false };
  const d = doc({ ...base(), "cloud-destructive": { mode: "override", override: terms } });
  writeFileSync(join(dir, MANAGED_DOC_FILE), JSON.stringify(d));
  writeFileSync(join(dir, "policy.json"), JSON.stringify(compileManaged(defaultRules(), d, agentKid)));
  setActivePacks([TARGET_PACK]);
  const asked = [];
  const runtime = createHookRuntime({
    policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"), attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db"), cwd: "/repo",
    override: (kid) => {
      const made = createOverrideHandler({ dir, home: dir, agentKid: kid, harness: "claude", permissionMode: "default", waitMs: 50,
        ask: async (_home, request) => { asked.push(request); return { decision: "allow", reason: "Removing the old test bucket", os_user: "dev" }; } });
      return made ? { handler: made.handler, hint: () => overrideHint(made.note()) } : null;
    },
  });
  try {
    const decision = await runtime.evaluate(bash("demoinfra bucket delete logs"));
    assert.equal(decision.decision, "allow", decision.reason);
    assert.equal(asked.length, 1);
    assert.equal(asked[0].rule, "cloud-destructive");
  } finally { runtime.close(); }
});

test("the default policy file carries the starter rules only; the pack's rules join it when it is loaded", () => {
  const dir = temp();
  scaffold(dir, ENFORCE);
  const policy = JSON.parse(readFileSync(join(dir, "policy.json"), "utf8"));
  assert.ok(!policy.clauses.some((c) => c.id === "production-deploy"));
  assert.ok(withPackRules(policy, new Set(), [TARGET_PACK]).clauses.some((c) => c.id === "production-deploy"));
});
