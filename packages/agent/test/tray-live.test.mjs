// The live prompt: when the hook asks during a coding session and a tray is listening, the question waits in the tray; the
// person answers there, or, when they do not open it in time, the Scopebond window opens for the time left. With no tray
// listening the window opens at once, as before.
import { test } from "node:test";
import assert from "node:assert/strict";
import { livePrompt } from "../dist/live-prompt.js";
import { parseQuestion, singleChoice, questionText, windowsScript } from "../dist/prompt.js";
import { callAgent } from "../dist/index.js";
import { computer, serviceFor } from "./tray-helpers.mjs";

const REASON = "Integration tests need the production API URL";
const question = (extra = {}) => parseQuestion({
  action_id: "act-live-000000000001", rule: "secret-read", title: "Reading a secret file", summary: ".env.production", reason_min: 12,
  lasts: "this action only", timeout_ms: 45_000, mode: "override", offers: { allow: true, always: true, ask: true, fifteen: true },
  harness: "claude", always_days: 30, ...extra,
});
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const later = (ms) => new Promise((r) => setTimeout(r, ms));

test("with no tray listening, the Scopebond window opens at once, as before", async () => {
  const shown = [];
  const live = livePrompt({ fallback: async (q) => { shown.push(q); return { decision: "deny" }; } });
  assert.deepEqual(await live.prompter(question()), { decision: "deny" });
  assert.equal(shown.length, 1);
  assert.equal(live.current(), null);
});

test("a listening tray gets the question, and the person's answer from its form is the hook's answer", async () => {
  const shown = [];
  const live = livePrompt({ fallback: async (q) => { shown.push(q); return { decision: "deny" }; } });
  const waited = live.wait(null, 5_000);
  const asked = live.prompter(question());
  const q = await waited;
  assert.equal(q.action_id, "act-live-000000000001");
  assert.equal(q.what, ".env.production");
  assert.equal(q.rule_title, "Reading a secret file");
  assert.equal(q.tool, "Claude Code");
  assert.deepEqual(q.offers, { once: true, fifteen: true, always: true, always_days: 30, always_needs_admin: false, ask: true, reviewed: false });
  assert.ok(Date.parse(q.deadline) > Date.now() + 40_000, "the hook's own wait");
  assert.equal(live.open(q.action_id), true);
  assert.deepEqual(live.answer({ action_id: q.action_id, choice: "once", reason: "too short" }), { ok: false, outcome: "reason_short", text: "Say why in at least 12 characters." });
  assert.equal(live.answer({ action_id: "act-other-0000000001", choice: "once", reason: REASON }).outcome, "gone");
  assert.equal(live.answer({ action_id: q.action_id, choice: "never", reason: REASON }).outcome, "invalid");
  assert.equal(live.answer({ action_id: q.action_id, choice: "fifteen", reason: REASON }, "dev").ok, true);
  assert.deepEqual(await asked, { decision: "allow", reason: REASON, lasts: "15m", os_user: "dev" });
  assert.equal(shown.length, 0, "no window");
  assert.equal(live.current(), null);
  assert.equal(live.answer({ action_id: q.action_id, choice: "once", reason: REASON }).outcome, "gone", "answered once");
});

test("not opened in the tray in time: withdrawn, and the window opens for the time that is left", async () => {
  const shown = [];
  const live = livePrompt({ fallback: async (q) => { shown.push(q); return { decision: "allow", reason: REASON, lasts: "once" }; }, openWithin: () => 50, minWindowMs: 1_000 });
  const waited = live.wait(null, 5_000);
  const asked = live.prompter(question({ timeout_ms: 20_000 }));
  await waited;
  assert.deepEqual(await asked, { decision: "allow", reason: REASON, lasts: "once" });
  assert.equal(shown.length, 1);
  assert.ok(shown[0].timeout_ms > 19_000 && shown[0].timeout_ms <= 20_000, `the time left: ${shown[0].timeout_ms}`);
  assert.equal(live.current(), null, "the tray no longer shows it");
});

test("opened in the tray: no window; unanswered at the hook's deadline, nothing is allowed", async () => {
  let shown = 0;
  const live = livePrompt({ fallback: async () => { shown += 1; return { decision: "allow", reason: REASON }; }, openWithin: () => 30 });
  const waited = live.wait(null, 5_000);
  const asked = live.prompter({ ...question(), timeout_ms: 300 });
  const q = await waited;
  live.open(q.action_id);
  assert.deepEqual(await asked, { decision: "deny" });
  assert.equal(shown, 0);
});

test("the tray's wait returns at once for a question it has not seen, and when the question changes", async () => {
  const live = livePrompt({ fallback: async () => ({ decision: "deny" }) });
  const t = Date.now();
  assert.equal(await live.wait(null, 80), null, "nothing waiting: after the wait");
  assert.ok(Date.now() - t >= 60);
  const first = live.wait(null, 5_000);
  const asked = live.prompter(question());
  const q = await first;
  assert.equal((await live.wait(null, 5_000)).action_id, q.action_id, "not seen yet: at once");
  const gone = live.wait(q.action_id, 5_000);
  live.answer({ action_id: q.action_id, choice: "ask", reason: REASON });
  assert.equal(await gone, null, "answered: the wait ends with nothing waiting");
  assert.deepEqual(await asked, { decision: "ask", reason: REASON });
  live.close();
});

test("through the agent: the hook's POST /override waits for the tray's answer; without a tray the window answers", async () => {
  const shown = [];
  const dir = computer();
  const service = await serviceFor(dir, { prompter: async (q) => { shown.push(q); return { decision: "deny" }; } });
  try {
    const body = { action_id: "act-live-000000000001", rule: "secret-read", title: "Reading a secret file", summary: ".env.production", reason_min: 12,
      lasts: "this action only", timeout_ms: 20_000, mode: "ask", offers: { allow: false, always: false, ask: true }, harness: "codex" };
    // No tray: the window, as before.
    assert.deepEqual(await callAgent(dir, "POST", "/override", body, 10_000), { decision: "deny" });
    assert.equal(shown.length, 1);
    // A tray waits; the hook asks; the tray's person asks to unblock.
    const waited = callAgent(dir, "POST", "/override/wait", { seen: null }, 25_000);
    await later(100);
    const hook = callAgent(dir, "POST", "/override", body, 25_000);
    const { question: q } = await waited;
    assert.equal(q.tool, "Codex");
    assert.deepEqual(q.offers, { once: false, fifteen: false, always: false, always_days: null, always_needs_admin: false, ask: true, reviewed: false });
    assert.equal((await callAgent(dir, "GET", "/tray", undefined, 10_000)).tray.pending.action_id, q.action_id);
    assert.equal((await callAgent(dir, "POST", "/override/open", { action_id: q.action_id }, 10_000)).opened, true);
    assert.equal((await callAgent(dir, "POST", "/override/answer", { action_id: q.action_id, choice: "once", reason: REASON }, 10_000)).outcome, "not_offered");
    const done = await callAgent(dir, "POST", "/override/answer", { action_id: q.action_id, choice: "ask", reason: REASON }, 10_000);
    assert.equal(done.outcome, "asked");
    assert.match(done.text, /^Request (sent|saved)/);
    const answer = await hook;
    assert.equal(answer.decision, "ask");
    assert.equal(answer.reason, REASON);
    assert.equal(shown.length, 1, "no window for the answered question");
    assert.equal((await callAgent(dir, "GET", "/tray", undefined, 10_000)).tray.pending, null);
  } finally { await service.stop(); }
});

test("the window's words: ask to unblock; macOS and Linux offer the workspace's one length", () => {
  const ask = question({ mode: "ask", offers: { allow: false, always: false, ask: true } });
  assert.ok(windowsScript(ask).includes(b64("Ask to unblock")));
  assert.ok(!windowsScript(ask).includes(b64("Ask an admin")));
  assert.match(questionText(ask), /You may ask to unblock it; an admin decides\./);
  assert.deepEqual(singleChoice(ask), { label: "Ask to unblock", decision: "ask" });
  assert.deepEqual(singleChoice(question()), { label: "Allow once", decision: "allow", lasts: "once" });
  assert.deepEqual(singleChoice(question({ offers: { allow: false, always: false, ask: false, fifteen: true } })), { label: "Allow for 15 min", decision: "allow", lasts: "15m" });
  assert.deepEqual(singleChoice(question({ offers: { allow: false, always: true, ask: false, fifteen: false } })), { label: "Always allow", decision: "allow", lasts: "always" });
  assert.equal(singleChoice(question({ offers: { allow: false, always: false, ask: false, fifteen: false } })), null);
  const extra = question({ harness: "Not A Tool", reviewed: true, always_days: 999, project: "checkout" });
  assert.equal(extra.harness, undefined, "only a tool id");
  assert.equal(extra.reviewed, true);
  assert.equal(extra.always_days, undefined, "within a year");
  assert.equal(extra.project, "checkout");
});
