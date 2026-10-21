// Fault: the end-to-end self-check does not pass. Nothing in it is the person's to do, so the tray stays "Protected" and
// Settings says what did not pass, in words (never check ids); the line stays until a check passes (an upkeep pass or a
// cycle that runs no self-check never clears it).
import { agent, computer, modelInput, seen, serve, tray, trayModel, workspace } from "./b2-fault-helpers.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const NOW = Date.parse("2026-10-20T15:30:00Z");

test("a self-check that did not pass is a quiet Settings line in words, never the header", () => {
  const failed = (ids) => seen(trayModel(modelInput(NOW, {}, { selfCheck: { ok: false, failed: ids } })));
  const m = failed(["signing_key", "workspace_http_500"]);
  assert.equal(m.state, "protected");
  assert.equal(m.fix, null);
  assert.equal(m.row("Self-check"), "Last check didn't pass: this computer's signing key is missing; the workspace didn't answer");
  assert.equal(failed(["hook_duplicates"]).row("Self-check"), "Last check didn't pass: the Scopebond hook runs more than once");
  assert.doesNotMatch(failed(["hook_entry", "autostart", "something_new"]).row("Self-check"), /hook_entry|autostart\b/, "no ids");
  // Records waiting and the connection's renewal are chores with their own lines: not repeated here.
  assert.equal(failed(["queue", "credential"]).row("Self-check"), null);
  assert.equal(seen(trayModel(modelInput(NOW, {}, { selfCheck: { ok: true, failed: [] } }))).row("Self-check"), null);
});

test("the workspace says the self-check failed: Protected, the line stays through cycles, and goes once a check passes", async () => {
  const ws = workspace();
  const { dir } = computer();
  ws.answers["self-check"] = { ok: false, signature_verified: false, failed: ["signing_key"] };
  const service = await serve(dir, ws);
  try {
    await service.maintainNow();
    let m = seen(await tray(dir));
    assert.equal(m.state, "protected", m.headline);
    assert.equal(m.row("Self-check"), "Last check didn't pass: this computer's signing key is missing");
    await service.cycleNow();
    m = seen(await tray(dir));
    assert.equal(m.row("Self-check"), "Last check didn't pass: this computer's signing key is missing", "kept until a check passes");
    ws.answers["self-check"] = { ok: true, signature_verified: true, failed: [] };
    const checked = await agent.callAgent(dir, "POST", "/check", {}, 30_000);
    assert.equal(checked.text, "Checked just now: all good");
    assert.equal(seen(await tray(dir)).row("Self-check"), null);
  } finally { await service.stop(); }
});
