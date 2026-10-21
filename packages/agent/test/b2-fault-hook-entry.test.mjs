// Fault: the Scopebond hook entry is removed from (or duplicated in) the coding agent's settings, or autostart is broken.
// The agent repairs it as soon as it sees it, checks again and records the repair, and the tray shows nothing; only a repair
// that fails is shown, in words ("Scopebond couldn't reconnect to Claude Code") with Repair.
import { CLAUDE_SETTINGS, HOME, agent, computer, hook, seen, serve, tray, workspace } from "./b2-fault-helpers.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LOCAL_SETTINGS = join(HOME, ".claude", "settings.local.json");
const entries = (file) => hook.configuredHookCommands(file).length;

test("the hook entry removed from Claude Code's settings: repaired at once, recorded, and the tray stays Protected", async () => {
  const ws = workspace();
  const { dir } = computer();
  const service = await serve(dir, ws, { selfRepair: true });
  try {
    const before = readFileSync(CLAUDE_SETTINGS, "utf8");
    writeFileSync(CLAUDE_SETTINGS, JSON.stringify({ theme: "dark" }));
    const m = seen(await tray(dir));
    assert.equal(m.state, "protected", `the person sees nothing: ${m.headline}`);
    assert.equal(entries(CLAUDE_SETTINGS), 1, "the hook is back in Claude Code's settings");
    assert.equal(JSON.parse(readFileSync(CLAUDE_SETTINGS, "utf8")).theme, "dark", "the person's own settings are kept");
    const status = await agent.callAgent(dir, "GET", "/status", undefined, 5_000);
    assert.deepEqual(status.agent.last_repair?.repaired, ["claude"], "the repair is recorded");
    assert.deepEqual(status.agent.last_repair?.failed, []);
    assert.ok(before.length > 0);
  } finally { await service.stop(); }
});

test("the hook entry twice (user and local settings): the copy goes at the next cycle", async () => {
  const ws = workspace();
  const { dir } = computer();
  const service = await serve(dir, ws, { selfRepair: true });
  try {
    agent.repairHookEntries(["claude"]);
    hook.writeHarnessConfig(LOCAL_SETTINGS, "claude", hook.configuredHookCommands(CLAUDE_SETTINGS)[0]);
    assert.ok(hook.duplicateHooks("claude", HOME, HOME), "the fault is in place");
    await service.cycleNow();
    assert.equal(hook.duplicateHooks("claude", HOME, HOME), null, "one Scopebond hook again");
    assert.equal(entries(CLAUDE_SETTINGS), 1, "the user settings keep theirs");
    assert.equal(seen(await tray(dir)).state, "protected");
  } finally { await service.stop(); }
});

test("autostart on but broken (its launcher gone): started again by itself; autostart the person turned off is left off", async () => {
  const ws = workspace();
  const { dir } = computer();
  const health = { on: true, ok: false, detail: "the autostart launcher is missing" };
  let enabled = 0;
  ws.answers["self-check"] = { ok: true, signature_verified: true, failed: [] };
  const service = await serve(dir, ws, { selfRepair: true, autostart: { health: () => health, enable: () => { enabled += 1; health.ok = true; return "on"; } } });
  try {
    await service.maintainNow();
    assert.equal(enabled, 1, "repaired");
    const status = await agent.callAgent(dir, "GET", "/status", undefined, 5_000);
    assert.equal(status.agent.last_repair?.autostart, "repaired");
    health.on = false; health.ok = false; health.detail = "the agent does not start with sign-in";
    await service.maintainNow();
    assert.equal(enabled, 1, "the person's choice is kept");
    assert.equal(seen(await tray(dir)).state, "protected");
  } finally { await service.stop(); }
});

test("a repair that fails is shown in words, with Repair, and clears once a repair works", async () => {
  const ws = workspace();
  const { dir } = computer();
  const service = await serve(dir, ws, { selfRepair: true });
  const aside = `${CLAUDE_SETTINGS}.aside`;
  try {
    // Claude Code's settings cannot be written: a folder stands where the file was.
    renameSync(CLAUDE_SETTINGS, aside);
    mkdirSync(CLAUDE_SETTINGS);
    const m = seen(await tray(dir));
    assert.equal(m.state, "problem");
    assert.equal(m.headline, "Scopebond couldn't reconnect to Claude Code");
    assert.equal(m.fix, "repair");
    rmSync(CLAUDE_SETTINGS, { recursive: true });
    writeFileSync(CLAUDE_SETTINGS, "{}");
    const repaired = await agent.callAgent(dir, "POST", "/repair", {}, 10_000);
    assert.deepEqual(repaired.failed, []);
    assert.equal(seen(await tray(dir)).state, "protected");
  } finally {
    await service.stop();
    try { rmSync(aside, { force: true }); } catch { /* gone */ }
  }
});
