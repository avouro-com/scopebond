// Answer lengths in the tray: where the workspace names the lengths a person's unblock may last (Once · 1 hour · Until
// tomorrow · 30 days), a recent block's offers and the live question's offers carry `hour` and `tomorrow`, and the form's
// choices "hour" and "tomorrow" make allowances that last an hour and 24 hours. Without them, nothing changes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readAllowances, readBlocked } from "@scopebond/hook";
import { callAgent } from "../dist/index.js";
import { parseBlockedAnswer, answerText } from "../dist/service.js";
import { livePrompt } from "../dist/live-prompt.js";
import { parseQuestion, singleChoice } from "../dist/prompt.js";
import { computer, blockActions, serviceFor } from "./tray-helpers.mjs";

const REASON = "Integration tests need the build folder gone";
const HOUR = 60 * 60_000;
const lengthsTerms = (lengths, extra = {}) => ({ reason_min: 12, minutes: 0, daily_limit: 5, harness_prompt: false, always: "at_once", requests: true, lengths, ...extra });
const answer = (dir, body) => callAgent(dir, "POST", "/blocked/answer", body, 10_000);
const lastsFor = (a) => Date.parse(a.expires_at) - Date.parse(a.created_at);

test("the form's new choices are read, and say how long", () => {
  assert.deepEqual(parseBlockedAnswer({ action_id: "act-1", choice: "hour", reason: REASON }), { action_id: "act-1", choice: "hour", reason: REASON });
  assert.deepEqual(parseBlockedAnswer({ action_id: "act-1", choice: "tomorrow", reason: REASON }), { action_id: "act-1", choice: "tomorrow", reason: REASON });
  assert.equal(answerText("allowed", "hour", 30, "Acme", true), "Allowed for 1 hour · recorded in Acme");
  assert.equal(answerText("allowed", "tomorrow", 30, "Acme", true), "Allowed until tomorrow · recorded in Acme");
  assert.equal(answerText("allowed", "always", 30, "Acme", true), "Allowed for 30 days · recorded in Acme");
  const now = Date.UTC(2026, 9, 14, 20, 52);
  assert.match(answerText("allowed", "hour", 30, "Acme", true, true, now), /^Unblocked until \d{1,2}:\d\d [AP]M · an admin will review it$/);
});

test("the workspace's lengths: offered in the tray, applied for 1 hour and until tomorrow, 15 minutes not offered", async () => {
  const dir = computer({ "destructive-shell": { mode: "override", override: lengthsTerms(["once", "1h", "tomorrow", "30d"]) } });
  await blockActions(dir, [{ tool_name: "Bash", tool_input: { command: "rm -rf ../a" } }, { tool_name: "Bash", tool_input: { command: "rm -rf ../b" } }]);
  const [b, a] = readBlocked(dir).slice(-2).reverse();
  const service = await serviceFor(dir);
  try {
    const { tray } = await callAgent(dir, "GET", "/tray", undefined, 10_000);
    const row = tray.recent_blocks.find((r) => r.action_id === a.id);
    assert.deepEqual(row.offers, { once: true, fifteen: false, hour: true, tomorrow: true, quiet: true, always: true, always_days: 30, always_needs_admin: false, ask: true, reviewed: false });
    assert.equal(row.outcome, "unblock");
    assert.equal((await answer(dir, { action_id: a.id, choice: "fifteen", reason: REASON })).outcome, "not_offered");
    const hour = await answer(dir, { action_id: a.id, choice: "hour", reason: REASON });
    assert.equal(hour.outcome, "allowed");
    assert.match(hour.text, /^Allowed for 1 hour: .+ · recorded on this computer$/);
    assert.ok(Math.abs(lastsFor(readAllowances(dir).at(-1)) - HOUR) < 1000);
    const tomorrow = await answer(dir, { action_id: b.id, choice: "tomorrow", reason: REASON });
    assert.equal(tomorrow.outcome, "allowed");
    assert.ok(Math.abs(lastsFor(readAllowances(dir).at(-1)) - 24 * HOUR) < 1000);
    const { allowances } = await callAgent(dir, "GET", "/allowances", undefined, 10_000);
    assert.deepEqual(allowances.map((x) => x.choice).sort(), ["hour", "tomorrow"]);
  } finally { await service.stop(); }
});

test("legacy terms: hour and tomorrow are offered as false and refused", async () => {
  const dir = computer();
  await blockActions(dir, [{ tool_name: "Bash", tool_input: { command: "rm -rf ../a" } }]);
  const id = readBlocked(dir).at(-1).id;
  const service = await serviceFor(dir);
  try {
    const { tray } = await callAgent(dir, "GET", "/tray", undefined, 10_000);
    assert.deepEqual(tray.recent_blocks[0].offers, { once: true, fifteen: true, hour: false, tomorrow: false, quiet: true, always: true, always_days: 14, always_needs_admin: true, ask: true, reviewed: false });
    assert.equal((await answer(dir, { action_id: id, choice: "hour", reason: REASON })).outcome, "not_offered");
    assert.equal((await answer(dir, { action_id: id, choice: "tomorrow", reason: REASON })).outcome, "not_offered");
  } finally { await service.stop(); }
});

test("the live question carries hour and tomorrow, and the answer says the length", async () => {
  const q0 = parseQuestion({ action_id: "act-live-000000000001", rule: "destructive-shell", title: "Run a command", summary: "rm -rf ../a", reason_min: 12,
    lasts: "this action only", timeout_ms: 45_000, mode: "override", offers: { allow: false, always: true, ask: false, fifteen: false, hour: true, tomorrow: true }, harness: "claude", always_days: 30 });
  assert.equal(q0.offers.hour, true);
  assert.equal(q0.offers.tomorrow, true);
  assert.deepEqual(singleChoice({ ...q0, offers: { allow: false, always: false, ask: false, fifteen: false, hour: true } }), { label: "Allow for 1 hour", decision: "allow", lasts: "1h" });
  for (const [choice, lasts] of [["hour", "1h"], ["tomorrow", "tomorrow"]]) {
    const live = livePrompt({ fallback: async () => ({ decision: "deny" }) });
    const waited = live.wait(null, 5_000);
    const asked = live.prompter(q0);
    const q = await waited;
    assert.deepEqual(q.offers, { once: false, fifteen: false, hour: true, tomorrow: true, quiet: true, always: true, always_days: 30, always_needs_admin: false, ask: false, reviewed: false });
    assert.equal(live.answer({ action_id: q.action_id, choice: "once", reason: REASON }).outcome, "not_offered");
    assert.equal(live.answer({ action_id: q.action_id, choice, reason: REASON }, "dev").ok, true);
    assert.deepEqual(await asked, { decision: "allow", reason: REASON, lasts, os_user: "dev" });
  }
});
