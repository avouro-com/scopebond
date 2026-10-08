// Record completeness on the computer: a record whose queue write failed is kept as a gap, reported, and queued again on the
// next flush; an evaluation cut off before its receipt is closed as an outcome-unknown record; and the queue's gap counts
// reach the workspace on the rules check and the person in `status`, `doctor` and `status --json`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { verifyReceipt } from "@scopebond/gateway";
import { SqliteCloudOutbox, SqliteReceiptStore, loadOrCreateAttester } from "@scopebond/gateway/node";
import {
  scaffold, createHookRuntime, mapClaudeToolUse, describeDelivery, buildStatusJson, syncPolicy, policyBuilds,
  settleInterruptedActions, LOSSLESS_OUTBOX, OUTBOX_FILE,
} from "../dist/index.js";
import { ENFORCE } from "./enforce-all.mjs";

const connection = {
  url: "http://127.0.0.1:1", credential: "sbm_x", credential_id: "c", organization_id: "o",
  environment_id: "e", gateway_id: "g", attester_kid: "k", scopes: [], expires_at: "2027-01-01T00:00:00.000Z",
};
const read = (path) => mapClaudeToolUse({ tool_name: "Read", tool_input: { file_path: path }, cwd: "/repo" });

function hookDir() {
  const dir = mkdtempSync(join(tmpdir(), "sb-completeness-"));
  scaffold(dir, ENFORCE);
  return dir;
}
function runtimeFor(dir, extra = {}) {
  return createHookRuntime({
    policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"),
    attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db"),
    cloud: { connection, flushTimeoutMs: 0 }, ...extra,
  });
}
function outboxStatus(dir) {
  const o = new SqliteCloudOutbox(join(dir, OUTBOX_FILE), LOSSLESS_OUTBOX);
  try { return o.status(); } finally { o.close(); }
}
function localCount(dir) {
  const s = new SqliteReceiptStore(join(dir, "receipts.db"));
  try { return s.count(); } finally { s.close(); }
}

test("a queue that cannot be opened: the action is allowed and recorded locally, the miss is kept as a gap, and the record is queued on the next flush", async () => {
  const dir = hookDir();
  try {
    mkdirSync(join(dir, OUTBOX_FILE)); // a path SQLite cannot open (stands in for a read-only or full-disk queue)
    const first = runtimeFor(dir);
    assert.ok(first.deliveryUnavailable, "the runtime knows the queue is unusable");
    const d1 = await first.evaluate(read("/repo/a.ts"));
    await first.flush();
    first.close();
    assert.equal(d1.decision, "allow", "the action stays allowed while the queue is unusable (the record is kept locally)");
    rmSync(join(dir, OUTBOX_FILE), { recursive: true, force: true }); // the condition clears
    const second = runtimeFor(dir);
    assert.equal(second.deliveryUnavailable, null);
    await second.evaluate(read("/repo/b.ts"));
    await second.flush();
    second.close();
    const st = outboxStatus(dir);
    assert.equal(localCount(dir), 2, "both receipts are in the local log");
    assert.equal(st.pending, 2, "the record written while the queue was unusable is queued on the next flush");
    assert.equal(st.seqAssigned, 2, "and numbered, so the workspace counts it");
    assert.equal(st.gaps, 1, "the failed queue write is kept as a gap");
    assert.deepEqual(st.gapsByReason, { outbox_error: 1 });
    // A second flush finds nothing more to queue: the backfill runs once.
    const third = runtimeFor(dir);
    await third.flush();
    third.close();
    assert.equal(outboxStatus(dir).pending, 2);
    assert.equal(outboxStatus(dir).gaps, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a queue write that fails after the local write (lock held) waits briefly, keeps a gap, and the record is queued on the next flush", async () => {
  const dir = hookDir();
  try {
    const runtime = runtimeFor(dir); // opens the queue before the lock is taken
    assert.equal(runtime.deliveryUnavailable, null);
    const holder = new DatabaseSync(join(dir, OUTBOX_FILE));
    holder.exec("BEGIN IMMEDIATE"); // another process holding the queue's write lock
    const started = Date.now();
    let decision;
    try { decision = await runtime.evaluate(read("/repo/locked.ts")); }
    finally { holder.exec("ROLLBACK"); holder.close(); }
    const waited = Date.now() - started;
    await runtime.evaluate(read("/repo/after.ts"));
    await runtime.flush();
    runtime.close();
    const st = outboxStatus(dir);
    assert.equal(decision.decision, "allow");
    assert.ok(waited < 8_000, `the tool call waited ${waited} ms for the queue: well under the 30 s Codex hook timeout with an override wait`);
    assert.equal(localCount(dir), 2, "both receipts are in the local log");
    assert.equal(st.pending, 2, "the receipt written while the queue was locked is queued on the next flush");
    assert.equal(st.seqAssigned, 2);
    assert.equal(st.gaps, 1, "the failed queue write is kept as a gap");
    assert.deepEqual(st.gapsByReason, { outbox_error: 1 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an evaluation cut off before its receipt is closed as an outcome-unknown record, queued like any other", async () => {
  const dir = hookDir();
  try {
    // A hook process killed between the reservation and the receipt: reserve the action, then never finish it.
    const runtime = runtimeFor(dir);
    await runtime.evaluate(read("/repo/one.ts"));
    runtime.close();
    const db = new DatabaseSync(join(dir, "receipts.db"));
    const [row] = db.prepare("SELECT action_id FROM authority_actions").all();
    const actionId = row.action_id;
    // Turn the finished action back into one left mid-evaluation ten minutes ago.
    db.prepare("UPDATE authority_actions SET state = 'reserved', terminal_receipt_id = NULL, created_at = ? WHERE action_id = ?")
      .run(new Date(Date.now() - 10 * 60_000).toISOString(), actionId);
    db.prepare("INSERT INTO authority_lifecycle (action_id, reservation_json, realtime_result) SELECT action_id, ?, 'allow' FROM authority_actions WHERE action_id = ?")
      .run(JSON.stringify({ action_id: actionId, receipt_context: JSON.parse(db.prepare("SELECT receipt_json FROM receipts").all()[0].receipt_json).payload, scopebond_slim: 1 }), actionId);
    db.prepare("DELETE FROM receipts").run();
    db.close();
    const outbox = new SqliteCloudOutbox(join(dir, OUTBOX_FILE), LOSSLESS_OUTBOX);
    outbox.acknowledge(outbox.peek(100, Date.now()).map((e) => ({ id: e.id, payloadHash: e.payloadHash })));
    outbox.close();

    const next = runtimeFor(dir);
    await next.flush();
    next.close();
    const store = new SqliteReceiptStore(join(dir, "receipts.db"));
    try {
      const receipts = store.list();
      assert.equal(receipts.length, 1, "the interrupted action now has a receipt");
      const p = receipts[0].payload;
      assert.equal(p.action_ref.action_id, actionId);
      assert.equal(p.execution.state, "outcome_unknown");
      assert.equal(p.execution.assertion, "adapter_outcome_unknown");
      assert.equal(p.execution.reference, "scopebond:evaluation-interrupted");
      assert.equal(p.executed, false);
      const { attester } = loadOrCreateAttester({ file: join(dir, "attester.key") });
      const check = verifyReceipt(receipts[0], attester.publicKeyPem);
      assert.equal(check.signature_valid, true, "signed by this computer's key");
      assert.equal(check.contract_valid, true, "a well-formed receipt");
      assert.equal(store.unresolvedActions().length, 0, "nothing is left held");
    } finally { store.close(); }
    assert.equal(outboxStatus(dir).pending, 1, "the closing record is queued for delivery");
    // A second pass changes nothing.
    const again = new SqliteReceiptStore(join(dir, "receipts.db"));
    try { assert.equal((await settleInterruptedActions(again, null, { now: Date.now() })).length, 0); } finally { again.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an evaluation still inside the harness time limit is left alone", async () => {
  const dir = hookDir();
  try {
    const runtime = runtimeFor(dir);
    await runtime.evaluate(read("/repo/one.ts"));
    runtime.close();
    const db = new DatabaseSync(join(dir, "receipts.db"));
    const [row] = db.prepare("SELECT action_id FROM authority_actions").all();
    db.prepare("UPDATE authority_actions SET state = 'reserved', terminal_receipt_id = NULL, created_at = ? WHERE action_id = ?")
      .run(new Date(Date.now() - 20_000).toISOString(), row.action_id);
    db.prepare("INSERT INTO authority_lifecycle (action_id, reservation_json, realtime_result) VALUES (?, ?, 'allow')")
      .run(row.action_id, JSON.stringify({ action_id: row.action_id, scopebond_slim: 1 }));
    db.close();
    const store = new SqliteReceiptStore(join(dir, "receipts.db"));
    try { assert.equal(store.interruptedActions(new Date(Date.now() - 5 * 60_000).toISOString()).length, 0); } finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function connected() {
  const dir = hookDir();
  writeFileSync(join(dir, "cloud.json"), JSON.stringify({ ...connection, url: "https://ws.example" }));
  return dir;
}
function fakeWorkspace() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), headers: Object.fromEntries(Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])) });
    return new Response(null, { status: 204 });
  };
  return { calls, fetchImpl };
}

test("the rules check sends the queue's lifetime gap total and its counts by reason", async () => {
  const dir = connected();
  try {
    const outbox = new SqliteCloudOutbox(join(dir, OUTBOX_FILE), { ...LOSSLESS_OUTBOX, maxGapRecords: 1 });
    outbox.recordGap("action:g-0001", "rejected");
    outbox.recordGap("action:g-0002", "rejected");
    outbox.recordGap("action:g-0003", "id_conflict");
    outbox.close();
    const w = fakeWorkspace();
    const { agentKid } = { agentKid: "kid" };
    await syncPolicy(dir, { agentKid, hookVersion: "0.21.1", policyBuilds, fetchImpl: w.fetchImpl });
    const headers = w.calls[0].headers;
    assert.equal(headers["x-scopebond-gaps-total"], "3", "the lifetime total, not only the retained gap rows");
    assert.deepEqual(JSON.parse(headers["x-scopebond-gaps-by-reason"]), { id_conflict: 1, rejected: 2 });
    assert.ok(!/\s/.test(headers["x-scopebond-gaps-by-reason"]), "compact JSON");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a queue with no gaps sends no gap headers", async () => {
  const dir = connected();
  try {
    new SqliteCloudOutbox(join(dir, OUTBOX_FILE), LOSSLESS_OUTBOX).close();
    const w = fakeWorkspace();
    await syncPolicy(dir, { agentKid: "kid", hookVersion: "0.21.1", policyBuilds, fetchImpl: w.fetchImpl });
    assert.equal(w.calls[0].headers["x-scopebond-gaps-total"], undefined);
    assert.equal(w.calls[0].headers["x-scopebond-gaps-by-reason"], undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("status, doctor and status --json show delivery gaps, with the lifetime total", () => {
  const dir = connected();
  try {
    const outbox = new SqliteCloudOutbox(join(dir, OUTBOX_FILE), { ...LOSSLESS_OUTBOX, maxGapRecords: 1 });
    outbox.recordGap("action:g-0001", "rejected");
    outbox.recordGap("action:g-0002", "outbox_error");
    outbox.close();
    const report = describeDelivery(dir, { url: "https://ws.example" });
    assert.ok(report.lines.some((l) => /^delivery gaps\s+2 record\(s\)/.test(l) && /rejected 1/.test(l) && /outbox_error 1/.test(l)), JSON.stringify(report.lines));
    const json = buildStatusJson({ version: "0", activeDir: dir, candidateDirs: [dir], hasPolicy: true, agents: { claude: true, cursor: false, codex: false } });
    assert.equal(json.delivery.gaps_total, 2, "the lifetime total, though only one gap row is retained");
    assert.deepEqual(json.delivery.gaps_by_reason, { outbox_error: 1, rejected: 1 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
