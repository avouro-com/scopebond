import { test } from "node:test";
import assert from "node:assert/strict";
import { createGateway, MemoryReceiptStore, createCloudExporter, withCloudExporter } from "../dist/index.js";

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

test("exporter batches receipts and POSTs to /v1/ingest with the key", async () => {
  const f = mockFetch();
  const ex = createCloudExporter({ url: "https://cloud.example/", apiKey: "sbk_x", batchSize: 2, flushMs: 1e9, fetch: f });
  ex.enqueue({ payload: {} }); ex.enqueue({ payload: {} }); // reaches batchSize → auto-flush
  await new Promise((r) => setTimeout(r, 20));
  ex.enqueue({ payload: {} });
  await ex.flush();
  ex.stop();
  assert.equal(f.calls[0].url, "https://cloud.example/v1/ingest");
  assert.equal(f.calls[0].auth, "Bearer sbk_x");
  assert.equal(f.calls.reduce((s, c) => s + c.count, 0), 3);
});

test("exporter keeps the buffer on failure and retries", async () => {
  const f = mockFetch(); f.failNext(1);
  const ex = createCloudExporter({ url: "https://c", apiKey: "k", batchSize: 10, flushMs: 1e9, fetch: f });
  ex.enqueue({ payload: { a: 1 } });
  await ex.flush();               // first attempt fails
  assert.equal(ex.pending(), 1);  // buffer retained
  await ex.flush();               // retry succeeds
  assert.equal(ex.pending(), 0);
  ex.stop();
});

test("withCloudExporter stores locally AND queues for Cloud; anchoring still works", async () => {
  const f = mockFetch();
  const ex = createCloudExporter({ url: "https://c", apiKey: "k", batchSize: 100, flushMs: 1e9, fetch: f });
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
  assert.equal(a.count, 1);
  ex.stop();
});
