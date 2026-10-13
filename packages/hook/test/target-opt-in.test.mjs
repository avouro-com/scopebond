// Derived actions are decided only under a policy that opts in to them. A policy opts in when one of its clauses names an
// action type Action Taxonomy 1.1 introduced (other than db.exec, which policies named before 1.1): every policy this
// version compiles does, through the target rules. Under any other policy the derived actions are recorded and every call
// is decided exactly as it was before they existed. Also: a file written through the GitHub API is not a file on this
// computer, and the derived actions of one call are bounded.

import { ENFORCE } from "./enforce-all.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scaffold, createHookRuntime, mapClaudeToolUse, compile, defaultRules, compileManaged, digestRules, starterPolicy, policyOptsIntoTargets,
  TARGET_OPT_IN_TYPES, TARGET_RULES, classifyIntent, DERIVED_CAP,
} from "../dist/index.js";

const temps = [];
after(() => { for (const d of temps) { try { rmSync(d, { recursive: true, force: true, maxRetries: 5 }); } catch { /* a handle still open on Windows */ } } });

function runtimeWith(policyOf, rules) {
  const dir = mkdtempSync(join(tmpdir(), "sb-optin-"));
  temps.push(dir);
  const { agentKid } = scaffold(dir, ENFORCE);
  if (rules) writeFileSync(join(dir, "rules.json"), JSON.stringify(rules));
  writeFileSync(join(dir, "policy.json"), JSON.stringify(policyOf(agentKid)));
  return createHookRuntime({ policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"), attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db"), cwd: "/repo" });
}

/** The same policy as an earlier hook compiled it: without the target clauses. */
const withoutTargets = (policy) => ({ ...policy, clauses: policy.clauses.filter((c) => !TARGET_RULES.includes(c.id) && c.id !== "observe-targets") });

const INSTALLATION = "gw-optin-1";
const managedDoc = (rules) => ({
  type: "scopebond:managed-rules", version: 1, revision: 1, export_id: `rev-1-${INSTALLATION}`, environment_id: "env-1", agent_id: "agent-1",
  installation_id: INSTALLATION, rules, rules_digest: digestRules(rules),
});
const WORKSPACE = {
  "force-push-protected": { mode: "block" }, "push-protected": { mode: "block", protected_branches: ["main"] }, "destructive-shell": { mode: "monitor" },
  "secret-read": { mode: "block" }, "ci-config-write": { mode: "block" }, "network-egress": { mode: "block", allowed_hosts: ["github.com"] },
};

// The 1.0-vocabulary policies an earlier hook or workspace produced: the starter policy, a workspace that blocks pushes to
// main and sites other than github.com, and a computer that protects remote databases and keeps writes in its folder.
const LEGACY = {
  starter: { policy: (kid) => withoutTargets(starterPolicy(kid, ENFORCE)) },
  workspace: { policy: (kid) => withoutTargets(compileManaged(defaultRules(), managedDoc(WORKSPACE), kid)) },
  "remote-database-and-roots": {
    policy: (kid) => withoutTargets(compile({ ...defaultRules(), ...ENFORCE, protect_remote_database: true, allowed_roots: ["."] }, kid)),
    rules: { ...defaultRules(), ...ENFORCE, protect_remote_database: true, allowed_roots: ["."] },
  },
};

const bash = (command) => mapClaudeToolUse({ tool_name: "Bash", tool_input: { command }, cwd: "/repo" });
const mcp = (name, input) => mapClaudeToolUse({ tool_name: name, tool_input: input, cwd: "/repo" });

// Calls whose mapping gained derived actions.
const CALLS = [
  ["gh api write", () => bash("gh api -X POST repos/o/r/issues -f title=x")],
  ["aws s3 rb", () => bash("aws s3 rb s3://acme-old --force")],
  ["kubectl delete behind an unknown option", () => bash("kubectl --warnings-as-errors delete ns prod")],
  ["vercel --prod", () => bash("vercel --prod")],
  ["prisma migrate reset", () => bash("npx prisma migrate reset --force")],
  ["terraform saved plan", () => bash("terraform apply tfplan")],
  ["GitHub MCP push to main", () => mcp("mcp__github__push_files", { owner: "o", repo: "r", branch: "main", files: [{ path: ".github/workflows/ci.yml", content: "x" }, { path: ".claude/settings.json", content: "x" }] })],
  ["GitHub MCP file to main", () => mcp("mcp__github__create_or_update_file", { owner: "o", repo: "r", path: "/docs/x.md", branch: "main", content: "x" })],
  ["fetch MCP", () => mcp("mcp__fetch__fetch", { url: "https://elsewhere.example/x" })],
  ["playwright MCP", () => mcp("mcp__playwright__browser_navigate", { url: "https://elsewhere.example/" })],
  ["postgres MCP, unclassifiable SQL", () => mcp("mcp__postgres__query", { sql: "CALL do_things()" })],
  ["filesystem MCP write to Scopebond's folder", () => mcp("mcp__filesystem__write_file", { path: "/repo/.scopebond/policy.json", content: "x" })],
  ["filesystem MCP read of a secret", () => mcp("mcp__filesystem__read_file", { path: "/repo/.env" })],
];

const outcome = (d) => ({ decision: d.decision, clauseId: d.clauseId ?? null, reason: d.reason });

test("a policy opts in when a clause names a type Taxonomy 1.1 introduced; db.exec alone does not opt in", () => {
  assert.ok(TARGET_OPT_IN_TYPES.includes("cloud.resource.delete"));
  assert.ok(!TARGET_OPT_IN_TYPES.includes("db.exec"), "db.exec was named by policies before 1.1");
  for (const t of ["git.push", "file.write", "file.read", "net.fetch", "deploy.release", "pr.open", "mcp.tool.call", "shell.exec"]) {
    assert.ok(!TARGET_OPT_IN_TYPES.includes(t), `${t} is a 1.0 type`);
  }
  for (const [name, { policy }] of Object.entries(LEGACY)) assert.equal(policyOptsIntoTargets(policy("key:abc")), false, `${name} does not opt in`);
  assert.equal(policyOptsIntoTargets(starterPolicy("key:abc", ENFORCE)), true, "the starter policy opts in");
  assert.equal(policyOptsIntoTargets(compile({ ...defaultRules(), ...ENFORCE }, "key:abc")), true, "a compiled rule set opts in");
  assert.equal(policyOptsIntoTargets(compileManaged(defaultRules(), managedDoc(WORKSPACE), "key:abc")), true, "a compiled workspace document opts in");
  const minimal = { clauses: [{ id: "x", type: "action_allowlist", mode: "monitor", action_types: ["secret.write"] }] };
  assert.equal(policyOptsIntoTargets(minimal), true, "one clause naming one 1.1 type is enough");
  assert.equal(policyOptsIntoTargets({ clauses: [{ id: "db", type: "action_allowlist", action_types: ["db.exec"] }] }), false);
});

test("under a policy that does not opt in, every call is decided exactly as it was without the derived actions", async () => {
  for (const [name, { policy, rules }] of Object.entries(LEGACY)) {
    const runtime = runtimeWith(policy, rules);
    try {
      for (const [label, call] of CALLS) {
        const mapped = call();
        assert.ok(mapped.some((m) => m.derived), `${label}: the call has derived actions`);
        const before = outcome(await runtime.evaluate(mapped.filter((m) => !m.derived)));
        const now = await runtime.evaluate(mapped);
        assert.deepEqual(outcome(now), before, `${name}: ${label}`);
        // The derived actions are still recorded.
        const derived = now.receipts.map((r) => r.payload).filter((p) => p.intent.params.derived_from !== undefined);
        if (now.decision !== "deny") assert.ok(derived.length > 0 && derived.every((p) => p.realtime_result === "not_evaluated"), `${name}: ${label} recorded, not decided`);
      }
    } finally { runtime.close(); }
  }
});

test("the same workspace, opted in, decides the derived push and fetch", async () => {
  const runtime = runtimeWith((kid) => compileManaged(defaultRules(), managedDoc(WORKSPACE), kid));
  try {
    const push = await runtime.evaluate(CALLS.find(([l]) => l === "GitHub MCP push to main")[1]());
    assert.equal(push.decision, "deny");
    assert.equal(push.clauseId, "protect-branches");
    assert.equal((await runtime.evaluate(CALLS.find(([l]) => l === "fetch MCP")[1]())).decision, "deny");
    // A read through gh api is not a fetch, so a list naming github.com does not stop it; a write to api.github.com is one.
    assert.equal((await runtime.evaluate(bash("gh api repos/o/r/pulls"))).decision, "allow");
    assert.equal((await runtime.evaluate(bash("gh api -X POST repos/o/r/issues -f title=x"))).decision, "deny");
  } finally { runtime.close(); }
});

test("a file written through the GitHub API is recorded, not decided by this computer's file rules", async () => {
  const rules = { ...defaultRules(), ...ENFORCE, allowed_roots: ["."] };
  const runtime = runtimeWith((kid) => compile(rules, kid), rules);
  try {
    const settings = mcp("mcp__github__create_or_update_file", { owner: "o", repo: "r", path: ".claude/settings.json", branch: "agent/fix", content: "x" });
    const write = settings.find((m) => m.intent.action_type === "file.write");
    assert.equal(write.evaluated, false);
    assert.equal(write.intent.params.repo, "o/r");
    assert.equal(write.intent.params.path, ".claude/settings.json", "the path as the call names it");
    assert.deepEqual(classifyIntent(write.intent, rules).ids, ["I04"], "not Scopebond's own settings: a file in another repository");
    const d1 = await runtime.evaluate(settings);
    assert.equal(d1.decision, "allow", d1.reason);
    const outside = await runtime.evaluate(mcp("mcp__github__create_or_update_file", { owner: "o", repo: "r", path: "/docs/x.md", branch: "agent/fix", content: "x" }));
    assert.equal(outside.decision, "allow", `the allowed folders are this computer's: ${outside.reason}`);
    const fileReceipt = outside.receipts.map((r) => r.payload).find((p) => p.intent.action_type === "file.write");
    assert.equal(fileReceipt.intent.params.root_scope, undefined, "no root scope for a remote file");
    // The push to a protected branch is still decided by the push rule.
    assert.equal((await runtime.evaluate(mcp("mcp__github__create_or_update_file", { owner: "o", repo: "r", path: "x.md", branch: "main", content: "x" }))).decision, "deny");
    // A filesystem server's file is on this computer, and is still protected.
    assert.equal((await runtime.evaluate(mcp("mcp__filesystem__write_file", { path: "/repo/.claude/settings.json", content: "x" }))).decision, "deny");
  } finally { runtime.close(); }
});

test("the derived actions of one call are bounded: beyond the cap, one per type with a count and a digest", () => {
  const files = Array.from({ length: 30 }, (_, i) => ({ path: `src/f${i}.ts`, content: "x" }));
  const mapped = mcp("mcp__github__push_files", { owner: "o", repo: "r", branch: "agent/fix", files });
  const derived = mapped.filter((m) => m.derived);
  assert.ok(derived.length <= DERIVED_CAP, `${derived.length} derived intents`);
  const folded = derived.find((m) => m.intent.action_type === "file.write");
  assert.equal(folded.intent.params.count, 30);
  assert.match(folded.intent.params.members_digest, /^hmac-sha256:[0-9a-f]{64}$/);
  assert.equal(folded.intent.params.repo, "o/r", "what every member shares is kept");
  assert.equal(folded.intent.params.path, undefined, "what they do not share is left out");
  assert.equal(derived.filter((m) => m.intent.action_type === "git.push").length, 1);

  const many = bash(Array.from({ length: 25 }, (_, i) => `kubectl delete pod p${i}`).join(" && "));
  const k8s = many.filter((m) => m.derived);
  assert.equal(k8s.length, 1);
  assert.equal(k8s[0].intent.params.count, 25);
  assert.equal(k8s[0].intent.params.risk_class, "destructive", "the shared risk class is kept, so the rule still applies");
  assert.equal(many.filter((m) => m.intent.action_type === "shell.exec").length, 25, "the commands themselves are all kept");

  // At the cap, nothing is folded.
  const twenty = bash(Array.from({ length: DERIVED_CAP }, (_, i) => `kubectl delete pod p${i}`).join(" && "));
  assert.equal(twenty.filter((m) => m.derived).length, DERIVED_CAP);
  assert.ok(twenty.every((m) => m.intent.params.count === undefined));

  // A file read on this computer is checked path by path, never folded.
  const reads = mcp("mcp__filesystem__read_multiple_files", { paths: Array.from({ length: 25 }, (_, i) => `/repo/r${i}.txt`) });
  assert.equal(reads.filter((m) => m.intent.action_type === "file.read").length, 25);
});

test("a folded deletion is still blocked by the rule that blocks each of its members", async () => {
  const runtime = runtimeWith((kid) => compile({ ...defaultRules(), enforce: ["cloud-destructive"] }, kid));
  try {
    const d = await runtime.evaluate(bash(Array.from({ length: 25 }, (_, i) => `kubectl delete pod p${i}`).join(" && ")));
    assert.equal(d.decision, "deny");
    assert.equal(d.clauseId, "cloud-destructive");
  } finally { runtime.close(); }
});
