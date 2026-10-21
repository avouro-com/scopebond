// Quiet blocks ("Keep blocking without asking me"). A person may keep a block they could act on without being asked again:
// the same action is denied at once, with no question, for 30 days or until they undo it. A quiet block is kept with the
// allowances and sent to the workspace like one, but it never lets anything through.
import { ENFORCE } from "./enforce-all.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import {
  scaffold, createHookRuntime, mapClaudeToolUse, compileManaged, digestRules, defaultRules,
  createOverrideHandler, overrideHint, MANAGED_DOC_FILE, makeAllowance, readAllowances, writeAllowances, readBlocked, blockedQuestion, actOnBlocked, endAllowance,
} from "../dist/index.js";
import { matchAllowance, mergeWorkspaceAllowances } from "../dist/allowances.js";
import { allowanceKey } from "../dist/override.js";

const INSTALLATION = "gw-quiet-1";
const DAY_MS = 24 * 60 * 60 * 1000;
const terms = (extra = {}) => ({ reason_min: 10, minutes: 0, daily_limit: 5, harness_prompt: false, always: "at_once", requests: true, ...extra });
const defaults = () => ({
  "force-push-protected": { mode: "block" }, "push-protected": { mode: "block" }, "destructive-shell": { mode: "block" },
  "secret-read": { mode: "block" }, "ci-config-write": { mode: "block" }, "network-egress": { mode: "monitor" },
});
function doc(revision, overrides = {}, extra = {}) {
  const rules = { ...defaults(), ...overrides };
  return { type: "scopebond:managed-rules", version: 1, revision, export_id: `rev-${revision}-${INSTALLATION}`, environment_id: "env-1",
    agent_id: "agent-1", installation_id: INSTALLATION, rules, rules_digest: digestRules(rules), ...extra };
}
const bash = (command) => ({ tool_name: "Bash", tool_input: { command } });

function setup(rules, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "scopebond-quiet-"));
  const { agentKid } = scaffold(dir, ENFORCE);
  const d = doc(2, rules, extra);
  writeFileSync(join(dir, MANAGED_DOC_FILE), JSON.stringify(d));
  writeFileSync(join(dir, "policy.json"), JSON.stringify(compileManaged(defaultRules(), d, agentKid)));
  return dir;
}

async function run(dir, toolUse, { answers = [] } = {}) {
  const asked = [];
  let hint = null;
  const runtime = createHookRuntime({
    policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"), attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db"), cwd: "/repo",
    override: (agentKid) => {
      const made = createOverrideHandler({ dir, home: dir, agentKid, harness: "claude", permissionMode: "default", waitMs: 50,
        ask: async (_home, request) => { asked.push(request); return answers.shift() ?? { decision: "unavailable" }; } });
      return made ? { handler: made.handler, hint: () => { hint = overrideHint(made.note()); return hint; } } : null;
    },
  });
  try {
    const d = await runtime.evaluate(mapClaudeToolUse({ cwd: "/repo", ...toolUse }));
    return { ...d, asked, hint, override: d.receipts?.map((r) => r.payload.override).find(Boolean) ?? null };
  } finally { runtime.close(); }
}

const shownKeyOf = (command) => {
  const exec = mapClaudeToolUse({ cwd: "/repo", ...bash(command) }).find((m) => m.intent.action_type === "shell.exec");
  return allowanceKey(exec.intent, exec.shown(), "destructive-shell", null);
};
const quietOnes = (dir) => readAllowances(dir).filter((a) => a.kind === "quiet");

test("kept blocked from the tray: the same action is denied at once with no question, and the hint says so", async () => {
  const dir = setup({ "destructive-shell": { mode: "override", override: terms() } });
  assert.equal((await run(dir, bash("rm -rf ../build"))).decision, "deny");
  const item = readBlocked(dir).at(-1);
  assert.ok(blockedQuestion(dir, item.id), "the person may act on it");
  // No reason is needed to keep something blocked, whatever the workspace asks for an unblock.
  assert.deepEqual(actOnBlocked(dir, item.id, { decision: "quiet" }), { outcome: "quiet" });
  assert.equal(readBlocked(dir).at(-1).acted, "quiet");
  assert.equal(blockedQuestion(dir, item.id), null, "not offered again");

  const [quiet] = quietOnes(dir);
  assert.equal(quiet.state, "active");
  assert.equal(quiet.action_key, item.action_key);
  assert.equal(quiet.rule, "destructive-shell");
  assert.equal(quiet.created_by, "person");
  assert.equal(quiet.reason_digest, null);
  assert.equal(quiet.reason_length, 0);
  assert.equal("reason" in quiet, false, "no reason text, nothing new to send");
  const days = (Date.parse(quiet.expires_at) - Date.parse(quiet.created_at)) / DAY_MS;
  assert.ok(days > 29.9 && days < 30.1, "30 days");

  const again = await run(dir, bash("rm -rf ../build"), { answers: [{ decision: "allow", reason: "should never be asked", lasts: "once" }] });
  assert.equal(again.decision, "deny");
  assert.deepEqual(again.asked, [], "nobody is asked");
  assert.equal(again.override, null, "nothing let through");
  assert.match(again.hint, /^The person chose to keep this blocked; do not ask again/);
  assert.equal(readBlocked(dir).at(-1).acted, "quiet", "the new block is noted as kept blocked");
  assert.equal(blockedQuestion(dir, readBlocked(dir).at(-1).id), null);
  // Another action under the same rule still asks.
  assert.equal((await run(dir, bash("rm -rf ../dist"))).asked.length, 1);
});

test("Undo ends a quiet block: the next try asks again", async () => {
  const dir = setup({ "destructive-shell": { mode: "override", override: terms() } });
  await run(dir, bash("rm -rf ../build"));
  actOnBlocked(dir, readBlocked(dir).at(-1).id, { decision: "quiet" });
  const [quiet] = quietOnes(dir);
  assert.deepEqual(endAllowance(dir, quiet.id), { outcome: "ended" });
  const next = await run(dir, bash("rm -rf ../build"));
  assert.equal(next.decision, "deny");
  assert.equal(next.asked.length, 1, "asked again");
  assert.doesNotMatch(next.hint ?? "", /chose to keep this blocked/);
});

test("kept blocked from the live question: the answer makes a quiet block for what the window showed", async () => {
  const dir = setup({ "destructive-shell": { mode: "ask", override: { reason_min: 10, minutes: 0, daily_limit: 5, harness_prompt: false, requests: true } } });
  const first = await run(dir, bash("cd /repo && rm -rf ../build 2>&1 | tail -2"), { answers: [{ decision: "quiet", os_user: userInfo().username }] });
  assert.equal(first.decision, "deny");
  assert.match(first.hint, /^The person chose to keep this blocked; do not ask again/);
  assert.equal(readBlocked(dir).at(-1).acted, "quiet");
  const [quiet] = quietOnes(dir);
  assert.equal(quiet.action_key, shownKeyOf("rm -rf ../build"));
  // The same command in another line is the same action: kept blocked, no question.
  const second = await run(dir, bash("rm -rf ../build"));
  assert.equal(second.decision, "deny");
  assert.deepEqual(second.asked, []);
});

test("a quiet block never lets anything through, whatever copy of it the workspace sends back", async () => {
  const dir = setup({ "destructive-shell": { mode: "override", override: terms() } });
  await run(dir, bash("rm -rf ../build"));
  actOnBlocked(dir, readBlocked(dir).at(-1).id, { decision: "quiet" });
  const [quiet] = quietOnes(dir);
  const query = { rule: "destructive-shell", actionKey: quiet.action_key, osUserDigest: quiet.os_user_digest, now: Date.now() };
  assert.equal(matchAllowance(readAllowances(dir), query), null);
  // A workspace that does not know quiet blocks sends its copy without the kind: it stays a quiet block here.
  const theirs = { ...quiet, created_by: "workspace" };
  delete theirs.kind;
  const merged = mergeWorkspaceAllowances(readAllowances(dir), [theirs], []);
  assert.equal(merged.find((a) => a.id === quiet.id).kind, "quiet");
  assert.equal(matchAllowance(merged, query), null);
  // A quiet block the workspace delivers on its own is not an allowance either.
  const delivered = { ...makeAllowance({ rule: "destructive-shell", actionKey: shownKeyOf("rm -rf ../dist"), reason: "", osUserDigest: null, lasts: "always" }), kind: "quiet", created_by: "workspace" };
  assert.equal(matchAllowance([delivered], { ...query, actionKey: delivered.action_key }), null);
  const dir2 = setup({ "destructive-shell": { mode: "override", override: terms() } }, { allowances: [delivered] });
  const d = await run(dir2, bash("rm -rf ../dist"));
  assert.equal(d.decision, "deny");
  assert.equal(d.override, null);
});

test("an admin's allowance made after a quiet block wins; one made before it does not", async () => {
  const dir = setup({ "destructive-shell": { mode: "override", override: terms() } });
  await run(dir, bash("rm -rf ../build"));
  actOnBlocked(dir, readBlocked(dir).at(-1).id, { decision: "quiet" });
  const [quiet] = quietOnes(dir);
  const older = { ...makeAllowance({ rule: "destructive-shell", actionKey: quiet.action_key, reason: "approved long ago", osUserDigest: null, lasts: "always", now: Date.parse(quiet.created_at) - 60_000 }) };
  writeAllowances(dir, [...readAllowances(dir), older]);
  assert.equal((await run(dir, bash("rm -rf ../build"))).decision, "deny", "the person's later choice to keep it blocked stands");
  const newer = { ...makeAllowance({ rule: "destructive-shell", actionKey: quiet.action_key, reason: "approved by the platform team", osUserDigest: null, lasts: "always", now: Date.parse(quiet.created_at) + 60_000 }) };
  writeAllowances(dir, [...readAllowances(dir), newer]);
  const allowed = await run(dir, bash("rm -rf ../build"));
  assert.equal(allowed.decision, "allow");
  assert.equal(allowed.override.repeat_of, newer.id);
});
