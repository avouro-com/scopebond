// Rules as data: a level-2 pack rule carries its own title, whether it may block, what it does by default and a safer way;
// the workspace sets any pack rule's mode in `pack_rules`; a rule id this version does not know is skipped and reported, never a
// reason to refuse the document. Level-1 packs read exactly as before (the target rules' own tests). The pack here is made up and
// put in force directly (`setActivePacks`), as pack-store.ts does after verifying one.

import { ENFORCE } from "./enforce-all.mjs";
import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scaffold, createHookRuntime, mapClaudeToolUse, compile, compileManaged, defaultRules, digestRules, digestManaged, inspectManaged, policyBuilds,
  setActivePacks, packRuleClauses, switchablePackRules, withPackRules, packRuleAdjustments, packRuleSaferWay, blockTitle, ruleName, describeRules,
  managedSetting, packRulesOf, floorDocument, MANAGED_DOC_FILE, ruleSummary,
} from "../dist/index.js";

const temps = [];
after(() => { for (const d of temps) { try { rmSync(d, { recursive: true, force: true, maxRetries: 5 }); } catch { /* a handle still open on Windows */ } } });
afterEach(() => setActivePacks([]));
const temp = () => { const d = mkdtempSync(join(tmpdir(), "sb-rulesdata-")); temps.push(d); return d; };
const INSTALLATION = "gw-data-1";

const c = (v) => ({ const: v });
const VAULT_RULE = {
  id: "vault-put", type: "action_allowlist", mode: "monitor", action_types: ["secret.write"],
  param_bounds: { risk_class: { pattern: "^(?!sensitive$).+" } }, description: "Deny storing secrets in the demo vault.",
  title: "Put a secret in the demo vault", blockable: true, default_mode: "block", safer_way: "Ask the person to store the secret in the vault themselves.",
};
const pack = (rules = [VAULT_RULE], id = "demo-vault") => ({
  format: "scopebond:pack/v1", id, version: "1.0.0", issued_at: "2026-10-01T00:00:00Z", requires: { engine: 2 },
  signature: { alg: "Ed25519", key_id: "test-only", value: "A".repeat(86) + "==" },
  grammars: [{ id: "demovault", programs: ["demovault"], commands: [
    { path: ["put"], emit: [{ action_type: "secret.write", params: { store: c("demovault"), risk_class: c("sensitive") } }] },
  ] }],
  profiles: [], rules,
  vectors: [{ id: "put", shell: { command: "demovault put TOKEN" }, expect: [{ action_type: "secret.write", params: { store: "demovault", risk_class: "sensitive", via: "demovault", derived_from: "shell.exec" } }] }],
});
const bash = (command) => mapClaudeToolUse({ tool_name: "Bash", tool_input: { command }, cwd: "/repo" });
const base = () => ({
  "force-push-protected": { mode: "block" }, "push-protected": { mode: "block" }, "destructive-shell": { mode: "block" },
  "secret-read": { mode: "block" }, "ci-config-write": { mode: "block" }, "network-egress": { mode: "monitor" },
});
const doc = (rules, extra = {}) => ({
  type: "scopebond:managed-rules", version: 1, revision: 4, export_id: `rev-4-${INSTALLATION}`, environment_id: "env-1", agent_id: "agent-1", installation_id: INSTALLATION,
  rules, rules_digest: digestManaged(rules, undefined, extra.pack_rules), ...extra,
});

function runtimeFor({ managed, packs = [pack()], local } = {}) {
  const dir = temp();
  const { agentKid } = scaffold(dir, ENFORCE);
  if (local) writeFileSync(join(dir, "rules.json"), JSON.stringify({ ...defaultRules(), ...local }));
  if (managed) {
    writeFileSync(join(dir, MANAGED_DOC_FILE), JSON.stringify(managed));
    writeFileSync(join(dir, "policy.json"), JSON.stringify(compileManaged(defaultRules(), managed, agentKid)));
  } else writeFileSync(join(dir, "policy.json"), JSON.stringify(compile({ ...defaultRules(), ...ENFORCE, ...(local ?? {}) }, agentKid)));
  setActivePacks(packs);
  return { dir, runtime: createHookRuntime({ policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"), attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db"), cwd: "/repo" }) };
}

test("a level-2 rule that blocks by default blocks with no setting, under its own title, and says the safer way", async () => {
  const { runtime } = runtimeFor();
  try {
    const decision = await runtime.evaluate(bash("demovault put TOKEN"));
    assert.equal(decision.decision, "deny", decision.reason);
    assert.equal(decision.clauseId, "vault-put");
    assert.match(decision.reason, /\("Put a secret in the demo vault"\)/);
    const what = decision.reason.split("\n").find((l) => l.startsWith("What to do: "));
    assert.ok(what.endsWith(" A safer way: Ask the person to store the secret in the vault themselves."), what);
  } finally { runtime.close(); }
  setActivePacks([pack()]);
  assert.equal(blockTitle(null, "vault-put"), "Put a secret in the demo vault");
  assert.equal(ruleName("vault-put"), "Put a secret in the demo vault");
  assert.equal(packRuleSaferWay("vault-put"), "Ask the person to store the secret in the vault themselves.");
});

test("a pack rule's clause carries only what the policy language defines, and the policy still builds", () => {
  const [clause] = packRuleClauses(new Set(), [pack()]);
  assert.deepEqual(Object.keys(clause).sort(), ["action_types", "description", "id", "mode", "param_bounds", "type"]);
  assert.equal(clause.mode, "enforce");
  assert.equal(policyBuilds(withPackRules(compile(defaultRules(), "kid-1"), new Set(), [pack()])), true);
});

test("blockable decides whether a level-2 rule may block; a level-1 rule falls back to the target rules", () => {
  const notBlockable = { ...VAULT_RULE, blockable: false, default_mode: "monitor" };
  assert.equal(packRuleClauses(new Set(["vault-put"]), [pack([notBlockable])])[0].mode, "monitor", "enforced, but it may not block");
  assert.deepEqual(switchablePackRules([pack([notBlockable])]), []);
  assert.deepEqual(switchablePackRules([pack()]), ["vault-put"]);
  // Level 1: only a target rule may block, as before.
  const { title, blockable, default_mode, safer_way, ...level1 } = VAULT_RULE;
  void title; void blockable; void default_mode; void safer_way;
  assert.equal(packRuleClauses(new Set(["vault-put"]), [pack([level1])])[0].mode, "monitor");
  assert.equal(packRuleClauses(new Set(["production-deploy"]), [pack([{ ...level1, id: "production-deploy" }])])[0].mode, "enforce");
});

test("a pack in shadow records what its rules would block", async () => {
  setActivePacks([pack()], ["demo-vault"]);
  assert.equal(packRuleClauses(new Set(["vault-put"]))[0].mode, "monitor");
  setActivePacks([pack()]);
  assert.equal(packRuleClauses(new Set())[0].mode, "enforce");
});

test("a person's own choice on this computer wins over the rule's default", async () => {
  const { runtime, dir } = runtimeFor({ local: { local_overrides: { "vault-put": "monitor" } } });
  try {
    assert.equal((await runtime.evaluate(bash("demovault put TOKEN"))).decision, "allow");
  } finally { runtime.close(); }
  assert.match(describeRules({ ...defaultRules(), local_overrides: { "vault-put": "monitor" } }), /\[records\] vault-put\s+Put a secret in the demo vault/);
  assert.match(describeRules(defaultRules()), /\[blocks\] vault-put/);
  assert.equal(ruleSummary(dir, [pack()]).rules["vault-put"][0], "monitor");
});

test("the workspace sets a pack rule's mode in pack_rules: Monitor wins over the default, Block turns on a rule that records by default, Off allows", async () => {
  const recordsByDefault = { ...VAULT_RULE, default_mode: "monitor" };
  const modeOf = (packRules, rule = VAULT_RULE) => {
    const d = doc(base(), { pack_rules: packRules });
    return packRuleClauses(new Set(), [pack([rule])], packRuleAdjustments(d))[0];
  };
  assert.equal(modeOf({ "vault-put": { mode: "monitor" } }).mode, "monitor");
  assert.equal(modeOf({ "vault-put": { mode: "block" } }, recordsByDefault).mode, "enforce");
  assert.equal(modeOf({ "vault-put": { mode: "ask", override: { reason_min: 0, minutes: 0, daily_limit: 5, harness_prompt: false } } }, recordsByDefault).mode, "enforce");
  const off = modeOf({ "vault-put": { mode: "off" } });
  assert.equal(off.mode, "monitor");
  assert.equal(off.param_bounds, undefined, "Off: no bounds, nothing matches");
  // Exceptions on the fields the packs' actions carry.
  const excepted = modeOf({ "vault-put": { mode: "block", exceptions: [{ environments: ["staging"] }] } });
  assert.deepEqual(excepted.exceptions, [{ environment: { pattern: "^(?:staging)$" } }]);

  const d = doc(base(), { pack_rules: { "vault-put": { mode: "monitor" } } });
  const inspected = inspectManaged(d, { installationId: INSTALLATION, currentRevision: null });
  assert.equal(inspected.ok, true, inspected.message);
  const { runtime } = runtimeFor({ managed: d });
  try {
    assert.equal((await runtime.evaluate(bash("demovault put TOKEN"))).decision, "allow", "the workspace's Monitor wins over the default");
  } finally { runtime.close(); }
});

test("pack_rules is digested with the rules: a changed entry is refused like changed rules", () => {
  const d = doc(base(), { pack_rules: { "vault-put": { mode: "monitor" } } });
  assert.notEqual(d.rules_digest, digestRules(base()));
  assert.equal(digestManaged(base(), undefined, undefined), digestRules(base()), "without pack_rules the digest is as before");
  const changed = { ...d, pack_rules: { "vault-put": { mode: "off" } } };
  const refused = inspectManaged(changed, { installationId: INSTALLATION, currentRevision: null });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /digest/);
});

test("an unknown rule id or a malformed pack_rules entry is skipped and reported, never refusing the document", () => {
  const packRules = { "vault-put": { mode: "block" }, "bad-mode": { mode: "sometimes" }, "destructive-shell": { mode: "off" }, "x y": { mode: "block" },
    "terms-missing": { mode: "override" }, "bad-exceptions": { mode: "block", exceptions: [{ programs: ["rm"] }] } };
  const d = doc({ ...base(), "future-rule": { mode: "block", anything: 1 } }, { pack_rules: packRules });
  const inspected = inspectManaged(d, { installationId: INSTALLATION, currentRevision: null });
  assert.equal(inspected.ok, true, inspected.message);
  assert.deepEqual(inspected.skipped.sort(), ["bad-exceptions", "bad-mode", "destructive-shell", "future-rule", "terms-missing", "x y"].sort());
  assert.deepEqual(Object.keys(packRulesOf(d)), ["vault-put"]);
  assert.equal(managedSetting(d, "vault-put").mode, "block");
  assert.equal(managedSetting(d, "future-rule"), undefined, "an unknown rule in rules has no setting");
  assert.equal(managedSetting(d, "destructive-shell").mode, "block", "a rule of rules is read from rules");
  // A pack_rules member that is not an object is skipped whole.
  const whole = inspectManaged(doc(base(), { pack_rules: ["vault-put"] }), { installationId: INSTALLATION, currentRevision: null });
  assert.equal(whole.ok, true);
  assert.deepEqual(whole.skipped, ["pack_rules"]);
});

test("the floor document records a pack rule a person may allow", () => {
  const terms = { reason_min: 0, minutes: 0, daily_limit: 5, harness_prompt: false };
  const d = doc(base(), { pack_rules: { "vault-put": { mode: "override", override: terms }, other: { mode: "block" } } });
  const floor = floorDocument(d);
  assert.equal(floor.pack_rules["vault-put"].mode, "monitor");
  assert.equal(floor.pack_rules["vault-put"].override, undefined);
  assert.equal(floor.pack_rules.other.mode, "block");
});
