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

const HEX = "a".repeat(64);
/** A well-formed summary item, as the workspace checks it (the signature is not verified by the fake). */
const summaryItem = (id, count, { seq = { ranges: [[1, count]], unnumbered: 0 }, payload = {} } = {}) => ({
  summary: {
    payload: {
      type: "scopebond:summary", version: "1.0", canonicalization: "RFC8785", evidence_class: "summary",
      summary_id: id, attester: { kind: "gateway", kid: "key:0123456789abcdef" }, harness: "claude-code",
      window: { kind: "interval", start: "2026-10-07T10:00:00Z", end: "2026-10-07T10:05:00Z" },
      receipt_count: count, receipts_root: HEX, notable_count: 0,
      counts: [{ action_type: "shell.exec", result: "allow", program: "pnpm", cwd_digest: null, count }],
      dedupe: [], timestamp: "2026-10-07T10:05:01Z", ...payload,
    },
    signature: { alg: "Ed25519", sig: "fixture" },
  },
  ...(seq === undefined ? {} : { seq }),
});
const ID = (s) => `summary-${s}`.padEnd(16, "0");

test("summaries: held once by id, counted with the records they stand for", async () => {
  const cloud = await startFakeCloud();
  try {
    const auth = { authorization: `Bearer ${await enrolled(cloud)}` };
    const first = await post(cloud, "/v1/summaries", { summaries: [summaryItem(ID("a"), 6), summaryItem(ID("b"), 4)], queue: "q1" }, auth);
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { ok: true, accepted: 2, duplicates: 0, actions: 10, rejected: [] });
    // Sent again (a retry after a lost answer): a duplicate, not counted twice; the same id twice in one request counts once.
    assert.deepEqual(await (await post(cloud, "/v1/summaries", { summaries: [summaryItem(ID("b"), 4), summaryItem(ID("c"), 1), summaryItem(ID("c"), 1)] }, auth)).json(),
      { ok: true, accepted: 1, duplicates: 2, actions: 1, rejected: [] });
    const state = (await (await fetch(cloud.url + "/__test/state")).json());
    assert.equal(state.summaries, 3);
    assert.equal(state.summarized_records, 11);
    assert.equal(state.summary_duplicates, 2);
    assert.equal(state.summary_rejected, 0);
    assert.deepEqual(state.last_summaries.summaries.map((s) => s.summary.payload.summary_id), [ID("b"), ID("c"), ID("c")]);
    assert.equal(cloud.state().summaries, 3, "state() and /__test/state agree");
    // Every summary already held: 200 with nothing new, never a refusal.
    assert.deepEqual(await (await post(cloud, "/v1/summaries", { summaries: [summaryItem(ID("a"), 6)] }, auth)).json(), { ok: true, accepted: 0, duplicates: 1, actions: 0, rejected: [] });
  } finally { await cloud.close(); }
});

test("summaries: a bad summary is refused on its own and the rest are held", async () => {
  const cloud = await startFakeCloud();
  try {
    const auth = { authorization: `Bearer ${await enrolled(cloud)}` };
    const res = await post(cloud, "/v1/summaries", { summaries: [
      summaryItem(ID("ok1"), 3),
      summaryItem("short-id", 2),
      summaryItem(ID("seq"), 5, { seq: { ranges: [[1, 3]], unnumbered: 1 } }),
      summaryItem(ID("ok2"), 2, { seq: { ranges: [[10, 10]], unnumbered: 1 } }),
    ] }, auth);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, accepted: 2, duplicates: 0, actions: 5, rejected: [
      { index: 1, summary_id: "short-id", reason: "summary_id must be 16 to 200 characters" },
      { index: 2, summary_id: ID("seq"), reason: "the record numbers do not match the records the summary covers" },
    ] });
    const state = cloud.state();
    assert.equal(state.summaries, 2);
    assert.equal(state.summarized_records, 5);
    assert.equal(state.summary_rejected, 2);
  } finally { await cloud.close(); }
});

test("summaries: 400 invalid_receipt only when every summary was refused", async () => {
  const cloud = await startFakeCloud();
  try {
    const auth = { authorization: `Bearer ${await enrolled(cloud)}` };
    const res = await post(cloud, "/v1/summaries", { summaries: [summaryItem("x".repeat(201), 1), summaryItem(ID("cnt"), 2, { payload: { receipt_count: 3 }, seq: undefined })] }, auth);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, "invalid_receipt");
    assert.equal(body.error, "summary_id must be 16 to 200 characters", "the first refusal's reason");
    assert.equal(typeof body.remediation, "string");
    assert.deepEqual(body.rejected, [
      { index: 0, summary_id: "x".repeat(200), reason: "summary_id must be 16 to 200 characters" },
      { index: 1, summary_id: ID("cnt"), reason: "the counts must add up to receipt_count" },
    ]);
    assert.equal(body.ok, undefined);
    // One duplicate beside the refused ones makes it a 200.
    assert.equal((await post(cloud, "/v1/summaries", { summaries: [summaryItem(ID("held"), 1)] }, auth)).status, 200);
    const mixed = await post(cloud, "/v1/summaries", { summaries: [summaryItem(ID("held"), 1), summaryItem("tiny", 1)] }, auth);
    assert.equal(mixed.status, 200);
    assert.deepEqual(await mixed.json(), { ok: true, accepted: 0, duplicates: 1, actions: 0, rejected: [{ index: 1, summary_id: "tiny", reason: "summary_id must be 16 to 200 characters" }] });
    assert.equal(cloud.state().summary_rejected, 3);
  } finally { await cloud.close(); }
});

test("summaries: the record numbers must add up to receipt_count exactly", async () => {
  const cloud = await startFakeCloud();
  try {
    const auth = { authorization: `Bearer ${await enrolled(cloud)}` };
    const reasonFor = async (item) => {
      const res = await post(cloud, "/v1/summaries", { summaries: [item] }, auth);
      const body = await res.json();
      return res.status === 200 ? "accepted" : body.rejected[0].reason;
    };
    const mismatch = "the record numbers do not match the records the summary covers";
    const malformed = "the record numbers are malformed";
    assert.equal(await reasonFor(summaryItem(ID("s1"), 6, { seq: { ranges: [[1, 2], [5, 7]], unnumbered: 1 } })), "accepted", "2 + 3 + 1");
    assert.equal(await reasonFor(summaryItem(ID("s2"), 4, { seq: { ranges: [], unnumbered: 4 } })), "accepted", "all unnumbered");
    assert.equal(await reasonFor(summaryItem(ID("s3"), 4, { seq: undefined })), "accepted", "no numbers sent");
    assert.equal(await reasonFor(summaryItem(ID("s4"), 4, { seq: { ranges: [[1, 4]], unnumbered: 1 } })), mismatch, "one too many");
    assert.equal(await reasonFor(summaryItem(ID("s5"), 4, { seq: { ranges: [[1, 2]], unnumbered: 0 } })), mismatch, "too few");
    assert.equal(await reasonFor(summaryItem(ID("s6"), 4, { seq: { ranges: [[1, 4]] } })), malformed, "unnumbered missing");
    assert.equal(await reasonFor(summaryItem(ID("s7"), 4, { seq: { ranges: [[4, 1]], unnumbered: 0 } })), malformed, "a range running backwards");
    assert.equal(await reasonFor(summaryItem(ID("s8"), 4, { seq: { ranges: [[0, 3]], unnumbered: 0 } })), malformed, "numbers start at 1");
    assert.equal(await reasonFor(summaryItem(ID("s9"), 4, { seq: "1-4" })), malformed, "not an object");
  } finally { await cloud.close(); }
});

test("summaries: summary_id is 16 to 200 characters", async () => {
  const cloud = await startFakeCloud();
  try {
    const auth = { authorization: `Bearer ${await enrolled(cloud)}` };
    for (const [id, status] of [["a".repeat(15), 400], ["a".repeat(16), 200], ["b".repeat(200), 200], ["c".repeat(201), 400]]) {
      assert.equal((await post(cloud, "/v1/summaries", { summaries: [summaryItem(id, 1)] }, auth)).status, status, `${id.length} characters`);
    }
  } finally { await cloud.close(); }
});

test("summaries: 413 batch_too_large over 20 summaries or 1 MiB", async () => {
  const cloud = await startFakeCloud();
  try {
    const auth = { authorization: `Bearer ${await enrolled(cloud)}` };
    const items = (n) => Array.from({ length: n }, (_, i) => summaryItem(ID(`n${i}`), 1));
    const tooMany = await post(cloud, "/v1/summaries", { summaries: items(21) }, auth);
    assert.equal(tooMany.status, 413);
    const body = await tooMany.json();
    assert.equal(body.code, "batch_too_large");
    assert.equal(body.error, "at most 20 summaries are accepted per request");
    assert.equal(typeof body.remediation, "string");
    const tooBig = await post(cloud, "/v1/summaries", { summaries: items(1), padding: "x".repeat(1024 * 1024) }, auth);
    assert.equal(tooBig.status, 413);
    assert.equal((await tooBig.json()).code, "batch_too_large");
    assert.equal(cloud.state().summaries, 0, "nothing held from a refused request");
    assert.equal((await post(cloud, "/v1/summaries", { summaries: items(20) }, auth)).status, 200, "20 is the most");
  } finally { await cloud.close(); }
});

test("summaries: an unknown credential gets 401 credential_refused, an unreadable body 400 bad_request, and nothing is counted", async () => {
  const cloud = await startFakeCloud();
  try {
    const auth = { authorization: `Bearer ${await enrolled(cloud)}` };
    const refused = await post(cloud, "/v1/summaries", { summaries: [summaryItem(ID("a"), 1)] }, { authorization: "Bearer sbm_wrong" });
    assert.equal(refused.status, 401);
    const refusal = await refused.json();
    assert.equal(refusal.code, "credential_refused");
    assert.equal(refusal.error, "unauthorized");
    assert.match(refusal.remediation, /Sign it in again/);
    assert.equal((await post(cloud, "/v1/summaries", { summaries: [summaryItem(ID("a"), 1)] })).status, 401, "no credential");
    for (const body of [{}, { summaries: [] }, { summaries: "x" }, null]) {
      const res = await post(cloud, "/v1/summaries", body, auth);
      assert.equal(res.status, 400, JSON.stringify(body));
      const answer = await res.json();
      assert.equal(answer.code, "bad_request");
      assert.equal(answer.error, "summaries[] required");
      assert.equal(typeof answer.remediation, "string");
    }
    const bad = await fetch(cloud.url + "/v1/summaries", { method: "POST", headers: { "content-type": "application/json", ...auth }, body: "{not json" });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).code, "bad_request");
    const state = cloud.state();
    assert.equal(state.summaries, 0);
    assert.equal(state.summarized_records, 0);
    assert.equal(state.last_summaries, null);
    cloud.fault("summaries", { status: 404, times: 1 });
    assert.equal((await post(cloud, "/v1/summaries", { summaries: [summaryItem(ID("a"), 1)] }, auth)).status, 404, "a workspace without summaries");
    assert.equal((await post(cloud, "/v1/summaries", { summaries: [summaryItem(ID("a"), 1)] }, auth)).status, 200);
  } finally { await cloud.close(); }
});

test("summaries: the workspace's shape checks refuse a summary with their reason", async () => {
  const cloud = await startFakeCloud();
  try {
    const auth = { authorization: `Bearer ${await enrolled(cloud)}` };
    const reasonFor = async (item) => (await (await post(cloud, "/v1/summaries", { summaries: [item] }, auth)).json()).rejected?.[0]?.reason;
    assert.equal(await reasonFor({ summary: { payload: { summary_id: ID("x") } } }), "a summary is { payload, signature }");
    assert.equal(await reasonFor(summaryItem(ID("x"), 1, { payload: { extra: 1 } })), "the summary has an unknown member");
    assert.equal(await reasonFor(summaryItem(ID("x"), 1, { payload: { type: "scopebond:receipt" } })), "not a scopebond:summary 1.0 record");
    assert.equal(await reasonFor(summaryItem(ID("x"), 1, { payload: { attester: { kind: "gateway", kid: "nope" } } })), "attester must be { kind: gateway, kid }");
    assert.equal(await reasonFor(summaryItem(ID("x"), 1, { payload: { window: { kind: "interval", start: "2026-10-07T10:05:00Z", end: "2026-10-07T10:00:00Z" } } })), "window must be { kind, start, end } running forwards");
    assert.equal(await reasonFor(summaryItem(ID("x"), 0, { seq: undefined })), "receipt_count and notable_count must be whole numbers");
    const future = new Date(Date.now() + 3_600_000).toISOString();
    assert.equal(await reasonFor(summaryItem(ID("x"), 1, { payload: { window: { kind: "interval", start: future, end: future } } })), "the window ends in the future");
  } finally { await cloud.close(); }
});

test("uninstall: the notice is recorded with the hook version and answers only whether the removal was allowed", async () => {
  const cloud = await startFakeCloud();
  try {
    const auth = { authorization: `Bearer ${await enrolled(cloud)}`, "x-scopebond-hook-version": "9.9.9" };
    const res = await post(cloud, "/v1/uninstall", { purge: false, hook_version: "9.9.9" }, auth);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { authorized: false }, "not allowed until an owner says so");
    cloud.setUninstallAuthorized(true);
    assert.deepEqual(await (await post(cloud, "/v1/uninstall", { purge: true }, { authorization: auth.authorization })).json(), { authorized: true });
    assert.deepEqual((await (await fetch(cloud.url + "/__test/state")).json()).uninstalls, [
      { purge: false, hook_version: "9.9.9", header_hook_version: "9.9.9", body: { purge: false, hook_version: "9.9.9" } },
      { purge: true, hook_version: null, header_hook_version: null, body: { purge: true } },
    ]);
  } finally { await cloud.close(); }
});

test("uninstall: any body is recorded and never refused; an unknown credential gets 401 credential_refused", async () => {
  const cloud = await startFakeCloud();
  try {
    const credential = await enrolled(cloud);
    const refused = await post(cloud, "/v1/uninstall", { purge: false }, { authorization: "Bearer sbm_wrong" });
    assert.equal(refused.status, 401);
    assert.equal((await refused.json()).code, "credential_refused");
    assert.equal((await post(cloud, "/v1/uninstall", { purge: false })).status, 401, "no credential");
    assert.deepEqual(cloud.state().uninstalls, []);
    const auth = { authorization: `Bearer ${credential}` };
    for (const body of [{}, { purge: "yes" }, { purge: false, hook_version: 3 }, []]) {
      const res = await post(cloud, "/v1/uninstall", body, auth);
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.deepEqual(await res.json(), { authorized: false });
    }
    for (const raw of ["{not json", ""]) {
      const res = await fetch(cloud.url + "/v1/uninstall", { method: "POST", headers: auth, body: raw });
      assert.equal(res.status, 200, JSON.stringify(raw));
    }
    assert.deepEqual(cloud.state().uninstalls.map((u) => [u.purge, u.hook_version, u.body]), [
      [null, null, {}], [null, null, { purge: "yes" }], [false, null, { purge: false, hook_version: 3 }], [null, null, []],
      [null, null, "{not json"], [null, null, null],
    ]);
    cloud.fault("uninstall", { status: 500, times: 1 });
    assert.equal((await post(cloud, "/v1/uninstall", { purge: false }, auth)).status, 500);
    assert.deepEqual(cloud.state().faults_applied, [{ route: "uninstall", what: "500" }]);
  } finally { await cloud.close(); }
});
