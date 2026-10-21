// From the tray's own form: a person answers an earlier block (allow once, for 15 minutes, always, or ask an admin) with a
// reason. The agent checks it again as the Scopebond window would, applies it as the window's answer is applied, and sends
// it to the workspace signed by this computer's key. The Allowed and Requests lists show what came of it.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MANAGED_DOC_FILE, readAllowances, readBlocked, readRequests, makeAllowance } from "@scopebond/hook";
import { callAgent } from "../dist/index.js";
import { parseBlockedAnswer, answerText, readTraySettings, writeTraySettings, settleTraySettings } from "../dist/service.js";
import { computer, blockActions, serviceFor } from "./tray-helpers.mjs";

const REASON = "Integration tests need the production API URL";

async function blockedComputer(rules) {
  const dir = computer(rules);
  await blockActions(dir, [{ tool_name: "Bash", tool_input: { command: "rm -rf ../build" } }]);
  return { dir, id: readBlocked(dir).at(-1).id };
}
const answer = (dir, body) => callAgent(dir, "POST", "/blocked/answer", body, 10_000);

test("an answer from the form is read strictly", () => {
  assert.deepEqual(parseBlockedAnswer({ action_id: "act-1", choice: "fifteen", reason: `  ${REASON}  ` }), { action_id: "act-1", choice: "fifteen", reason: REASON });
  for (const bad of [null, {}, { action_id: "act-1", choice: "forever", reason: REASON }, { action_id: "a b", choice: "once", reason: REASON },
    { action_id: "act-1", choice: "once", reason: "x".repeat(501) }, { action_id: "act-1", choice: "once", reason: "ok\u0007bell" }, { action_id: "act-1", choice: "once", reason: 42 }]) {
    assert.equal(parseBlockedAnswer(bad), null, JSON.stringify(bad));
  }
  // No reason is an empty one; the workspace's minimum decides whether that is enough.
  assert.deepEqual(parseBlockedAnswer({ action_id: "act-1", choice: "once" }), { action_id: "act-1", choice: "once", reason: "" });
  assert.equal(answerText("allowed", "once", 30, "Acme", true), "Allowed once · recorded in Acme");
  assert.equal(answerText("allowed", "always", 14, null, true), "Allowed for 14 days · recorded in your workspace");
  assert.equal(answerText("asked", "ask", 30, "Acme", true), "Request sent · the answer shows on the block");
  assert.equal(answerText("asked", "ask", 30, "Acme", false), "Request saved, sent once this computer is connected · the answer shows on the block");
});

test("allow once from the tray: checked as the window would be, applied once, then no longer offered", async () => {
  const { dir, id } = await blockedComputer();
  const service = await serviceFor(dir);
  try {
    assert.equal((await answer(dir, { action_id: "act-unknown-000000001", choice: "once", reason: REASON })).outcome, "gone");
    assert.equal((await answer(dir, { action_id: id, choice: "once", reason: "too short" })).outcome, "reason_short", "the workspace's minimum (12)");
    assert.equal((await answer(dir, { action_id: id, choice: "once", reason: 42 })).outcome, "invalid");
    const done = await answer(dir, { action_id: id, choice: "once", reason: REASON });
    assert.deepEqual(done, { outcome: "allowed", choice: "once", text: "Allowed once: rm -rf ../build (in /repo) · recorded on this computer" });
    const made = readAllowances(dir).at(-1);
    assert.equal(made.once, true);
    assert.equal(made.reason, REASON);
    assert.equal(readBlocked(dir).at(-1).acted, "allowed");
    assert.equal((await answer(dir, { action_id: id, choice: "once", reason: REASON })).outcome, "gone", "answered once");
    const { allowances } = await callAgent(dir, "GET", "/allowances", undefined, 10_000);
    assert.equal(allowances.length, 1);
    assert.equal(allowances[0].choice, "once");
    assert.equal(allowances[0].what, "rm -rf ../build (in /repo)");
    assert.equal(allowances[0].rule_title, "Run a command that deletes data or shuts down the computer");
    const { tray } = await callAgent(dir, "GET", "/tray", undefined, 10_000);
    assert.equal(tray.allowed.length, 1);
    assert.equal(tray.recent_blocks[0].acted, "allowed");
  } finally { await service.stop(); }
});

test("only a choice the workspace offers is applied; always waits for an admin and covers 15 minutes meanwhile", async () => {
  const { dir, id } = await blockedComputer({ "destructive-shell": { mode: "override", override: { reason_min: 12, minutes: 0, daily_limit: 5, harness_prompt: false, always: "needs_admin", always_days: 14 } } });
  const service = await serviceFor(dir);
  try {
    assert.equal((await answer(dir, { action_id: id, choice: "ask", reason: REASON })).outcome, "not_offered", "asking is not on");
    assert.equal(readRequests(dir).length, 0);
    const done = await answer(dir, { action_id: id, choice: "always", reason: REASON });
    assert.equal(done.outcome, "proposed");
    assert.equal(done.text, "Allowed for 15 minutes while an admin decides on 14 days: rm -rf ../build (in /repo) · recorded on this computer");
    const { allowances } = await callAgent(dir, "GET", "/allowances", undefined, 10_000);
    assert.deepEqual(allowances.map((a) => [a.choice, a.state, a.needs_admin]).sort(), [["always", "proposed", true], ["fifteen", "active", false]]);
    assert.ok(allowances.every((a) => a.what === "rm -rf ../build (in /repo)"));
  } finally { await service.stop(); }
});

test("ask an admin from the tray: the request waits, then shows the admin's answer when the workspace sends it", async () => {
  const { dir, id } = await blockedComputer({ "destructive-shell": { mode: "ask", override: { reason_min: 12, minutes: 0, daily_limit: 5, harness_prompt: false, requests: true } } });
  const service = await serviceFor(dir);
  try {
    assert.equal((await answer(dir, { action_id: id, choice: "once", reason: REASON })).outcome, "not_offered", "'Block, person may ask' never allows on the spot");
    // Only an admin unblocks: the tray is told that asking is all there is, and shows Ask to unblock and its Requests list.
    const before = (await callAgent(dir, "GET", "/tray", undefined, 10_000)).tray;
    assert.deepEqual(before.recent_blocks[0].offers, { once: false, fifteen: false, always: false, always_days: null, always_needs_admin: false, ask: true, reviewed: false, hour: false, tomorrow: false, quiet: false });
    assert.equal(before.can_ask, true);
    const done = await answer(dir, { action_id: id, choice: "ask", reason: REASON });
    assert.equal(done.outcome, "asked");
    assert.equal(done.text, "Request saved: rm -rf ../build (in /repo), sent once this computer is connected · the answer shows on the block");
    let { requests } = await callAgent(dir, "GET", "/requests", undefined, 10_000);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].state, "waiting");
    assert.equal(requests[0].what, "rm -rf ../build (in /repo)");
    assert.equal(requests[0].reason, REASON);
    // The workspace approves: its allowance for the same rule and action arrives in the rules document.
    const request = readRequests(dir)[0];
    const doc = JSON.parse(readFileSync(join(dir, MANAGED_DOC_FILE), "utf8"));
    const approved = { ...makeAllowance({ rule: request.rule, actionKey: request.action_key, reason: REASON, osUserDigest: null, lasts: "always" }), created_by: "workspace", approved_by: "morgan@acme.test" };
    delete approved.reason;
    writeFileSync(join(dir, MANAGED_DOC_FILE), JSON.stringify({ ...doc, allowances: [approved] }));
    ({ requests } = await callAgent(dir, "GET", "/requests", undefined, 10_000));
    assert.equal(requests[0].state, "approved");
    assert.equal(requests[0].answered_by, "morgan@acme.test");
    const { allowances } = await callAgent(dir, "GET", "/allowances", undefined, 10_000);
    assert.equal(allowances[0].by, "admin");
    assert.equal(allowances[0].what, "rm -rf ../build (in /repo)");
    // A workspace that says it declined, with a note.
    writeFileSync(join(dir, MANAGED_DOC_FILE), JSON.stringify({ ...doc, request_answers: [{ request_id: request.id, state: "declined", by: "morgan@acme.test", note: "Use the clean script\u0007" }] }));
    ({ requests } = await callAgent(dir, "GET", "/requests", undefined, 10_000));
    assert.equal(requests[0].state, "declined");
    assert.equal(requests[0].note, "Use the clean script", "control characters are taken out");
  } finally { await service.stop(); }
});

test("an answer from the tray reaches the workspace signed by this computer, as the window's answer does", async () => {
  const posted = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      if (req.url === "/v1/allowances" || req.url === "/v1/requests") posted.push({ path: req.url, body: JSON.parse(raw) });
      res.writeHead(req.url === "/v1/policy" ? 404 : 200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { dir, id } = await blockedComputer();
  writeFileSync(join(dir, "cloud.json"), JSON.stringify({
    url: `http://127.0.0.1:${server.address().port}`, credential: "sbm_us_test", credential_id: "cred-1", organization_id: "org-1", environment_id: "env-1",
    gateway_id: "gw-1", attester_kid: "key:x", scopes: ["receipt:ingest"], expires_at: new Date(Date.now() + 80 * 86_400_000).toISOString(),
  }));
  const doc = readFileSync(join(dir, MANAGED_DOC_FILE), "utf8");
  const service = await serviceFor(dir);
  try {
    writeFileSync(join(dir, MANAGED_DOC_FILE), doc); // as the workspace sent it, whatever the first rules check did
    const done = await answer(dir, { action_id: id, choice: "fifteen", reason: REASON });
    assert.equal(done.outcome, "allowed");
    assert.match(done.text, /^Allowed for 15 minutes: .* · recorded in /);
    await service.cycleNow();
    const sent = posted.find((p) => p.path === "/v1/allowances");
    assert.ok(sent, "the allowance was sent");
    assert.equal(sent.body.record.reason, REASON);
    assert.ok(sent.body.signature && sent.body.kid);
    assert.ok(readAllowances(dir).at(-1).sent_at);
  } finally { await service.stop(); server.close(); }
});

test("notifications: one switch, on for every install; the older 'all' and 'problems' read as on; a person's off stays", () => {
  const fresh = mkdtempSync(join(tmpdir(), "sb-settings-"));
  settleTraySettings(fresh);
  assert.equal(readTraySettings(fresh).notifications, "blocks");
  const existing = mkdtempSync(join(tmpdir(), "sb-settings-"));
  settleTraySettings(existing);
  assert.equal(readTraySettings(existing).notifications, "blocks", "an install whose person never chose: on");
  writeFileSync(join(existing, "agent-settings.json"), JSON.stringify({ notifications: "problems" }));
  assert.equal(readTraySettings(existing).notifications, "blocks", "problems only, the old default nobody chose, reads as on");
  assert.equal(readTraySettings(mkdtempSync(join(tmpdir(), "sb-settings-"))).notifications, "blocks", "no file: on");
  writeTraySettings(existing, { notifications: "off" });
  settleTraySettings(existing);
  assert.equal(readTraySettings(existing).notifications, "off", "never changed once written");
  writeFileSync(join(existing, "agent-settings.json"), JSON.stringify({ notifications: "all" }));
  assert.equal(readTraySettings(existing).notifications, "blocks");
  assert.equal(writeTraySettings(existing, { notifications: "loud" }).notifications, "blocks");
});

test("blocks are final: nothing offered for a block, and no Requests list", async () => {
  const dir = computer({ "destructive-shell": { mode: "block" } });
  await blockActions(dir, [{ tool_name: "Bash", tool_input: { command: "rm -rf ../build" } }]);
  const service = await serviceFor(dir);
  try {
    const { tray } = await callAgent(dir, "GET", "/tray", undefined, 10_000);
    assert.equal(tray.recent_blocks[0].can_act, false);
    assert.equal(tray.recent_blocks[0].offers, null);
    assert.equal(tray.can_ask, false);
    assert.deepEqual(tray.asked, []);
  } finally { await service.stop(); }
});

test("unblocking automatically, reviewed later: one length, applied at once, and gone from Allowed when an admin undoes it", async () => {
  const { dir, id } = await blockedComputer({ "destructive-shell": { mode: "override", override: { reason_min: 12, minutes: 0, daily_limit: 5, harness_prompt: false, lasts: "15m", review: true } } });
  const service = await serviceFor(dir);
  try {
    const before = (await callAgent(dir, "GET", "/tray", undefined, 10_000)).tray;
    assert.deepEqual(before.recent_blocks[0].offers, { once: false, fifteen: true, always: false, always_days: null, always_needs_admin: false, ask: false, reviewed: true, hour: false, tomorrow: false, quiet: false });
    assert.equal((await answer(dir, { action_id: id, choice: "once", reason: REASON })).outcome, "not_offered", "only the length the workspace set");
    const done = await answer(dir, { action_id: id, choice: "fifteen", reason: REASON });
    assert.equal(done.outcome, "allowed");
    assert.match(done.text, /^Unblocked until \d{1,2}:\d{2} [AP]M: .* · an admin will review it$/);
    let { allowances } = await callAgent(dir, "GET", "/allowances", undefined, 10_000);
    assert.equal(allowances.length, 1);
    assert.equal(allowances[0].choice, "fifteen");
    // An admin undoes it: the workspace lists it among its revoked allowances, and it leaves Allowed at the next look.
    const doc = JSON.parse(readFileSync(join(dir, MANAGED_DOC_FILE), "utf8"));
    writeFileSync(join(dir, MANAGED_DOC_FILE), JSON.stringify({ ...doc, revoked_allowances: [allowances[0].id] }));
    ({ allowances } = await callAgent(dir, "GET", "/allowances", undefined, 10_000));
    assert.deepEqual(allowances, []);
    assert.deepEqual((await callAgent(dir, "GET", "/tray", undefined, 10_000)).tray.allowed, []);
  } finally { await service.stop(); }
});

test("the words after an unblock that an admin reviews later", () => {
  const now = Date.parse("2026-10-14T15:52:00");
  assert.equal(answerText("allowed", "fifteen", 30, "Acme", true, true, now), "Unblocked until 4:07 PM · an admin will review it");
  assert.equal(answerText("allowed", "once", 30, "Acme", true, true, now), "Unblocked for the next try · an admin will review it");
  assert.equal(answerText("allowed", "always", 30, "Acme", true, true, now), "Unblocked until Nov 13 · an admin will review it");
  assert.equal(answerText("allowed", "fifteen", 30, "Acme", true, false, now), "Allowed for 15 minutes · recorded in Acme", "not reviewed: as before");
});

test("stop allowing from the tray: the person's allowance ends at once and leaves Allowed; an admin's is not theirs to stop", async () => {
  const { dir, id } = await blockedComputer();
  const service = await serviceFor(dir);
  try {
    await answer(dir, { action_id: id, choice: "fifteen", reason: REASON });
    const [mine] = (await callAgent(dir, "GET", "/allowances", undefined, 10_000)).allowances;
    assert.equal(mine.by, "person");
    const stopped = await callAgent(dir, "POST", "/allowances/stop", { id: mine.id }, 10_000);
    assert.deepEqual(stopped, { outcome: "stopped", text: "Stopped allowing rm -rf ../build (in /repo) on this computer" });
    assert.deepEqual((await callAgent(dir, "GET", "/allowances", undefined, 10_000)).allowances, []);
    assert.ok(readAllowances(dir).find((a) => a.id === mine.id).ended_at);
    assert.equal((await callAgent(dir, "POST", "/allowances/stop", { id: mine.id }, 10_000)).outcome, "gone");
    const doc = JSON.parse(readFileSync(join(dir, MANAGED_DOC_FILE), "utf8"));
    const admins = { ...makeAllowance({ rule: "destructive-shell", actionKey: "c".repeat(64), reason: REASON, osUserDigest: null, lasts: "always" }), created_by: "workspace" };
    delete admins.reason;
    writeFileSync(join(dir, MANAGED_DOC_FILE), JSON.stringify({ ...doc, allowances: [admins] }));
    assert.equal((await callAgent(dir, "POST", "/allowances/stop", { id: admins.id }, 10_000)).outcome, "gone");
  } finally { await service.stop(); }
});

test("where the workspace asks for no reason, the tray's answer needs none; a minimum above 0 still needs one", async () => {
  const { dir, id } = await blockedComputer({ "destructive-shell": { mode: "override", override: { reason_min: 0, minutes: 0, daily_limit: 5, harness_prompt: false, always: "at_once", requests: true } } });
  const service = await serviceFor(dir);
  try {
    const done = await answer(dir, { action_id: id, choice: "always" });
    assert.equal(done.outcome, "allowed");
    const made = readAllowances(dir).at(-1);
    assert.equal(made.reason_length, 0, "recorded with no reason");
    assert.equal(made.reason_digest, null);
    assert.equal("reason" in made, false, "no text to send");
  } finally { await service.stop(); }
  const { dir: strict, id: blocked } = await blockedComputer();
  const again = await serviceFor(strict);
  try {
    assert.equal((await answer(strict, { action_id: blocked, choice: "once" })).outcome, "reason_short", "the workspace's minimum (12)");
  } finally { await again.stop(); }
});
