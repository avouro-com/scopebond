// A wait an earlier process recorded (`backoff`) is bounded from when it was recorded, not from when this exporter starts,
// so a stored wait cannot hold delivery longer by being handed from process to process. A clock that went back since
// the wait was recorded ends it: what is left of it cannot be told, and a jump never makes a wait longer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCloudExporter, createMemoryCloudOutbox } from "../dist/index.js";

const MIN = 60_000;
const receipt = (id) => ({ payload: { action_ref: { action_id: id } }, signature: { alg: "Ed25519", sig: "fixture" } });
const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });

function exporterAt(t, backoff) {
  let calls = 0;
  const ex = createCloudExporter({
    url: "https://cloud.example", credential: "sbm_x", outbox: createMemoryCloudOutbox({ now: () => t }), flushMs: 1e9, now: () => t, backoff,
    fetch: async () => { calls += 1; return ok(); },
  });
  return { ex, calls: () => calls };
}

test("a recorded wait ends at most an hour and five minutes after it was recorded", async () => {
  const t = 50_000_000;
  const { ex, calls } = exporterAt(t, { until: t + 24 * 60 * MIN, count: 1, retryAfterMs: 60 * MIN, recordedAt: t - 30 * MIN });
  assert.equal(ex.status().nextAttemptAt, t + 35 * MIN, "65 minutes from when it was recorded, not from this exporter's start");
  assert.equal(ex.status().backoff.recordedAt, t - 30 * MIN, "kept for the next process");
  const late = exporterAt(t + 36 * MIN, { until: t + 24 * 60 * MIN, count: 1, retryAfterMs: 60 * MIN, recordedAt: t - 30 * MIN });
  late.ex.enqueue(receipt("action:recorded-wait-0001"));
  await late.ex.flush();
  late.ex.stop();
  assert.equal(late.calls(), 1, "a later process sends once the bound has passed");
  ex.stop();
  assert.equal(calls(), 0);
});

test("a wait recorded later than now (the clock went back since) has ended", async () => {
  const t = 50_000_000;
  const { ex, calls } = exporterAt(t, { until: t + 70 * MIN, count: 2, retryAfterMs: 60 * MIN, recordedAt: t + 10 * MIN });
  assert.equal(ex.status().nextAttemptAt, null);
  assert.equal(ex.status().backoff.count, 2, "the count carries on");
  ex.enqueue(receipt("action:recorded-wait-0002"));
  await ex.flush();
  ex.stop();
  assert.equal(calls(), 1);
});

test("a wait inside the bound is kept as recorded", () => {
  const t = 50_000_000;
  const { ex } = exporterAt(t, { until: t + 20 * MIN, count: 1, retryAfterMs: 30 * MIN, recordedAt: t - 10 * MIN });
  assert.equal(ex.status().nextAttemptAt, t + 20 * MIN);
  ex.stop();
});
