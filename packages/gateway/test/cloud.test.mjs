import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createGateway, MemoryReceiptStore, createCloudExporter, createMemoryCloudOutbox, withCloudExporter,
} from "../dist/index.js";
import { SqliteCloudOutbox } from "../dist/node.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const receipt = (id, value = 1) => ({
  payload: { action_ref: { action_id: id }, value },
  signature: { alg: "Ed25519", sig: "fixture" },
});

function mockFetch() {
  const calls = [];
  let fail = 0;
  const f = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (fail > 0) { fail--; return { ok: false, status: 500 }; }
    calls.push({ url, count: body.receipts.length, auth: opts.headers.authorization });
    return { ok: true, status: 200 };
  };
  f.calls = calls;
  f.failNext = (n) => { fail = n; };
  return f;
}

test("exporter batches receipts and POSTs to /v1/ingest with the machine credential", async () => {
  const f = mockFetch();
  const ex = createCloudExporter({
    url: "https://cloud.example/", credential: "sbm_x", outbox: createMemoryCloudOutbox(),
    batchSize: 2, flushMs: 1e9, fetch: f,
  });
  ex.enqueue(receipt("action:cloud-test-0001")); ex.enqueue(receipt("action:cloud-test-0002"));
  await new Promise((r) => setTimeout(r, 20));
  ex.enqueue(receipt("action:cloud-test-0003"));
  await ex.flush();
  ex.stop();
  assert.equal(f.calls[0].url, "https://cloud.example/v1/ingest");
  assert.equal(f.calls[0].auth, "Bearer sbm_x");
  assert.equal(f.calls.reduce((s, c) => s + c.count, 0), 3);
});

test("exporter keeps the buffer on failure and retries", async () => {
  const f = mockFetch(); f.failNext(1);
  let now = 1_000;
  const ex = createCloudExporter({
    url: "https://c", credential: "sbm_k", outbox: createMemoryCloudOutbox({ now: () => now }),
    batchSize: 10, flushMs: 100, maxRetryMs: 1_000, fetch: f, now: () => now,
  });
  ex.enqueue(receipt("action:cloud-retry-0001"));
  await ex.flush();               // first attempt fails
  assert.equal(ex.pending(), 1);  // buffer retained
  assert.equal(ex.status().consecutiveFailures, 1);
  now += 100;
  await ex.flush();               // retry succeeds
  assert.equal(ex.pending(), 0);
  ex.stop();
});

test("withCloudExporter stores locally AND queues for Cloud; anchoring still works", async () => {
  const f = mockFetch();
  const ex = createCloudExporter({
    url: "https://c", credential: "sbm_k", outbox: createMemoryCloudOutbox(),
    batchSize: 100, flushMs: 1e9, fetch: f,
  });
  const base = new MemoryReceiptStore();
  const gw = createGateway({ authentication: { mode: "insecure-development" },
    policy: {
      vocabulary_version: "1.0", policy_id: "cloud-export", version: 1,
      clauses: [{ id: "actions", type: "action_allowlist", mode: "enforce", action_types: ["x"] }],
    },
    store: withCloudExporter(base, ex),
  });
  await gw.app.request("/v1/evaluate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ intent: { action_type: "x" } }) });
  assert.equal((await base.list()).length, 1); // persisted locally
  assert.equal(ex.pending(), 1);               // queued for Cloud
  await ex.flush();
  assert.equal(ex.pending(), 0);
  const a = await gw.anchor();                  // anchor via the wrapped store
  assert.equal(a.tree_size, 1);
  ex.stop();
});

test("bounded outbox reports conflicts, capacity drops, and expiry as delivery gaps", () => {
  let now = 10_000;
  const outbox = createMemoryCloudOutbox({ maxPending: 1, maxBytes: 10_000, maxAgeMs: 100, now: () => now });
  assert.deepEqual(outbox.enqueue(receipt("action:bounded-outbox-0001")), { queued: true, duplicate: false });
  assert.deepEqual(outbox.enqueue(receipt("action:bounded-outbox-0001")), { queued: true, duplicate: true });
  assert.equal(outbox.enqueue(receipt("action:bounded-outbox-0001", 2)).gap.reason, "id_conflict");
  assert.equal(outbox.enqueue(receipt("action:bounded-outbox-0002")).gap.reason, "capacity");
  now += 101;
  assert.equal(outbox.peek(10, now).length, 0);
  assert.deepEqual(outbox.status(), {
    pending: 0,
    pendingBytes: 0,
    oldestEnqueuedAt: null,
    gaps: 3,
    retainedGapRecords: 1,
    latestGap: { id: "action:bounded-outbox-0001", reason: "expired", at: now },
  });
});

test("legacy receipts without durable action ids become explicit delivery gaps", () => {
  const gaps = [];
  const outbox = createMemoryCloudOutbox();
  const ex = createCloudExporter({
    url: "https://cloud.example", credential: "sbm_x", outbox,
    flushMs: 1e9, onGap: (gap) => gaps.push(gap),
  });
  ex.enqueue({ payload: { value: 1 }, signature: { alg: "Ed25519", sig: "fixture" } });
  assert.equal(ex.pending(), 0);
  assert.equal(ex.status().gaps, 1);
  assert.equal(gaps[0].reason, "missing_action_id");
  ex.stop();
});

test("exporter rejects incomplete Cloud configuration", () => {
  assert.throws(
    () => createCloudExporter({ url: "", credential: "sbm_x", outbox: createMemoryCloudOutbox() }),
    /URL is required/,
  );
  assert.throws(
    () => createCloudExporter({ url: "https://cloud.example", credential: "", outbox: createMemoryCloudOutbox() }),
    /machine credential is required/,
  );
});

test("SQLite outbox survives reopen and acknowledges only the matching content hash", () => {
  const directory = mkdtempSync(join(tmpdir(), "scopebond-cloud-outbox-"));
  const path = join(directory, "outbox.db");
  const first = new SqliteCloudOutbox(path);
  first.enqueue(receipt("action:durable-outbox-0001"));
  const entry = first.peek(10, Date.now())[0];
  first.close();

  const reopened = new SqliteCloudOutbox(path);
  assert.equal(reopened.status().pending, 1);
  reopened.acknowledge([{ id: entry.id, payloadHash: "wrong" }]);
  assert.equal(reopened.status().pending, 1);
  reopened.acknowledge([{ id: entry.id, payloadHash: entry.payloadHash }]);
  assert.equal(reopened.status().pending, 0);
  reopened.close();
  rmSync(directory, { recursive: true, force: true });
});

test("SQLite gap detail is bounded while its cumulative count survives restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "scopebond-cloud-gaps-"));
  const path = join(directory, "outbox.db");
  const first = new SqliteCloudOutbox(path, { maxPending: 1, maxGapRecords: 2 });
  first.enqueue(receipt("action:gap-limit-0001"));
  first.enqueue(receipt("action:gap-limit-0002"));
  first.enqueue(receipt("action:gap-limit-0003"));
  first.enqueue(receipt("action:gap-limit-0004"));
  assert.equal(first.status().gaps, 3);
  assert.equal(first.status().retainedGapRecords, 2);
  assert.equal(first.status().latestGap.id, "action:gap-limit-0004");
  first.close();

  const reopened = new SqliteCloudOutbox(path, { maxPending: 1, maxGapRecords: 2 });
  assert.equal(reopened.status().gaps, 3);
  assert.equal(reopened.status().retainedGapRecords, 2);
  assert.equal(reopened.status().latestGap.id, "action:gap-limit-0004");
  reopened.close();
  rmSync(directory, { recursive: true, force: true });
});
