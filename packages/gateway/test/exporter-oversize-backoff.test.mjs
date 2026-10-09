// A record the workspace will never accept never holds up the records behind it, and a workspace that asks the exporter to
// slow down is honoured, also by a new exporter made later (a per-call hook, an agent cycle).
import { test } from "node:test";
import assert from "node:assert/strict";
import { canonical, createCloudExporter, createMemoryCloudOutbox } from "../dist/index.js";

const KiB = 1024;
const receipt = (id, padBytes = 0) => ({ payload: { action_ref: { action_id: id }, ...(padBytes ? { pad: "x".repeat(padBytes) } : {}) }, signature: { alg: "Ed25519", sig: "fixture" } });
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** A workspace with the hosted limits: a body over 1 MiB, more than `maxCount` receipts, or any receipt over 128 KiB of
 *  canonical JSON is refused whole with 413 batch_too_large. */
function sizedWorkspace({ maxCount = 100 } = {}) {
  const requests = [];
  const delivered = [];
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const ids = body.receipts.map((r) => r.payload.action_ref.action_id);
    const tooLarge = Buffer.byteLength(init.body) > 1024 * KiB || ids.length > maxCount || body.receipts.some((r) => Buffer.byteLength(canonical(r)) > 128 * KiB);
    requests.push({ ids, status: tooLarge ? 413 : 200 });
    if (tooLarge) return json(413, { error: "receipt exceeds 128 KiB", code: "batch_too_large", remediation: "Send smaller batches." });
    delivered.push(...ids);
    return json(200, { ok: true, ingested: ids.length, duplicates: 0 });
  };
  return { fetch, requests, delivered };
}

function exporter(fetch, extra = {}) {
  const gaps = [];
  const outbox = extra.outbox ?? createMemoryCloudOutbox(extra.now ? { now: extra.now } : {});
  const ex = createCloudExporter({ url: "https://cloud.example", credential: "sbm_x", outbox, flushMs: 1e9, fetch, onGap: (gap) => gaps.push(gap), ...extra });
  return { ex, outbox, gaps };
}

test("a mixed batch delivers the small records and settles the oversized one as an oversize gap", async () => {
  const ws = sizedWorkspace();
  const { ex, gaps } = exporter(ws.fetch);
  ex.enqueue(receipt("action:small-0001"));
  ex.enqueue(receipt("action:big-0002", 140 * KiB));
  ex.enqueue(receipt("action:small-0003"));
  ex.enqueue(receipt("action:small-0004"));
  await ex.flush();
  ex.stop();
  assert.deepEqual(ws.delivered, ["action:small-0001", "action:small-0003", "action:small-0004"]);
  assert.deepEqual(gaps.map((g) => [g.id, g.reason]), [["action:big-0002", "oversize"]]);
  assert.equal(ex.status().pending, 0, "nothing waits behind the oversized record");
  assert.equal(ex.status().lastError, null);
  assert.deepEqual(ex.status().gapsByReason, { oversize: 1 });
  // A large record travels on its own, so the workspace's refusal names it in one request.
  assert.deepEqual(ws.requests.filter((r) => r.status === 413).map((r) => r.ids), [["action:big-0002"]]);
});

test("an oversized record first in the queue is settled, not sent again on every flush", async () => {
  const ws = sizedWorkspace();
  const { ex, gaps } = exporter(ws.fetch);
  ex.enqueue(receipt("action:big-0001", 200 * KiB));
  for (let i = 2; i <= 4; i++) ex.enqueue(receipt(`action:after-000${i}`));
  await ex.flush();
  await ex.flush();
  ex.stop();
  assert.deepEqual(gaps.map((g) => g.reason), ["oversize"]);
  assert.deepEqual(ws.delivered, ["action:after-0002", "action:after-0003", "action:after-0004"]);
  assert.equal(ws.requests.filter((r) => r.ids.includes("action:big-0001")).length, 1);
});

test("a batch over the workspace's count limit is split until it is accepted; nothing is dropped", async () => {
  const ws = sizedWorkspace({ maxCount: 10 });
  const { ex, gaps } = exporter(ws.fetch);
  for (let i = 0; i < 25; i++) ex.enqueue(receipt(`action:many-${String(i).padStart(4, "0")}`));
  await ex.flush();
  ex.stop();
  assert.equal(gaps.length, 0);
  assert.equal(ws.delivered.length, 25);
  assert.equal(ex.status().pending, 0);
  assert.deepEqual(ws.requests.map((r) => [r.ids.length, r.status]), [[25, 413], [13, 413], [7, 200], [7, 200], [7, 200], [4, 200]]);
});

test("a batch is cut by size before it is sent, so a queue of large records never meets the body limit", async () => {
  const ws = sizedWorkspace();
  const { ex, gaps } = exporter(ws.fetch);
  for (let i = 0; i < 20; i++) ex.enqueue(receipt(`action:wide-${String(i).padStart(4, "0")}`, 60 * KiB));
  await ex.flush();
  ex.stop();
  assert.equal(gaps.length, 0);
  assert.equal(ws.delivered.length, 20);
  assert.ok(ws.requests.every((r) => r.status === 200), JSON.stringify(ws.requests.map((r) => [r.ids.length, r.status])));
});

test("a lone record refused with a 413 that is not the workspace's own (a proxy's) is kept and retried", async () => {
  const { ex, gaps } = exporter(async () => new Response("<html>413 Request Entity Too Large</html>", { status: 413, headers: { "content-type": "text/html" } }));
  ex.enqueue(receipt("action:proxy-0001"));
  await ex.flush();
  ex.stop();
  assert.equal(gaps.length, 0);
  assert.equal(ex.status().pending, 1);
  assert.match(ex.status().lastError, /HTTP 413/);
});

test("a refusal listing a record refused for good beside one kept back settles the first and keeps the second", async () => {
  let calls = 0;
  const { ex, gaps } = exporter(async (_url, init) => {
    calls += 1;
    const ids = JSON.parse(init.body).receipts.map((r) => r.payload.action_ref.action_id);
    return json(400, { code: "invalid_receipt", rejected: ids.map((id, index) => ({ index, action_id: id, code: id.includes("reset") ? "before_reset" : "future_timestamp" })) });
  });
  ex.enqueue(receipt("action:reset-0001"));
  ex.enqueue(receipt("action:ahead-0002"));
  await ex.flush();
  assert.deepEqual(gaps.map((g) => [g.id, g.reason]), [["action:reset-0001", "rejected"]], "refused for good: a gap, not retried");
  assert.equal(ex.status().pending, 1, "the record with a clock ahead waits to be sent again");
  assert.equal(calls, 1, "the kept record is not sent again in the same flush");
  await ex.flush();
  ex.stop();
  assert.equal(gaps.length, 1);
  assert.equal(ex.status().pending, 1);
  assert.match(ex.status().lastError, /clock ahead/);
});

test("records refused for a key the connection did not enroll are settled once kept a day, not retried for ever", async () => {
  let t = Date.parse("2026-10-05T10:00:00Z");
  const { ex, gaps } = exporter(async (_url, init) => {
    const ids = JSON.parse(init.body).receipts.map((r) => r.payload.action_ref.action_id);
    return json(409, { code: "attester_unavailable", rejected: ids.map((id, index) => ({ index, action_id: id, code: "attester_mismatch" })) });
  }, { now: () => t, flushMs: 1_000 });
  ex.enqueue(receipt("action:key-0001"));
  await ex.flush();
  assert.equal(gaps.length, 0, "kept while the key may still come back");
  t += 25 * 60 * 60 * 1000;
  await ex.flush();
  ex.stop();
  assert.deepEqual(gaps.map((g) => [g.id, g.reason]), [["action:key-0001", "rejected"]]);
  assert.equal(ex.status().pending, 0);
});

test("a wait the workspace asked for holds for a new exporter over the same queue, and a delivery clears it", async () => {
  let t = 1_000_000;
  const outbox = createMemoryCloudOutbox({ now: () => t });
  const first = exporter(async () => json(503, { code: "ingest_paused" }, { "retry-after": "600" }), { outbox, now: () => t });
  first.ex.enqueue(receipt("action:paused-0001"));
  await first.ex.flush();
  first.ex.stop();
  const backoff = first.ex.status().backoff;
  assert.ok(backoff.until >= t + 600_000 && backoff.until <= t + 720_000, JSON.stringify(backoff));
  assert.equal(backoff.retryAfterMs, 600_000);
  // A later process: a new exporter, given the recorded wait.
  let calls = 0;
  const second = exporter(async () => { calls += 1; return json(200, { ok: true }); }, { outbox, now: () => t, backoff });
  t += 60_000;
  await second.ex.flush();
  assert.equal(calls, 0, "nothing sent before the wait ends");
  assert.equal(second.ex.status().pending, 1);
  t = backoff.until;
  await second.ex.flush();
  second.ex.stop();
  assert.equal(calls, 1);
  assert.equal(second.ex.status().pending, 0);
  assert.equal(second.ex.status().backoff, null, "a delivery ends the wait");
});

test("a 429 that names no wait backs off from 30 seconds, doubling with each in a row, at most an hour", async () => {
  let t = 5_000_000;
  const outbox = createMemoryCloudOutbox({ now: () => t });
  outbox.enqueue(receipt("action:quota-0001"));
  let backoff = null;
  const waits = [];
  for (let i = 0; i < 9; i++) {
    const { ex } = exporter(async () => json(429, { code: "quota" }), { outbox, now: () => t, ...(backoff ? { backoff } : {}) });
    await ex.flush();
    ex.stop();
    backoff = ex.status().backoff;
    waits.push([backoff.count, backoff.until - t]);
    t = backoff.until;
  }
  for (const [count, wait] of waits) {
    const base = Math.min(3_600_000, 30_000 * 2 ** (count - 1));
    assert.ok(wait >= base && wait <= base + Math.min(base / 5, 300_000), `refusal ${count}: waited ${wait} ms`);
  }
  assert.deepEqual(waits.map(([count]) => count), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(backoff.retryAfterMs, null);
});

test("a 503 that names no wait is retried on the exporter's own schedule, not kept as a wait", async () => {
  const { ex } = exporter(async () => new Response("{}", { status: 503 }));
  ex.enqueue(receipt("action:down-0001"));
  await ex.flush();
  ex.stop();
  assert.equal(ex.status().backoff, null);
  assert.equal(ex.status().pending, 1);
});

test("a recorded wait is bounded, whatever it says", async () => {
  const t = 9_000_000;
  let calls = 0;
  const { ex } = exporter(async () => { calls += 1; return json(200, { ok: true }); }, { now: () => t, backoff: { until: t + 10 * 24 * 3_600_000, count: 3, retryAfterMs: 1e12 } });
  assert.ok(ex.status().nextAttemptAt <= t + 3_900_000, "at most an hour and five minutes");
  assert.deepEqual({ count: ex.status().backoff.count, retryAfterMs: ex.status().backoff.retryAfterMs }, { count: 3, retryAfterMs: 3_600_000 });
  ex.enqueue(receipt("action:bounded-0001"));
  await ex.flush();
  ex.stop();
  assert.equal(calls, 0);
});
