// The tray's rule counts: every rule that blocks (the starter rules, the workspace's own, the packs' rules on Block and each
// service the workspace blocks by name), the rules that only record and the packs in force, from the hook's rule summary.
// "Rules updated" is the last successful check; a failed one is passed on as its own time and error. Older fields stay.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ruleSummary, readMeta } from "@scopebond/hook";
import { callAgent } from "../dist/index.js";
import { trayModel } from "../dist/tray-model.js";
import { healthOf } from "../dist/health.js";
import { computer, serviceFor } from "./tray-helpers.mjs";

const MIN = 60_000;
const NOW = Date.parse("2026-10-21T12:00:00Z");
const status = () => ({
  schema: "scopebond.status.v1", version: "0.40.0", state: "delivering",
  delivery: { connected: true, last_success_at: NOW - MIN, last_attempt_at: NOW - MIN, last_error: null, last_error_code: null, connection_refused_since: null, pending: 0, oldest_pending_age_s: null, gaps_by_reason: {}, queue_error: null },
  identity: { installation_id: "gw-1", generation: 1, key_kid: "key:1", credential_expires_at: null },
  config: { active: "C:/x", others: [], user_connection_shadowed: false }, agents: { claude: true, cursor: false, codex: false },
});

test("the tray model passes the rule counts, the packs and the last check on, beside the older fields", () => {
  const packs = [{ id: "cloud-clis", version: "1.2.0", title: "Cloud CLIs" }];
  const m = trayModel({
    status: status(), health: healthOf(status(), null), now: NOW, awakeSince: NOW - 600 * MIN, working: null,
    rules: { checked_at: NOW - 3 * MIN, managed: true, block: 9, monitor: 2, blocking: 9, monitoring: 2, packs, last_attempt_at: NOW - MIN, last_error: "could not reach the workspace (TypeError); the rules in force stay" },
    today: null, version: { agent: "0.5.0", hook: "0.40.0", policy: "recommended", recommendedAgent: null, recommendedHook: null },
    workspace: null, computerName: "LAPTOP",
  });
  assert.deepEqual(m.rules, { managed: true, blocking: 9, monitoring: 2, packs, checked_at: NOW - 3 * MIN, last_attempt_at: NOW - MIN,
    last_error: "could not reach the workspace (TypeError); the rules in force stay" });
  assert.match(m.rows[0].value, /· 9 block · 2 monitor$/, "the older row counts every rule too");
  // An older input without the new fields: the model still reads, from the older counts.
  const old = trayModel({
    status: status(), health: healthOf(status(), null), now: NOW, awakeSince: NOW - 600 * MIN, working: null,
    rules: { checked_at: NOW - 3 * MIN, managed: true, block: 3, monitor: 1 }, today: null,
    version: { agent: "0.5.0", hook: "0.40.0", policy: "recommended", recommendedAgent: null, recommendedHook: null }, workspace: null, computerName: "LAPTOP",
  });
  assert.deepEqual(old.rules, { managed: true, blocking: 3, monitoring: 1, packs: [], checked_at: NOW - 3 * MIN, last_attempt_at: null, last_error: null });
});

test("through the agent: the tray's rules come from the hook's summary and the last successful check", async () => {
  const dir = computer();
  writeFileSync(join(dir, "managed-meta.json"), JSON.stringify({ checked_at: "2026-10-21T11:00:00.000Z", last_attempt_at: "2026-10-21T11:30:00.000Z", last_error: "the workspace answered 503; the rules in force stay" }));
  const service = await serviceFor(dir);
  try {
    const { tray } = await callAgent(dir, "GET", "/tray", undefined, 10_000);
    const summary = ruleSummary(dir);
    assert.ok(summary.blocking >= 4, `${summary.blocking}`);
    assert.equal(tray.rules.blocking, summary.blocking);
    assert.equal(tray.rules.monitoring, summary.monitoring);
    assert.deepEqual(tray.rules.packs, []);
    assert.equal(tray.rules.managed, true);
    assert.equal(tray.rules.checked_at, Date.parse(readMeta(dir).checked_at));
    assert.equal(tray.rules.last_attempt_at, Date.parse("2026-10-21T11:30:00.000Z"));
    assert.equal(tray.rules.last_error, "the workspace answered 503; the rules in force stay");
  } finally { await service.stop(); }
});
