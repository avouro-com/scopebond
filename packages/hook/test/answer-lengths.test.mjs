// Answer lengths: a workspace may name the lengths a person's unblock may last (`lengths` on a rule's override terms): Once,
// 1 hour, Until tomorrow (24 hours) and 30 days. A hook reports the `answer_lengths` capability so the workspace knows it may
// send them. Without `lengths` the terms read as before: once, 15 minutes, and "always" for `always_days`.
import { ENFORCE } from "./enforce-all.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import {
  scaffold, createHookRuntime, mapClaudeToolUse, inspectManaged, compileManaged, digestRules, defaultRules, HOOK_CAPABILITIES,
  createOverrideHandler, overrideHint, MANAGED_DOC_FILE, makeAllowance, readAllowances, readBlocked, blockedQuestion, actOnBlocked, offersFor, askAgent,
} from "../dist/index.js";

const ME = userInfo().username;
const INSTALLATION = "gw-lengths-1";
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const REASON = "Cleaning the build output before release";
const terms = (extra = {}) => ({ reason_min: 10, minutes: 0, daily_limit: 5, harness_prompt: false, always: "at_once", requests: true, ...extra });
const defaults = () => ({
  "force-push-protected": { mode: "block" }, "push-protected": { mode: "block" }, "destructive-shell": { mode: "block" },
  "secret-read": { mode: "block" }, "ci-config-write": { mode: "block" }, "network-egress": { mode: "monitor" },
});
function doc(revision, overrides = {}) {
  const rules = { ...defaults(), ...overrides };
  return { type: "scopebond:managed-rules", version: 1, revision, export_id: `rev-${revision}-${INSTALLATION}`, environment_id: "env-1",
    agent_id: "agent-1", installation_id: INSTALLATION, rules, rules_digest: digestRules(rules) };
}
const bash = (command) => ({ tool_name: "Bash", tool_input: { command } });

function setup(rules) {
  const dir = mkdtempSync(join(tmpdir(), "scopebond-lengths-"));
  const { agentKid } = scaffold(dir, ENFORCE);
  const d = doc(2, rules);
  writeFileSync(join(dir, MANAGED_DOC_FILE), JSON.stringify(d));
  writeFileSync(join(dir, "policy.json"), JSON.stringify(compileManaged(defaultRules(), d, agentKid)));
  return dir;
}

async function run(dir, toolUse, { answers = [] } = {}) {
  const asked = [];
  const runtime = createHookRuntime({
    policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"), attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db"), cwd: "/repo",
    override: (agentKid) => {
      const made = createOverrideHandler({ dir, home: dir, agentKid, harness: "claude", permissionMode: "default", waitMs: 50,
        ask: async (_home, request) => { asked.push(request); return answers.shift() ?? { decision: "unavailable" }; } });
      return made ? { handler: made.handler, hint: () => overrideHint(made.note()) } : null;
    },
  });
  try {
    const d = await runtime.evaluate(mapClaudeToolUse({ cwd: "/repo", ...toolUse }));
    return { ...d, asked, override: d.receipts?.map((r) => r.payload.override).find(Boolean) ?? null };
  } finally { runtime.close(); }
}

const lastsFor = (a) => Date.parse(a.expires_at) - Date.parse(a.created_at);

test("the hook reports the answer_lengths capability", () => {
  assert.ok(HOOK_CAPABILITIES.includes("answer_lengths"));
});

test("terms may name the lengths offered; an unknown, repeated or empty list is refused", () => {
  const at = (override) => inspectManaged(doc(3, { "destructive-shell": { mode: "override", override } }), { installationId: INSTALLATION, currentRevision: 2 });
  assert.equal(at(terms({ lengths: ["once", "1h", "tomorrow", "30d"] })).ok, true);
  assert.equal(at(terms({ lengths: ["1h"] })).ok, true);
  for (const lengths of [["15m"], ["always"], ["forever"], ["1h", "1h"], [], "1h", [1], ["once", "1h", "tomorrow", "30d", "once"]]) {
    assert.equal(at(terms({ lengths })).ok, false, JSON.stringify(lengths));
  }
  assert.equal(at(terms()).ok, true, "terms without lengths, as before");
});

test("what is offered: the named lengths, never 15 minutes; 30 days follows the workspace's always setting", () => {
  assert.deepEqual(offersFor("override", terms({ lengths: ["once", "1h", "tomorrow", "30d"] })),
    { allow: true, always: true, ask: true, fifteen: false, hour: true, tomorrow: true });
  assert.deepEqual(offersFor("override", terms({ lengths: ["1h", "tomorrow"] })),
    { allow: false, always: false, ask: true, fifteen: false, hour: true, tomorrow: true });
  assert.deepEqual(offersFor("override", terms({ lengths: ["30d"], always: "off" })),
    { allow: false, always: false, ask: true, fifteen: false, hour: false, tomorrow: false });
  assert.deepEqual(offersFor("ask", terms({ lengths: ["once", "1h"] })), { allow: false, always: false, ask: true, fifteen: false, hour: false, tomorrow: false });
  assert.deepEqual(offersFor("override", terms({ lengths: ["1h"] }), false), { allow: false, always: false, ask: true, fifteen: false, hour: false, tomorrow: false }, "the daily limit");
  // Legacy terms: as before, and no new lengths.
  assert.deepEqual(offersFor("override", terms()), { allow: true, always: true, ask: true, fifteen: true, hour: false, tomorrow: false });
  assert.deepEqual(offersFor("override", { reason_min: 10, minutes: 0, daily_limit: 5, harness_prompt: false }), { allow: true, always: false, ask: false, fifteen: false, hour: false, tomorrow: false });
});

test("the live question: 1 hour, until tomorrow and 30 days make allowances that last 1 h, 24 h and 30 days", async () => {
  const dir = setup({ "destructive-shell": { mode: "override", override: terms({ lengths: ["once", "1h", "tomorrow", "30d"], always_days: 90 }) } });
  for (const [command, lasts, length] of [["rm -rf ../a", "1h", HOUR], ["rm -rf ../b", "tomorrow", DAY], ["rm -rf ../c", "30d", 30 * DAY]]) {
    const d = await run(dir, bash(command), { answers: [{ decision: "allow", reason: REASON, os_user: ME, lasts }] });
    assert.equal(d.decision, "allow", lasts);
    assert.equal(d.asked[0].always_days, 30, "the long length is 30 days, whatever always_days says");
    assert.deepEqual(d.asked[0].offers, { allow: true, always: true, ask: true, fifteen: false, hour: true, tomorrow: true });
    const made = readAllowances(dir).at(-1);
    assert.equal(made.state, "active");
    assert.ok(Math.abs(lastsFor(made) - length) < 1000, `${lasts}: ${lastsFor(made)}`);
    const next = await run(dir, bash(command));
    assert.equal(next.override.method, "allowance", `${lasts} stands for the next try`);
  }
});

test("30 days waits for an admin where the workspace says so, with 15 minutes meanwhile", async () => {
  const dir = setup({ "destructive-shell": { mode: "override", override: terms({ lengths: ["1h", "30d"], always: "needs_admin" }) } });
  await run(dir, bash("rm -rf ../build"), { answers: [{ decision: "allow", reason: REASON, os_user: ME, lasts: "30d" }] });
  const made = readAllowances(dir);
  assert.deepEqual(made.map((a) => a.state).sort(), ["active", "proposed"]);
  assert.ok(Math.abs(lastsFor(made.find((a) => a.state === "proposed")) - 30 * DAY) < 1000);
  assert.ok(Math.abs(lastsFor(made.find((a) => a.state === "active")) - 15 * 60_000) < 1000);
  // 1 hour needs no admin.
  await run(dir, bash("rm -rf ../dist"), { answers: [{ decision: "allow", reason: REASON, os_user: ME, lasts: "1h" }] });
  assert.equal(readAllowances(dir).at(-1).state, "active");
});

test("a length the terms do not offer is not given", async () => {
  const dir = setup({ "destructive-shell": { mode: "override", override: terms({ lengths: ["1h"] }) } });
  for (const lasts of ["once", "15m", "tomorrow", "30d", "always"]) {
    const d = await run(dir, bash(`rm -rf ../${lasts}`), { answers: [{ decision: "allow", reason: REASON, os_user: ME, lasts }] });
    assert.equal(d.decision, "deny", lasts);
  }
  assert.equal(readAllowances(dir).length, 0);
});

test("from the tray: the offers carry hour and tomorrow, and each length is applied", () => {
  const dir = setup({ "destructive-shell": { mode: "override", override: terms({ lengths: ["once", "1h", "tomorrow", "30d"] }) } });
  return (async () => {
    for (const [command, lasts, length] of [["rm -rf ../a", "1h", HOUR], ["rm -rf ../b", "tomorrow", DAY], ["rm -rf ../c", "30d", 30 * DAY], ["rm -rf ../d", "always", 30 * DAY]]) {
      await run(dir, bash(command));
      const item = readBlocked(dir).at(-1);
      const q = blockedQuestion(dir, item.id);
      assert.deepEqual(q.offers, { allow: true, always: true, ask: true, fifteen: false, hour: true, tomorrow: true });
      assert.equal(q.always_days, 30);
      assert.deepEqual(actOnBlocked(dir, item.id, { decision: "allow", reason: REASON, os_user: ME, lasts }), { outcome: "allowed" }, lasts);
      assert.ok(Math.abs(lastsFor(readAllowances(dir).at(-1)) - length) < 1000, lasts);
    }
  })();
});

test("legacy terms are unchanged: 15 minutes and always for always_days; the new lengths are not offered", async () => {
  const dir = setup({ "destructive-shell": { mode: "override", override: terms({ always_days: 14 }) } });
  await run(dir, bash("rm -rf ../a"), { answers: [{ decision: "allow", reason: REASON, os_user: ME, lasts: "always" }] });
  assert.ok(Math.abs(lastsFor(readAllowances(dir).at(-1)) - 14 * DAY) < 1000);
  await run(dir, bash("rm -rf ../b"), { answers: [{ decision: "allow", reason: REASON, os_user: ME, lasts: "15m" }] });
  assert.ok(Math.abs(lastsFor(readAllowances(dir).at(-1)) - 15 * 60_000) < 1000);
  // An hour asked for where it is not offered falls back to once, as any length not offered does.
  const d = await run(dir, bash("rm -rf ../c"), { answers: [{ decision: "allow", reason: REASON, os_user: ME, lasts: "1h" }] });
  assert.equal(d.decision, "allow");
  assert.equal(readAllowances(dir).length, 2, "once needs no allowance");
  assert.equal(makeAllowance({ rule: "destructive-shell", actionKey: "a".repeat(64), reason: REASON, osUserDigest: null, lasts: "always" }).state, "active");
});

test("the agent's answer may carry the new lengths", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scopebond-lengths-agent-"));
  writeFileSync(join(dir, "agent.json"), JSON.stringify({ port: 9, token: "t" }));
  for (const lasts of ["1h", "tomorrow", "30d", "15m", "always", "once"]) {
    const answer = await askAgent(dir, {}, 1000, async () => new Response(JSON.stringify({ decision: "allow", reason: REASON, lasts }), { status: 200 }));
    assert.equal(answer.lasts, lasts);
  }
  const odd = await askAgent(dir, {}, 1000, async () => new Response(JSON.stringify({ decision: "allow", reason: REASON, lasts: "forever" }), { status: 200 }));
  assert.equal(odd.lasts, "once");
});
