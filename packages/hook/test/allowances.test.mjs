// D144 (SB411): allowances and "Ask an admin". A standing allowance lets the same action through on a rule a person may act
// on, and the receipt names it; one-time, revoked and expired allowances do not; nothing allows Scopebond's own protection.
// "Block, person may ask" never allows on the spot: the person asks an admin, the request waits for the agent, the block stands.
import { ENFORCE } from "./enforce-all.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";

const ME = userInfo().username; // a person-scoped allowance applies to the account that made it
import { join } from "node:path";
import {
  scaffold, createHookRuntime, mapClaudeToolUse, inspectManaged, compileManaged, digestRules, defaultRules,
  createOverrideHandler, overrideHint, MANAGED_DOC_FILE, makeAllowance, readAllowances, writeAllowances, readRequests, readBlocked,
} from "../dist/index.js";
import { actionKey } from "../dist/override.js";

const INSTALLATION = "gw-allow-1";
const terms = (extra = {}) => ({ reason_min: 10, minutes: 0, daily_limit: 5, harness_prompt: false, ...extra });
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
const write = (file_path) => ({ tool_name: "Write", tool_input: { file_path, content: "x" } });

function setup(rules, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "scopebond-allow-"));
  const { agentKid } = scaffold(dir, ENFORCE);
  const d = doc(2, rules, extra);
  writeFileSync(join(dir, MANAGED_DOC_FILE), JSON.stringify(d));
  writeFileSync(join(dir, "policy.json"), JSON.stringify(compileManaged(defaultRules(), d, agentKid)));
  return { dir, agentKid };
}

async function run(dir, toolUse, { answers = [], permissionMode = "default", now } = {}) {
  const asked = [];
  let hint = null;
  const runtime = createHookRuntime({
    policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"), attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db"), cwd: "/repo",
    override: (agentKid) => {
      const made = createOverrideHandler({ dir, home: dir, agentKid, harness: "claude", permissionMode, now, waitMs: 50,
        ask: async (_home, request) => { asked.push(request); return answers.shift() ?? { decision: "unavailable" }; } });
      return made ? { handler: made.handler, hint: () => { hint = overrideHint(made.note()); return hint; } } : null;
    },
  });
  try {
    const d = await runtime.evaluate(mapClaudeToolUse({ cwd: "/repo", ...toolUse }));
    return { ...d, asked, hint, override: d.receipts?.map((r) => r.payload.override).find(Boolean) ?? d.receipt?.payload?.override ?? null };
  } finally { runtime.close(); }
}

const keyOf = (command) => actionKey(mapClaudeToolUse({ cwd: "/repo", ...bash(command) }).find((m) => m.intent.action_type === "shell.exec").intent);

test("the workspace may send 'Block, person may ask' and the new terms; unknown terms are refused", () => {
  const at = (rules) => inspectManaged(doc(3, rules), { installationId: INSTALLATION, currentRevision: 2 });
  assert.equal(at({ "destructive-shell": { mode: "ask", override: terms({ requests: true }) } }).ok, true);
  assert.equal(at({ "destructive-shell": { mode: "ask" } }).ok, false, "terms are required");
  assert.equal(at({ "destructive-shell": { mode: "override", override: terms({ always: "at_once", always_days: 30, requests: true }) } }).ok, true);
  assert.equal(at({ "destructive-shell": { mode: "override", override: terms({ always: "sometimes" }) } }).ok, false);
  assert.equal(at({ "destructive-shell": { mode: "override", override: terms({ always_days: 400 }) } }).ok, false);
});

test("a standing allowance lets the same action through, and the receipt names it; a one-time one is used once", async () => {
  const { dir } = setup({ "destructive-shell": { mode: "override", override: terms() } });
  const standing = makeAllowance({ rule: "destructive-shell", actionKey: keyOf("rm -rf build"), reason: "release clean-up step", osUserDigest: null, lasts: "always" });
  const once = makeAllowance({ rule: "destructive-shell", actionKey: keyOf("rm -rf dist"), reason: "one-off clean of dist", osUserDigest: null, lasts: "once" });
  writeAllowances(dir, [standing, once]);
  const first = await run(dir, bash("rm -rf build"));
  assert.equal(first.decision, "allow");
  assert.deepEqual(first.asked, [], "no window: the allowance stands");
  assert.equal(first.override.method, "allowance");
  assert.equal(first.override.repeat_of, standing.id);
  assert.equal(first.override.reason_digest, standing.reason_digest);
  assert.equal((await run(dir, bash("rm -rf build"))).decision, "allow", "it stands for the next one too");
  assert.equal(readAllowances(dir).find((a) => a.id === standing.id).uses, 2);
  assert.equal((await run(dir, bash("rm -rf dist"))).decision, "allow");
  const again = await run(dir, bash("rm -rf dist"));
  assert.equal(again.decision, "deny", "a one-time allowance is used up");
  assert.equal(again.asked.length, 1, "so the window asks again");
  assert.equal((await run(dir, bash("rm -rf other"))).decision, "deny", "another action is not covered");
});

test("allowances the workspace delivers apply; ones it revoked, expired ones and ones for another person do not", async () => {
  const delivered = makeAllowance({ rule: "destructive-shell", actionKey: keyOf("rm -rf build"), reason: "approved by the platform team", osUserDigest: null, lasts: "always" });
  const gone = makeAllowance({ rule: "destructive-shell", actionKey: keyOf("rm -rf out"), reason: "approved earlier, then revoked", osUserDigest: null, lasts: "always" });
  const { dir } = setup({ "destructive-shell": { mode: "ask", override: terms({ requests: true }) } },
    { allowances: [{ ...delivered, created_by: "workspace" }, { ...gone, created_by: "workspace" }], revoked_allowances: [gone.id] });
  assert.equal((await run(dir, bash("rm -rf build"))).decision, "allow");
  assert.equal((await run(dir, bash("rm -rf out"))).decision, "deny");
  const expired = makeAllowance({ rule: "destructive-shell", actionKey: keyOf("rm -rf tmp"), reason: "only for a short while", osUserDigest: null, lasts: "15m", now: Date.now() - 20 * 60_000 });
  const theirs = makeAllowance({ rule: "destructive-shell", actionKey: keyOf("rm -rf cache"), reason: "someone else's allowance", osUserDigest: "f".repeat(64), lasts: "always" });
  writeAllowances(dir, [expired, theirs]);
  assert.equal((await run(dir, bash("rm -rf tmp"))).decision, "deny");
  assert.equal((await run(dir, bash("rm -rf cache"))).decision, "deny");
});

test("nothing allows Scopebond's own protection, whatever allowance exists", async () => {
  const { dir } = setup({ "ci-config-write": { mode: "override", override: terms() } });
  const write0 = mapClaudeToolUse({ cwd: "/repo", ...write("/repo/.scopebond/policy.json") }).find((m) => m.intent.action_type === "file.write");
  writeAllowances(dir, [makeAllowance({ rule: "ci-config-write", actionKey: actionKey(write0.intent), reason: "trying to switch it off", osUserDigest: null, lasts: "always" })]);
  const d = await run(dir, write("/repo/.scopebond/policy.json"));
  assert.equal(d.decision, "deny");
  assert.deepEqual(d.asked, []);
});

test("'Block, person may ask': the window offers only Ask an admin; the request waits for the agent and the block stands", async () => {
  const { dir } = setup({ "destructive-shell": { mode: "ask", override: terms({ requests: true, harness_prompt: true }) } });
  const reason = "Need to clear the build cache before the release";
  const d = await run(dir, bash("rm -rf build"), { answers: [{ decision: "ask", reason, os_user: "dev" }] });
  assert.equal(d.decision, "deny");
  assert.deepEqual(d.asked[0].offers, { allow: false, always: false, ask: true, fifteen: false });
  assert.equal(d.asked[0].mode, "ask");
  assert.match(d.hint, /request to allow .* was sent to your workspace's admins/);
  const [request] = readRequests(dir);
  assert.equal(request.rule, "destructive-shell");
  assert.equal(request.reason, reason);
  assert.equal(request.summary, "rm -rf build");
  assert.equal(request.sent_at, null);
  assert.equal(readBlocked(dir).at(-1).mode, "ask");
  // An "allow" answer is not honoured where allowing is not offered, and Claude Code's own prompt is never offered here.
  const forced = await run(dir, bash("rm -rf build"), { answers: [{ decision: "allow", reason, os_user: "dev" }] });
  assert.equal(forced.decision, "deny");
  const unavailable = await run(dir, bash("rm -rf build"), { answers: [] });
  assert.equal(unavailable.decision, "deny");
  assert.equal(unavailable.override, null);
});

test("'Allow for 15 min' and 'Always allow this here…' also stand for the same action afterwards", async () => {
  const { dir } = setup({ "destructive-shell": { mode: "override", override: terms({ always: "at_once" }) } });
  const reason = "Cleaning the build output before release";
  const first = await run(dir, bash("rm -rf build"), { answers: [{ decision: "allow", reason, os_user: ME, lasts: "15m" }] });
  assert.equal(first.decision, "allow");
  assert.equal(first.override.method, "agent_dialog");
  assert.deepEqual(first.asked[0].offers, { allow: true, always: true, ask: false, fifteen: true });
  const next = await run(dir, bash("rm -rf build"));
  assert.equal(next.override.method, "allowance", "the next one needs no window");
  const always = await run(dir, bash("rm -rf dist"), { answers: [{ decision: "allow", reason, os_user: ME, lasts: "always" }] });
  assert.equal(always.decision, "allow");
  const made = readAllowances(dir).find((a) => a.lasts === undefined && a.action_key === keyOf("rm -rf dist"));
  assert.equal(made.state, "active");
  assert.ok(Date.parse(made.expires_at) - Date.now() > 29 * 24 * 60 * 60 * 1000, "30 days by default");
  assert.equal(made.reason, reason, "kept until the agent sends it");
});

test("an 'always' choice that needs an admin is proposed, and the person is covered for 15 minutes meanwhile", async () => {
  const { dir } = setup({ "destructive-shell": { mode: "override", override: terms({ always: "needs_admin" }) } });
  await run(dir, bash("rm -rf build"), { answers: [{ decision: "allow", reason: "Cleaning the build output before release", os_user: ME, lasts: "always" }] });
  const states = readAllowances(dir).map((a) => a.state).sort();
  assert.deepEqual(states, ["active", "proposed"]);
  assert.equal((await run(dir, bash("rm -rf build"))).override.method, "allowance");
});

test("a rule a person may only ask about still blocks when another rule on the same action lets a person allow", async () => {
  const { dir } = setup({
    "push-protected": { mode: "override", override: terms({ always: "at_once", requests: true }) },
    "force-push-protected": { mode: "ask", override: terms({ requests: true }) },
  });
  const d = await run(dir, { tool_name: "Bash", tool_input: { command: "git push --force origin main" } }, { answers: [{ decision: "allow", reason: "Need to fix the release branch", os_user: ME, lasts: "once" }] });
  assert.equal(d.decision, "deny", "allowing the push rule does not get past the force-push rule");
});

test("an older agent's 'Allow once' on a rule a person may only ask about becomes a request to an admin", async () => {
  const { dir } = setup({ "destructive-shell": { mode: "ask", override: terms({ requests: true }) } });
  const reason = "Need to clear the build cache before the release";
  const d = await run(dir, bash("rm -rf build"), { answers: [{ decision: "allow", reason, os_user: ME }] });
  assert.equal(d.decision, "deny");
  assert.equal(readRequests(dir).at(-1)?.reason, reason);
});

test("a workspace without the allowance terms gets no 15-minute allowance", async () => {
  const { dir } = setup({ "destructive-shell": { mode: "override", override: terms() } });
  const d = await run(dir, bash("rm -rf build"), { answers: [{ decision: "allow", reason: "Cleaning the build output before release", os_user: ME, lasts: "15m" }] });
  assert.equal(d.decision, "allow");
  assert.equal(d.asked[0].offers.fifteen, false);
  assert.equal(readAllowances(dir).length, 0, "allowed once, no standing allowance");
});
