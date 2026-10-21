// The tray's second panel: blocks grouped by rule and action with their details, the Allowed list with what the person chose
// to keep blocked, one Settings screen of facts, a support bundle with nothing private in it, and the Unblock form's words.
import { test } from "node:test";
import assert from "node:assert/strict";
import { callAgent } from "../dist/index.js";
import { makeAllowance, readBlocked, writeAllowances } from "@scopebond/hook";
import { computer, blockActions, serviceFor } from "./tray-helpers.mjs";
import { groupBlocks, redactLine, trayModel, whyOf } from "../dist/tray-model.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { healthOf } from "../dist/health.js";
import { answerText, lastGoodCheck, newerOffers } from "../dist/service.js";

const NOW = new Date(2026, 9, 21, 16, 30).getTime();
const at = (hoursAgo) => new Date(NOW - hoursAgo * 3_600_000).toISOString();
const block = (over) => ({ action_id: `act-${Math.random().toString(16).slice(2)}`, summary: "file.read .env", at: at(1), rule: "secret-read",
  what: "Read .env", rule_title: "Read passwords, keys or secrets", tries: 1, ...over });

test("today's repeats of one action under one rule are one row, counted by every try; earlier blocks stay one row each", () => {
  const blocks = [
    block({ at: at(0.1), tries: 3 }),
    block({ at: at(0.2), what: "rm -rf ../build", rule: "destructive-shell", rule_title: "Run a command that deletes data or shuts down the computer" }),
    block({ at: at(0.5), tries: 2, first_at: at(0.7) }),
    block({ at: at(2) }),
    block({ at: at(30) }),
    block({ at: at(31) }),
  ];
  const groups = groupBlocks(blocks, NOW);
  assert.deepEqual(groups.map((g) => g.members), [[0, 2, 3], [1], [4], [5]]);
  assert.equal(groups[0].times, 6, "3 + 2 + 1 tries, across sessions");
  assert.equal(groups[0].last_at, blocks[0].at);
  assert.equal(groups[0].first_at, blocks[3].at, "the earliest try of the group");
  assert.equal(groups[0].today, true);
  assert.equal(groups[2].today, false, "yesterday's are not grouped");
  assert.equal(groupBlocks([], NOW).length, 0);
});

test("why a rule exists, in one line: the first sentence of its description, cut at a word", () => {
  assert.equal(whyOf("Deny pushes to main. A tags-only push is allowed."), "Deny pushes to main.");
  assert.equal(whyOf("  Never read   Scopebond's folder  "), "Never read Scopebond's folder");
  assert.equal(whyOf(""), null);
  assert.equal(whyOf(null), null);
  const long = whyOf(`Deny ${"destructive programs ".repeat(20)}now.`);
  assert.ok(long.length <= 200 && long.endsWith("…") && !long.includes("  "));
  assert.equal(whyOf("Deny v1.2 releases. Then more."), "Deny v1.2 releases.", "a dot inside a word is not the end of the sentence");
});

test("each block carries why its rule exists, and the model lists today's blocks as groups", async () => {
  const dir = computer();
  await blockActions(dir, [
    { tool_name: "Bash", tool_input: { command: "rm -rf ../build" } },
    { tool_name: "Read", tool_input: { file_path: "/repo/.env.production" } },
  ]);
  const service = await serviceFor(dir);
  try {
    const { tray } = await callAgent(dir, "GET", "/tray", undefined, 10_000);
    const [read, rm] = tray.recent_blocks;
    assert.match(rm.rule_why ?? "", /^Deny destructive programs/, "the clause's own description, first sentence");
    assert.ok(rm.rule_why.length <= 200);
    assert.ok(typeof read.rule_why === "string" || read.rule_why === null);
    assert.deepEqual(tray.blocked_groups.map((g) => g.members), [[0], [1]]);
    assert.equal(tray.blocked_groups[0].times, 1);
  } finally { await service.stop(); }
});

test("a block the person chose to keep blocked is listed under Kept blocked, offers nothing, and Undo asks again", async () => {
  const dir = computer();
  await blockActions(dir, [{ tool_name: "Bash", tool_input: { command: "rm -rf ../build" } }]);
  const key = readBlocked(dir).at(-1).action_key;
  const quiet = { ...makeAllowance({ rule: "destructive-shell", actionKey: key, reason: "", osUserDigest: null, lasts: "always", alwaysDays: 30 }), kind: "quiet" };
  const hour = makeAllowance({ rule: "destructive-shell", actionKey: "a".repeat(64), reason: "", osUserDigest: null, lasts: "always", alwaysDays: 1 });
  hour.expires_at = new Date(Date.parse(hour.created_at) + 3_600_000).toISOString();
  writeAllowances(dir, [hour, quiet]);
  const service = await serviceFor(dir);
  try {
    const { tray } = await callAgent(dir, "GET", "/tray", undefined, 10_000);
    const kept = tray.allowed.find((a) => a.id === quiet.id);
    assert.equal(kept.kind, "quiet");
    assert.equal(tray.allowed.find((a) => a.id === hour.id).kind, "allow");
    assert.equal(tray.allowed.find((a) => a.id === hour.id).choice, "hour", "an hour reads as an hour, never as always");
    const [rm] = tray.recent_blocks;
    assert.equal(rm.outcome, "quiet");
    assert.equal(rm.acted, "quiet");
    assert.equal(rm.can_act, false, "nothing to unblock or ask: the person chose to keep it blocked");
    assert.match(rm.outcome_text, /^Kept blocked/);
    const undone = await callAgent(dir, "POST", "/allowances/stop", { id: quiet.id }, 10_000);
    assert.equal(undone.outcome, "stopped");
    assert.match(undone.text, /^You'll be asked about .* again on this computer$/);
    const after = (await callAgent(dir, "GET", "/tray", undefined, 10_000)).tray;
    assert.ok(!after.allowed.some((a) => a.id === quiet.id));
    assert.notEqual(after.recent_blocks[0].outcome, "quiet");
  } finally { await service.stop(); }
});

const status = (delivery = {}) => ({
  schema: "scopebond.status.v1", version: "0.31.0", state: "delivering",
  delivery: { connected: true, last_success_at: NOW - 60_000, last_attempt_at: NOW - 60_000, last_error: null, last_error_code: null, connection_refused_since: null, pending: 0, oldest_pending_age_s: null, gaps_by_reason: {}, queue_error: null, ...delivery },
  identity: { installation_id: "gw-1", generation: 1, key_kid: "key:1", credential_expires_at: null },
  config: { active: "C:/x", others: [], user_connection_shadowed: false }, agents: { claude: true, cursor: false, codex: false },
});
const modelInput = (over = {}) => {
  const s = over.status ?? status();
  return {
    status: s, health: healthOf(s, null), now: NOW, awakeSince: NOW - 3_600_000, working: null,
    rules: { checked_at: NOW - 60_000, managed: true, block: 9, monitor: 2 },
    today: { actions: 16867, blocked: 19, allowed_by_person: 0 },
    version: { agent: "0.11.5", hook: "0.31.1", policy: "recommended", recommendedAgent: "0.11.5", recommendedHook: null },
    workspace: { name: "Avouro", environment: "Production", computer_url: null }, computerName: "LAPTOP",
    packs: [{ id: "cloud-clis", title: "Cloud CLIs", version: "1.2.0" }, { id: "databases", title: "Databases", version: "1.0.3" }],
    rulesUpdatedAt: NOW - 2 * 60_000,
    ...over,
  };
};

test("Settings' This computer: protection with rules and packs, the workspace, the last good rules check and one version", () => {
  const m = trayModel(modelInput());
  assert.deepEqual(m.computer_rows, [
    { label: "Protection", value: "On · 9 rules blocking · 2 packs", items: ["Cloud CLIs 1.2.0", "Databases 1.0.3"] },
    { label: "Workspace", value: "Avouro · Production" },
    { label: "Rules updated", value: "2 min ago" },
    { label: "Version", value: "Scopebond 0.11.5 · up to date" },
  ]);
  assert.equal(m.version_label, "Scopebond 0.11.5");
  assert.equal(m.detail, "19 blocked today · rules updated 2 min ago", "the header: what was blocked, then when the rules were updated");
  const one = trayModel(modelInput({ packs: [], rules: { checked_at: NOW, managed: true, block: 1, monitor: 0 } }));
  assert.equal(one.computer_rows[0].value, "On · 1 rule blocking");
  assert.equal(one.computer_rows[0].items, undefined);
  const update = trayModel(modelInput({ version: { agent: "0.11.4", hook: "0.31.1", policy: "recommended", recommendedAgent: "0.11.5", recommendedHook: null } }));
  assert.equal(update.computer_rows.at(-1).value, "Scopebond 0.11.4 · 0.11.5 ready to install");
  const never = trayModel(modelInput({ rulesUpdatedAt: null }));
  assert.ok(!never.computer_rows.some((r) => r.label === "Rules updated"), "no successful check known: nothing claimed");
  const local = trayModel(modelInput({ workspace: null, status: status({ connected: false }), rules: { checked_at: null, managed: false, block: 4, monitor: 0 }, rulesUpdatedAt: null }));
  assert.deepEqual(local.computer_rows.slice(1, 3).map((r) => r.value), ["Not connected: using this computer's own rules", "Using this computer's own rules"]);
  for (const row of m.computer_rows) assert.doesNotMatch(row.value, /waiting|queue|sending|self-check/i, "no internals");
});

test("the last good rules check: the field the rules check keeps for a success, else a check that did not fail", () => {
  assert.equal(lastGoodCheck({ checked_at: "2026-10-21T10:00:00Z", last_error: null }), Date.parse("2026-10-21T10:00:00Z"));
  assert.equal(lastGoodCheck({ checked_at: "2026-10-21T10:00:00Z", last_error: "could not reach the workspace" }), null, "a failed check is never 'updated'");
  assert.equal(lastGoodCheck({ checked_at: "2026-10-21T10:00:00Z", last_error: "x", checked_ok_at: "2026-10-21T09:00:00Z" }), Date.parse("2026-10-21T09:00:00Z"));
  assert.equal(lastGoodCheck({}), null);
});

// Made here, so no token-shaped text sits in the repository.
const TOKEN = ["ghp", "_", "q".repeat(36)].join("");

test("Get help's support report: state, versions, settings and failures, with nothing private in it", async () => {
  const dir = computer();
  await blockActions(dir, [{ tool_name: "Bash", tool_input: { command: "rm -rf ../build --token=SECRET-ARG-123" } }]);
  const lines = [
    "2026-10-21T10:00:00.000Z Scopebond Agent 0.11.5 running",
    `2026-10-21T10:01:00.000Z delivery problem: fetch failed reading ${dir}/receipts.db`,
    "2026-10-21T10:02:00.000Z signing in again: waiting for approval of code ABCD-EFGH (failed once)",
    `2026-10-21T10:03:00.000Z could not reach https://cloud.example.test/v1?token=${TOKEN}`,
  ];
  writeFileSync(join(dir, "agent.log"), lines.join("\n") + "\n");
  const service = await serviceFor(dir);
  try {
    const { bundle } = await callAgent(dir, "GET", "/support", undefined, 10_000);
    const text = JSON.stringify(bundle);
    assert.equal(bundle.schema, "scopebond.support.v1");
    assert.match(bundle.versions.scopebond, /^\d+\.\d+\.\d+/);
    assert.equal(bundle.settings.notifications, "blocks");
    assert.equal(typeof bundle.state.state, "string");
    assert.ok(Array.isArray(bundle.computer) && bundle.computer.some((r) => r.label === "Version"));
    assert.equal(bundle.last_errors.length, 3, "only the lines about a failure");
    assert.match(bundle.last_errors[0], /<scopebond>\/receipts\.db/, "the folder is named, not spelled out");
    assert.ok(!text.includes(dir) && !text.includes(dir.replace(/\\/g, "/")), "no path to the Scopebond folder");
    assert.ok(!text.includes("ABCD-EFGH"), "no sign-in code");
    assert.ok(!text.includes(TOKEN), "nothing token-shaped");
    assert.ok(!text.includes("SECRET-ARG-123") && !text.includes("rm -rf"), "no record and no command");
    assert.ok(!/"(?:key|private_key|token|credential|reason)"\s*:/.test(text), "no key, token, credential or reason field");
  } finally { await service.stop(); }
});

test("a report line names the folders, never the person's user name, and masks codes", () => {
  assert.equal(redactLine("D:\\work\\sb\\.scopebond\\agent.log failed", "D:\\work\\sb\\.scopebond", "D:\\work\\sb"), "<scopebond>\\agent.log failed");
  assert.equal(redactLine("D:/work/sb/x failed", "D:\\work\\sb\\.scopebond", "D:\\work\\sb"), "~/x failed");
  assert.equal(redactLine("code WXYZ-1234", "", ""), "code ****-****");
  assert.equal(redactLine("x".repeat(400), "", "").length, 300);
});

test("the form's result line names the length, the command and where it was recorded; never 'always'", () => {
  const now = new Date(2026, 9, 21, 15, 52).getTime();
  assert.equal(answerText("allowed", "hour", 30, "Avouro", true, false, now, "rm -rf ./dist"), "Allowed for 1 hour: rm -rf ./dist · recorded in Avouro");
  assert.equal(answerText("allowed", "tomorrow", 30, "Avouro", true, false, now, "rm -rf ./dist"), "Allowed until tomorrow: rm -rf ./dist · recorded in Avouro");
  assert.equal(answerText("allowed", "always", 30, "Avouro", true, false, now, "rm -rf ./dist"), "Allowed for 30 days: rm -rf ./dist · recorded in Avouro");
  assert.equal(answerText("allowed", "once", 30, null, false, false, now, null), "Allowed once · recorded on this computer");
  assert.equal(answerText("proposed", "always", 30, "Avouro", true, false, now, "rm -rf ./dist"), "Allowed for 15 minutes while an admin decides on 30 days: rm -rf ./dist · recorded in Avouro");
  assert.equal(answerText("allowed", "hour", 30, "Avouro", true, true, now, "rm -rf ./dist"), "Unblocked until 4:52 PM: rm -rf ./dist · an admin will review it");
  assert.equal(answerText("allowed", "tomorrow", 30, "Avouro", true, true, now, null), "Unblocked until tomorrow 3:52 PM · an admin will review it");
  assert.equal(answerText("quiet", "quiet", 30, "Avouro", true, false, now, "rm -rf ./dist"), "Kept blocked without asking you: rm -rf ./dist · undo it under Allowed");
  assert.equal(answerText("asked", "ask", 30, "Avouro", true, false, now, "rm -rf ./dist"), "Request sent: rm -rf ./dist · the answer shows on the block");
  assert.ok(answerText("allowed", "once", 30, "A", true, false, now, "x".repeat(300)).length < 180, "a long command is cut");
  for (const choice of ["once", "fifteen", "hour", "tomorrow", "always"]) {
    assert.doesNotMatch(answerText("allowed", choice, 30, "Avouro", true, false, now, "x"), /always/i);
  }
});

test("the newer lengths and keeping a block quietly are offered only by a hook that knows them", () => {
  assert.deepEqual(newerOffers({ allow: true, fifteen: true, always: true, ask: true }), { hour: false, tomorrow: false, quiet: false }, "an older hook");
  assert.deepEqual(newerOffers({ allow: true, hour: true, tomorrow: false, always: true, ask: true }), { hour: true, tomorrow: false, quiet: true });
  assert.deepEqual(newerOffers({ hour: false, tomorrow: false, quiet: false }), { hour: false, tomorrow: false, quiet: false }, "said no");
});
