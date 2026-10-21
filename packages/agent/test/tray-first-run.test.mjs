// First run and updates, as the tray model tells them: the sign-in code whole in the tooltip, the first sign-in marked (so the
// tray tells no problem meanwhile and "Connected to …" once after), and the update this computer took, for a day.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentVersion, callAgent, noteRunningVersion, recentUpdate, UPDATED_SHOWN_MS, VERSION_SEEN_FILE } from "../dist/index.js";
import { trayModel } from "../dist/tray-model.js";
import { healthOf } from "../dist/health.js";
import { computer, serviceFor } from "./tray-helpers.mjs";

const NOW = Date.parse("2026-10-21T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function status(connected) {
  return {
    schema: "scopebond.status.v1", version: "0.21.0", state: connected ? "delivering" : "not_governing",
    delivery: { connected, last_success_at: connected ? NOW - 60_000 : null, last_attempt_at: null, last_error: null, last_error_code: null, connection_refused_since: null, pending: 0, oldest_pending_age_s: null, gaps_by_reason: {}, queue_error: null },
    identity: { installation_id: connected ? "gw-1" : null, generation: connected ? 1 : 0, key_kid: null, credential_expires_at: null },
    config: { active: "C:/x", others: [], user_connection_shadowed: false },
    agents: { claude: connected, cursor: false, codex: false },
  };
}
const model = (connected, over = {}) => {
  const s = status(connected);
  return trayModel({
    status: s, health: healthOf(s, null, { kind: "per-user", platform: "win32" }), now: NOW, awakeSince: NOW - DAY, working: null, rules: null, today: null,
    version: { agent: "0.11.5", hook: "0.21.0", policy: "unknown", recommendedAgent: null, recommendedHook: null },
    workspace: connected ? { name: "A workspace with a rather long name for a tooltip", environment: "Production", computer_url: null } : null,
    computerName: "PC", canSignIn: true, ...over,
  });
};

test("a sign-in waiting: the tooltip carries the code whole, within 63 characters", () => {
  const waiting = model(false, { signingIn: { user_code: "BCDF-GHJK", verification_url: "https://x.example.test" } });
  assert.equal(waiting.tooltip, "Scopebond: approve code BCDF-GHJK");
  assert.equal(waiting.sign_in_code, "BCDF-GHJK");
  // Signing in again (connected, a long workspace name): still the code, not a headline cut before it.
  const again = model(true, { signingIn: { user_code: "WXYZ-MNPQ", verification_url: "https://x.example.test" } });
  assert.equal(again.tooltip, "Scopebond: approve code WXYZ-MNPQ");
  assert.equal(again.first_sign_in, false, "a sign-in again is not the first");
  const protectedNow = model(true);
  assert.equal(protectedNow.sign_in_code, null);
  assert.ok(protectedNow.tooltip.length <= 63);
});

test("the first sign-in is marked until this computer is connected", () => {
  assert.equal(model(false).first_sign_in, true, "never connected: the first sign-in is still to come");
  assert.equal(model(false, { signingIn: { user_code: "BCDF-GHJK", verification_url: "https://x.example.test" } }).first_sign_in, true);
  assert.equal(model(true).first_sign_in, false);
  // An npm install signs in from a terminal: no first sign-in in the tray.
  assert.equal(model(false, { canSignIn: false }).first_sign_in, false);
});

test("the update this computer took is noted once per version, and named in the model for a day", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-version-seen-"));
  assert.equal(noteRunningVersion(dir, "0.11.4", NOW), null, "a first start here is not an update");
  assert.equal(noteRunningVersion(dir, "0.11.4", NOW + 1_000), null, "the same version again");
  const updated = noteRunningVersion(dir, "0.11.5", NOW + 2_000);
  assert.deepEqual(updated, { from: "0.11.4", to: "0.11.5", at: new Date(NOW + 2_000).toISOString() });
  // A restart of the same version keeps the note (a tray that starts later still tells it).
  assert.deepEqual(noteRunningVersion(dir, "0.11.5", NOW + 60_000), updated);
  assert.deepEqual(recentUpdate(updated, NOW + 60_000), updated);
  assert.equal(recentUpdate(updated, NOW + 2_000 + UPDATED_SHOWN_MS), null, "a day later it is no longer named");
  assert.equal(recentUpdate(null, NOW), null);
  // Going back to an older version is not "Updated to".
  assert.equal(noteRunningVersion(dir, "0.11.3", NOW + 120_000), null);
  assert.equal(JSON.parse(readFileSync(join(dir, VERSION_SEEN_FILE), "utf8")).version, "0.11.3");
  // A file that cannot be read is a first start.
  writeFileSync(join(dir, VERSION_SEEN_FILE), "not json");
  assert.equal(noteRunningVersion(dir, "0.11.5", NOW), null);
  assert.equal(noteRunningVersion(dir, "not a version", NOW), null);
  // The model passes it on as given.
  assert.deepEqual(model(true, { updated }).updated, updated);
  assert.equal(model(true).updated, null);
});

test("an agent starting after an update names it in its tray model", async () => {
  const dir = computer();
  writeFileSync(join(dir, VERSION_SEEN_FILE), JSON.stringify({ version: "0.0.1", updated: null }));
  const service = await serviceFor(dir);
  try {
    const { tray } = await callAgent(dir, "GET", "/tray", undefined, 10_000);
    assert.equal(tray.updated?.from, "0.0.1");
    assert.equal(tray.updated?.to, agentVersion());
    assert.equal(tray.first_sign_in, false, "an npm install signs in from a terminal");
  } finally { await service.stop(); }
});
