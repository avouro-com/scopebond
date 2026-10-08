// The wake time survives a restart of the agent alone: the service saves it each cycle and the next start reads it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, uptime } from "node:os";
import { join } from "node:path";
import { startService, AWAKE_FILE } from "../dist/index.js";

test("the service saves its wake time each cycle and a restart keeps it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-agent-awake-"));
  const fourHoursAgo = Date.now() - 4 * 3_600_000;
  writeFileSync(join(dir, AWAKE_FILE), JSON.stringify({ awake_since: fourHoursAgo, last_cycle_at: Date.now() - 20_000 }));
  const service = await startService({ dir, maintenance: false, tray: false, intervalMs: 1e9, log: () => {} });
  try {
    await service.cycleNow();
    const saved = JSON.parse(readFileSync(join(dir, AWAKE_FILE), "utf8"));
    // The wake time from before the restart stands, never earlier than this computer's start (a CI runner may be younger).
    const bootAt = Date.now() - uptime() * 1000;
    const expected = Math.max(fourHoursAgo, bootAt);
    assert.ok(Math.abs(saved.awake_since - expected) < 5_000, `awake since ${new Date(saved.awake_since).toISOString()}, expected ${new Date(expected).toISOString()}`);
    assert.ok(Date.now() - saved.awake_since > 60_000, "not counted from the agent's start");
    assert.ok(Date.now() - saved.last_cycle_at < 5_000);
  } finally { await service.stop(); }
});
