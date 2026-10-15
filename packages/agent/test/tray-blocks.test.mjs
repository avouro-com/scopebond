// The tray lists what was blocked in plain words: the action as the Scopebond window shows it (secrets masked), the
// rule's name, the project and the coding tool, and what the person may do about it now (the choices the workspace allows,
// and the shortest reason it accepts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBlocked } from "@scopebond/hook";
import { callAgent } from "../dist/index.js";
import { computer, blockActions, serviceFor } from "./tray-helpers.mjs";
import { workspaceLetsAsk } from "../dist/service.js";
import { projectName, toolName } from "../dist/tray-model.js";

test("tool and project names a person knows", () => {
  assert.equal(toolName("claude"), "Claude Code");
  assert.equal(toolName("cursor"), "Cursor");
  assert.equal(toolName("codex"), "Codex");
  assert.equal(toolName("copilot"), "GitHub Copilot");
  assert.equal(toolName("something-new"), null);
  assert.equal(toolName("__proto__"), null);
  assert.equal(projectName("github.com/acme/checkout"), "checkout");
  assert.equal(projectName(null), null);
});

test("the tray model lists today's blocks in plain words, with the rule's name, the project, the tool and what may be done", async () => {
  const dir = computer();
  await blockActions(dir, [
    { tool_name: "Read", tool_input: { file_path: "/repo/.env.production" } },
    { tool_name: "Bash", tool_input: { command: "rm -rf build --token=SECRET-ARG-123" } },
  ]);
  const service = await serviceFor(dir);
  try {
    const { tray } = await callAgent(dir, "GET", "/tray", undefined, 10_000);
    const [rm, read] = tray.recent_blocks;
    assert.equal(rm.what, "rm -rf build --token=***", "the secret is masked as the window masks it");
    assert.equal(rm.action_text, readBlocked(dir).at(-1).summary, "the text the Scopebond window shows");
    assert.equal(rm.rule, "destructive-shell");
    assert.equal(rm.rule_title, "Destructive command");
    assert.equal(rm.project, "checkout");
    assert.equal(rm.tool, "Claude Code");
    assert.equal(rm.can_act, true);
    assert.deepEqual(rm.offers, { once: true, fifteen: true, always: true, always_days: 14, always_needs_admin: true, ask: true, reviewed: false });
    assert.equal(rm.reason_min, 12);
    assert.equal(rm.summary, "shell.exec rm", "the older fields stay for older trays");
    assert.equal(read.what, "Read .env.production");
    assert.equal(read.can_act, false, "a rule on Block offers nothing");
    assert.equal(read.offers, null);
    assert.equal(read.reason_min, null);
    assert.ok(!JSON.stringify(tray).includes("SECRET-ARG-123"));
    assert.deepEqual(tray.today, { actions: 2, blocked: 2 });
  } finally { await service.stop(); }
});

test("up to 20 blocks, newest first", async () => {
  const dir = computer();
  await blockActions(dir, Array.from({ length: 24 }, (_, i) => ({ tool_name: "Bash", tool_input: { command: `rm -rf build${i}` } })));
  const service = await serviceFor(dir);
  try {
    const { tray } = await callAgent(dir, "GET", "/tray", undefined, 10_000);
    assert.equal(tray.recent_blocks.length, 20);
    assert.equal(tray.recent_blocks[0].what, "rm -rf build23");
    assert.equal(tray.recent_blocks[19].what, "rm -rf build4");
  } finally { await service.stop(); }
});

test("the model says whether the workspace lets a person ask an admin under any rule, for the tray's Requests list", async () => {
  const asking = computer();
  const service = await serviceFor(asking);
  try { assert.equal((await callAgent(asking, "GET", "/tray", undefined, 10_000)).tray.can_ask, true); }
  finally { await service.stop(); }
  const selfService = computer({ "destructive-shell": { mode: "override", override: { reason_min: 12, minutes: 0, daily_limit: 5, harness_prompt: false, always: "at_once" } } });
  assert.equal(workspaceLetsAsk(selfService), false, "allowing only: no Requests list until the person has asked");
  const final = computer({ "destructive-shell": { mode: "block" } });
  assert.equal(workspaceLetsAsk(final), false);
  const central = computer({ "destructive-shell": { mode: "ask", override: { reason_min: 12, minutes: 0, daily_limit: 5, harness_prompt: false, requests: true } } });
  assert.equal(workspaceLetsAsk(central), true);
  assert.equal(workspaceLetsAsk(join(tmpdir(), "sb-no-such-folder")), false, "no workspace rules");
});
