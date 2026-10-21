// "Keep blocking without asking me" from the tray: a quiet block for a block the person could act on. It is listed under the
// allowed items as kind "quiet" (the tray shows it under "Kept blocked" with Undo), ends with POST /allowances/stop, is sent
// to the workspace as an allowance record with kind "quiet" and no reason, and is also the answer to a live question.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateAttester } from "@scopebond/gateway/node";
import { readAllowances, readBlocked, writeAllowances, makeQuietBlock } from "@scopebond/hook";
import { callAgent } from "../dist/index.js";
import { parseBlockedAnswer, answerText } from "../dist/service.js";
import { livePrompt } from "../dist/live-prompt.js";
import { parseQuestion } from "../dist/prompt.js";
import { sendAllowancesAndRequests } from "../dist/allowance-sender.js";
import { computer, blockActions, serviceFor } from "./tray-helpers.mjs";

const answer = (dir, body) => callAgent(dir, "POST", "/blocked/answer", body, 10_000);

test("the form's quiet answer is read strictly and says what happened", () => {
  assert.deepEqual(parseBlockedAnswer({ action_id: "act-1", choice: "quiet" }), { action_id: "act-1", choice: "quiet", reason: "" });
  assert.equal(answerText("quiet", "quiet", 30, "Acme", true), "Kept blocked without asking you · undo it under Allowed");
});

test("keep blocking from the tray: no reason needed, listed as kept blocked, and Undo ends it", async () => {
  const dir = computer();
  await blockActions(dir, [{ tool_name: "Bash", tool_input: { command: "rm -rf ../build" } }]);
  const id = readBlocked(dir).at(-1).id;
  const service = await serviceFor(dir);
  try {
    const done = await answer(dir, { action_id: id, choice: "quiet" });
    assert.deepEqual(done, { outcome: "quiet", choice: "quiet", text: "Kept blocked without asking you: rm -rf ../build (in /repo) · undo it under Allowed" });
    assert.equal(readBlocked(dir).at(-1).acted, "quiet");
    const quiet = readAllowances(dir).find((a) => a.kind === "quiet");
    assert.ok(quiet);
    assert.equal(quiet.reason_digest, null);
    assert.equal((await answer(dir, { action_id: id, choice: "quiet" })).outcome, "gone", "answered once");

    const { allowances } = await callAgent(dir, "GET", "/allowances", undefined, 10_000);
    assert.equal(allowances.length, 1);
    assert.equal(allowances[0].kind, "quiet");
    assert.equal(allowances[0].by, "person");
    assert.equal(allowances[0].what, "rm -rf ../build (in /repo)");
    const { tray } = await callAgent(dir, "GET", "/tray", undefined, 10_000);
    assert.equal(tray.allowed[0].kind, "quiet");
    assert.equal(tray.recent_blocks[0].acted, "quiet");
    assert.equal(tray.recent_blocks[0].outcome, "quiet");
    assert.equal(tray.recent_blocks[0].can_act, false);

    // The next try is denied at once, with no question, and the tray shows it as kept blocked too.
    await blockActions(dir, [{ tool_name: "Bash", tool_input: { command: "rm -rf ../build" } }]);
    assert.equal(readBlocked(dir).at(-1).acted, "quiet");

    // Undo: the existing "Stop allowing".
    const stopped = await callAgent(dir, "POST", "/allowances/stop", { id: allowances[0].id }, 10_000);
    assert.equal(stopped.outcome, "stopped");
    assert.deepEqual((await callAgent(dir, "GET", "/allowances", undefined, 10_000)).allowances, []);
    assert.ok(readAllowances(dir).find((a) => a.id === quiet.id).ended_at);
  } finally { await service.stop(); }
});

test("an ordinary allowance is listed as kind allow", async () => {
  const dir = computer();
  await blockActions(dir, [{ tool_name: "Bash", tool_input: { command: "rm -rf ../build" } }]);
  const service = await serviceFor(dir);
  try {
    await answer(dir, { action_id: readBlocked(dir).at(-1).id, choice: "once", reason: "Integration tests need the build folder gone" });
    const { allowances } = await callAgent(dir, "GET", "/allowances", undefined, 10_000);
    assert.equal(allowances[0].kind, "allow");
  } finally { await service.stop(); }
});

test("a quiet block is sent to the workspace as an allowance record with kind quiet and no reason", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-quiet-send-"));
  loadOrCreateAttester({ file: join(dir, "attester.key") });
  const quiet = makeQuietBlock({ rule: "destructive-shell", actionKey: "a".repeat(64), osUserDigest: null });
  writeAllowances(dir, [quiet]);
  const posts = [];
  const fetchImpl = async (url, init) => { posts.push({ path: new URL(url).pathname, body: JSON.parse(init.body) }); return new Response("{}", { status: 200 }); };
  assert.deepEqual(await sendAllowancesAndRequests(dir, { url: "https://cloud.example.test", credential: "sbm_x" }, fetchImpl), { allowances: 1, requests: 0, ended: 0 });
  const [post] = posts;
  assert.equal(post.path, "/v1/allowances");
  assert.equal(post.body.record.id, quiet.id);
  assert.equal(post.body.record.kind, "quiet");
  assert.equal(post.body.record.state, "active");
  assert.equal(post.body.record.reason_digest, null);
  assert.equal(post.body.record.reason_length, 0);
  assert.equal("reason" in post.body.record, false);
  assert.deepEqual(Object.keys(post.body.record).sort(), ["action_key", "created_at", "created_by", "expires_at", "id", "kind", "once", "os_user_digest",
    "reason_digest", "reason_length", "rule", "scope", "state"], "an allowance's fields and its kind: nothing new about the person");
});

test("the live question: keep blocking is an answer the tray may give, by choice or by decision", async () => {
  const question = () => parseQuestion({ action_id: "act-live-000000000001", rule: "secret-read", title: "Read passwords, keys or secrets", summary: ".env.production",
    reason_min: 12, lasts: "this action only", timeout_ms: 45_000, mode: "override", offers: { allow: true, always: true, ask: true, fifteen: true }, harness: "claude" });
  for (const body of [{ choice: "quiet" }, { decision: "quiet" }]) {
    const live = livePrompt({ fallback: async () => ({ decision: "deny" }) });
    const waited = live.wait(null, 5_000);
    const asked = live.prompter(question());
    const q = await waited;
    const done = live.answer({ action_id: q.action_id, ...body }, "dev");
    assert.equal(done.ok, true);
    assert.equal(done.choice, "quiet");
    assert.deepEqual(await asked, { decision: "quiet", os_user: "dev" });
  }
});
