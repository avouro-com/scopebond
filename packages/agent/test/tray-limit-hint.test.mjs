// At the workspace's monthly limit the tray says what is true: records wait on this computer and send once the limit
// allows. It says a plan change lifts the limit only when the workspace said so, and then names the limit that plan gives.
import { test } from "node:test";
import assert from "node:assert/strict";
import { trayModel } from "../dist/tray-model.js";
import { healthOf } from "../dist/health.js";

const MIN = 60_000;
const NOW = Date.parse("2026-10-08T12:00:00Z");
const REFUSED = "ingest failed: HTTP 429 (quota): The workspace reached its monthly limit. Records stay queued on the computer and send once the limit allows.";
function status(delivery = {}) {
  return {
    schema: "scopebond.status.v1", version: "0.21.1", state: "delivering",
    delivery: { connected: true, last_success_at: NOW - 120 * MIN, last_attempt_at: NOW - MIN, last_error: null, last_error_code: null, connection_refused_since: null, pending: 0, oldest_pending_age_s: null, gaps_by_reason: {}, queue_error: null, ...delivery },
    identity: { installation_id: "gw-1", generation: 1, key_kid: "key:1", credential_expires_at: null },
    config: { active: "C:/x", others: [], user_connection_shadowed: false },
    agents: { claude: true, cursor: false, codex: false },
  };
}
const input = (s) => ({
  status: s, health: healthOf(s, null), now: NOW, awakeSince: NOW - 600 * MIN, working: null,
  rules: { checked_at: NOW - 3 * MIN, managed: true, block: 3, monitor: 1 }, today: { actions: 30, blocked: 0, allowed_by_person: 0 },
  version: { agent: "0.5.2", hook: "0.21.1", policy: "recommended", recommendedAgent: "0.5.2", recommendedHook: "0.21.1" },
  workspace: { name: "W", environment: "E", computer_url: null }, computerName: "LAPTOP",
});
const atLimit = (lastError) => trayModel(input(status({ pending: 120, oldest_pending_age_s: 60 * 60, last_error: lastError })));

test("the monthly limit is named and, with no word from the workspace about plans, the hint promises no plan change", () => {
  const m = atLimit(REFUSED);
  assert.equal(m.state, "attention");
  assert.match(m.headline, /^Workspace limit reached/);
  assert.equal(m.fix?.id, "open_workspace");
  assert.match(m.hint, /monthly limit/);
  assert.match(m.hint, /send once the limit allows/);
  assert.doesNotMatch(m.hint, /plan/i, "nothing says a plan change lifts it");
});

test("when the workspace says a plan change lifts the limit, the hint says to how many records a month", () => {
  const m = atLimit(`${REFUSED} [plan_lifts_to=250000]`);
  assert.match(m.headline, /^Workspace limit reached/);
  assert.match(m.hint, /send once the limit allows/);
  assert.match(m.hint, /plan that allows 250,000 records a month/);
});

test("a malformed hint is ignored", () => {
  for (const tail of [" [plan_lifts_to=]", " [plan_lifts_to=abc]", " [plan_lifts_to=0]", " [plan_lifts_to=250000] trailing"]) {
    assert.doesNotMatch(atLimit(`${REFUSED}${tail}`).hint, /plan/i, tail);
  }
});
