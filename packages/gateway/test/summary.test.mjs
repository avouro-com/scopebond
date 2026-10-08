// Summary records (evidence class "summary"): a signed stand-in for routine receipts, with a root over the receipts it
// covers. Notable receipts are never covered; the summary verifies with the receipts' key and against the full receipts.
// A Monitor match is recorded as out of policy (realtime_result "deny", allowed), so it is notable by default too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAttester, createGateway, buildSummary, isNotable, repeatKey } from "../dist/index.js";
import { verifyReceiptSignature } from "@scopebond/verify/signature";
import { validateSummary, verifySummaryCoverage, verifySummarySignature } from "@scopebond/verify/summary";

const policy = {
  vocabulary_version: "1.0", policy_id: "sum", version: 1,
  clauses: [{ id: "allowed", type: "action_allowlist", mode: "enforce", action_types: ["shell.exec", "file.read", "file.write"] }],
};
let clock = Date.parse("2026-10-07T10:00:00Z");
const attester = createAttester();
const gateway = createGateway({ authentication: { mode: "insecure-development" }, mode: "check_only", attester, policy, now: () => new Date(clock += 1000).toISOString() });
const act = async (intent) => (await gateway.check({ intent })).receipt;
const shell = (command, program, extra = {}) => ({ action_type: "shell.exec", params: { command, program, cwd: "/repo", ...extra } });
const window = { kind: "interval", start: "2026-10-07T10:00:00Z", end: "2026-10-07T10:05:00Z" };

async function routine() {
  const out = [];
  for (let i = 0; i < 4; i++) out.push(await act(shell("pnpm test", "pnpm", { action_group: `g${i}`, action_group_size: 1, action_group_seq: 0 })));
  out.push(await act(shell("git status", "git")));
  out.push(await act({ action_type: "file.read", params: { path: "src/index.ts" } }));
  out.push(await act({ action_type: "file.write", params: { path: "src/index.ts" } }));
  return out;
}

test("a summary of routine receipts is signed with their key, validates, and checks out against the receipts", async () => {
  const receipts = await routine();
  assert.ok(receipts.every((r) => !isNotable(r.payload)));
  const summary = await buildSummary(receipts, { attester, window, sessionId: "s-1", harness: "claude", notableCount: 2 });
  assert.deepEqual(validateSummary(summary), { valid: true, errors: [] });
  assert.equal(summary.payload.receipt_count, 7);
  assert.equal(summary.payload.notable_count, 2);
  assert.deepEqual(summary.payload.counts.find((c) => c.program === "pnpm"), { action_type: "shell.exec", result: "allow", program: "pnpm", cwd_digest: summary.payload.counts[0].cwd_digest, count: 4 });
  assert.equal(summary.payload.dedupe.length, 1, "the same command four times is one repeat, whatever tool call it came from");
  assert.equal(summary.payload.dedupe[0].count, 4);
  assert.equal((await verifySummarySignature(summary, attester.publicKeyPem)).valid, true);
  assert.equal((await verifySummaryCoverage(summary, receipts)).valid, true);
  // The signature is domain-separated: it is not a receipt signature.
  assert.equal((await verifyReceiptSignature(summary, attester.publicKeyPem)).signature_valid, false);
});

test("a missing, changed or extra receipt, or a changed summary, does not check out", async () => {
  const receipts = await routine();
  const summary = await buildSummary(receipts, { attester, window, notableCount: 0 });
  const dropped = await verifySummaryCoverage(summary, receipts.slice(1));
  assert.equal(dropped.count_valid, false);
  assert.equal(dropped.valid, false);
  const changed = receipts.map((r, i) => (i === 2 ? { ...r, payload: { ...r.payload, intent: { ...r.payload.intent, params: { ...r.payload.intent.params, command: "pnpm test --x" } } } } : r));
  assert.equal((await verifySummaryCoverage(summary, changed)).root_valid, false);
  const reordered = [receipts[1], receipts[0], ...receipts.slice(2)];
  assert.equal((await verifySummaryCoverage(summary, reordered)).root_valid, true, "any order: the root is taken by timestamp, then action id");
  const edited = { ...summary, payload: { ...summary.payload, notable_count: 0, receipt_count: 7, counts: summary.payload.counts } };
  edited.payload = { ...edited.payload, notable_count: 5 };
  assert.equal((await verifySummarySignature(edited, attester.publicKeyPem)).signature_valid, false);
  assert.equal((await verifySummarySignature(summary, createAttester().publicKeyPem)).valid, false, "another key");
});

test("a denied action, a push, an MCP call, a fetch and a write outside the folder or to CI settings are notable", async () => {
  const denied = await act({ action_type: "git.push", params: { remote: "origin", ref: "main" } });
  assert.equal(denied.payload.realtime_result, "deny");
  assert.equal(isNotable(denied.payload), true);
  const base = (await routine())[6].payload;
  const write = (path) => ({ ...base, intent: { action_type: "file.write", params: { path } } });
  for (const path of ["../other/x", "/etc/hosts", "C:/Windows/x", "~/.ssh/config", ".github/workflows/ci.yml", ".claude/settings.json", ".scopebond/rules.json", ""]) {
    assert.equal(isNotable(write(path)), true, path);
  }
  assert.equal(isNotable(write("src/app.ts")), false);
  for (const type of ["git.push", "mcp.tool.call", "net.fetch"]) assert.equal(isNotable({ ...base, intent: { action_type: type, params: {} } }), true, type);
  assert.equal(isNotable({ ...base, override: { version: 1 } }), true);
  await assert.rejects(buildSummary([denied], { attester, window, notableCount: 0 }), /notable/);
  await assert.rejects(buildSummary([], { attester, window, notableCount: 0 }), /at least one/);
});

test("past 500 groups the rest fold by action type and result, and the counts still add up", async () => {
  const many = [];
  for (let i = 0; i < 620; i++) many.push(await act(shell(`tool${i} --run`, `tool${i}`)));
  many.push(await act({ action_type: "file.read", params: { path: "a.txt" } }));
  const summary = await buildSummary(many, { attester, window, notableCount: 0 });
  assert.ok(summary.payload.counts.length <= 500);
  assert.equal(summary.payload.counts.reduce((n, c) => n + c.count, 0), 621);
  assert.deepEqual(validateSummary(summary), { valid: true, errors: [] });
  assert.equal((await verifySummaryCoverage(summary, many)).valid, true);
  assert.ok(Date.parse(summary.payload.window.end) >= Date.parse(many.at(-1).payload.timestamp), "the window holds every receipt");
});

test("the repeat key leaves out the tool call's group fields only", () => {
  const a = repeatKey({ action_type: "shell.exec", params: { command: "ls", action_group: "x", action_group_size: 3, action_group_seq: 1 } });
  assert.equal(a, repeatKey({ action_type: "shell.exec", params: { command: "ls" } }));
  assert.notEqual(a, repeatKey({ action_type: "shell.exec", params: { command: "ls -la" } }));
});
