// Warn mode: a rule the workspace set to "Block, user may override" stops the action until a person allows it in the Scopebond
// Agent's window (with a reason, signed into the receipt as a digest), or, where the workspace allows it and Claude Code really
// asks, Claude Code's own prompt is offered. Scopebond's own protection and other Block rules are never overridable, the
// daily limit holds, and a repeat inside the allowed time is recorded as a repeat.
import { ENFORCE } from "./enforce-all.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scaffold, createHookRuntime, mapClaudeToolUse, inspectManaged, compileManaged, digestRules, defaultRules,
  createOverrideHandler, overrideHint, overrideRemedy, digestOf, MANAGED_DOC_FILE, HOOK_CAPABILITIES,
} from "../dist/index.js";
import { actionSummary, askAgent, revealHidden } from "../dist/override.js";

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

async function run(dir, toolUse, { answers = [], permissionMode = "default", now, project } = {}) {
  const asked = [];
  const runtime = createHookRuntime({
    policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"), attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db"), cwd: "/repo",
    override: (agentKid) => {
      const made = createOverrideHandler({ dir, home: dir, agentKid, harness: "claude", permissionMode, now, waitMs: 50, ...(project ? { project } : {}),
        ask: async (_home, request) => { asked.push(request); return answers.shift() ?? { decision: "unavailable" }; } });
      return made ? { handler: made.handler, hint: () => overrideHint(made.note()), remedy: () => overrideRemedy(made.note()) } : null;
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
  // "unlimited" for either length or daily count (unlimited_terms); any other value still refuses the terms.
  assert.equal(at({ "destructive-shell": { mode: "override", override: terms({ minutes: "unlimited" }) } }).ok, true);
  assert.equal(at({ "destructive-shell": { mode: "override", override: terms({ daily_limit: "unlimited" }) } }).ok, true);
  assert.equal(at({ "destructive-shell": { mode: "override", override: terms({ minutes: "unlimited", daily_limit: "unlimited" }) } }).ok, true);
  for (const bad of ["forever", -1, 61, 1.5, "Unlimited", "60", null, true]) {
    assert.equal(at({ "destructive-shell": { mode: "override", override: terms({ minutes: bad }) } }).ok, false, `minutes ${String(bad)}`);
  }
  for (const bad of ["forever", -1, 0, 51, 2.5, "unlimited ", "50", null, false]) {
    assert.equal(at({ "destructive-shell": { mode: "override", override: terms({ daily_limit: bad }) } }).ok, false, `daily_limit ${String(bad)}`);
  }
  assert.equal(at({ "destructive-shell": { mode: "override", override: terms({ reason_min: "unlimited" }) } }).ok, false, "only minutes and daily_limit");
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
    assert.equal(allowed.asked[0].summary, "rm -rf build (in /repo)", "the command, and the folder its relative target is in");
    assert.equal(allowed.asked[0].title, "Run a command that deletes data or shuts down the computer", "the workspace's name for the rule");
    assert.equal(allowed.asked[0].harness, "claude");
    assert.equal(allowed.asked[0].project, undefined, "no project when the hook cannot read one");
    assert.deepEqual({ ...allowed.override, decided_at: "x" }, {
      version: 1, rule: "destructive-shell", method: "agent_dialog", state: "allowed", repeat_of: null,
      reason_digest: digestOf(reason), reason_length: reason.length, os_user_digest: digestOf("dev"), decided_at: "x",
    });
    // A reason shorter than the workspace accepts is no override.
    const short = await run(dir, bash("rm -rf dist"), { answers: [{ decision: "allow", reason: "because" }] });
    assert.equal(short.decision, "deny");
    assert.match(short.reason, /not given/);
    // The person says no.
    const declined = await run(dir, bash("rm -rf dist"), { answers: [{ decision: "deny" }], project: () => "checkout" });
    assert.equal(declined.decision, "deny");
    assert.equal(declined.asked[0].project, "checkout", "the window and the tray name the project");
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

test("with no time limit, an allowed action stays allowed from then on: after an hour and after the two days the hook keeps", async () => {
  let clock = Date.parse("2026-10-05T10:00:00Z");
  const now = () => clock;
  const { dir } = setup({ "destructive-shell": { mode: "override", override: terms({ minutes: "unlimited" }) } });
  try {
    const reason = "Cleaning the build output before release";
    const first = await run(dir, bash("rm -rf build"), { answers: [{ decision: "allow", reason }], now });
    assert.equal(first.decision, "allow");
    assert.equal(first.asked[0].lasts, "the same action from now on", "the window says how long it lasts");
    const firstId = first.receipts[0].payload.action_ref.action_id;
    clock += 61 * 60_000;
    const later = await run(dir, bash("rm -rf build"), { now });
    assert.equal(later.decision, "allow", "beyond any numbered window");
    assert.equal(later.asked.length, 0);
    assert.equal(later.override.repeat_of, firstId);
    assert.equal(later.override.reason_digest, digestOf(reason));
    const other = await run(dir, bash("rm -rf dist"), { now });
    assert.equal(other.decision, "deny", "another action still asks");
    // Three days on, another unblock rewrites the hook's state; the earlier unblock is kept and still applies.
    clock += 3 * 24 * 60 * 60_000;
    assert.equal((await run(dir, bash("rm -rf dist"), { answers: [{ decision: "allow", reason }], now })).decision, "allow");
    const kept = JSON.parse(readFileSync(join(dir, "overrides.json"), "utf8")).entries;
    assert.ok(kept.some((e) => e.action_id === firstId && e.lasting === true));
    const days = await run(dir, bash("rm -rf build"), { now });
    assert.equal(days.decision, "allow");
    assert.equal(days.asked.length, 0);
    assert.equal(days.override.repeat_of, firstId);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("with a numbered time window, the same action asks again once it has passed", async () => {
  let clock = Date.parse("2026-10-05T10:00:00Z");
  const now = () => clock;
  const { dir } = setup({ "destructive-shell": { mode: "override", override: terms({ minutes: 60 }) } });
  try {
    const reason = "Cleaning the build output before release";
    const first = await run(dir, bash("rm -rf build"), { answers: [{ decision: "allow", reason }], now });
    assert.equal(first.asked[0].lasts, "the same action for 60 minutes");
    clock += 61 * 60_000;
    const later = await run(dir, bash("rm -rf build"), { now });
    assert.equal(later.decision, "deny");
    assert.equal(later.asked.length, 1, "asked again");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("with no daily limit, a person may allow more than 50 in a day; the highest numbered limit still stops at 50", async () => {
  const clock = Date.parse("2026-10-05T18:00:00Z");
  const now = () => clock;
  const reason = "Cleaning the build output before release";
  // Sixty unblocks of this rule earlier today, each of a different action.
  const today = Array.from({ length: 60 }, (_, i) => ({ rule: "destructive-shell", action_key: digestOf(`earlier-${i}`), action_id: `earlier-${i}`,
    at: clock - (i + 1) * 60_000, reason_digest: digestOf(reason), reason_length: reason.length }));
  const unlimited = setup({ "destructive-shell": { mode: "override", override: terms({ daily_limit: "unlimited" }) } });
  const fifty = setup({ "destructive-shell": { mode: "override", override: terms({ daily_limit: 50 }) } });
  try {
    for (const { dir } of [unlimited, fifty]) writeFileSync(join(dir, "overrides.json"), JSON.stringify({ entries: today }));
    const more = await run(unlimited.dir, bash("rm -rf build"), { answers: [{ decision: "allow", reason }], now });
    assert.equal(more.decision, "allow");
    assert.equal(more.asked.length, 1);
    const kept = JSON.parse(readFileSync(join(unlimited.dir, "overrides.json"), "utf8")).entries;
    assert.equal(kept.length, 61, "the 61st of the day is counted");
    const stopped = await run(fifty.dir, bash("rm -rf build"), { answers: [{ decision: "allow", reason }], now });
    assert.equal(stopped.decision, "deny");
    assert.equal(stopped.asked.length, 0);
    assert.match(stopped.reason, /today's overrides/);
  } finally { for (const s of [unlimited, fifty]) rmSync(s.dir, { recursive: true, force: true }); }
});

test("the hook tells the workspace it reads unlimited terms", () => {
  assert.ok(HOOK_CAPABILITIES.includes("unlimited_terms"));
  assert.ok(HOOK_CAPABILITIES.includes("unblock_terms"));
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

test("no tray and no window: the denial's line for the person says where to allow it or ask, with the record, and asks no one twice", async () => {
  const allow = setup({ "destructive-shell": { mode: "override", override: terms() } });
  const ask = setup({ "destructive-shell": { mode: "ask", override: terms({ requests: true }) } });
  try {
    const link = "https://app.scopebond.example/computers/c-1";
    const later = await run(allow.dir, bash("rm -rf build"), { answers: [{ decision: "unavailable", later: true, link }] });
    assert.equal(later.decision, "deny");
    assert.equal(later.asked.length, 1, "the agent was asked once");
    const person = later.reason.split("\n").find((l) => l.startsWith("For the person: "));
    assert.match(person, /allow it with a reason from the Scopebond icon in the notification area \(its recent blocks: choose the record below\)/);
    assert.ok(person.includes(link), "the computer's page in the workspace, when the agent knows it");
    assert.match(later.reason, /\nRecord: \S+/, "the record the person picks");
    assert.doesNotMatch(later.reason, /not running/);
    const asking = await run(ask.dir, bash("rm -rf build"), { answers: [{ decision: "unavailable", later: true }] });
    const askLine = asking.reason.split("\n").find((l) => l.startsWith("For the person: "));
    assert.match(askLine, /ask an admin to unblock it from the Scopebond icon in the notification area \(its recent blocks: choose the record below\)/);
    assert.doesNotMatch(askLine, /https:/, "no link the agent did not give");
    // An agent that is not running: as before, the denial says to start it, and the line for the person is the workspace's.
    const down = await run(allow.dir, bash("rm -rf build"), { answers: [{ decision: "unavailable" }] });
    assert.match(down.reason, /Scopebond Agent is not running/);
    assert.doesNotMatch(down.reason, /recent blocks/);
  } finally { for (const s of [allow, ask]) rmSync(s.dir, { recursive: true, force: true }); }
});

test("the agent's 'nobody to ask now' answer reaches the hook, with an https link only", async () => {
  const home = mkdtempSync(join(tmpdir(), "scopebond-ask-later-"));
  try {
    writeFileSync(join(home, "agent.json"), JSON.stringify({ port: 4999, token: "t" }));
    const reply = (body) => async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    assert.deepEqual(await askAgent(home, {}, 1_000, reply({ decision: "unavailable", later: true, link: "https://app.example/c/1" })), { decision: "unavailable", later: true, link: "https://app.example/c/1" });
    assert.deepEqual(await askAgent(home, {}, 1_000, reply({ decision: "unavailable", later: true, link: "javascript:alert(1)" })), { decision: "unavailable", later: true });
    assert.deepEqual(await askAgent(home, {}, 1_000, reply({ decision: "unavailable" })), { decision: "unavailable" });
    assert.deepEqual(await askAgent(home, {}, 1_000, reply({ decision: "deny", later: true })), { decision: "deny" });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("the one-line summary writes out control, bidi and zero-width characters, so it reads as what runs", () => {
  const rlo = String.fromCharCode(0x202e), zwsp = String.fromCharCode(0x200b);
  const summary = actionSummary({ action_type: "shell.exec", params: { command: `rm -rf ~/${rlo}txt.sgol${zwsp}` } });
  assert.equal(summary, "rm -rf ~/⟨U+202E⟩txt.sgol⟨U+200B⟩");
  assert.equal(summary.includes(rlo), false);
  assert.equal(revealHidden("git push origin main"), "git push origin main");
  assert.equal(actionSummary({ action_type: "repo.write", params: { path: `src/${String.fromCharCode(0x2066)}a.ts` } }), "src/⟨U+2066⟩a.ts");
});
