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

const summaryItem = (id, count) => ({ summary: { payload: { summary_id: id, receipt_count: count }, signature: { alg: "Ed25519", sig: "fixture" } }, seq: { ranges: [[1, count]], unnumbered: 0 } });

test("summaries: held once by id, counted with the records they stand for", async () => {
  const cloud = await startFakeCloud();
  try {
    const auth = { authorization: `Bearer ${await enrolled(cloud)}` };
    const first = await post(cloud, "/v1/summaries", { summaries: [summaryItem("sum_a", 6), summaryItem("sum_b", 4)], queue: "q1" }, auth);
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { accepted: 2, duplicates: 0 });
    // Sent again (a retry after a lost answer): a duplicate, not counted twice.
    assert.deepEqual(await (await post(cloud, "/v1/summaries", { summaries: [summaryItem("sum_b", 4), summaryItem("sum_c", 1)] }, auth)).json(), { accepted: 1, duplicates: 1 });
    const state = (await (await fetch(cloud.url + "/__test/state")).json());
    assert.equal(state.summaries, 3);
    assert.equal(state.summarized_records, 11);
    assert.equal(state.summary_duplicates, 1);
    assert.deepEqual(state.last_summaries.summaries.map((s) => s.summary.payload.summary_id), ["sum_b", "sum_c"]);
    assert.equal(cloud.state().summaries, 3, "state() and /__test/state agree");
  } finally { await cloud.close(); }
});

test("summaries: an unknown credential gets 401, a malformed body 400, and nothing is counted", async () => {
  const cloud = await startFakeCloud();
  try {
    const auth = { authorization: `Bearer ${await enrolled(cloud)}` };
    const refused = await post(cloud, "/v1/summaries", { summaries: [summaryItem("sum_a", 1)] }, { authorization: "Bearer sbm_wrong" });
    assert.equal(refused.status, 401);
    assert.equal((await refused.json()).code, "credential_unknown");
    assert.equal((await post(cloud, "/v1/summaries", { summaries: [summaryItem("sum_a", 1)] })).status, 401, "no credential");
    for (const body of [{}, { summaries: [] }, { summaries: "x" }, { summaries: [{ summary: { payload: { summary_id: "sum_x" } } }] }, { summaries: [summaryItem("sum_y", 0)] }]) {
      assert.equal((await post(cloud, "/v1/summaries", body, auth)).status, 400, JSON.stringify(body));
    }
    const bad = await fetch(cloud.url + "/v1/summaries", { method: "POST", headers: { "content-type": "application/json", ...auth }, body: "{not json" });
    assert.equal(bad.status, 400);
    const state = cloud.state();
    assert.equal(state.summaries, 0);
    assert.equal(state.summarized_records, 0);
    assert.equal(state.last_summaries, null);
    cloud.fault("summaries", { status: 404, times: 1 });
    assert.equal((await post(cloud, "/v1/summaries", { summaries: [summaryItem("sum_a", 1)] }, auth)).status, 404, "a workspace without summaries");
    assert.equal((await post(cloud, "/v1/summaries", { summaries: [summaryItem("sum_a", 1)] }, auth)).status, 200);
  } finally { await cloud.close(); }
});

test("uninstall: the notice is recorded with the hook version and answers whether the removal was allowed", async () => {
  const cloud = await startFakeCloud();
  try {
    const auth = { authorization: `Bearer ${await enrolled(cloud)}`, "x-scopebond-hook-version": "9.9.9" };
    const res = await post(cloud, "/v1/uninstall", { purge: false, hook_version: "9.9.9" }, auth);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).authorized, false, "not allowed until an owner says so");
    cloud.setUninstallAuthorized(true);
    assert.equal((await (await post(cloud, "/v1/uninstall", { purge: true }, { authorization: auth.authorization })).json()).authorized, true);
    assert.deepEqual((await (await fetch(cloud.url + "/__test/state")).json()).uninstalls, [
      { purge: false, hook_version: "9.9.9", header_hook_version: "9.9.9" },
      { purge: true, hook_version: null, header_hook_version: null },
    ]);
  } finally { await cloud.close(); }
});

test("uninstall: an unknown credential gets 401, a malformed body 400, and nothing is recorded", async () => {
  const cloud = await startFakeCloud();
  try {
    const credential = await enrolled(cloud);
    assert.equal((await post(cloud, "/v1/uninstall", { purge: false }, { authorization: "Bearer sbm_wrong" })).status, 401);
    assert.equal((await post(cloud, "/v1/uninstall", { purge: false })).status, 401, "no credential");
    for (const body of [{}, { purge: "yes" }, { purge: false, hook_version: 3 }]) {
      assert.equal((await post(cloud, "/v1/uninstall", body, { authorization: `Bearer ${credential}` })).status, 400, JSON.stringify(body));
    }
    assert.deepEqual(cloud.state().uninstalls, []);
    cloud.fault("uninstall", { status: 500, times: 1 });
    assert.equal((await post(cloud, "/v1/uninstall", { purge: false }, { authorization: `Bearer ${credential}` })).status, 500);
    assert.deepEqual(cloud.state().faults_applied, [{ route: "uninstall", what: "500" }]);
  } finally { await cloud.close(); }
});
