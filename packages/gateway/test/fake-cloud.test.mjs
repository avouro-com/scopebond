// Delivery against the shared stand-in workspace (@scopebond/fake-cloud) with injected faults:
// a refused or rate-limited delivery, a dropped connection and a slow answer all keep the
// records and deliver them once the workspace answers again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { startFakeCloud } from "@scopebond/fake-cloud";
import { createCloudExporter, createMemoryCloudOutbox } from "../dist/index.js";

const receipt = (id) => ({ payload: { action_ref: { action_id: id }, realtime_result: "allow" }, signature: { alg: "Ed25519", sig: "fixture" } });

async function credentialFrom(cloud) {
  const public_key_pem = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
  const res = await fetch(cloud.url + "/v1/enroll", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enrollment_token: "sbe_fake_gateway", public_key_pem }) });
  return (await res.json()).credential;
}

for (const [name, fault] of [
  ["429 with a reason", { status: 429, code: "rate_limited", times: 1 }],
  ["500", { status: 500, times: 1 }],
  ["a dropped connection", { drop: true, times: 1 }],
]) {
  test(`exporter keeps the records through ${name} and delivers them next time`, async () => {
    const cloud = await startFakeCloud();
    let now = 1_000;
    try {
      const ex = createCloudExporter({
        url: cloud.url, credential: await credentialFrom(cloud), outbox: createMemoryCloudOutbox({ now: () => now }),
        batchSize: 10, flushMs: 100, maxRetryMs: 1_000, now: () => now,
      });
      cloud.fault("ingest", fault);
      ex.enqueue(receipt("action:fake-cloud-0001"));
      await ex.flush();
      assert.equal(ex.pending(), 1, "the record waits");
      assert.equal(ex.status().consecutiveFailures, 1);
      if (fault.code) assert.match(ex.status().lastError, /rate_limited/, "the workspace's reason is kept");
      now += 1_000;
      await ex.flush();
      assert.equal(ex.pending(), 0);
      assert.equal(cloud.state().ingested, 1, "delivered exactly once");
      ex.stop();
    } finally { await cloud.close(); }
  });
}

test("a slow workspace still receives the record", async () => {
  const cloud = await startFakeCloud();
  try {
    const ex = createCloudExporter({ url: cloud.url, credential: await credentialFrom(cloud), outbox: createMemoryCloudOutbox(), flushMs: 1e9 });
    cloud.fault("ingest", { delayMs: 400, times: 1 });
    ex.enqueue(receipt("action:fake-cloud-slow-0001"));
    await ex.flush();
    assert.equal(ex.pending(), 0);
    assert.equal(cloud.state().ingested, 1);
    ex.stop();
  } finally { await cloud.close(); }
});
