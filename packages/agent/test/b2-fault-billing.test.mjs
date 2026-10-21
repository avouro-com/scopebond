// Fault: the workspace refuses records for billing reasons (429 quota: its monthly limit; 402 not_licensed; 402 agent_paused).
// A developer cannot fix billing (Scopebond Cloud tells the workspace's owner), and the hook keeps checking every action: the
// tray stays "Protected" with no attention state and no button, and Settings carries one quiet line and the plain note.
import { HOUR, computer, modelInput, seen, serve, tray, trayModel, until, waitingRecords, workspace } from "./b2-fault-helpers.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const NOW = Date.parse("2026-10-20T15:30:00Z");
const QUOTA = "ingest failed: HTTP 429 (quota): The workspace reached its monthly limit. Records stay queued on the computer and send once the limit allows.";
const model = (lastError, pending) => trayModel(modelInput(NOW, { pending, oldest_pending_age_s: 3 * HOUR / 1000, last_success_at: NOW - 3 * HOUR, last_error: lastError }));

test("at the workspace's monthly limit: Protected, one Settings line, the note in Settings, nothing to press", () => {
  const raw = model(QUOTA, 120);
  const m = seen(raw);
  assert.equal(m.state, "protected");
  assert.equal(m.fix, null);
  assert.equal(m.row("Records"), "Workspace limit reached · 120 records wait on this computer");
  assert.match(raw.hint, /monthly limit/, "the note Settings shows under This computer");
  assert.ok(!raw.actions.some((a) => a.id === "open_workspace" && raw.fix), "no button for a developer");
});

test("not licensed, and paused by the plan: Protected, one quiet Settings line each", () => {
  const unlicensed = seen(model("ingest failed: HTTP 402 (not_licensed): This agent is not licensed.", 4));
  assert.equal(unlicensed.state, "protected");
  assert.equal(unlicensed.fix, null);
  assert.equal(unlicensed.row("Records"), "Not licensed · 4 records wait on this computer");
  const paused = seen(model("ingest failed: HTTP 402 (agent_paused)", 1));
  assert.equal(paused.state, "protected");
  assert.equal(paused.row("Records"), "Paused by your workspace's plan · 1 record waits on this computer");
});

test("the workspace answers 402 not_licensed: the agent keeps going, the tray stays Protected with the quiet line", async () => {
  const ws = workspace();
  const { dir, connection } = computer();
  ws.faults.ingest = { status: 402, code: "not_licensed" };
  await waitingRecords(dir, connection, 2);
  const service = await serve(dir, ws, { intervalMs: 100 });
  try {
    await until(() => ws.calls.ingest >= 2, 10_000, "delivery tried");
    const m = seen(await tray(dir));
    assert.equal(m.state, "protected", m.headline);
    assert.equal(m.fix, null);
    assert.match(m.row("Records") ?? "", /^Not licensed · 2 records wait on this computer$/);
  } finally { await service.stop(); }
});
