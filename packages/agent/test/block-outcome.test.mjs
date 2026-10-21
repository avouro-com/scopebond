// Every block in the tray has exactly one outcome: Unblock…, Ask an admin…, or a plain sentence saying why it stays blocked
// or where the person's request stands. A block with no button used to show nothing at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { REQUESTS_FILE, readBlocked, MANAGED_DOC_FILE } from "@scopebond/hook";
import { callAgent } from "../dist/index.js";
import { blockOutcome } from "../dist/block-outcome.js";
import { computer, blockActions, serviceFor } from "./tray-helpers.mjs";

const base = { offers: null, clause: null, rule: null, kind: null, verdict: null, request: null, allowed: false, workspace: "Avouro", tool: "Claude Code", what: "rm -rf /data", rule_title: "Delete files", action_id: "a1" };

test("one outcome per block, with the sentence the row shows when there is no button", () => {
  const unblock = blockOutcome({ ...base, offers: { once: true, fifteen: false, always: false, ask: true } });
  assert.deepEqual(unblock, { outcome: "unblock", outcome_text: null, copy_details: null });
  assert.equal(blockOutcome({ ...base, offers: { once: false, fifteen: false, always: false, ask: true } }).outcome, "ask");
  const always = blockOutcome({ ...base, clause: "protect-scopebond-read" });
  assert.equal(always.outcome, "always_on");
  assert.equal(always.outcome_text, "Always on. Scopebond protects its own keys and records on this computer.");
  const rule = blockOutcome({ ...base, clause: "safe-shell", rule: "destructive-shell" });
  assert.equal(rule.outcome, "workspace_rule");
  assert.equal(rule.outcome_text, "Set by Avouro. Ask an admin to change the rule.");
  assert.equal(rule.copy_details, "rm -rf /data\nRule: Delete files\nRecord: a1");
  assert.equal(blockOutcome({ ...base, workspace: null }).outcome_text, "Set by your workspace. Ask an admin to change the rule.");
  const install = blockOutcome({ ...base, kind: "install", verdict: "It is on your workspace's list of known malware" });
  assert.equal(install.outcome, "safe_install");
  assert.equal(install.outcome_text, "Blocked by Safe Install: it is on your workspace's list of known malware.");
  assert.ok(install.copy_details);
  assert.equal(blockOutcome({ ...base, kind: "install" }).outcome_text, "Blocked by Safe Install.");
  // Held for the person (the verdict was "ask") where the coding tool could not ask: not a silent block.
  const held = blockOutcome({ ...base, kind: "install", held: true, verdict: "It was published less than 7 days ago" });
  assert.equal(held.outcome, "safe_install");
  assert.equal(held.outcome_text, "Waiting for you: Safe Install held this install to check with you first. It was published less than 7 days ago. If you meant to install it, run the install yourself in your terminal.");
});

test("a request's state replaces the buttons: waiting, approved by whom (run it again), declined", () => {
  const waiting = blockOutcome({ ...base, offers: { once: true, fifteen: true, always: true, ask: true }, request: { state: "waiting", answered_by: null, answered_at: null } });
  assert.deepEqual([waiting.outcome, waiting.outcome_text], ["requested", "Waiting for an admin"]);
  const approved = blockOutcome({ ...base, request: { state: "approved", answered_by: "Jason", answered_at: "2026-10-20T20:52:44Z" } });
  assert.equal(approved.outcome_text, "Approved by Jason: ask Claude Code to try again");
  assert.equal(blockOutcome({ ...base, request: { state: "declined", answered_by: null, answered_at: null } }).outcome_text, "Declined");
  const covered = blockOutcome({ ...base, offers: { once: true, fifteen: false, always: false, ask: false }, allowed: true });
  assert.deepEqual([covered.outcome, covered.outcome_text], ["allowed", "Allowed: ask Claude Code to try again"]);
});

test("the tray model gives every listed block an outcome; a block an admin approved shows the answer, not Unblock or Ask", async () => {
  const dir = computer();
  await blockActions(dir, [
    { tool_name: "Read", tool_input: { file_path: "/repo/.env.production" } },
    { tool_name: "Bash", tool_input: { command: "rm -rf /data/cache" } },
  ]);
  const blocked = readBlocked(dir).at(-1);
  // The person asked an admin about the rm, and the workspace's rules document carries the answer.
  writeFileSync(join(dir, REQUESTS_FILE), JSON.stringify({ items: [{ id: "req-1", rule: blocked.rule, action_key: blocked.action_key, action_id: blocked.id,
    summary: blocked.summary, reason: "", os_user_digest: null, harness: "claude", created_at: new Date().toISOString(), sent_at: new Date().toISOString() }] }));
  const doc = JSON.parse((await import("node:fs")).readFileSync(join(dir, MANAGED_DOC_FILE), "utf8"));
  doc.request_answers = [{ request_id: "req-1", state: "approved", by: "Jason", note: null, at: new Date().toISOString() }];
  writeFileSync(join(dir, MANAGED_DOC_FILE), JSON.stringify(doc));
  const service = await serviceFor(dir);
  try {
    const { tray } = await callAgent(dir, "GET", "/tray", undefined, 10_000);
    for (const b of tray.recent_blocks) assert.ok(b.outcome, `${b.what} has an outcome`);
    const [rm, read] = tray.recent_blocks;
    assert.equal(rm.outcome, "requested");
    assert.equal(rm.outcome_text, "Approved by Jason: ask Claude Code to try again");
    assert.equal(rm.offers, null, "no Unblock or Ask once a request covers it");
    assert.equal(read.outcome, "workspace_rule");
    assert.match(read.outcome_text, /Ask an admin to change the rule\.$/);
  } finally { await service.stop(); }
});

test("a block the workspace keeps quiet: listed as kept blocked, with nothing to answer and no notification", async () => {
  const quiet = blockOutcome({ ...base, clause: "safe-shell", rule: "destructive-shell", offers: { once: true, fifteen: false, always: false, ask: true }, workspace_quiet: true });
  assert.equal(quiet.outcome, "quiet");
  assert.equal(quiet.outcome_text, "Kept blocked without asking you. Set by Avouro.");
  assert.equal(quiet.copy_details, "rm -rf /data\nRule: Delete files\nRecord: a1");
  assert.equal(blockOutcome({ ...base, workspace: null, workspace_quiet: true }).outcome_text, "Kept blocked without asking you. Set by your workspace.");
  // A request or an allowance in force says where it stands first.
  assert.equal(blockOutcome({ ...base, workspace_quiet: true, allowed: true }).outcome, "allowed");

  const { tuneDigestOfReceipt } = await import("@scopebond/hook");
  const dir = computer();
  // The workspace lists the digest of `rm -rf /data/cache` as it would compute it from the record.
  const probe = computer();
  const { createHookRuntime, mapClaudeToolUse } = await import("@scopebond/hook");
  const runtime = createHookRuntime({ policyPath: join(probe, "policy.json"), keyPath: join(probe, "agent.key"), attesterPath: join(probe, "attester.key"), dbPath: join(probe, "receipts.db"), cwd: "/repo" });
  let digest;
  try { digest = tuneDigestOfReceipt((await runtime.evaluate(mapClaudeToolUse({ cwd: "/repo", tool_name: "Bash", tool_input: { command: "rm -rf /data/cache" } }))).receipts.at(-1)); }
  finally { runtime.close(); }
  assert.match(digest, /^[0-9a-f]{64}$/);
  const fs = await import("node:fs");
  const doc = JSON.parse(fs.readFileSync(join(dir, MANAGED_DOC_FILE), "utf8"));
  writeFileSync(join(dir, MANAGED_DOC_FILE), JSON.stringify({ ...doc, quiet_patterns: [digest] }));
  await blockActions(dir, [
    { tool_name: "Read", tool_input: { file_path: "/repo/.env.production" } },
    { tool_name: "Bash", tool_input: { command: "rm -rf /data/cache" } },
  ], { note: { project: "checkout" } });
  const service = await serviceFor(dir);
  try {
    const { tray } = await callAgent(dir, "GET", "/tray", undefined, 10_000);
    const [rm, read] = tray.recent_blocks;
    assert.equal(rm.outcome, "quiet");
    assert.equal(rm.outcome_text, "Kept blocked without asking you. Set by your workspace.");
    assert.equal(rm.acted, "quiet", "the tray shows no notification for it");
    assert.equal(rm.offers, null, "nothing to answer");
    assert.equal(rm.can_act, false);
    assert.equal(read.outcome, "workspace_rule", "another block is shown as before");
  } finally { await service.stop(); }
});
