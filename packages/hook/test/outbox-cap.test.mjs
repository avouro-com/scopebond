// The delivery queue's size limit: a queue that never drains does not fill the disk, and a record that comes when it is
// full is never dropped silently: its receipt stays in the log, the queue counts it as a `capacity` gap (the workspace
// hears of it with the rules check, beside the backlog's size), and status and doctor say the queue is full.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliveryQueueLimits, describeDelivery, openDeliveryQueue, OUTBOX_FILE, OUTBOX_MAX_BYTES, queueFullness, queueStatus } from "../dist/index.js";

const receipt = (i, size) => ({ payload: { action_ref: { action_id: `a-${i}` }, note: "x".repeat(size) }, signature: "s" });

test("the queue has a generous size limit, and no count limit or expiry", () => {
  const prev = process.env.SCOPEBOND_OUTBOX_MAX_MB;
  try {
    delete process.env.SCOPEBOND_OUTBOX_MAX_MB;
    const limits = deliveryQueueLimits();
    assert.equal(limits.maxBytes, OUTBOX_MAX_BYTES);
    assert.equal(OUTBOX_MAX_BYTES, 512 * 1024 * 1024);
    assert.equal(limits.maxPending, Number.MAX_SAFE_INTEGER);
    assert.equal(limits.maxAgeMs, Number.MAX_SAFE_INTEGER);
    process.env.SCOPEBOND_OUTBOX_MAX_MB = "2048";
    assert.equal(deliveryQueueLimits().maxBytes, 2048 * 1024 * 1024);
    process.env.SCOPEBOND_OUTBOX_MAX_MB = "nonsense";
    assert.equal(deliveryQueueLimits().maxBytes, OUTBOX_MAX_BYTES);
  } finally { if (prev === undefined) delete process.env.SCOPEBOND_OUTBOX_MAX_MB; else process.env.SCOPEBOND_OUTBOX_MAX_MB = prev; }
  assert.equal(queueFullness(0, 100), null);
  assert.equal(queueFullness(90, 100), "nearly_full");
  assert.equal(queueFullness(100, 100), "full");
});

test("a full queue counts the next record as a capacity gap and status and doctor say so loudly", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-outbox-cap-"));
  const prev = process.env.SCOPEBOND_OUTBOX_MAX_MB;
  process.env.SCOPEBOND_OUTBOX_MAX_MB = "1";
  try {
    const queue = openDeliveryQueue(join(dir, OUTBOX_FILE));
    let i = 0;
    for (; i < 64; i++) { const r = queue.enqueue(receipt(i, 64 * 1024)); if (!r.queued) { assert.equal(r.gap?.reason, "capacity"); break; } }
    assert.ok(i < 64, "the queue stopped taking records at its limit");
    queue.close();
    const status = queueStatus(dir);
    assert.equal(status.gapsByReason.capacity, 1, "counted, not dropped silently");
    assert.ok(status.bytes > 0.9 * 1024 * 1024);
    const report = describeDelivery(dir, { url: "https://workspace.example" });
    assert.match(report.lines.join("\n"), /DELIVERY QUEUE (?:NEARLY )?FULL/);
    assert.ok(report.problems.some((p) => /delivery queue is (?:nearly )?full/.test(p)), report.problems.join("\n"));
  } finally { if (prev === undefined) delete process.env.SCOPEBOND_OUTBOX_MAX_MB; else process.env.SCOPEBOND_OUTBOX_MAX_MB = prev; }
});
