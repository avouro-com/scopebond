// The tray's second panel: blocks grouped by rule and action with their details, the Allowed list with what the person chose
// to keep blocked, one Settings screen of facts, a support bundle with nothing private in it, and the Unblock form's words.
import { test } from "node:test";
import assert from "node:assert/strict";
import { callAgent } from "../dist/index.js";
import { makeAllowance, readBlocked, writeAllowances } from "@scopebond/hook";
import { computer, blockActions, serviceFor } from "./tray-helpers.mjs";
import { groupBlocks, whyOf } from "../dist/tray-model.js";

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
