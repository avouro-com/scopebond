// Fault: the rules have not been checked for over an hour (the workspace's rules check answers 500). The last-known rules
// stay in force, so there is nothing for the person to do: the agent checks again at once, then with backoff, and the tray
// shows nothing (no "Rules not checked for…" attention state).
import { HOUR, MIN, computer, modelInput, seen, serve, tray, trayModel, until, workspace } from "./b2-fault-helpers.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const NOW = Date.parse("2026-10-20T15:30:00Z");

test("rules last checked two hours ago, the check failing: Protected, nothing about it in the header", () => {
  const m = trayModel(modelInput(NOW, {}, { rules: { checked_at: NOW - 2 * HOUR, managed: true, block: 9, monitor: 2, last_attempt_at: NOW - MIN, last_error: "the workspace answered 500" } }));
  assert.equal(m.state, "protected");
  assert.equal(m.fix, null);
  assert.doesNotMatch(JSON.stringify(m), /not checked/i, "no 'Rules not checked for…' anywhere");
  assert.equal(m.computer_rows.find((r) => r.label === "Rules updated")?.value, "2 h ago", "Settings keeps the fact");
});

test("the rules check fails with the rules stale: the agent checks again at once and keeps trying, then the rules update", async () => {
  const ws = workspace();
  const { dir } = computer();
  const stale = new Date(Date.now() - 2 * HOUR).toISOString();
  writeFileSync(join(dir, "managed-meta.json"), JSON.stringify({ evidence_detail: "full", checked_at: stale, checked_ok_at: stale }));
  ws.faults.policy = 500;
  // An hour between cycles: only the agent's own retry can explain a second check soon after the first.
  const service = await serve(dir, ws, { intervalMs: HOUR });
  try {
    await until(() => ws.calls.policy >= 2, 10_000, "a second rules check at once");
    const m = seen(await tray(dir));
    assert.equal(m.state, "protected", m.headline);
    assert.equal(m.fix, null);
    delete ws.faults.policy;
    await service.cycleNow();
    const after = seen(await tray(dir));
    assert.equal(after.row("Rules updated"), "just now");
  } finally { await service.stop(); }
});
