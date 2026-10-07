// Evidence detail "standard": routine receipts leave as one signed summary per closed window, notable ones in full at once,
// and routine ones in a window still open wait. A workspace without summaries is sent every receipt, as before.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAttester, createGateway, createCloudExporter, seqRanges } from "../dist/index.js";
import { SqliteCloudOutbox } from "../dist/node.js";
import { verifySummaryCoverage, verifySummarySignature, validateSummary } from "@scopebond/verify/summary";

const policy = {
  vocabulary_version: "1.0", policy_id: "sum", version: 1,
  clauses: [{ id: "allowed", type: "action_allowlist", mode: "enforce", action_types: ["shell.exec", "file.read"] }],
};
const W0 = Date.parse("2026-10-07T10:00:00Z");
const attester = createAttester();

async function receiptsAt(times, intent) {
  const out = [];
  for (const t of times) {
    const gw = createGateway({ authentication: { mode: "insecure-development" }, mode: "check_only", attester, policy, now: () => new Date(t).toISOString() });
    out.push((await gw.check({ intent: typeof intent === "function" ? intent(t) : intent })).receipt);
  }
  return out;
}

function workspace({ summaries = true } = {}) {
  const calls = { ingest: [], summaries: [] };
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (url.endsWith("/v1/summaries")) {
      if (!summaries) return { ok: false, status: 404, text: async () => "not found", headers: new Map() };
      calls.summaries.push(body);
      return { ok: true, status: 200, json: async () => ({ accepted: body.summaries.length }), text: async () => "", headers: new Map() };
    }
    calls.ingest.push(body);
    return { ok: true, status: 200, json: async () => ({ accepted: body.receipts.length }), text: async () => "{}", headers: new Map() };
  };
  return { calls, fetch };
}

/** Flush until nothing more moves (a notable record starts a flush of its own; a second call meanwhile returns at once). */
async function settle(exporter) {
  for (let i = 0, still = 0; i < 200 && still < 5; i++) {
    const before = exporter.pending();
    await new Promise((r) => setTimeout(r, 10));
    await exporter.flush();
    still = exporter.pending() === before ? still + 1 : 0;
  }
}

async function setup(detail, ws) {
  const outbox = new SqliteCloudOutbox(join(mkdtempSync(join(tmpdir(), "sb-sum-")), "outbox.db"), { maxPending: Number.MAX_SAFE_INTEGER, maxBytes: Number.MAX_SAFE_INTEGER, maxAgeMs: Number.MAX_SAFE_INTEGER });
  const routine = await receiptsAt([0, 1, 2, 3, 4, 5].map((i) => W0 + i * 1000), (t) => ({ action_type: "shell.exec", params: { command: "pnpm test", program: "pnpm", cwd: "/repo", n: t % 2 } }));
  const denied = await receiptsAt([W0 + 7000], { action_type: "git.push", params: { remote: "origin", ref: "main" } });
  const late = await receiptsAt([W0 + 9 * 60_000, W0 + 9 * 60_000 + 1], { action_type: "file.read", params: { path: "a.txt" } });
  const now = W0 + 10 * 60_000; // the first window closed; the second (10:05–10:10) is still open
  const exporter = createCloudExporter({ url: "https://ws.example", credential: "sbm_x", outbox, flushMs: 1e9, fetch: ws.fetch, now: () => now,
    summaries: { detail: () => detail, attester } });
  for (const r of [...routine, ...denied, ...late]) exporter.enqueue(r);
  await settle(exporter);
  return { exporter, outbox, routine, denied, late };
}

test("standard: one signed summary for the closed window, the denied push in full, the open window waits", async () => {
  const ws = workspace();
  const { exporter, routine, denied } = await setup("standard", ws);
  try {
    assert.equal(ws.calls.summaries.length, 1);
    const [item] = ws.calls.summaries[0].summaries;
    assert.deepEqual(validateSummary(item.summary), { valid: true, errors: [] });
    assert.equal(item.summary.payload.receipt_count, 6);
    assert.equal(item.summary.payload.notable_count, 1);
    assert.equal(item.summary.payload.window.start, "2026-10-07T10:00:00.000Z");
    assert.deepEqual(item.seq, { ranges: [[1, 6]], unnumbered: 0 });
    assert.ok(ws.calls.summaries[0].queue, "the queue id names the numbering");
    assert.equal((await verifySummarySignature(item.summary, attester.publicKeyPem)).valid, true);
    assert.equal((await verifySummaryCoverage(item.summary, routine)).valid, true);
    const sent = ws.calls.ingest.flatMap((b) => b.receipts);
    assert.deepEqual(sent.map((r) => r.payload.action_ref.action_id), [denied[0].payload.action_ref.action_id]);
    assert.equal(exporter.pending(), 2, "the open window's records wait");
    assert.equal(exporter.status().lastError, null);
  } finally { exporter.stop(); }
});

test("full: every receipt is sent, and no summary", async () => {
  const ws = workspace();
  const { exporter } = await setup("full", ws);
  try {
    assert.equal(ws.calls.summaries.length, 0);
    assert.equal(ws.calls.ingest.flatMap((b) => b.receipts).length, 9);
    assert.equal(exporter.pending(), 0);
  } finally { exporter.stop(); }
});

test("a workspace without summaries is sent every receipt, as before", async () => {
  const ws = workspace({ summaries: false });
  const { exporter } = await setup("standard", ws);
  try {
    assert.equal(ws.calls.ingest.flatMap((b) => b.receipts).length, 9);
    assert.equal(exporter.pending(), 0);
  } finally { exporter.stop(); }
});

test("record numbers become closed ranges", () => {
  assert.deepEqual(seqRanges([5, 1, 2, 3, undefined, 7, 8, 3]), { ranges: [[1, 3], [5, 5], [7, 8]], unnumbered: 1 });
  assert.deepEqual(seqRanges([]), { ranges: [], unnumbered: 0 });
});

test("a 1,000-action session over 20 minutes ships at most 20 records, and every summary checks out", async () => {
  const ws = workspace();
  const outbox = new SqliteCloudOutbox(join(mkdtempSync(join(tmpdir(), "sb-sum-1k-")), "outbox.db"), { maxPending: Number.MAX_SAFE_INTEGER, maxBytes: Number.MAX_SAFE_INTEGER, maxAgeMs: Number.MAX_SAFE_INTEGER });
  const gw = (t) => createGateway({ authentication: { mode: "insecure-development" }, mode: "check_only", attester, policy, now: () => new Date(t).toISOString() });
  const all = [];
  for (let i = 0; i < 1000; i++) {
    const t = W0 + i * 1200; // 20 minutes
    const intent = i % 3 === 0 ? { action_type: "file.read", params: { path: `src/f${i % 40}.ts` } } : { action_type: "shell.exec", params: { command: i % 2 ? "pnpm test" : "git status", program: i % 2 ? "pnpm" : "git", cwd: "/repo" } };
    all.push((await gw(t).check({ intent })).receipt);
  }
  for (let i = 0; i < 5; i++) all.push((await gw(W0 + i * 200_000 + 7).check({ intent: { action_type: "git.push", params: { remote: "origin", ref: `release-${i}` } } })).receipt);
  // The clock follows the actions, as on a computer: each record is queued when its action happens.
  let clock = W0;
  const exporter = createCloudExporter({ url: "https://ws.example", credential: "sbm_x", outbox, flushMs: 1e9, fetch: ws.fetch, now: () => clock, summaries: { detail: () => "standard", attester } });
  try {
    for (const r of [...all].sort((a, b) => Date.parse(a.payload.timestamp) - Date.parse(b.payload.timestamp))) { clock = Date.parse(r.payload.timestamp) + 50; exporter.enqueue(r); }
    clock = W0 + 30 * 60_000;
    // Enqueueing starts a flush of its own at 100 waiting; wait until the queue settles.
    await settle(exporter);
    const summaries = ws.calls.summaries.flatMap((b) => b.summaries);
    const receipts = ws.calls.ingest.flatMap((b) => b.receipts);
    assert.ok(summaries.length + receipts.length <= 20, `${summaries.length} summaries + ${receipts.length} receipts`);
    assert.equal(receipts.length, 5, "every push in full, and nothing else");
    assert.equal(summaries.reduce((n, s) => n + s.summary.payload.receipt_count, 0), 1000);
    assert.equal(exporter.pending(), 0);
    const byWindow = (s) => all.slice(0, 1000).filter((r) => { const t = Date.parse(r.payload.timestamp); return t >= Date.parse(s.summary.payload.window.start) && t <= Date.parse(s.summary.payload.window.end); });
    for (const s of summaries) assert.equal((await verifySummaryCoverage(s.summary, byWindow(s))).valid, true);
  } finally { exporter.stop(); }
});

test("a per-call flush (routine: false) sends only after a notable record was queued; enqueueing never starts one", async () => {
  const ws = workspace();
  const outbox = new SqliteCloudOutbox(join(mkdtempSync(join(tmpdir(), "sb-sum-call-")), "outbox.db"), { maxPending: Number.MAX_SAFE_INTEGER, maxBytes: Number.MAX_SAFE_INTEGER, maxAgeMs: Number.MAX_SAFE_INTEGER });
  const exporter = createCloudExporter({ url: "https://ws.example", credential: "sbm_x", outbox, flushMs: 1e9, fetch: ws.fetch, now: () => W0 + 60 * 60_000, summaries: { detail: () => "standard", attester } });
  try {
    for (const r of await receiptsAt([W0, W0 + 1000], { action_type: "file.read", params: { path: "a.txt" } })) exporter.enqueue(r);
    await exporter.flush({ routine: false });
    assert.equal(ws.calls.summaries.length + ws.calls.ingest.length, 0, "nothing notable: the call sends nothing");
    exporter.enqueue((await receiptsAt([W0 + 2000], { action_type: "git.push", params: { remote: "origin", ref: "x" } }))[0]);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(ws.calls.ingest.length, 0, "enqueueing started no flush");
    await exporter.flush({ routine: false });
    assert.equal(ws.calls.ingest.flatMap((b) => b.receipts).length, 1);
    assert.equal(ws.calls.summaries.length, 1, "the closed window went with it");
    assert.equal(exporter.pending(), 0);
  } finally { exporter.stop(); }
});
