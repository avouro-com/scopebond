// Fault: records cannot be delivered (the workspace answers 500). Sending them is Scopebond's job, never the person's: the
// agent retries with backoff by itself and starts again at once when a delivery works elsewhere; the tray stays "Protected"
// with no "Send records now" and no attention state. Only after 24 hours awake and online without a delivery does Settings
// say so, in one quiet row.
import { HOUR, MIN, agent, computer, seen, serve, tray, trayModel, until, waitingRecords, workspace, modelInput, hook } from "./b2-fault-helpers.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const NOW = Date.parse("2026-10-20T15:30:00");
const REFUSED = "ingest failed: HTTP 500";

test("records waiting are never the person's job: Protected, no Send records now, no attention, at 40 minutes or 23 hours", () => {
  for (const ageMs of [40 * MIN, 3 * HOUR, 23 * HOUR]) {
    const m = seen(trayModel(modelInput(NOW, { pending: 42, oldest_pending_age_s: ageMs / 1000, last_success_at: NOW - ageMs, last_error: REFUSED })));
    assert.equal(m.state, "protected", `waiting ${ageMs / MIN} min`);
    assert.equal(m.fix, null);
    assert.equal(m.sendNow, false, "no Send records now: the agent sends them");
    assert.equal(m.row("Delivery"), null, "nothing in Settings before a day");
  }
});

test("after 24 hours awake and online without a delivery, one quiet Settings row names the workspace and since when", () => {
  const since = NOW - 25 * HOUR;
  const m = seen(trayModel(modelInput(NOW, { pending: 42, oldest_pending_age_s: 30 * HOUR / 1000, last_success_at: since, last_error: REFUSED })));
  assert.equal(m.state, "protected", "still protected: the hook decides every action");
  assert.equal(m.fix, null);
  assert.equal(m.hint, null);
  const d = new Date(since);
  const at = `${d.toLocaleDateString("en-US", { weekday: "short" })} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  assert.equal(m.row("Delivery"), `Records can't reach Avouro since ${at}`);
  // Time asleep never counts: awake for two hours after a long sleep.
  const woke = seen(trayModel(modelInput(NOW, { pending: 42, oldest_pending_age_s: 30 * HOUR / 1000, last_success_at: since, last_error: REFUSED }, { awakeSince: NOW - 2 * HOUR })));
  assert.equal(woke.row("Delivery"), null);
  // Without the workspace's name: "your workspace".
  const unnamed = seen(trayModel(modelInput(NOW, { pending: 1, oldest_pending_age_s: 30 * HOUR / 1000, last_success_at: since, last_error: REFUSED }, { workspace: null })));
  assert.match(unnamed.row("Delivery"), /^Records can't reach your workspace since /);
});

test("the workspace answers 500: the agent keeps retrying by itself, the tray never asks, and the records go once it heals", async () => {
  const ws = workspace();
  const { dir, connection } = computer();
  ws.faults.ingest = 500;
  await waitingRecords(dir, connection, 3);
  const service = await serve(dir, ws, { intervalMs: 100 });
  try {
    await until(() => ws.calls.ingest >= 3, 10_000, "three delivery attempts");
    const m = seen(await tray(dir));
    assert.notEqual(m.state, "attention");
    assert.equal(m.sendNow, false);
    delete ws.faults.ingest;
    await until(async () => (await agent.callAgent(dir, "GET", "/status", undefined, 5_000)).delivery.pending === 0, 30_000, "the records delivered without Send now");
  } finally { await service.stop(); }
});

test("backing off, the agent starts again at once when a delivery worked elsewhere (the hook reached the workspace)", async () => {
  const ws = workspace();
  const { dir, connection } = computer();
  ws.faults.ingest = 500;
  await waitingRecords(dir, connection, 2);
  const service = await serve(dir, ws, { intervalMs: 100 });
  try {
    // Six failures: the next try is 100 ms × 2^6 = 6.4 s away.
    await until(() => ws.calls.ingest >= 6, 20_000, "six failed attempts");
    // ...and that sixth cycle over, so the agent is waiting out its backoff.
    await until(async () => (await agent.callAgent(dir, "GET", "/status", undefined, 5_000)).agent.cycle_started_at === null, 10_000, "the cycle over");
    delete ws.faults.ingest;
    // A hook call delivered its own record just now: the workspace is back.
    hook.writeDeliveryState(dir, { last_success_at: Date.now(), last_attempt_at: Date.now(), last_error: null, last_status: null });
    const started = Date.now();
    await until(async () => (await agent.callAgent(dir, "GET", "/status", undefined, 5_000)).delivery.pending === 0, 4_000, "sent at once, not after the backoff");
    assert.ok(Date.now() - started < 4_000);
  } finally { await service.stop(); }
});
