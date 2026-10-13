// Session budgets: a workspace limits what one coding-agent session may do (at most N file writes, no pushes, no package
// installs, until the budget expires). The hook counts per session before an action runs, denies beyond a limit with the
// reason "session budget", records the decision in the receipt, and fails closed when it cannot read its count.
import { ENFORCE } from "./enforce-all.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scaffold, createHookRuntime, mapClaudeToolUse, inspectManaged, compileManaged, digestRules, defaultRules, MANAGED_DOC_FILE,
  sessionBudgetGuard, sessionBudgetGuardFor, keyedSessionId, validSessionBudgets, SESSION_BUDGETS_FILE, matchAllowance, makeAllowance, isPackageInstall, isAgentLaunch,
} from "../dist/index.js";
import { validateEvidencePayload } from "@scopebond/gateway";

const vectors = JSON.parse(readFileSync(new URL("../../policy-schema/vectors/session-budgets.json", import.meta.url), "utf8"));
const INSTALLATION = "gw-budget-1";
const SESSION = "sbs_0123456789abcdef0123456789abcdef";
const OTHER = "sbs_fedcba9876543210fedcba9876543210";
const HOUR = 60 * 60 * 1000;
const rulesOf = () => ({
  "force-push-protected": { mode: "block" }, "push-protected": { mode: "block" }, "destructive-shell": { mode: "block" },
  "secret-read": { mode: "block" }, "ci-config-write": { mode: "block" }, "network-egress": { mode: "monitor" },
});
function doc(revision, extra = {}) {
  const rules = rulesOf();
  return { type: "scopebond:managed-rules", version: 1, revision, export_id: `rev-${revision}-${INSTALLATION}`, environment_id: "env-1",
    agent_id: "agent-1", installation_id: INSTALLATION, rules, rules_digest: digestRules(rules), ...extra };
}
const budget = (extra = {}) => ({
  budget_id: "sbud_overnight01", scope: "session", session_id: SESSION, mode: "enforce", version: 1, source: "admin",
  expires_at: new Date(Date.now() + 2 * HOUR).toISOString(),
  limits: [{ operations: ["file.write"], max: 2 }, { operations: ["git.push"], max: 0 }, { operations: ["package.install"], max: 0 }],
  ...extra,
});

function setup(budgets) {
  const dir = mkdtempSync(join(tmpdir(), "scopebond-budget-"));
  const { agentKid } = scaffold(dir, ENFORCE);
  const d = doc(2, budgets ? { session_budgets: budgets } : {});
  writeFileSync(join(dir, MANAGED_DOC_FILE), JSON.stringify(d));
  writeFileSync(join(dir, "policy.json"), JSON.stringify(compileManaged(defaultRules(), d, agentKid)));
  return dir;
}

let call = 0;
async function run(dir, toolUse, { session = SESSION, groupKey = `call-${++call}` } = {}) {
  const runtime = createHookRuntime({
    policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"), attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db"), cwd: "/repo",
    context: { harness: "claude", session_id: session }, sessionBudgets: sessionBudgetGuard(dir, session),
  });
  try { return await runtime.evaluate(mapClaudeToolUse({ cwd: "/repo", ...toolUse }), { groupKey }); }
  finally { runtime.close(); }
}
const bash = (command) => ({ tool_name: "Bash", tool_input: { command } });
const write = (file_path) => ({ tool_name: "Write", tool_input: { file_path, content: "x" } });
const budgetsOf = (d) => (d.receipts ?? []).map((r) => r.payload.budget).filter(Boolean);

test("the rules document: session budgets are optional and checked whole; other unknown members are ignored as before", () => {
  const at = (extra) => inspectManaged(doc(3, extra), { installationId: INSTALLATION, currentRevision: 2 });
  assert.equal(at({}).ok, true, "a document without budgets (an older workspace) is unchanged");
  assert.equal(at({ some_future_member: { x: 1 } }).ok, true, "a member this hook does not know is ignored, which is how an older hook treats session_budgets");
  assert.equal(at({ session_budgets: [budget()] }).ok, true);
  for (const vector of vectors.valid) assert.equal(validSessionBudgets(vector.session_budgets), true, vector.name);
  for (const vector of vectors.invalid) {
    assert.equal(validSessionBudgets(vector.session_budgets), false, vector.name);
    const refused = at({ session_budgets: vector.session_budgets });
    assert.equal(refused.ok, false, vector.name);
    assert.equal(refused.reason, "invalid_document");
  }
  assert.equal(at({ session_budgets: [budget(), budget()] }).ok, false, "budget ids are unique");
});

test("acceptance: a session with a budget of zero pushes has its push denied with 'session budget', and the receipt says so", async () => {
  const dir = setup([budget()]);
  const d = await run(dir, bash("git push origin feature/night"));
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /session budget/);
  assert.match(d.reason, /may push no times/);
  const denied = d.receipts.at(-1).payload;
  assert.equal(denied.realtime_result, "deny");
  assert.equal(denied.intent.action_type, "git.push");
  assert.equal(denied.context.session_id, SESSION, "grouped under its session");
  assert.deepEqual(denied.budget, { version: 1, scope: "session", budget_id: "sbud_overnight01", budget_version: 1, mode: "enforce", operation: "git.push", count: 1, max: 0, state: "over" });
  assert.equal(validateEvidencePayload(denied), true);
  // Another session on the same computer is not limited by it.
  assert.notEqual((await run(dir, bash("git push origin feature/night"), { session: OTHER })).decision, "deny");
});

test("file writes are counted per tool call: within, at the limit, then denied; a retry of the same call is not counted twice", async () => {
  const dir = setup([budget()]);
  const first = await run(dir, write("/repo/src/a.ts"), { groupKey: "w1" });
  assert.equal(first.decision, "allow");
  assert.deepEqual(budgetsOf(first).map((b) => [b.state, b.count, b.max]), [["within", 1, 2]]);
  const retry = await run(dir, write("/repo/src/a.ts"), { groupKey: "w1" });
  assert.equal(retry.decision, "allow");
  assert.equal(budgetsOf(retry)[0].count, 1, "the same tool call again is not counted again");
  const second = await run(dir, write("/repo/src/b.ts"));
  assert.deepEqual(budgetsOf(second).map((b) => b.state), ["at_limit"]);
  const third = await run(dir, write("/repo/src/c.ts"));
  assert.equal(third.decision, "deny");
  assert.match(third.reason, /session budget/);
  assert.equal(budgetsOf(third)[0].state, "over");
  // An action the budget does not limit is not counted and carries no budget.
  const read = await run(dir, { tool_name: "Read", tool_input: { file_path: "/repo/src/a.ts" } });
  assert.notEqual(read.decision, "deny");
  assert.deepEqual(budgetsOf(read), []);
});

test("a tool call a rule denies gives its count back", async () => {
  const dir = setup([budget({ limits: [{ operations: ["file.write"], max: 1 }] })]);
  const blocked = await run(dir, write("/repo/.github/workflows/ci.yml"));
  assert.equal(blocked.decision, "deny");
  assert.doesNotMatch(blocked.reason, /session budget/, "the rule denied it, not the budget");
  const next = await run(dir, write("/repo/src/a.ts"));
  assert.equal(next.decision, "allow");
  assert.equal(budgetsOf(next)[0].count, 1);
});

test("monitor records over the limit and allows; an expired budget ends and the rules alone decide again", async () => {
  const monitored = setup([budget({ mode: "monitor" })]);
  const pushed = await run(monitored, bash("git push origin feature/night"));
  assert.notEqual(pushed.decision, "deny");
  assert.equal(budgetsOf(pushed)[0].state, "over");
  assert.equal(budgetsOf(pushed)[0].mode, "monitor");

  const expired = setup([budget({ expires_at: new Date(Date.now() - 1000).toISOString(), limits: [{ operations: ["file.write"], max: 100 }] })]);
  const d = await run(expired, write("/repo/src/a.ts"));
  assert.equal(d.decision, "allow", "after its expiry the budget no longer applies");
  assert.deepEqual(budgetsOf(d), []);
  const ended = setup([budget({ expires_at: new Date(Date.now() - 1000).toISOString() })]);
  assert.notEqual((await run(ended, bash("git push origin feature/night"))).decision, "deny", "a zero-push budget that ended no longer refuses");
  assert.notEqual((await run(ended, bash("claude -p 'carry on'"))).decision, "deny", "nor starting another agent");
});

test("fail closed: an unreadable count for a budgeted session denies, never 'no limit'", async () => {
  const dir = setup([budget({ limits: [{ operations: ["file.write"], max: 100 }] })]);
  writeFileSync(join(dir, SESSION_BUDGETS_FILE), "{ damaged");
  const d = await run(dir, write("/repo/src/a.ts"));
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /session budget/);
  assert.match(d.reason, /could not check this session's count/);
  assert.equal(budgetsOf(d)[0].state, "unavailable");
  assert.equal(readFileSync(join(dir, SESSION_BUDGETS_FILE), "utf8"), "{ damaged", "the damaged file is left for a person to see");
  // A count file with the wrong shape is damaged too.
  writeFileSync(join(dir, SESSION_BUDGETS_FILE), JSON.stringify({ version: 1, sessions: { [SESSION]: { updated_at: 1, counts: { x: -4 }, groups: [] } } }));
  assert.equal((await run(dir, write("/repo/src/a.ts"))).decision, "deny");
  // A session id that cannot be worked out while budgets exist: the limited actions are refused.
  const guard = sessionBudgetGuard(dir, new Error("no key"));
  const r = guard.reserve("g1", [{ action_type: "file.write", params: { path: "a" } }]);
  assert.equal(r.allow, false);
  assert.match(r.reason, /session budget/);
  assert.equal(guard.reserve("g2", [{ action_type: "file.read", params: { path: "a" } }]).allow, true);
});

test("the count file is bounded and written whole", async () => {
  const dir = setup([budget({ limits: [{ operations: ["file.write"], max: 1000 }] })]);
  for (let i = 0; i < 60; i += 1) await run(dir, write(`/repo/src/f${i}.ts`));
  const file = JSON.parse(readFileSync(join(dir, SESSION_BUDGETS_FILE), "utf8"));
  assert.equal(file.version, 1);
  assert.equal(Object.values(file.sessions[SESSION].counts)[0], 60);
  assert.equal(file.sessions[SESSION].groups.length, 50, "only the last tool calls are kept");
  assert.equal(existsSync(join(dir, "session-budgets.lock")), false, "the lock is released");
  // Counts are kept at least a day past the budget's expiry, however long it lasts.
  assert.ok(file.sessions[SESSION].keep_until >= Date.parse(budget().expires_at) + 23 * HOUR);
});

test("the hook input's session id is keyed the way receipts carry it; no budgets or no session means no guard", () => {
  const dir = setup(null);
  assert.equal(sessionBudgetGuardFor(dir, { session_id: "raw-session" }), null, "no budgets in the document");
  const keyed = keyedSessionId(dir, { session_id: "raw-session" });
  assert.match(keyed, /^sbs_[0-9a-f]{32}$/);
  const withBudget = setup([budget({ session_id: keyed })]);
  // Another folder has its own key, so the id differs there; the guard for this folder's own key is found.
  const ownKey = keyedSessionId(withBudget, { session_id: "raw-session" });
  writeFileSync(join(withBudget, MANAGED_DOC_FILE), JSON.stringify(doc(2, { session_budgets: [budget({ session_id: ownKey })] })));
  assert.ok(sessionBudgetGuardFor(withBudget, { session_id: "raw-session" }));
  assert.equal(sessionBudgetGuardFor(withBudget, { session_id: "another-session" }), null);
  assert.equal(sessionBudgetGuardFor(withBudget, {}), null);
});

test("a session-scoped allowance applies only in its session", () => {
  const made = makeAllowance({ rule: "ci-config-write", actionKey: "a".repeat(64), reason: "overnight run may edit CI", osUserDigest: null, lasts: "always" });
  const session = { ...made, created_by: "workspace", scope: "session", session_id: SESSION };
  const query = { rule: "ci-config-write", actionKey: "a".repeat(64), osUserDigest: null, now: Date.now() };
  assert.equal(matchAllowance([session], { ...query, sessionId: SESSION })?.id, made.id);
  assert.equal(matchAllowance([session], { ...query, sessionId: OTHER }), null);
  assert.equal(matchAllowance([session], query), null, "no session: no match");
});

test("package installs in shell commands count as package.install: npm install x is denied under no installs", async () => {
  const dir = setup([budget()]);
  for (const command of ["npm install left-pad", "pnpm add zod", "yarn add react", "pip install requests", "python -m pip install -r requirements.txt", "npm ci", "uv add httpx"]) {
    const d = await run(dir, bash(command));
    assert.equal(d.decision, "deny", command);
    assert.match(d.reason, /session budget/, command);
    assert.match(d.reason, /may install packages no times/, command);
    assert.equal(budgetsOf(d)[0].operation, "package.install", command);
  }
  for (const command of ["npm test", "npm run build", "pip list", "ls -la"]) assert.equal(isPackageInstall({ action_type: "shell.exec", params: { program: command.split(" ")[0], command } }), false, command);
  assert.notEqual((await run(dir, bash("npm test"))).decision, "deny");
});

test("a push in a shell command is its own git.push and is counted", async () => {
  const dir = setup([budget({ limits: [{ operations: ["git.push"], max: 1 }] })]);
  const first = await run(dir, bash("git push origin feature/a"));
  assert.notEqual(first.decision, "deny");
  assert.deepEqual(budgetsOf(first).map((b) => [b.operation, b.count, b.state]), [["git.push", 1, "at_limit"]]);
  const second = await run(dir, bash("git push origin feature/b"));
  assert.equal(second.decision, "deny");
  assert.match(second.reason, /session budget/);
});

test("a budgeted session may not start another coding agent; a monitor-only one, or none, may", async () => {
  const dir = setup([budget()]);
  for (const command of ["claude -p 'keep going'", "codex exec 'fix it'", "cursor-agent -p go", "copilot -p go", "gh copilot suggest 'x'", "npx @anthropic-ai/claude-code -p go"]) {
    const d = await run(dir, bash(command));
    assert.equal(d.decision, "deny", command);
    assert.match(d.reason, /session budget: starting another coding agent is not allowed in a budgeted session/, command);
  }
  assert.equal(isAgentLaunch({ action_type: "shell.exec", params: { program: "gh", command: "gh pr list" } }), false);
  const monitored = setup([budget({ mode: "monitor" })]);
  assert.notEqual((await run(monitored, bash("claude -p 'keep going'"))).decision, "deny");
  assert.notEqual((await run(dir, bash("claude -p 'keep going'"), { session: OTHER })).decision, "deny", "another session has no budget");
});

test("count_shell_as_write: off by default; on, any other shell command counts against the file-write limit", async () => {
  const off = setup([budget({ limits: [{ operations: ["file.write"], max: 1 }] })]);
  assert.deepEqual(budgetsOf(await run(off, bash("ls -la"))), []);
  const on = setup([budget({ count_shell_as_write: true, limits: [{ operations: ["file.write"], max: 1 }] })]);
  const first = await run(on, bash("sed -i s/a/b/ notes.txt"));
  assert.equal(budgetsOf(first)[0].operation, "file.write");
  const second = await run(on, bash("touch b.txt"));
  assert.equal(second.decision, "deny");
  assert.match(second.reason, /may write files once/);
});

test("an action reported after it ran (Cursor's after-edit) is counted, never refused; later calls are refused once over", () => {
  const dir = setup([budget({ limits: [{ operations: ["file.write"], max: 1 }] })]);
  const guard = sessionBudgetGuard(dir, SESSION);
  const edit = (path) => [{ action_type: "file.write", params: { path } }];
  assert.equal(guard.reserve("p1", edit("a"), { postHoc: true }).allow, true);
  const over = guard.reserve("p2", edit("b"), { postHoc: true });
  assert.equal(over.allow, true, "already happened: not refused");
  assert.equal(over.budgetFor(edit("b")[0]).state, "over");
  const next = guard.reserve("p3", edit("c"));
  assert.equal(next.allow, false);
  assert.match(next.reason, /session budget/);
});
