// A stop asked for by this computer's user is noted in the Scopebond folder, so the native tray leaves the agent stopped;
// the next start removes the note.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callAgent, startService, STOPPED_FILE } from "../dist/index.js";

test("POST /stop leaves agent-stopped.json; a start removes it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-agent-stopped-"));
  writeFileSync(join(dir, STOPPED_FILE), "{}\n");
  let stopped;
  const done = new Promise((resolve) => { stopped = resolve; });
  const service = await startService({ dir, maintenance: false, tray: false, intervalMs: 1e9, log: () => {}, onStopped: () => stopped() });
  try {
    assert.equal(existsSync(join(dir, STOPPED_FILE)), false, "a start removes an earlier note");
    const answer = await callAgent(dir, "POST", "/stop", {});
    assert.deepEqual(answer, { stopping: true });
    await done;
    const note = JSON.parse(readFileSync(join(dir, STOPPED_FILE), "utf8"));
    assert.equal(note.pid, process.pid);
    assert.ok(Date.parse(note.stopped_at) > Date.now() - 60_000);
  } finally { await service.stop(); }
});
