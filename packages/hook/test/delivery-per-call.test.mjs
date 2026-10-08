// A hook call with a backlog and no agent: its bounded delivery waits on the flush under way instead of returning at once, so a
// backlog of 100 or more drains, and a cut-off is recorded only when the time limit really ran out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway, createAttester, createCloudExporter } from "@scopebond/gateway";
import { SqliteCloudOutbox } from "@scopebond/gateway/node";
import { flushBounded, recordDeliveryAttempt, readDeliveryState, LOSSLESS_OUTBOX, OUTBOX_FILE } from "../dist/index.js";

const policy = {
  vocabulary_version: "1.0", policy_id: "b2b", version: 1,
  clauses: [{ id: "allowed", type: "action_allowlist", mode: "enforce", action_types: ["shell.exec"] }],
};
const attester = createAttester();
let receiptsCache;
async function backlogReceipts(n) {
  if (receiptsCache) return receiptsCache;
  let t = Date.now() - 15 * 60 * 60 * 1000;
  const gw = createGateway({ authentication: { mode: "insecure-development" }, mode: "check_only", attester, policy, now: () => new Date(t).toISOString() });
  const out = [];
  for (let i = 0; i < n; i++) {
    t += 8_000;
    out.push((await gw.check({ intent: { action_type: "shell.exec", params: { command: "pnpm test", program: "pnpm", cwd: "/repo" } } })).receipt);
  }
  receiptsCache = out;
  return out;
}

/** Emulates N per-tool-call hook processes: each opens the queue, queues one record, flushes for at most 800 ms, then exits
 *  (a request still in flight is abandoned: its answer never reaches the process). */
async function hookCalls({ dir, calls, latencyMs, detail, extra }) {
  const accepted = { ingest: 0, summaries: 0, posts: 0, firstPostAfterMs: [] };
  let progressPerCall = [];
  for (let c = 0; c < calls; c++) {
    let alive = true;
    const t0 = Date.now();
    let firstPost = null;
    const fetch = async (url, init) => {
      if (firstPost === null) firstPost = Date.now() - t0;
      accepted.posts++;
      await new Promise((r) => setTimeout(r, latencyMs));
      if (!alive) throw new Error("process exited");
      const body = JSON.parse(init.body);
      if (url.endsWith("/v1/summaries")) { accepted.summaries += body.summaries.length; return { ok: true, status: 200, json: async () => ({ accepted: body.summaries.length }), text: async () => "", headers: new Map() }; }
      accepted.ingest += body.receipts.length;
      return { ok: true, status: 200, json: async () => ({ accepted: body.receipts.length }), text: async () => "{}", headers: new Map() };
    };
    const outbox = new SqliteCloudOutbox(join(dir, OUTBOX_FILE), LOSSLESS_OUTBOX);
    const before = outbox.status().pending;
    const exporter = createCloudExporter({ url: "https://ws.example", credential: "sbm_x", outbox, flushMs: 1e9, fetch,
      summaries: { detail: () => detail, attester } });
    exporter.enqueue(extra[c]);
    const lastSuccess = exporter.status().lastSuccessAt;
    const cutOff = await flushBounded(exporter, 800, { routine: false });
    const status = exporter.status();
    recordDeliveryAttempt(dir, status, Date.now(), lastSuccess, cutOff ? 800 : null, "hook");
    alive = false;
    exporter.stop(); // closes the queue: the abandoned flush can no longer acknowledge anything
    progressPerCall.push(before + 1 - status.pending);
    accepted.firstPostAfterMs.push(firstPost);
  }
  return { accepted, progressPerCall };
}

async function seed(dir, receipts, agoMs = 0) {
  const outbox = new SqliteCloudOutbox(join(dir, OUTBOX_FILE), { ...LOSSLESS_OUTBOX, now: () => Date.now() - agoMs });
  try { for (const r of receipts) outbox.enqueue(r); } finally { outbox.close(); }
}


test("with 100 or more waiting, a hook call's bounded delivery waits on the flush under way and moves records", async () => {
  const all = await backlogReceipts(6_308 + 40);
  const edge = mkdtempSync(join(tmpdir(), "sb-percall-edge-"));
  await seed(edge, all.slice(0, 99));
  const e = await hookCalls({ dir: edge, calls: 3, latencyMs: 300, detail: "full", extra: all.slice(6_309, 6_312) });
  assert.ok(e.progressPerCall[0] > 0, `at the batch size the call delivers (${JSON.stringify(e.progressPerCall)})`);
  const big = mkdtempSync(join(tmpdir(), "sb-percall-big-"));
  await seed(big, all.slice(0, 6_308));
  const b = await hookCalls({ dir: big, calls: 5, latencyMs: 300, detail: "full", extra: all.slice(6_312, 6_317) });
  assert.ok(b.progressPerCall.every((n) => n > 0), `at 6,308 waiting every call delivers (${JSON.stringify(b.progressPerCall)})`);
});

test("a hook call that had nothing to wait for (a retry not yet due) records no cut-off", async () => {
  const all = await backlogReceipts(6_308 + 40);
  const dir = mkdtempSync(join(tmpdir(), "sb-percall-backoff-"));
  await seed(dir, all.slice(0, 5));
  const outbox = new SqliteCloudOutbox(join(dir, OUTBOX_FILE), LOSSLESS_OUTBOX);
  const exporter = createCloudExporter({ url: "https://ws.example", credential: "sbm_x", outbox, flushMs: 1e9,
    fetch: async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => "busy", headers: new Map() }) });
  try {
    await exporter.flush().catch(() => {}); // fails: the next try waits
    const cutOff = await flushBounded(exporter, 800, { routine: false });
    assert.equal(cutOff, false, "the flush returned at once: it was waiting out its retry");
    recordDeliveryAttempt(dir, { ...exporter.status(), lastError: null }, Date.now(), exporter.status().lastSuccessAt, cutOff ? 800 : null, "hook");
    assert.doesNotMatch(String(readDeliveryState(dir).last_error), /did not finish within 800 ms/);
  } finally { exporter.stop(); }
});

test("status says an agent the plan paused is paused, and suggests no flush", async () => {
  const { describeDelivery } = await import("../dist/delivery-report.js");
  const all = await backlogReceipts(6_308 + 40);
  const dir = mkdtempSync(join(tmpdir(), "sb-percall-paused-"));
  await seed(dir, all.slice(0, 3), 60 * 60_000);
  recordDeliveryAttempt(dir, { lastSuccessAt: null, lastError: "ingest failed: HTTP 402 (agent_paused)", pending: 3 }, Date.now(), null, null, "agent");
  const report = describeDelivery(dir, { url: "https://ws.example" });
  assert.match(report.lines[0], /^PAUSED BY THE WORKSPACE'S PLAN: 3 record\(s\)/);
  assert.ok(!report.lines.some((l) => /next step\s+run .*flush/.test(l)), "no flush is suggested");
});
