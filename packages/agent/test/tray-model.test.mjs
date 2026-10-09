// The tray draws the agent's model (SB387, SB388): one state with its own badge, one headline, rows only when there is data,
// the one fix when something is wrong, and time asleep never counted as records waiting.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkResult, trayModel, unreachable, WAITING_ATTENTION_MS } from "../dist/tray-model.js";
import { healthOf } from "../dist/health.js";

const MIN = 60_000;
const NOW = Date.parse("2026-10-07T12:00:00Z");

function status(delivery = {}, extra = {}) {
  return {
    schema: "scopebond.status.v1", version: "0.21.0", state: "delivering",
    delivery: { connected: true, last_success_at: NOW - MIN, last_attempt_at: NOW - MIN, last_error: null, last_error_code: null, connection_refused_since: null, pending: 0, oldest_pending_age_s: null, gaps_by_reason: {}, queue_error: null, ...delivery },
    identity: { installation_id: "gw-1", generation: 1, key_kid: "key:1", credential_expires_at: null },
    config: { active: "C:/x", others: [], user_connection_shadowed: false },
    agents: { claude: true, cursor: false, codex: false },
    ...extra,
  };
}
const input = (s, over = {}) => ({
  status: s, health: healthOf(s, null), now: NOW, awakeSince: NOW - 10 * 60 * MIN, working: null,
  rules: { checked_at: NOW - 3 * MIN, managed: true, block: 3, monitor: 1 },
  today: { actions: 312, blocked: 3, allowed_by_person: 0 },
  version: { agent: "0.5.0", hook: "0.21.0", policy: "recommended", recommendedAgent: "0.5.0", recommendedHook: "0.21.0" },
  workspace: { name: "Avouro", environment: "Staging US", computer_url: null }, computerName: "LAPTOP",
  ...over,
});

test("protected: no badge, the rows that have data, Check now, and a tooltip naming the workspace", () => {
  const m = trayModel(input(status()));
  assert.equal(m.state, "protected");
  assert.equal(m.fix, null);
  assert.deepEqual(m.rows.map((r) => r.label), ["Rules", "Delivery", "Today", "Version"]);
  assert.match(m.rows[0].value, /^Up to date · checked 3 min ago · 3 block · 1 monitor$/);
  assert.equal(m.rows[1].value, "All sent · 1 min ago");
  assert.equal(m.rows[2].value, "312 actions · 3 blocked");
  assert.equal(m.rows[3].value, "Up to date (agent 0.5.0)");
  assert.deepEqual(m.actions.map((a) => a.id), ["check_now"]);
  assert.equal(m.tooltip, "Scopebond — Protected · Avouro · Staging US");
  assert.ok(m.tooltip.length <= 63);
});

test("records waiting: attention only after 15 minutes of awake time, with Send records now as the fix", () => {
  const waiting = (ageMin, awakeMin) => trayModel(input(status({ pending: 42, oldest_pending_age_s: ageMin * 60 }), { awakeSince: NOW - awakeMin * MIN }));
  assert.equal(waiting(5, 600).state, "protected", "five minutes is normal");
  assert.deepEqual(waiting(5, 600).actions.map((a) => a.id), ["send_now", "check_now"]);
  const stuck = waiting(40, 600);
  assert.equal(stuck.state, "attention");
  assert.equal(stuck.headline, "42 records waiting to send");
  assert.equal(stuck.fix.id, "send_now");
  // The laptop slept: the records are four hours old but it woke two minutes ago.
  assert.equal(waiting(240, 2).state, "protected", "time asleep never counts");
  assert.ok(WAITING_ATTENTION_MS === 15 * MIN);
});

test("workspace unreachable is offline (grey) for four hours, then needs attention; records wait", () => {
  const down = (sinceMin) => trayModel(input(status({ pending: 7, oldest_pending_age_s: sinceMin * 60, last_error: "fetch failed (ENOTFOUND)", last_success_at: NOW - sinceMin * MIN })));
  const short = down(30);
  assert.equal(short.state, "offline");
  assert.match(short.headline, /Workspace unreachable: 7 records waiting/);
  assert.match(short.rows.find((r) => r.label === "Delivery").value, /^7 waiting since \d\d:\d\d · offline$/);
  assert.equal(down(5 * 60).state, "attention");
  assert.equal(unreachable("ingest failed: HTTP 503"), false, "an answer is not unreachable");
});

test("a refused connection is disconnected (slate), with the sign-in hint; a broken setup is a problem with Repair", () => {
  const refused = trayModel(input(status({ connection_refused_since: NOW - 60 * MIN, last_error: "ingest failed: HTTP 401" })));
  assert.equal(refused.state, "disconnected");
  assert.match(refused.headline, /using this computer's own rules/);
  assert.equal(refused.fix, null);
  assert.match(refused.hint, /Sign in again/);
  assert.equal(trayModel(input(status({ connection_refused_since: NOW - 60 * MIN, last_error: "ingest failed: HTTP 401" }), { canReconnect: true })).fix.id, "reconnect");
  assert.deepEqual(refused.actions.map((a) => a.id), ["check_now"], "no Send now: the workspace refuses");
  const broken = trayModel(input(status({}, { state: "not_governing" })));
  assert.equal(broken.state, "problem");
  assert.equal(broken.fix.id, "repair");
});

test("a newer recommended version offers Update now; on hold it says the workspace manages updates", () => {
  const newer = trayModel(input(status(), { version: { agent: "0.4.6", hook: "0.20.1", policy: "recommended", recommendedAgent: "0.5.0", recommendedHook: "0.21.0" } }));
  assert.ok(newer.actions.some((a) => a.id === "update_now"));
  assert.equal(newer.rows.at(-1).value, "Update available (agent 0.5.0)");
  const held = trayModel(input(status(), { version: { agent: "0.4.6", hook: "0.20.1", policy: "hold", recommendedAgent: "0.5.0", recommendedHook: null } }));
  assert.ok(!held.actions.some((a) => a.id === "update_now"));
  assert.match(held.rows.at(-1).value, /updates managed by your workspace/);
  const working = trayModel(input(status(), { working: "Updating Scopebond…" }));
  assert.equal(working.state, "working");
});

test("rows without data are left out, never shown as unknown", () => {
  const m = trayModel(input(status({ connected: false }), { rules: null, today: null }));
  assert.deepEqual(m.rows.map((r) => r.label), ["Version"]);
  assert.ok(!JSON.stringify(m).includes("unknown"));
});

test("Check now always says what it found", () => {
  assert.equal(checkResult({ ok: true, failed: [] }, null), "Checked just now: all good");
  assert.equal(checkResult({ ok: false, failed: ["autostart"] }, null), "Check found a problem: autostart");
  assert.match(checkResult(null, null), /not connected/);
  assert.match(checkResult(null, "timeout"), /could not finish: timeout/);
});

test("the tray script takes the home and agent id as data and draws all six states", async () => {
  const { trayScript } = await import("../dist/tray.js");
  const script = trayScript("D:/work/x';Remove-Item C:/ -Recurse;'", 42);
  assert.doesNotMatch(script, /Remove-Item C:/);
  for (const s of ["protected", "working", "offline", "attention", "problem", "disconnected"]) assert.match(script, new RegExp(`'${s}'`));
  assert.match(script, /GET' '\/tray'/);
  assert.match(script, /'Problems only'/);
});

test("a workspace at its monthly limit is said plainly, not 'sending'; another refusal names its status", () => {
  const atLimit = trayModel(input(status({ pending: 6037, oldest_pending_age_s: 4 * 3600, last_error: "ingest failed: HTTP 429 (quota): The workspace reached its monthly limit. Records stay queued on the computer and send once the limit allows." })));
  assert.equal(atLimit.state, "attention");
  assert.equal(atLimit.headline, "Workspace limit reached: 6037 records waiting");
  assert.equal(atLimit.fix?.id, "open_workspace");
  assert.match(atLimit.hint, /monthly limit/);
  assert.equal(atLimit.rows.find((r) => r.label === "Delivery")?.value, "6037 waiting · workspace limit reached");
  const refused = trayModel(input(status({ pending: 4, oldest_pending_age_s: 60, last_error: "ingest failed: HTTP 413: too large" })));
  assert.equal(refused.rows.find((r) => r.label === "Delivery")?.value, "4 waiting · last try refused (HTTP 413)");
});

test("after a restart of the agent alone, waiting counts from the saved wake time, so a backlog is attention at once", async () => {
  const { awakeSinceAtStart } = await import("../dist/index.js");
  const H = 60 * MIN;
  const gap = 5 * MIN;
  const boot = NOW - 48 * H;
  const uptimeMs = NOW - boot;
  // The agent restarted 30 s after its last cycle; the computer has been awake for four hours.
  const since = awakeSinceAtStart({ saved: { awake_since: NOW - 4 * H, last_cycle_at: NOW - 30_000 }, now: NOW, uptimeMs, allowedGapMs: gap });
  assert.equal(since, NOW - 4 * H);
  const model = trayModel(input(status({ pending: 42, oldest_pending_age_s: 4 * 3600 }), { awakeSince: since }));
  assert.equal(model.state, "attention");
  // Restarted soon after a cycle, with a saved wake time from before the computer last started: from its start.
  assert.equal(awakeSinceAtStart({ saved: { awake_since: NOW - 30 * H, last_cycle_at: NOW - 30_000 }, now: NOW, uptimeMs: 2 * H, allowedGapMs: gap }), NOW - 2 * H);
  // The computer was switched off and started 10 minutes ago: awake since it started, never since before.
  assert.equal(awakeSinceAtStart({ saved: { awake_since: NOW - 30 * H, last_cycle_at: NOW - 20 * H }, now: NOW, uptimeMs: 10 * MIN, allowedGapMs: gap }), NOW - 10 * MIN);
  // A long gap with no restart of the computer (asleep, or the agent stopped): from now, as before; sleep never counts.
  assert.equal(awakeSinceAtStart({ saved: { awake_since: NOW - 30 * H, last_cycle_at: NOW - 3 * H }, now: NOW, uptimeMs, allowedGapMs: gap }), NOW);
  // Nothing saved, or a saved time from the future (a clock that moved back): from now.
  assert.equal(awakeSinceAtStart({ saved: null, now: NOW, uptimeMs, allowedGapMs: gap }), NOW);
  assert.equal(awakeSinceAtStart({ saved: { awake_since: NOW - H, last_cycle_at: NOW + H }, now: NOW, uptimeMs, allowedGapMs: gap }), NOW);
});

test("after a long gap without a restart of the computer, the waiting records decide where waiting counts from", async () => {
  const { awakeSinceAtStart } = await import("../dist/index.js");
  const H = 60 * MIN;
  const gap = 5 * MIN;
  const uptimeMs = 48 * H;
  const saved = { awake_since: NOW - 30 * H, last_cycle_at: NOW - 3 * H };
  // A record written two hours ago, after the last cycle: the hook ran while the agent did not, so the computer was awake.
  // Waiting counts from the record at once, not 15 minutes from now.
  const written = awakeSinceAtStart({ saved, now: NOW, uptimeMs, allowedGapMs: gap, oldestPendingAt: NOW - 2 * H });
  assert.equal(written, NOW - 2 * H);
  const backlog = trayModel(input(status({ pending: 12, oldest_pending_age_s: 2 * 3600 }), { awakeSince: written }));
  assert.equal(backlog.state, "attention");
  // ...never from before the computer's start.
  assert.equal(awakeSinceAtStart({ saved: { awake_since: NOW - 30 * H, last_cycle_at: NOW - 3 * H }, now: NOW, uptimeMs: 2.5 * H, allowedGapMs: gap, oldestPendingAt: NOW - 2.75 * H }), NOW - 2.5 * H);
  // A record already waiting at the last cycle: the 40 minutes it waited while the agent ran still count, the three-hour
  // gap (perhaps asleep, perhaps shut down with Fast Startup) does not.
  const older = awakeSinceAtStart({ saved, now: NOW, uptimeMs, allowedGapMs: gap, oldestPendingAt: NOW - 3 * H - 40 * MIN });
  assert.equal(older, NOW - 40 * MIN);
  const carried = trayModel(input(status({ pending: 3, oldest_pending_age_s: (3 * 3600) + 40 * 60 }), { awakeSince: older }));
  assert.equal(carried.state, "attention");
  // Only five minutes before the gap: not yet attention, and the gap still never counts.
  const brief = awakeSinceAtStart({ saved, now: NOW, uptimeMs, allowedGapMs: gap, oldestPendingAt: NOW - 3 * H - 5 * MIN });
  assert.equal(brief, NOW - 5 * MIN);
  assert.notEqual(trayModel(input(status({ pending: 3, oldest_pending_age_s: (3 * 3600) + 5 * 60 }), { awakeSince: brief })).state, "attention");
  // The time before the gap is bounded by the saved wake time: a record older than the last wake counts from the wake.
  assert.equal(awakeSinceAtStart({ saved: { awake_since: NOW - 3 * H - 10 * MIN, last_cycle_at: NOW - 3 * H }, now: NOW, uptimeMs, allowedGapMs: gap, oldestPendingAt: NOW - 20 * H }), NOW - 10 * MIN);
  // Nothing waiting, or a record time from the future: from now.
  assert.equal(awakeSinceAtStart({ saved, now: NOW, uptimeMs, allowedGapMs: gap, oldestPendingAt: null }), NOW);
  assert.equal(awakeSinceAtStart({ saved, now: NOW, uptimeMs, allowedGapMs: gap, oldestPendingAt: NOW + MIN }), NOW);
  // After the computer was switched off, the record counts from the computer's start.
  const rebooted = awakeSinceAtStart({ saved, now: NOW, uptimeMs: 30 * MIN, allowedGapMs: gap, oldestPendingAt: NOW - 5 * H });
  assert.equal(rebooted, NOW - 30 * MIN);
  assert.equal(trayModel(input(status({ pending: 3, oldest_pending_age_s: 5 * 3600 }), { awakeSince: rebooted })).state, "attention");
});

test("an agent the workspace's plan paused says so, with Open workspace as the fix, not Send records now", () => {
  const m = trayModel(input(status({ pending: 12, oldest_pending_age_s: 3 * 60 * 60, last_error: "ingest failed: HTTP 402 (agent_paused)" }), { awakeSince: NOW - 3 * 60 * MIN }));
  assert.match(m.headline, /^Paused by your workspace's plan: 12 records waiting$/);
  assert.equal(m.fix.id, "open_workspace");
});

test("today: an edit recorded after it ran is shown apart from blocks, never added to them", () => {
  const m = trayModel(input(status(), { today: { actions: 10, blocked: 2, recorded_after: 1, allowed_by_person: 0 } }));
  assert.equal(m.rows.find((r) => r.label === "Today").value, "10 actions · 2 blocked · 1 recorded, not prevented");
});
