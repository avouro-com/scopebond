// A workspace may name exceptions for every rule that takes them, in Monitor as in Block: an excepted action matches no rule
// (it is routine, never a monitor match). Each kind is structured and bounded: programs and target folders for
// destructive-shell, environment names for production-deploy, Kubernetes contexts and Terraform workspaces for
// cloud-destructive, local database addresses for database-migrate, sites for network-egress. An exception never reaches
// further than its fields name, its folders are anchored, and the always-on rules take none.
import { ENFORCE } from "./enforce-all.mjs";
import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scaffold, createHookRuntime, mapClaudeToolUse, defaultRules, policyBuilds, inspectManaged, compileManaged, digestRules,
  setActivePacks, MANAGED_DOC_FILE, HOOK_CAPABILITIES,
} from "../dist/index.js";
import { TARGET_PACK_RULES } from "./target-pack.mjs";

const INSTALLATION = "gw-exc-1";
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
const check = (rules) => inspectManaged(doc(2, rules), { installationId: INSTALLATION, currentRevision: null });

// A made-up tool whose commands carry the facts the exceptions name (no real tool is described here).
const c = (value) => ({ const: value });
const flag = (...names) => ({ ident: { flag: names } });
const EXCEPTION_PACK = {
  format: "scopebond:pack/v1", id: "demo-exceptions", version: "1.0.0", issued_at: "2026-10-01T00:00:00Z",
  signature: { alg: "Ed25519", key_id: "test-only", value: "A".repeat(86) + "==" },
  grammars: [{
    id: "democloud", programs: ["democloud"],
    options: { valued: ["--context", "--workspace", "--env", "--db"], flags: ["--yes"] },
    skip: { options: ["--help"], words: ["help"] },
    commands: [
      { path: ["pod", "delete"], emit: [{ action_type: "k8s.delete", params: { kind: c("pod"), context: flag("--context"), risk_class: c("destructive") } }] },
      { path: ["stack", "destroy"], emit: [{ action_type: "cloud.resource.delete", params: { provider: c("unknown"), kind: c("stack"), workspace: flag("--workspace"), risk_class: c("destructive") } }] },
      { path: ["deploy"], emit: [{ action_type: "deploy.release", params: { provider: c("unknown"), environment: { first: [flag("--env"), c("unknown")] }, risk_class: c("destructive") } }] },
      { path: ["migrate", "reset"], emit: [{ action_type: "db.migrate", params: { provider: c("unknown"), direction: c("reset"), database: flag("--db"), risk_class: c("destructive") } }] },
    ],
  }],
  profiles: [],
  rules: TARGET_PACK_RULES,
  vectors: [],
};

const temps = [];
after(() => { for (const d of temps) { try { rmSync(d, { recursive: true, force: true, maxRetries: 5 }); } catch { /* a handle still open on Windows */ } } });
afterEach(() => setActivePacks([]));
function managedRuntime(d) {
  const dir = mkdtempSync(join(tmpdir(), "sb-exc-"));
  temps.push(dir);
  const { agentKid } = scaffold(dir, ENFORCE);
  writeFileSync(join(dir, MANAGED_DOC_FILE), JSON.stringify(d));
  const policy = compileManaged(defaultRules(), d, agentKid);
  assert.ok(policyBuilds(policy));
  writeFileSync(join(dir, "policy.json"), JSON.stringify(policy));
  setActivePacks([EXCEPTION_PACK]);
  return createHookRuntime({ policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"), attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db"), cwd: "/repo/app" });
}
// Mapped when judged, once the made-up pack is in force.
const call = (tool_name, tool_input) => () => mapClaudeToolUse({ tool_name, tool_input, cwd: "/repo/app" });
const bash = (command) => call("Bash", { command });
/** "routine" (allowed, no rule matched), "match" (a monitored rule matched; allowed) or "deny". */
async function judged(runtime, mapped) {
  const d = await runtime.evaluate(mapped());
  if (d.decision === "deny") return "deny";
  return (d.receipts ?? []).some((r) => r.payload?.clause_id) ? "match" : "routine";
}
/** The same commands judged with the rule on Monitor and on Block: [monitor results, block results]. */
async function bothModes(rule, settings, tools, extra = {}) {
  const out = [];
  for (const mode of ["monitor", "block"]) {
    const runtime = managedRuntime(doc(3, { [rule]: { mode, ...settings }, ...extra }));
    try {
      const row = [];
      for (const t of tools) row.push(await judged(runtime, t));
      out.push(row);
    } finally { runtime.close(); }
  }
  return out;
}

test("the hook reports that it takes exceptions for every rule", () => {
  assert.ok(HOOK_CAPABILITIES.includes("exceptions_any_rule"));
});

test("each rule takes its own kind of exception, checked like any other setting", () => {
  const ok = (rule, exceptions) => assert.equal(check({ [rule]: { mode: "monitor", exceptions } }).ok, true, `${rule} ${JSON.stringify(exceptions)}: ${check({ [rule]: { mode: "monitor", exceptions } }).message}`);
  const refused = (rule, exceptions, why) => assert.equal(check({ [rule]: { mode: "monitor", exceptions } }).ok, false, why);
  ok("destructive-shell", [{ programs: ["rm", "remove-item"], targets: ["~/scratch/**", "C:/builds/*/out"] }]);
  ok("destructive-shell", [{ programs: ["shred"] }]);
  ok("production-deploy", [{ environments: ["preview", "unknown"] }]);
  ok("cloud-destructive", [{ kube_contexts: ["kind-*", "minikube", "docker-desktop"] }, { terraform_workspaces: ["dev-*"] }]);
  ok("database-migrate", [{ database_urls: ["postgres://localhost:5432/app_dev", "mysql://127.0.0.1/test"] }]);
  ok("network-egress", [{ hosts: ["api.example.com", "*.internal.example"] }]);
  refused("destructive-shell", [{ programs: ["rm"] }], "a delete names the folders it may reach");
  refused("destructive-shell", [{ programs: ["rm"], targets: ["~/**"] }], "never the whole home folder");
  refused("destructive-shell", [{ programs: ["rm"], targets: ["/**"] }], "never the whole disk");
  refused("destructive-shell", [{ programs: ["rm"], targets: ["C:/*"] }], "never a drive's top folders");
  refused("destructive-shell", [{ programs: ["rm"], targets: ["build/**"] }], "inside the working folder needs no exception");
  refused("destructive-shell", [{ programs: ["rm"], targets: ["~/a/../.ssh/**"] }], "no climbing out");
  refused("destructive-shell", [{ programs: ["rm"], targets: ["~/.ssh/**"] }], "no protected place");
  refused("destructive-shell", [{ programs: ["rm"], targets: ["~/**/x"] }], "** only at the end");
  refused("destructive-shell", [{ programs: ["rm -rf"], targets: ["~/x/**"] }], "a program is a name");
  refused("destructive-shell", [{ programs: [] }], "an exception names something");
  refused("cloud-destructive", [{ kube_contexts: ["*"] }], "a context pattern has a name in it");
  refused("cloud-destructive", [{}], "an exception names something");
  refused("database-migrate", [{ database_urls: ["postgres://db.prod.example.com/app"] }], "only a database on this computer");
  refused("database-migrate", [{ database_urls: ["postgres://admin:pw@localhost/app"] }], "no credentials in an exception");
  refused("network-egress", [{ hosts: ["*"] }], "a site is a host name");
  refused("production-deploy", [{ environments: ["prod*"] }], "an environment is named exactly");
  refused("secret-write", [{ environments: ["dev"] }], "a rule without an exception kind takes none");
  refused("destructive-shell", [{ hosts: ["a.example.com"] }], "each rule takes only its own kind");
  refused("destructive-shell", Array.from({ length: 51 }, () => ({ programs: ["shred"] })), "at most 50");
  assert.equal(check({ "guardrail-config-write": { mode: "block", exceptions: [{ programs: ["rm"] }] } }).ok, false, "the always-on rules take none");
});

test("destructive-shell: a delete of the named folders is routine in Monitor and in Block; anything else is not", async () => {
  const exceptions = [{ programs: ["rm", "remove-item"], targets: ["~/scratch/**", "/srv/cache/*"] }, { programs: ["shred"] }];
  const [monitor, block] = await bothModes("destructive-shell", { exceptions }, [
    bash("rm -rf ~/scratch/build"), bash("rm -rf /srv/cache/a /srv/cache/b"), bash("rm -rf dist ~/scratch/x"), bash("shred notes.txt"),
    bash("rm -rf ~/scratch"), bash("rm -rf ~/scratch/x ~/other"), bash("rm -rf /srv/cache/a/b"), bash("rm -rf ~/scratch/$X"),
    bash("rm -rf ~/scratch/../.ssh"), bash("rmdir ~/scratch/x"), bash("$X ~/scratch/x"),
  ]);
  assert.deepEqual(monitor, ["routine", "routine", "routine", "routine", "match", "match", "match", "match", "match", "match", "match"]);
  assert.deepEqual(block, ["routine", "routine", "routine", "routine", "deny", "deny", "deny", "deny", "deny", "deny", "deny"]);
});

test("production-deploy: the named environments are routine in Monitor and in Block", async () => {
  const [monitor, block] = await bothModes("production-deploy", { exceptions: [{ environments: ["unknown", "preview"] }] },
    [bash("democloud deploy"), bash("democloud deploy --env preview"), bash("democloud deploy --env production")]);
  assert.deepEqual(monitor, ["routine", "routine", "match"]);
  assert.deepEqual(block, ["routine", "routine", "deny"]);
});

test("cloud-destructive: the named Kubernetes contexts and Terraform workspaces are routine; others and unnamed ones are not", async () => {
  const exceptions = [{ kube_contexts: ["kind-*", "minikube"] }, { terraform_workspaces: ["dev"] }];
  const tools = [bash("democloud pod delete --context kind-test"), bash("democloud pod delete --context minikube"), bash("democloud stack destroy --workspace dev"),
    bash("democloud pod delete --context prod-cluster"), bash("democloud pod delete"), bash("democloud stack destroy --workspace dev2"), bash("democloud pod delete --context xkind-test")];
  const [monitor, block] = await bothModes("cloud-destructive", { exceptions }, tools);
  assert.deepEqual(monitor, ["routine", "routine", "routine", "match", "match", "match", "match"]);
  assert.deepEqual(block, ["routine", "routine", "routine", "deny", "deny", "deny", "deny"]);
});

test("database-migrate: a reset of a named database on this computer is routine; any other is not", async () => {
  const [monitor, block] = await bothModes("database-migrate", { exceptions: [{ database_urls: ["postgres://localhost:5432/app_dev"] }] },
    [bash("democloud migrate reset --db postgres://localhost:5432/app_dev"), bash("democloud migrate reset --db postgres://localhost:5432/app"), bash("democloud migrate reset")]);
  assert.deepEqual(monitor, ["routine", "match", "match"]);
  assert.deepEqual(block, ["routine", "deny", "deny"]);
});

test("network-egress: an excepted site joins the allowed sites when the rule blocks", async () => {
  const runtime = managedRuntime(doc(4, { "network-egress": { mode: "block", allowed_hosts: ["api.github.com"], exceptions: [{ hosts: ["docs.example.com"] }] } }));
  try {
    const fetch = (url) => call("WebFetch", { url, prompt: "x" });
    assert.deepEqual([await judged(runtime, fetch("https://docs.example.com/a")), await judged(runtime, fetch("https://api.github.com/x")), await judged(runtime, fetch("https://evil.example.com/"))],
      ["routine", "routine", "deny"]);
  } finally { runtime.close(); }
});

test("the existing path and branch exclusions apply in Monitor as in Block", async () => {
  const read = (p) => call("Read", { file_path: p });
  const [monitor, block] = await bothModes("secret-read", { excluded_paths: ["test/fixtures/.env"] }, [read("/repo/app/test/fixtures/.env"), read("/repo/app/.env")]);
  assert.deepEqual(monitor, ["routine", "match"]);
  assert.deepEqual(block, ["routine", "deny"]);
  const [pushMonitor, pushBlock] = await bothModes("push-protected", { excluded_branches: ["release/repair"] }, [bash("git push origin release/repair"), bash("git push origin main")],
    { "force-push-protected": { mode: "monitor" } });
  assert.deepEqual(pushMonitor, ["routine", "match"]);
  assert.deepEqual(pushBlock, ["routine", "deny"]);
});
