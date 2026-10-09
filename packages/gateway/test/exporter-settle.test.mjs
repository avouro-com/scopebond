// DIC-1: a batch the workspace refuses in a way no retry can fix never holds up the records
// behind it. Before, the exporter sent the same batch forever and every newer record waited.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCloudExporter, createMemoryCloudOutbox } from "../dist/index.js";

const receipt = (id) => ({ payload: { action_ref: { action_id: id } }, signature: { alg: "Ed25519", sig: "fixture" } });
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** An exporter over a memory queue whose workspace answers each request with `answer(receipts)`. */
function setup(answer) {
  const outbox = createMemoryCloudOutbox();
  const gaps = [];
  const delivered = [];
  const requests = [];
  const ex = createCloudExporter({
    url: "https://cloud.example", credential: "sbm_x", outbox, flushMs: 1e9, onGap: (gap) => gaps.push(gap),
    fetch: async (_url, init) => {
      const ids = JSON.parse(init.body).receipts.map((r) => r.payload.action_ref.action_id);
      requests.push(ids);
      const res = answer(ids);
      if (res.status === 200) delivered.push(...ids);
      return res;
    },
  });
  return { ex, outbox, gaps, delivered, requests };
}

test("a 400 that refuses every record on its own settles them as gaps, and the records behind them deliver", async () => {
  let first = true;
  const { ex, gaps, delivered } = setup((ids) => {
    if (first) { first = false; return json(400, { error: "invalid", code: "invalid_receipt", rejected: ids.map((id, index) => ({ index, action_id: id, code: "invalid_receipt", reason: "bad signature" })) }); }
    return json(200, { ok: true });
  });
  ex.enqueue(receipt("action:bad-0001"));
  ex.enqueue(receipt("action:bad-0002"));
  await ex.flush();
  ex.enqueue(receipt("action:good-0003"));
  await ex.flush();
  ex.stop();
  assert.deepEqual(gaps.map((g) => [g.id, g.reason]), [["action:bad-0001", "rejected"], ["action:bad-0002", "rejected"]]);
  assert.deepEqual(delivered, ["action:good-0003"]);
  assert.equal(ex.status().pending, 0);
  assert.equal(ex.status().lastError, null);
});

test("a timestamp ahead of the workspace's clock is retried, not dropped: it is accepted once the time passes", async () => {
  const { ex, gaps } = setup((ids) => json(400, { error: "future", code: "invalid_receipt", rejected: ids.map((id, index) => ({ index, action_id: id, code: "future_timestamp", reason: "ahead" })) }));
  ex.enqueue(receipt("action:ahead-0001"));
  await ex.flush();
  ex.stop();
  assert.equal(gaps.length, 0);
  assert.equal(ex.status().pending, 1);
  assert.match(ex.status().lastError, /clock ahead/);
});

test("a 409 id_conflict finds the one record by sending one at a time; the others deliver", async () => {
  const { ex, gaps, delivered, requests } = setup((ids) => (ids.includes("action:dup-0002")
    ? json(409, { error: "conflict", code: "id_conflict", remediation: "Two different records used the same action id." })
    : json(200, { ok: true })));
  for (const id of ["action:dup-0001", "action:dup-0002", "action:dup-0003"]) ex.enqueue(receipt(id));
  await ex.flush();
  ex.stop();
  assert.deepEqual(delivered, ["action:dup-0001", "action:dup-0003"]);
  assert.deepEqual(gaps.map((g) => [g.id, g.reason]), [["action:dup-0002", "id_conflict"]]);
  assert.deepEqual(requests[0], ["action:dup-0001", "action:dup-0002", "action:dup-0003"], "the batch goes first as it is");
  assert.equal(ex.status().pending, 0);
});

test("any other refusal keeps the batch for a retry, as before", async () => {
  for (const [status, body] of [[409, { code: "attester_unavailable" }], [401, { code: "credential_refused" }], [500, {}], [400, { code: "bad_request" }]]) {
    const { ex, gaps } = setup(() => json(status, body));
    ex.enqueue(receipt(`action:keep-${status}`));
    await ex.flush();
    ex.stop();
    assert.equal(gaps.length, 0, `HTTP ${status} ${body.code ?? ""}`);
    assert.equal(ex.status().pending, 1);
  }
});

test("a 400 that refuses only some records (the rest were not stored) is retried, not settled", async () => {
  const { ex, gaps } = setup((ids) => json(400, { code: "invalid_receipt", rejected: [{ index: 0, action_id: ids[0], code: "invalid_receipt" }] }));
  ex.enqueue(receipt("action:part-0001"));
  ex.enqueue(receipt("action:part-0002"));
  await ex.flush();
  ex.stop();
  assert.equal(gaps.length, 0);
  assert.equal(ex.status().pending, 2);
});

test("a workspace asking to wait (429 with Retry-After) is not asked again sooner", async () => {
  let t = 1_000_000;
  const outbox = createMemoryCloudOutbox({ now: () => t });
  const ex = createCloudExporter({
    url: "https://cloud.example", credential: "sbm_x", outbox, flushMs: 1_000, now: () => t, maxRetryMs: 60_000,
    fetch: async () => new Response(JSON.stringify({ code: "rate_limited" }), { status: 429, headers: { "retry-after": "120" } }),
  });
  ex.enqueue(receipt("action:wait-0001"));
  await ex.flush();
  ex.stop();
  // Never sooner than asked; a random spread of at most a fifth of the wait keeps computers from coming back together.
  const next = ex.status().nextAttemptAt;
  assert.ok(next >= t + 120_000 && next <= t + 120_000 + 24_000, `next attempt ${next - t} ms after the refusal`);
  assert.deepEqual(ex.status().backoff, { until: next, count: 1, retryAfterMs: 120_000, recordedAt: t });
});

test("after the conflicting record is found, the rest of the queue goes in batches again", async () => {
  const { ex, requests, delivered } = setup((ids) => (ids.includes("action:iso-0001")
    ? json(409, { code: "id_conflict" })
    : json(200, { ok: true })));
  for (let i = 1; i <= 6; i += 1) ex.enqueue(receipt(`action:iso-000${i}`));
  await ex.flush();
  ex.stop();
  assert.deepEqual(delivered, ["action:iso-0002", "action:iso-0003", "action:iso-0004", "action:iso-0005", "action:iso-0006"]);
  // The batch, the conflicting record alone, then one batch for the rest.
  assert.deepEqual(requests.map((r) => r.length), [6, 1, 5]);
});

test("records signed with a key the connection did not enroll are retried, never settled", async () => {
  const { ex, gaps } = setup((ids) => json(400, { code: "invalid_receipt", rejected: ids.map((id, index) => ({ index, action_id: id, code: "attester_mismatch" })) }));
  ex.enqueue(receipt("action:key-0001"));
  await ex.flush();
  ex.stop();
  assert.equal(gaps.length, 0);
  assert.equal(ex.status().pending, 1);
});

test("Retry-After as an HTTP date is measured against the exporter's clock, at most an hour (plus at most five minutes of spread)", async () => {
  let t = Date.parse("2026-10-05T10:00:00Z");
  for (const [header, wait] of [[new Date(t + 90_000).toUTCString(), 90_000], ["99999", 3_600_000]]) {
    const outbox = createMemoryCloudOutbox({ now: () => t });
    const ex = createCloudExporter({
      url: "https://cloud.example", credential: "sbm_x", outbox, flushMs: 1_000, now: () => t, maxRetryMs: 60_000,
      fetch: async () => new Response("{}", { status: 503, headers: { "retry-after": header } }),
    });
    ex.enqueue(receipt(`action:date-${wait}`));
    await ex.flush();
    ex.stop();
    const next = ex.status().nextAttemptAt;
    assert.ok(next >= t + wait && next <= t + wait + Math.min(wait / 5, 300_000), `next attempt ${next - t} ms after the refusal`);
  }
});

test("a record refused only because this computer's clock is ahead stays queued and is sent again", async () => {
  let ahead = true;
  const { ex, gaps, delivered, requests } = setup((ids) => {
    const refused = ahead ? ids.filter((id) => id === "action:ahead-0001") : [];
    if (refused.length === ids.length) return json(400, { code: "invalid_receipt", rejected: ids.map((id, index) => ({ index, action_id: id, code: "future_timestamp" })) });
    return json(200, { ok: true, rejected: ids.flatMap((id, index) => (refused.includes(id) ? [{ index, action_id: id, code: "future_timestamp" }] : [])) });
  });
  ex.enqueue(receipt("action:ahead-0001"));
  ex.enqueue(receipt("action:ahead-0002"));
  await ex.flush();
  assert.equal(gaps.length, 0, "not settled as lost");
  assert.equal(ex.status().pending, 1, "the newer record went through; the one ahead waits");
  assert.equal(requests.length, 1, "the record ahead is not sent again in the same flush");
  void ahead;
  ex.stop();
  assert.ok(delivered.includes("action:ahead-0002"));
});

test("a non-conforming 200 that refuses every record for a clock ahead does not loop: it waits and retries", async () => {
  const { ex, requests } = setup((ids) => json(200, { ok: true, rejected: ids.map((id, index) => ({ index, action_id: id, code: "future_timestamp" })) }));
  ex.enqueue(receipt("action:loop-0001"));
  await ex.flush();
  ex.stop();
  assert.equal(requests.length, 1);
  assert.equal(ex.status().pending, 1);
  assert.match(ex.status().lastError, /clock ahead/);
});

test("a record kept for a clock ahead longer than a day is settled as a gap", async () => {
  let t = 10 * 86_400_000;
  const outbox = createMemoryCloudOutbox({ now: () => t });
  const gaps = [];
  const ex = createCloudExporter({
    url: "https://cloud.example", credential: "sbm_x", outbox, flushMs: 1_000, now: () => t, onGap: (g) => gaps.push(g),
    fetch: async (_u, init) => {
      const ids = JSON.parse(init.body).receipts.map((r) => r.payload.action_ref.action_id);
      return json(400, { code: "invalid_receipt", rejected: ids.map((id, index) => ({ index, action_id: id, code: "future_timestamp" })) });
    },
  });
  ex.enqueue(receipt("action:old-ahead-0001"));
  await ex.flush();
  assert.equal(ex.status().pending, 1, "kept while under a day");
  t += 86_400_000 + 1;
  await ex.flush();
  ex.stop();
  assert.equal(ex.status().pending, 0);
  assert.deepEqual(gaps.map((g) => [g.id, g.reason]), [["action:old-ahead-0001", "rejected"]]);
});

test("in a batch with valid records, one refused for a key the connection did not enroll is kept, not settled", async () => {
  const { ex, gaps, delivered } = setup((ids) => json(200, { ok: true, rejected: ids.flatMap((id, index) => (id === "action:key-mix-0001" ? [{ index, action_id: id, code: "attester_mismatch" }] : [])) }));
  ex.enqueue(receipt("action:key-mix-0001"));
  ex.enqueue(receipt("action:key-mix-0002"));
  await ex.flush();
  ex.stop();
  assert.equal(gaps.length, 0);
  assert.equal(ex.status().pending, 1);
  assert.ok(delivered.includes("action:key-mix-0002"));
});

test("more kept records than a batch at the head of the queue never hold up the records behind them", async () => {
  const { ex, outbox, gaps, delivered, requests } = setup((ids) => {
    const ahead = ids.filter((id) => id.startsWith("action:head-"));
    const rejected = ids.flatMap((id, index) => (ahead.includes(id) ? [{ index, action_id: id, code: "future_timestamp" }] : []));
    if (ahead.length === ids.length) return json(400, { code: "invalid_receipt", rejected });
    return json(200, { ok: true, rejected });
  });
  // Queued directly: enqueue() would start its own flush at 100 records.
  for (let i = 0; i < 120; i += 1) outbox.enqueue(receipt(`action:head-${String(i).padStart(4, "0")}`));
  for (let i = 0; i < 5; i += 1) outbox.enqueue(receipt(`action:tail-${String(i).padStart(4, "0")}`));
  await ex.flush();
  ex.stop();
  assert.equal(delivered.filter((id) => id.startsWith("action:tail-")).length, 5, "the records behind are delivered in the same flush");
  assert.equal(gaps.length, 0);
  assert.equal(ex.status().pending, 120);
  assert.ok(requests.length <= 3, `each record goes out at most once per flush (${requests.length} requests)`);
});
