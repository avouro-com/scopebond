// Warn mode: a rule the workspace set to "Block, user may override" stops the action until a person allows it in the Scopebond
// Agent's window (with a reason, signed into the receipt as a digest), or, where the workspace allows it and Claude Code really
// asks, Claude Code's own prompt is offered. Scopebond's own protection and other Block rules are never overridable, the
// daily limit holds, and a repeat inside the allowed time is recorded as a repeat.
import { ENFORCE } from "./enforce-all.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scaffold, createHookRuntime, mapClaudeToolUse, inspectManaged, compileManaged, digestRules, defaultRules,
  createOverrideHandler, overrideHint, digestOf, MANAGED_DOC_FILE,
} from "../dist/index.js";
import { actionSummary, revealHidden } from "../dist/override.js";

const INSTALLATION = "gw-test-1";
const terms = (extra = {}) => ({ reason_min: 10, minutes: 0, daily_limit: 5, harness_prompt: false, ...extra });
const defaults = () => ({
  "force-push-protected": { mode: "block" }, "push-protected": { mode: "block" }, "destructive-shell": { mode: "block" },
  "secret-read": { mode: "block" }, "ci-config-write": { mode: "block" }, "network-egress": { mode: "monitor" },
});
function doc(revision, overrides = {}) {
  const rules = { ...defaults(), ...overrides };
  return {
    type: "scopebond:managed-rules", version: 1, revision, export_id: `rev-${revision}-${INSTALLATION}`, environment_id: "env-1",
    agent_id: "agent-1", installation_id: INSTALLATION, rules_catalog_version: "coding-pack/3", rules, rules_digest: digestRules(rules),
  };
}
const bash = (command) => ({ tool_name: "Bash", tool_input: { command } });
const write = (file_path) => ({ tool_name: "Write", tool_input: { file_path, content: "x" } });

function setup(rules) {
  const dir = mkdtempSync(join(tmpdir(), "scopebond-override-"));
  const { agentKid } = scaffold(dir, ENFORCE);
  const d = doc(2, rules);
  writeFileSync(join(dir, MANAGED_DOC_FILE), JSON.stringify(d));
  writeFileSync(join(dir, "policy.json"), JSON.stringify(compileManaged(defaultRules(), d, agentKid)));
  return { dir, agentKid };
}

async function run(dir, toolUse, { answers = [], permissionMode = "default", now } = {}) {
  const asked = [];
  const runtime = createHookRuntime({
    policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"), attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db"), cwd: "/repo",
    override: (agentKid) => {
      const made = createOverrideHandler({ dir, home: dir, agentKid, harness: "claude", permissionMode, now, waitMs: 50,
        ask: async (_home, request) => { asked.push(request); return answers.shift() ?? { decision: "unavailable" }; } });
      return made ? { handler: made.handler, hint: () => overrideHint(made.note()) } : null;
    },
  });
  try {
    const d = await runtime.evaluate(mapClaudeToolUse({ cwd: "/repo", ...toolUse }));
    return { ...d, asked, override: d.receipts?.map((r) => r.payload.override).find(Boolean) ?? null };
  } finally { runtime.close(); }
}

test("the workspace may send mode override only with valid terms", () => {
  const at = (rules) => inspectManaged(doc(3, rules), { installationId: INSTALLATION, currentRevision: 2 });
  assert.equal(at({ "destructive-shell": { mode: "override", override: terms() } }).ok, true);
  assert.equal(at({ "destructive-shell": { mode: "override" } }).ok, false, "terms are required");
  assert.equal(at({ "destructive-shell": { mode: "block", override: terms() } }).ok, false, "terms only with override");
  assert.equal(at({ "destructive-shell": { mode: "override", override: terms({ daily_limit: 0 }) } }).ok, false);
  assert.equal(at({ "destructive-shell": { mode: "override", override: { ...terms(), extra: 1 } } }).ok, false);
  assert.equal(at({ "network-egress": { mode: "override", override: terms() } }).ok, false, "an allowlist needs sites, as for Block");
});

test("a person allows one action in the Scopebond window: approved, with the reason's digest, and the reason is checked", async () => {
  const { dir } = setup({ "destructive-shell": { mode: "override", override: terms() } });
  try {
    const reason = "Cleaning the build output before release";
    const allowed = await run(dir, bash("rm -rf build"), { answers: [{ decision: "allow", reason, os_user: "dev" }] });
    assert.equal(allowed.decision, "allow");
    assert.equal(allowed.asked.length, 1);
    assert.equal(allowed.asked[0].rule, "destructive-shell");
    assert.equal(allowed.asked[0].summary, "rm -rf build");
    assert.deepEqual({ ...allowed.override, decided_at: "x" }, {
      version: 1, rule: "destructive-shell", method: "agent_dialog", state: "allowed", repeat_of: null,
      reason_digest: digestOf(reason), reason_length: reason.length, os_user_digest: digestOf("dev"), decided_at: "x",
    });
    // A reason shorter than the workspace accepts is no override.
    const short = await run(dir, bash("rm -rf dist"), { answers: [{ decision: "allow", reason: "because" }] });
    assert.equal(short.decision, "deny");
    assert.match(short.reason, /not given/);
    // The person says no.
    const declined = await run(dir, bash("rm -rf dist"), { answers: [{ decision: "deny" }] });
    assert.equal(declined.decision, "deny");
    // Other commands are untouched: an ordinary one never asks.
    const ordinary = await run(dir, bash("npm test"));
    assert.equal(ordinary.decision, "allow");
    assert.equal(ordinary.asked.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Scopebond's own protection and other Block rules are never overridable", async () => {
  const { dir } = setup({ "ci-config-write": { mode: "override", override: terms() }, "destructive-shell": { mode: "block" } });
  try {
    const ci = await run(dir, write("/repo/.github/workflows/ci.yml"), { answers: [{ decision: "allow", reason: "Updating the release workflow" }] });
    assert.equal(ci.decision, "allow", "a CI file is overridable");
    const own = await run(dir, write("/repo/.scopebond/policy.json"), { answers: [{ decision: "allow", reason: "Updating the release workflow" }] });
    assert.equal(own.decision, "deny");
    assert.equal(own.asked.length, 0, "never asked");
    const hooks = await run(dir, write("/repo/.claude/settings.json"), { answers: [{ decision: "allow", reason: "Updating the release workflow" }] });
    assert.equal(hooks.decision, "deny");
    assert.equal(hooks.asked.length, 0);
    const blocked = await run(dir, bash("rm -rf build"), { answers: [{ decision: "allow", reason: "Updating the release workflow" }] });
    assert.equal(blocked.decision, "deny");
    assert.equal(blocked.asked.length, 0, "a rule on Block is not offered");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the daily limit holds, and a repeat inside the allowed time is recorded as a repeat without asking", async () => {
  let clock = Date.parse("2026-10-05T10:00:00Z");
  const now = () => clock;
  const { dir } = setup({ "destructive-shell": { mode: "override", override: terms({ daily_limit: 1, minutes: 15 }) } });
  try {
    const reason = "Cleaning the build output before release";
    const first = await run(dir, bash("rm -rf build"), { answers: [{ decision: "allow", reason }], now });
    assert.equal(first.decision, "allow");
    clock += 5 * 60_000;
    const again = await run(dir, bash("rm -rf build"), { now });
    assert.equal(again.decision, "allow");
    assert.equal(again.asked.length, 0);
    assert.equal(again.override.repeat_of, first.override && first.receipts[0].payload.action_ref.action_id);
    assert.equal(again.override.reason_digest, digestOf(reason));
    const other = await run(dir, bash("rm -rf dist"), { answers: [{ decision: "allow", reason }], now });
    assert.equal(other.decision, "deny", "beyond today's limit of one");
    assert.equal(other.asked.length, 0);
    assert.match(other.reason, /today's overrides/);
    clock += 24 * 60 * 60_000;
    const tomorrow = await run(dir, bash("rm -rf dist"), { answers: [{ decision: "allow", reason }], now });
    assert.equal(tomorrow.decision, "allow");
    assert.ok(existsSync(join(dir, "overrides.json")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("without the window, Claude Code's prompt is offered only where allowed and where it really asks; otherwise it blocks and says how", async () => {
  const off = setup({ "destructive-shell": { mode: "override", override: terms() } });
  const on = setup({ "destructive-shell": { mode: "override", override: terms({ harness_prompt: true }) } });
  try {
    const noAgent = await run(off.dir, bash("rm -rf build"));
    assert.equal(noAgent.decision, "deny");
    assert.match(noAgent.reason, /Scopebond Agent is not running/);
    const asked = await run(on.dir, bash("rm -rf build"), { permissionMode: "default" });
    assert.equal(asked.decision, "ask");
    assert.deepEqual({ ...asked.override, decided_at: "x", os_user_digest: null }, {
      version: 1, rule: "destructive-shell", method: "harness_prompt", state: "offered", repeat_of: null,
      reason_digest: null, reason_length: null, os_user_digest: null, decided_at: "x",
    });
    for (const mode of ["bypassPermissions", "dontAsk", "auto", null]) {
      const auto = await run(on.dir, bash("rm -rf build"), { permissionMode: mode });
      assert.equal(auto.decision, "deny", `permission mode ${mode}`);
    }
  } finally { for (const s of [off, on]) rmSync(s.dir, { recursive: true, force: true }); }
});

test("the one-line summary writes out control, bidi and zero-width characters, so it reads as what runs", () => {
  const rlo = String.fromCharCode(0x202e), zwsp = String.fromCharCode(0x200b);
  const summary = actionSummary({ action_type: "shell.exec", params: { command: `rm -rf ~/${rlo}txt.sgol${zwsp}` } });
  assert.equal(summary, "rm -rf ~/⟨U+202E⟩txt.sgol⟨U+200B⟩");
  assert.equal(summary.includes(rlo), false);
  assert.equal(revealHidden("git push origin main"), "git push origin main");
  assert.equal(actionSummary({ action_type: "repo.write", params: { path: `src/${String.fromCharCode(0x2066)}a.ts` } }), "src/⟨U+2066⟩a.ts");
});
