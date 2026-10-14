// Summaries against the shared stand-in workspace (@scopebond/fake-cloud): the exporter's /v1/summaries request is one the
// workspace's route takes, its answer adds up, and the routine records leave the queue as one summary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeCloud } from "@scopebond/fake-cloud";
import { createAttester, createGateway, createCloudExporter } from "../dist/index.js";
import { SqliteCloudOutbox } from "../dist/node.js";

const policy = {
  vocabulary_version: "1.0", policy_id: "sum", version: 1,
  clauses: [{ id: "allowed", type: "action_allowlist", mode: "enforce", action_types: ["shell.exec"] }],
};
const W0 = Date.parse("2026-10-07T10:00:00Z");
const attester = createAttester();

async function credentialFrom(cloud) {
  const public_key_pem = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
  const res = await fetch(cloud.url + "/v1/enroll", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enrollment_token: "sbe_fake_gateway", public_key_pem }) });
  return (await res.json()).credential;
}

async function routine(count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const gw = createGateway({ authentication: { mode: "insecure-development" }, mode: "check_only", attester, policy, now: () => new Date(W0 + i * 1000).toISOString() });
    out.push((await gw.check({ intent: { action_type: "shell.exec", params: { command: "pnpm test", program: "pnpm", cwd: "/repo" } } })).receipt);
  }
  return out;
}

test("exporter: a closed window's routine records go to the stand-in workspace as one summary", async () => {
  const cloud = await startFakeCloud();
  const dir = mkdtempSync(join(tmpdir(), "sb-fake-sum-"));
  const outbox = new SqliteCloudOutbox(join(dir, "outbox.db"), { maxPending: Number.MAX_SAFE_INTEGER, maxBytes: Number.MAX_SAFE_INTEGER, maxAgeMs: Number.MAX_SAFE_INTEGER });
  try {
    const exporter = createCloudExporter({ url: cloud.url, credential: await credentialFrom(cloud), outbox, flushMs: 1e9,
      now: () => W0 + 10 * 60_000, summaries: { detail: () => "standard", attester } });
    for (const r of await routine(5)) exporter.enqueue(r);
    await exporter.flush();
    assert.equal(exporter.pending(), 0, "the records left the queue");
    assert.equal(exporter.status().lastError, null);
    const state = cloud.state();
    assert.equal(state.summaries, 1);
    assert.equal(state.summarized_records, 5);
    assert.equal(state.summary_rejected, 0, "the workspace's shape checks pass the real summary");
    assert.equal(state.ingested, 0, "no record was sent in full");
    assert.ok(state.last_summaries.queue, "the queue id is sent");
    exporter.stop(); // closes the queue
  } finally { await cloud.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("exporter: a workspace without summaries (404) is sent the records in full", async () => {
  const cloud = await startFakeCloud();
  const dir = mkdtempSync(join(tmpdir(), "sb-fake-sum-"));
  const outbox = new SqliteCloudOutbox(join(dir, "outbox.db"), { maxPending: Number.MAX_SAFE_INTEGER, maxBytes: Number.MAX_SAFE_INTEGER, maxAgeMs: Number.MAX_SAFE_INTEGER });
  try {
    cloud.fault("summaries", { status: 404 });
    const exporter = createCloudExporter({ url: cloud.url, credential: await credentialFrom(cloud), outbox, flushMs: 1e9,
      now: () => W0 + 10 * 60_000, summaries: { detail: () => "standard", attester } });
    for (const r of await routine(3)) exporter.enqueue(r);
    for (let i = 0; i < 3 && exporter.pending() > 0; i++) await exporter.flush();
    assert.equal(exporter.pending(), 0);
    const state = cloud.state();
    assert.equal(state.summaries, 0);
    assert.equal(state.ingested, 3);
    exporter.stop(); // closes the queue
  } finally { await cloud.close(); rmSync(dir, { recursive: true, force: true }); }
});

// A window ending in the future is one the workspace refuses ("the window ends in the future"), which lets these tests drive
// its per-summary refusals with the real exporter's summaries.
const FUTURE = Math.ceil((Date.now() + 2 * 86_400_000) / 300_000) * 300_000;

async function routineAt(start, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const gw = createGateway({ authentication: { mode: "insecure-development" }, mode: "check_only", attester, policy, now: () => new Date(start + i * 1000).toISOString() });
    out.push((await gw.check({ intent: { action_type: "shell.exec", params: { command: "pnpm test", program: "pnpm", cwd: "/repo" } } })).receipt);
  }
  return out;
}

test("exporter: a summary the workspace refuses on its own is sent in full; the others are held", async () => {
  const cloud = await startFakeCloud();
  const dir = mkdtempSync(join(tmpdir(), "sb-fake-sum-"));
  const outbox = new SqliteCloudOutbox(join(dir, "outbox.db"), { maxPending: Number.MAX_SAFE_INTEGER, maxBytes: Number.MAX_SAFE_INTEGER, maxAgeMs: Number.MAX_SAFE_INTEGER });
  try {
    const exporter = createCloudExporter({ url: cloud.url, credential: await credentialFrom(cloud), outbox, flushMs: 1e9,
      now: () => FUTURE + 10 * 60_000, summaries: { detail: () => "standard", attester } });
    for (const r of [...await routineAt(W0, 4), ...await routineAt(FUTURE, 2)]) exporter.enqueue(r);
    for (let i = 0; i < 4 && exporter.pending() > 0; i++) await exporter.flush();
    assert.equal(exporter.pending(), 0, "the records left the queue");
    const state = cloud.state();
    assert.equal(state.summaries, 1, "the past window's summary is held");
    assert.equal(state.summarized_records, 4);
    assert.equal(state.summary_rejected, 1, "the future window's summary is refused on its own");
    assert.equal(state.ingested, 2, "its records are sent in full");
    exporter.stop(); // closes the queue
  } finally { await cloud.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("exporter: a request whose every summary is refused (400 invalid_receipt) is sent in full", async () => {
  const cloud = await startFakeCloud();
  const dir = mkdtempSync(join(tmpdir(), "sb-fake-sum-"));
  const outbox = new SqliteCloudOutbox(join(dir, "outbox.db"), { maxPending: Number.MAX_SAFE_INTEGER, maxBytes: Number.MAX_SAFE_INTEGER, maxAgeMs: Number.MAX_SAFE_INTEGER });
  try {
    const exporter = createCloudExporter({ url: cloud.url, credential: await credentialFrom(cloud), outbox, flushMs: 1e9,
      now: () => FUTURE + 10 * 60_000, summaries: { detail: () => "standard", attester } });
    for (const r of await routineAt(FUTURE, 3)) exporter.enqueue(r);
    for (let i = 0; i < 4 && exporter.pending() > 0; i++) await exporter.flush();
    assert.equal(exporter.pending(), 0);
    const state = cloud.state();
    assert.equal(state.summaries, 0);
    assert.equal(state.summary_rejected, 1);
    assert.equal(state.ingested, 3, "the records are sent in full");
    exporter.stop(); // closes the queue
  } finally { await cloud.close(); rmSync(dir, { recursive: true, force: true }); }
});
