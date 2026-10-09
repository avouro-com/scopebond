// A monthly-limit refusal (HTTP 429, code "quota") may say which monthly limit a plan change would give
// (`plan_lifts_to`). The exporter keeps that number, and only a well-formed one, at the end of its last error, so the tray
// can say what a plan change lifts, and nothing about plans when the workspace did not say.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCloudExporter, createMemoryCloudOutbox } from "../dist/index.js";

const receipt = (id) => ({ payload: { action_ref: { action_id: id }, value: 1, timestamp: new Date().toISOString() }, signature: { alg: "Ed25519", sig: "fixture" } });
const REMEDIATION = "The workspace reached its monthly limit. Records stay queued on the computer and send once the limit allows.";

async function lastErrorFor(body, status = 429) {
  const fetch = async () => ({ ok: false, status, headers: new Headers(), text: async () => JSON.stringify(body) });
  const ex = createCloudExporter({ url: "https://cloud.example", credential: "sbm_q", outbox: createMemoryCloudOutbox(), flushMs: 1e9, fetch });
  ex.enqueue(receipt("action:quota-0001"));
  await ex.flush();
  ex.stop();
  return ex.status().lastError;
}

test("a quota refusal that names the limit a plan change gives keeps it at the end of the error", async () => {
  const error = await lastErrorFor({ error: "monthly ingest limit reached", code: "quota", remediation: REMEDIATION, plan_lifts_to: 250000 });
  assert.equal(error, `ingest failed: HTTP 429 (quota): ${REMEDIATION} [plan_lifts_to=250000]`);
});

test("a quota refusal that names none says nothing about plans", async () => {
  for (const extra of [{}, { plan_lifts_to: null }, { plan_lifts_to: 0 }, { plan_lifts_to: -5 }, { plan_lifts_to: 1.5 }, { plan_lifts_to: "250000" }, { plan_lifts_to: 1e300 }]) {
    const error = await lastErrorFor({ error: "monthly ingest limit reached", code: "quota", remediation: REMEDIATION, ...extra });
    assert.equal(error, `ingest failed: HTTP 429 (quota): ${REMEDIATION}`, JSON.stringify(extra));
  }
});

test("only a quota refusal carries the hint", async () => {
  const error = await lastErrorFor({ error: "slow down", code: "rate_limited", remediation: "Nothing to do.", plan_lifts_to: 250000 });
  assert.equal(error, "ingest failed: HTTP 429 (rate_limited): Nothing to do.");
});

test("a remediation long enough to be cut still ends with the hint", async () => {
  const error = await lastErrorFor({ code: "quota", remediation: "x".repeat(1000), plan_lifts_to: 250000 });
  assert.match(error, / \[plan_lifts_to=250000\]$/);
});
