// A wait the workspace asked for (429, or 503 with Retry-After) is kept in delivery.json so it holds across processes
// (each hook call, each agent cycle, `flush`). It never holds more than an hour and five minutes after it was recorded,
// whatever the stored value says, and a clock that jumps (back or forward) never makes it longer: a stored wait beyond the
// bound is rewritten to it, so the processes that follow do not each start the bound again from their own start.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCloudExporter, createMemoryCloudOutbox } from "@scopebond/gateway";
import { deliveryBackoff, readDeliveryState, recordDeliveryAttempt, waitingUntil, writeDeliveryState } from "../dist/index.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const BOUND = 65 * MIN;
const receipt = (id) => ({ payload: { action_ref: { action_id: id }, timestamp: new Date().toISOString() }, signature: { alg: "Ed25519", sig: "fixture" } });
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** One computer whose clock the test sets, and a workspace that accepts or answers 429 (Retry-After: an hour). */
function world() {
  let clock = Date.parse("2026-10-09T00:00:00Z");
  let mode = "ok";
  const requests = [];
  const fetch = async () => {
    requests.push({ at: clock, mode });
    if (mode === "quota") return json(429, { error: "monthly ingest limit reached", code: "quota" }, { "retry-after": "3600" });
    return json(200, { ok: true, ingested: 1, duplicates: 0 });
  };
  const outbox = createMemoryCloudOutbox({ now: () => clock, maxAgeMs: 1e12 });
  return { get clock() { return clock; }, set clock(v) { clock = v; }, setMode: (m) => { mode = m; }, requests, fetch, outbox };
}

/** One per-call process (a hook call or an agent cycle): a new exporter with the recorded wait, one flush, the outcome recorded. */
async function oneProcess(w, dir) {
  const backoff = deliveryBackoff(dir, w.clock);
  const ex = createCloudExporter({ url: "https://cloud.example", credential: "sbm_x", outbox: w.outbox, flushMs: 1e9, fetch: w.fetch, now: () => w.clock, ...(backoff ? { backoff } : {}) });
  const before = ex.status().lastSuccessAt;
  await ex.flush();
  const status = ex.status();
  recordDeliveryAttempt(dir, status, w.clock, before, null, "hook");
  ex.stop();
  return status;
}

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "sb-wait-bound-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("a 429 recorded while the clock was a day ahead does not hold delivery once the clock is corrected", async (t) => {
  const dir = tempDir(t);
  const w = world();
  const trueStart = w.clock;
  w.clock = trueStart + 24 * HOUR; // the clock is a day ahead (a restored VM, a wrong RTC) when the workspace answers 429
  w.setMode("quota");
  w.outbox.enqueue(receipt("action:wait-bound-0001"));
  await oneProcess(w, dir);
  assert.ok(readDeliveryState(dir).backoff_until > trueStart + 25 * HOUR - 1, "the wait was recorded on the clock that was ahead");
  w.setMode("ok");
  let firstSendHour = null;
  for (let h = 0; h <= 26 && firstSendHour === null; h++) {
    w.clock = trueStart + h * HOUR + 1;
    const before = w.requests.length;
    await oneProcess(w, dir);
    if (w.requests.length > before) firstSendHour = h;
  }
  assert.ok(firstSendHour !== null && firstSendHour <= 2, `delivery resumed only at hour ${firstSendHour} after the clock was corrected`);
  assert.equal(w.outbox.status().pending, 0);
});

test("a far-future wait in delivery.json is brought back to the bound once, and later processes send", async (t) => {
  const dir = tempDir(t);
  const w = world();
  const start = w.clock;
  writeDeliveryState(dir, { backoff_until: start + 10 * 365 * 24 * HOUR, backoff_count: 1, retry_after_ms: HOUR });
  w.outbox.enqueue(receipt("action:wait-bound-0002"));
  await oneProcess(w, dir);
  assert.equal(w.requests.length, 0, "the first process still waits");
  const stored = readDeliveryState(dir).backoff_until;
  assert.ok(stored <= start + BOUND, `the stored wait is rewritten to the bound: ${new Date(stored).toISOString()}`);
  // A process every ten minutes: none of them starts the bound again from its own start.
  for (let m = 10; m <= 80 && w.requests.length === 0; m += 10) { w.clock = start + m * MIN; await oneProcess(w, dir); }
  assert.ok(w.requests.length > 0, "no process sent anything within the bound");
  assert.ok(w.requests[0].at <= start + BOUND + 10 * MIN, `first send at +${(w.requests[0].at - start) / MIN} min`);
  assert.equal(readDeliveryState(dir).backoff_until, null, "a delivery clears the wait");
});

test("two processes started 30 minutes apart honour one wait, and neither extends it", async (t) => {
  const dir = tempDir(t);
  const w = world();
  const start = w.clock;
  w.setMode("quota");
  w.outbox.enqueue(receipt("action:wait-bound-0003"));
  await oneProcess(w, dir);
  const recorded = readDeliveryState(dir);
  assert.ok(recorded.backoff_until >= start + HOUR && recorded.backoff_until <= start + BOUND, JSON.stringify(recorded));
  assert.equal(recorded.backoff_at, start, "the wait is kept with when it was recorded");
  w.setMode("ok");
  w.clock = start + 30 * MIN;
  await oneProcess(w, dir);
  assert.equal(w.requests.length, 1, "the second process waits too");
  assert.equal(readDeliveryState(dir).backoff_until, recorded.backoff_until, "and leaves the wait as it was");
  w.clock = recorded.backoff_until + 1;
  await oneProcess(w, dir);
  assert.equal(w.requests.length, 2, "the next process after the wait sends");
});

test("a clock that steps back during a wait ends it rather than extending it", async (t) => {
  const dir = tempDir(t);
  const w = world();
  const start = w.clock;
  w.setMode("quota");
  w.outbox.enqueue(receipt("action:wait-bound-0004"));
  await oneProcess(w, dir);
  w.setMode("ok");
  // 50 minutes later the clock is stepped back an hour: on the new clock the wait would last another 1 h 10 min.
  w.clock = start + 50 * MIN - HOUR;
  await oneProcess(w, dir);
  assert.equal(w.requests.length, 2, "the wait cannot be placed on a clock that went back, so it ends");
  assert.equal(readDeliveryState(dir).backoff_until, null);
});

test("status never reports a wait past the bound", (t) => {
  const dir = tempDir(t);
  const now = Date.parse("2026-10-09T12:00:00Z");
  writeDeliveryState(dir, { backoff_until: now + 10 * 365 * 24 * HOUR, backoff_count: 1 });
  assert.equal(waitingUntil(readDeliveryState(dir), now), now + BOUND);
  writeDeliveryState(dir, { backoff_until: now + 30 * MIN, backoff_at: now - 50 * MIN });
  assert.equal(waitingUntil(readDeliveryState(dir), now), now + 15 * MIN, "an hour and five minutes after it was recorded");
  writeDeliveryState(dir, { backoff_until: now + 30 * MIN, backoff_at: now + HOUR });
  assert.equal(waitingUntil(readDeliveryState(dir), now), null, "recorded later than now: the clock went back, the wait has ended");
  writeDeliveryState(dir, { backoff_until: now + 30 * MIN, backoff_at: now - 5 * MIN });
  assert.equal(waitingUntil(readDeliveryState(dir), now), now + 30 * MIN, "a wait inside the bound is kept as recorded");
});
