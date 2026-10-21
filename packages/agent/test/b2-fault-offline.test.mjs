// Fault: the workspace cannot be reached at all (no network). The hook keeps checking every action with this computer's
// rules and the agent keeps trying; there is nothing to do, however long it lasts: the tray says "Offline" with one line,
// "Using this computer's rules; records send when back online", and never turns to attention (so no toast).
import { HOUR, MIN, computer, modelInput, seen, serve, tray, trayModel, until, waitingRecords, workspace } from "./b2-fault-helpers.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const NOW = Date.parse("2026-10-20T15:30:00Z");
const LINE = "Using this computer's rules; records send when back online";

test("offline for 30 minutes, 5 hours or 2 days: Offline with the same line, never attention, nothing to press", () => {
  for (const forMs of [30 * MIN, 5 * HOUR, 48 * HOUR]) {
    const m = seen(trayModel(modelInput(NOW, { pending: 7, oldest_pending_age_s: forMs / 1000, last_success_at: NOW - forMs, last_error: "fetch failed (ENOTFOUND)" })));
    assert.equal(m.state, "offline", `offline for ${forMs / MIN} min`);
    assert.equal(m.headline, LINE);
    assert.equal(m.fix, null);
    assert.equal(m.row("Delivery"), null, "offline is said once, in the header");
  }
});

test("the workspace unreachable: the agent says Offline with the line, and keeps trying", async () => {
  const ws = workspace();
  const { dir, connection } = computer();
  ws.faults.ingest = "down"; ws.faults.policy = "down";
  await waitingRecords(dir, connection, 2);
  const service = await serve(dir, ws, { intervalMs: 100 });
  try {
    await until(() => ws.calls.ingest >= 2, 10_000, "delivery tried twice");
    const m = seen(await tray(dir));
    assert.equal(m.state, "offline");
    assert.equal(m.headline, LINE);
    assert.equal(m.fix, null);
  } finally { await service.stop(); }
});
