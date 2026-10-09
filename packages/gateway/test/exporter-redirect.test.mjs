// The record exporter never follows a redirect, like every other call to the workspace: a redirect answer is a failed
// delivery, retried later, and the records are never sent on to wherever it points. Local servers only.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createCloudExporter, createMemoryCloudOutbox } from "../dist/index.js";

const listen = (handler) => new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, "127.0.0.1", () => resolve(s)); });
const receipt = (id) => ({ payload: { action_ref: { action_id: id }, value: 1, timestamp: new Date().toISOString() }, signature: { alg: "Ed25519", sig: "fixture" } });

for (const status of [301, 302, 303, 307, 308]) {
  test(`a ${status} from the ingest origin leaves the records queued and sends nothing to the other origin`, async () => {
    const elsewhere = [];
    const other = await listen((req, res) => {
      let raw = ""; req.on("data", (c) => { raw += c; });
      req.on("end", () => { elsewhere.push({ url: req.url, body: raw }); res.writeHead(200, { "content-type": "application/json" }); res.end("{\"accepted\":1}"); });
    });
    let asked = 0;
    const ingest = await listen((req, res) => { asked += 1; req.resume(); res.writeHead(status, { location: `http://localhost:${other.address().port}/v1/ingest` }); res.end(); });
    try {
      const ex = createCloudExporter({ url: `http://127.0.0.1:${ingest.address().port}`, credential: "sbm_redirect", outbox: createMemoryCloudOutbox(), flushMs: 1e9 });
      ex.enqueue(receipt("action:redirect-0001"));
      await ex.flush();
      const s = ex.status();
      ex.stop();
      assert.equal(asked, 1, "the workspace was asked once");
      assert.deepEqual(elsewhere, [], "nothing reached the redirect target");
      assert.equal(ex.pending(), 1, "the record is still queued");
      assert.equal(s.consecutiveFailures, 1, "a redirect counts as a failed delivery");
      assert.ok(s.lastError, "the failure is recorded");
      assert.ok(s.nextAttemptAt !== null, "and retried later");
    } finally { ingest.close(); other.close(); }
  });
}
