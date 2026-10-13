// The target rules: what a coding agent reaches through cloud, Kubernetes, database, deployment and secret tools is
// classified (H06–H10), recorded by default and blocked once a rule is turned on, and the catalog and the compiled policy
// agree on every vector. A policy written before these types existed decides every call exactly as it did.

import { ENFORCE } from "./enforce-all.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scaffold, createHookRuntime, mapClaudeToolUse, mapCodexToolUse, compile, defaultRules, classifyIntent, classificationBlocks, MONITORED_HIGH,
  TARGET_RULES, SWITCHABLE_RULES, starterPolicy, namedActionTypes, inspectManaged, compileManaged, digestRules, RULE_OF_CLAUSE, describeRules,
} from "../dist/index.js";

const temps = [];
after(() => { for (const d of temps) { try { rmSync(d, { recursive: true, force: true, maxRetries: 5 }); } catch { /* a handle still open on Windows */ } } });
const temp = () => { const d = mkdtempSync(join(tmpdir(), "sb-targets-")); temps.push(d); return d; };

/** A runtime over the given policy (or the one compiled from a rule set). */
function runtimeWith(policyOf, opts = {}) {
  const dir = temp();
  const { agentKid } = scaffold(dir, ENFORCE);
  writeFileSync(join(dir, "policy.json"), JSON.stringify(policyOf(agentKid)));
  return createHookRuntime({ policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"), attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db"), cwd: "/repo", ...opts });
}
const bash = (command) => mapClaudeToolUse({ tool_name: "Bash", tool_input: { command }, cwd: "/repo" });

// Each vector: a command, and the target classes it carries.
const VECTORS = [
  ["aws s3 rb s3://acme-old --force", ["H06"]],
  ["aws ec2 terminate-instances --instance-ids i-0aaa", ["H06"]],
  ["kubectl -n payments delete pod api-1", ["H06"]],
  ["kubectl exec -it api-1 -- sh", ["H06"]],
  ["helm uninstall web -n prod", ["H06"]],
  ["terraform destroy -auto-approve", ["H06"]],
  ["gh repo delete acme/old --yes", ["H06"]],
  ["vercel --prod", ["H07"]],
  ["wrangler deploy", ["H07"]],
  ["fly deploy -a acme-prod", ["H07"]],
  ["az webapp deploy -g rg -n web --slot staging --src-path a.zip", []],
  ["vercel", []],
  ["gh secret set NPM_TOKEN --body x", ["H08"]],
  ["wrangler secret put API_KEY", ["H08"]],
  ["aws iam attach-role-policy --role-name r --policy-arn arn:x", ["H09"]],
  ["gcloud projects add-iam-policy-binding acme-prod --member=user:a@b.example --role=roles/owner", ["H09"]],
  ["npx prisma migrate reset --force", ["H10"]],
  ["bin/rails db:rollback", ["H10"]],
  ["npx prisma migrate deploy", []],
  ["terraform apply -auto-approve", []],
  ["kubectl apply -f k8s/", []],
  ["aws s3 ls", []],
  ["pnpm test", []],
];

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

test("the target classes are monitored by default: never blocking in the catalog, recorded by the compiled policy", async () => {
  const runtime = runtimeWith((kid) => compile({ ...defaultRules(), ...ENFORCE }, kid));
  try {
    for (const [command, classes] of VECTORS) {
      const mapped = bash(command);
      const { ids, blocks } = classesOf(mapped);
      assert.deepEqual(ids, classes, `${command}: classes`);
      assert.equal(blocks, false, `${command}: a target class never blocks by default`);
      const decision = await runtime.evaluate(mapped);
      assert.equal(decision.decision, "allow", `${command}: ${decision.reason}`);
      // Every derived intent was evaluated (the compiled policy names its type), and recorded.
      assert.equal(decision.receipts.length, mapped.length);
    }
  } finally { runtime.close(); }
});

test("with the target rules on, the compiled policy denies exactly what the catalog classes name", async () => {
  const runtime = runtimeWith((kid) => compile({ ...defaultRules(), enforce: [...ENFORCE.enforce, ...TARGET_RULES] }, kid));
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
    const runtime = runtimeWith((kid) => compile({ ...defaultRules(), enforce: [rule] }, kid));
    try {
      for (const [command, classes] of VECTORS) {
        const denied = (await runtime.evaluate(bash(command))).decision === "deny";
        assert.equal(denied, classes.some((id) => MONITORED_HIGH[id] === rule), `${rule}: ${command}`);
      }
    } finally { runtime.close(); }
  }
});

test("a policy written before the target types existed decides every call as it did, and records the derived actions", async () => {
  // The starter policy without the target clauses: what an earlier hook compiled.
  const legacy = (kid) => {
    const p = starterPolicy(kid, ENFORCE);
    return { ...p, clauses: p.clauses.filter((c) => !TARGET_RULES.includes(c.id) && c.id !== "observe-targets") };
  };
  for (const strict of [false, true]) {
    const runtime = runtimeWith(legacy, { strict });
    try {
      for (const command of ["aws s3 rb s3://acme-old --force", "vercel --prod", "npx prisma migrate reset --force"]) {
        const decision = await runtime.evaluate(bash(command));
        assert.equal(decision.decision, "allow", `${command} (strict ${strict}): ${decision.reason}`);
        const derived = decision.receipts.map((r) => r.payload).filter((p) => p.intent.params.derived_from === "shell.exec");
        assert.ok(derived.length > 0, "the derived action is recorded");
        for (const p of derived) assert.equal(p.realtime_result, "not_evaluated", `${command}: recorded, not decided`);
      }
      // A destructive program the legacy policy blocks is still blocked.
      assert.equal((await runtime.evaluate(bash("rm -rf build"))).decision, "deny");
    } finally { runtime.close(); }
  }
});

test("an MCP call's derived push is evaluated by the push rule, under any policy that names git.push", async () => {
  const runtime = runtimeWith((kid) => compile({ ...defaultRules(), ...ENFORCE }, kid));
  try {
    const call = (branch) => mapCodexToolUse({ tool_name: "mcp__github__push_files", tool_input: { owner: "acme", repo: "web", branch, files: [{ path: "src/a.ts", content: "x" }] }, cwd: "/repo" });
    assert.equal((await runtime.evaluate(call("main"))).decision, "deny");
    assert.equal((await runtime.evaluate(call("agent/fix"))).decision, "allow");
  } finally { runtime.close(); }
});

test("the starter policy and the compiled rules carry the same target clauses", () => {
  const compiled = compile({ ...defaultRules(), ...ENFORCE }, "key:abc");
  const shipped = starterPolicy("key:abc", ENFORCE);
  const targets = (p) => p.clauses.filter((c) => TARGET_RULES.includes(c.id) || c.id === "observe-targets").map((c) => ({ id: c.id, mode: c.mode, action_types: c.action_types, param_bounds: c.param_bounds }));
  assert.deepEqual(targets(compiled), targets(shipped));
  for (const c of targets(compiled)) assert.equal(c.mode, "monitor", `${c.id} records by default`);
  const types = namedActionTypes(compiled);
  for (const t of ["cloud.resource.delete", "cloud.resource.create", "cloud.resource.modify", "k8s.apply", "k8s.delete", "k8s.exec", "db.migrate", "deploy.release", "secret.write", "iam.change", "communication.send", "work.item.create", "work.item.update"]) {
    assert.ok(types.has(t), `${t} is named by the default policy`);
  }
  assert.ok(SWITCHABLE_RULES.includes("production-deploy"));
  assert.match(describeRules(defaultRules()), /\[records\] production-deploy/);
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
  const modes = (rules) => Object.fromEntries(compileManaged(defaultRules(), doc(rules), "key:abc").clauses.map((c) => [c.id, c.mode]));
  const on = modes({ ...base(), "production-deploy": { mode: "block" }, "iam-change": { mode: "monitor" } });
  assert.equal(on["production-deploy"], "enforce");
  assert.equal(on["iam-change"], "monitor");
  assert.equal(on["cloud-destructive"], "monitor", "left out: records");
  const off = modes(base());
  for (const id of TARGET_RULES) assert.equal(off[id], "monitor", id);
  for (const id of TARGET_RULES) assert.equal(RULE_OF_CLAUSE[id], id, `${id}: a denial names its workspace rule`);
});

test("the default policy file still compiles and parses after the target clauses were added", () => {
  const dir = temp();
  scaffold(dir, ENFORCE);
  const policy = JSON.parse(readFileSync(join(dir, "policy.json"), "utf8"));
  assert.ok(policy.clauses.some((c) => c.id === "production-deploy"));
});
