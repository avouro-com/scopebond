import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { startFakeCloud, kidForPem } from "../dist/index.js";
import { parseFault } from "../dist/cli.js";

const post = (cloud, path, body, headers = {}) => fetch(cloud.url + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const pem = () => generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();

async function enrolled(cloud) {
  const code = await (await post(cloud, "/v1/device/code", { client_name: "laptop", harness: "claude" })).json();
  assert.equal((await (await post(cloud, "/v1/device/token", { device_code: code.device_code })).json()).error, "authorization_pending");
  assert.equal(cloud.approve(code.user_code), true);
  const token = await (await post(cloud, "/v1/device/token", { device_code: code.device_code })).json();
  const key = pem();
  const credential = await (await post(cloud, "/v1/enroll", { enrollment_token: token.enrollment.enrollment_token, public_key_pem: key })).json();
  assert.equal(credential.attester_kid, kidForPem(key), "the credential is bound to the enrolling key");
  return credential.credential;
}

test("a computer signs in with a code a person approves, enrolls, and delivers", async () => {
  const cloud = await startFakeCloud();
  try {
    const credential = await enrolled(cloud);
    const res = await post(cloud, "/v1/ingest", { receipts: [{ payload: { realtime_result: "deny" } }] }, { authorization: `Bearer ${credential}` });
    assert.equal(res.status, 200);
    assert.equal((await post(cloud, "/v1/ingest", { receipts: [] }, { authorization: "Bearer sbm_wrong" })).status, 401);
    const state = cloud.state();
    assert.equal(state.ingested, 1);
    assert.deepEqual(state.ingested_results, ["deny"]);
    assert.deepEqual(state.code_requests, [{ client_name: "laptop", harness: "claude" }]);
    assert.equal((await fetch(cloud.url + "/v1/policy", { headers: { authorization: `Bearer ${credential}` } })).status, 204);
    assert.equal((await fetch(cloud.url + "/v1/client-version", { headers: { authorization: `Bearer ${credential}` } })).status, 404);
    cloud.setClientVersion({ policy: "recommended", hook: "1.2.3", agent: "0.4.0" });
    assert.equal((await (await fetch(cloud.url + "/v1/client-version")).json()).hook, "1.2.3");
  } finally { await cloud.close(); }
});

test("auto-approve approves each code on its second poll", async () => {
  const cloud = await startFakeCloud({ autoApprove: true });
  try {
    const code = await (await post(cloud, "/v1/device/code", {})).json();
    assert.equal((await (await post(cloud, "/v1/device/token", { device_code: code.device_code })).json()).error, "authorization_pending");
    assert.ok((await (await post(cloud, "/v1/device/token", { device_code: code.device_code })).json()).enrollment);
    assert.deepEqual(cloud.state().approved_codes, [code.user_code]);
  } finally { await cloud.close(); }
});

test("faults: a status for a number of requests, then normal service", async () => {
  const cloud = await startFakeCloud();
  try {
    const credential = await enrolled(cloud);
    const auth = { authorization: `Bearer ${credential}` };
    for (const status of [401, 409, 429, 500]) {
      cloud.fault("ingest", { status, code: `injected_${status}`, times: 1, ...(status === 429 ? { retryAfter: 7 } : {}) });
      const res = await post(cloud, "/v1/ingest", { receipts: [{}] }, auth);
      assert.equal(res.status, status);
      assert.equal((await res.json()).code, `injected_${status}`);
      if (status === 429) assert.equal(res.headers.get("retry-after"), "7");
      assert.equal((await post(cloud, "/v1/ingest", { receipts: [{}] }, auth)).status, 200, `${status} applied once`);
    }
    assert.deepEqual(cloud.state().faults_applied.map((f) => f.what), ["401", "409", "429", "500"]);
  } finally { await cloud.close(); }
});

test("faults: a slow answer, and a dropped connection", async () => {
  const cloud = await startFakeCloud();
  try {
    cloud.fault("device/code", { delayMs: 300, times: 1 });
    const started = Date.now();
    assert.equal((await post(cloud, "/v1/device/code", {})).status, 200);
    assert.ok(Date.now() - started >= 280, "answered late");
    cloud.fault("device/code", { drop: true });
    await assert.rejects(post(cloud, "/v1/device/code", {}), "the connection is closed with no answer");
    cloud.clearFaults();
    assert.equal((await post(cloud, "/v1/device/code", {})).status, 200);
  } finally { await cloud.close(); }
});

test("the CLI's fault syntax", () => {
  assert.deepEqual(parseFault("ingest=500x2"), { route: "ingest", fault: { status: 500, times: 2 } });
  assert.deepEqual(parseFault("policy=slow:3000"), { route: "policy", fault: { delayMs: 3000 } });
  assert.deepEqual(parseFault("ingest=drop"), { route: "ingest", fault: { drop: true } });
  assert.throws(() => parseFault("ingest=sometimes"), /unknown fault/);
});
