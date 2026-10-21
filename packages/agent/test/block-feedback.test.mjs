// "This shouldn't be blocked": a person's mark on a block, kept on this computer and sent to a workspace that takes it. It
// names the record, the rule and the action's key, never a reason or a command.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queueBlockFeedback, readBlockFeedback, sendBlockFeedback, BLOCK_FEEDBACK_CAPABILITY } from "../dist/block-feedback.js";
import { callAgent } from "../dist/index.js";
import { computer, blockActions, serviceFor } from "./tray-helpers.mjs";

const KEY = "a".repeat(64);

test("a mark is kept once per block and sent as the workspace takes it; refused items are not sent again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-feedback-"));
  assert.equal(queueBlockFeedback(dir, { action_id: "act-1", rule: "destructive-shell", action_key: KEY, harness: "claude" }), true);
  assert.equal(queueBlockFeedback(dir, { action_id: "act-1", rule: "destructive-shell", action_key: KEY, harness: "claude" }), false, "once per block");
  queueBlockFeedback(dir, { action_id: "act-2", rule: "secret-read", action_key: KEY, harness: null });
  const bodies = [];
  const fetchImpl = async (url, init) => {
    bodies.push({ path: new URL(url).pathname, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true, accepted: 1, rejected: [{ index: 1, code: "unknown_rule", reason: "x" }] }), { status: 200 });
  };
  assert.equal(await sendBlockFeedback(dir, { url: "https://cloud.example.test", credential: "sbm_x" }, fetchImpl), 1);
  assert.equal(bodies[0].path, "/v1/block-feedback");
  const [first, second] = bodies[0].body.items;
  assert.deepEqual(Object.keys(first).sort(), ["action_id", "action_key", "created_at", "harness", "id", "kind", "rule"]);
  assert.equal(first.kind, "not_a_concern");
  assert.equal("harness" in second, false, "no harness when it is not known");
  assert.ok(readBlockFeedback(dir).every((i) => i.sent_at), "accepted and refused items are both done");
  assert.equal(await sendBlockFeedback(dir, { url: "https://cloud.example.test", credential: "sbm_x" }, fetchImpl), 0, "nothing waits");
});

test("a workspace that cannot take the marks now leaves them waiting", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-feedback-"));
  queueBlockFeedback(dir, { action_id: "act-1", rule: "destructive-shell", action_key: KEY, harness: "claude" });
  for (const fail of [async () => new Response("{}", { status: 503 }), async () => { throw new Error("fetch failed"); }]) {
    assert.equal(await sendBlockFeedback(dir, { url: "https://cloud.example.test", credential: "sbm_x" }, fail), 0);
    assert.equal(readBlockFeedback(dir)[0].sent_at, null);
  }
  assert.equal(BLOCK_FEEDBACK_CAPABILITY, "block_feedback");
});

test("the tray marks any block of the week, by its record", async () => {
  const dir = computer({ "secret-read": { mode: "block" } });
  await blockActions(dir, [{ tool_name: "Read", tool_input: { file_path: "/repo/.env.production" } }]);
  const service = await serviceFor(dir);
  try {
    const { tray } = await callAgent(dir, "GET", "/tray", undefined, 10_000);
    const block = tray.recent_blocks[0];
    assert.equal(block.feedback_sent, false);
    const answer = await callAgent(dir, "POST", "/blocked/feedback", { action_id: block.action_id }, 10_000);
    assert.equal(answer.outcome, "noted");
    const [mark] = readBlockFeedback(dir);
    assert.equal(mark.action_id, block.action_id);
    assert.match(mark.action_key, /^[0-9a-f]{64}$/);
    assert.equal((await callAgent(dir, "POST", "/blocked/feedback", { action_id: block.action_id }, 10_000)).outcome, "already");
    assert.equal((await callAgent(dir, "POST", "/blocked/feedback", { action_id: "nope" }, 10_000)).outcome, "gone");
    assert.equal((await callAgent(dir, "GET", "/tray", undefined, 10_000)).tray.recent_blocks[0].feedback_sent, true);
  } finally { await service.stop(); }
});
