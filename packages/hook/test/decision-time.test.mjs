// A decision takes the same few milliseconds however many receipts the local log holds. A busy computer records about
// 18,000 actions a day; every one of them sits inside the replay window here (the worst case for the replay check),
// and 200 tool calls are then decided through the hook runtime. Only the decision is timed: starting the process,
// reading the keys and opening the log are not.
//
// 20,000 receipts by default; SCOPEBOND_BENCH=1 builds 50,000 (SCOPEBOND_BENCH_RECEIPTS=<n> picks any size).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { scaffold, createHookRuntime, mapClaudeToolUse } from "../dist/index.js";

const RECEIPTS = Number(process.env.SCOPEBOND_BENCH_RECEIPTS ?? (process.env.SCOPEBOND_BENCH === "1" ? 50_000 : 20_000));
const DECISIONS = 200;
const WARM_UP = 5;
const SEEDS = ["git status", "ls -la", "cat README.md", "grep -rn TODO src", "pnpm test", "rm -rf ../build", "git push origin feature/x", "sed -n 1,40p src/index.ts"];

const bash = (cwd, command) => mapClaudeToolUse({ cwd, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });

function runtimeFor(dir) {
  return createHookRuntime({
    policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"), attesterPath: join(dir, "attester.key"),
    dbPath: join(dir, "receipts.db"), cwd: dir, homeFolders: [dir],
  });
}

/** Real receipts from real tool calls, then `count` copies with fresh ids, all inside the last 50 minutes, written in one
 *  transaction: about 9 in 10 carry a request id, 1 in 20 an approval id, as the hook's own records do. */
async function buildStore(dir, count) {
  const seeding = runtimeFor(dir);
  try { for (const command of SEEDS) await seeding.evaluate(bash(dir, command)); } finally { seeding.close(); }
  const db = new DatabaseSync(join(dir, "receipts.db"));
  try {
    const seeds = db.prepare("SELECT receipt_json FROM receipts ORDER BY id").all().map((row) => JSON.parse(row.receipt_json));
    const action = db.prepare("SELECT policy_ref_json, policy_snapshot FROM authority_actions LIMIT 1").get();
    const insReceipt = db.prepare("INSERT INTO receipts (intent_hash,policy_hash,realtime_result,executed,timestamp,receipt_json,action_id) VALUES (?,?,?,?,?,?,?)");
    const insAction = db.prepare("INSERT INTO authority_actions (action_id,state,candidate_json,policy_ref_json,policy_snapshot,created_at,terminal_receipt_id) VALUES (?,?,?,?,?,?,?)");
    const insUse = db.prepare("INSERT INTO authority_consumptions (kind,value,action_id) VALUES (?,?,?)");
    const now = Date.now();
    const span = 50 * 60_000;
    let bytes = 0;
    db.exec("PRAGMA synchronous = OFF; BEGIN");
    for (let i = 0; i < count; i++) {
      const seed = structuredClone(seeds[i % seeds.length]);
      const p = seed.payload;
      const id = randomUUID();
      const at = new Date(now - span + Math.floor((span * i) / count)).toISOString();
      p.timestamp = at;
      if (p.action_ref) p.action_ref.action_id = id;
      const requestId = i % 10 === 9 ? null : randomUUID();
      if (p.authorization?.agent) {
        if (requestId) p.authorization.agent.request_id = requestId;
        else delete p.authorization.agent.request_id;
      }
      const approvalId = i % 20 === 7 ? randomUUID() : null;
      if (approvalId && p.authorization) p.authorization.approval = { approval_id: approvalId };
      const text = JSON.stringify(seed);
      bytes += text.length;
      const row = insReceipt.run(p.intent_hash, p.policy_hash, p.realtime_result, p.executed ? 1 : 0, at, text, id);
      insAction.run(id, p.execution?.state ?? "cooperative_allow", "{}", action.policy_ref_json, action.policy_snapshot, at, Number(row.lastInsertRowid));
      if (requestId) insUse.run("request_id", requestId, id);
      if (approvalId) insUse.run("approval_id", approvalId, id);
    }
    db.exec("COMMIT; PRAGMA wal_checkpoint(TRUNCATE);");
    return { averageBytes: Math.round(bytes / count) };
  } finally { db.close(); }
}

const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];

test(`a decision stays under 10 ms at p95 with ${RECEIPTS.toLocaleString("en-US")} receipts in the replay window`, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sb-decision-time-"));
  scaffold(dir);
  const built = performance.now();
  const { averageBytes } = await buildStore(dir, RECEIPTS);
  const buildMs = performance.now() - built;

  const decide = [];
  const call = [];
  for (let i = 0; i < WARM_UP + DECISIONS; i++) {
    const opened = performance.now();
    const runtime = runtimeFor(dir);
    let started, ended;
    try {
      const mapped = bash(dir, "ls");
      started = performance.now();
      const decision = await runtime.evaluate(mapped);
      ended = performance.now();
      assert.equal(decision.decision, "allow", decision.reason);
    } finally { runtime.close(); }
    if (i >= WARM_UP) { decide.push(ended - started); call.push(performance.now() - opened); }
  }
  decide.sort((a, b) => a - b);
  call.sort((a, b) => a - b);
  const ms = (n) => n.toFixed(2);
  t.diagnostic(`${RECEIPTS} receipts of ~${averageBytes} B (${Math.round(statSync(join(dir, "receipts.db")).size / 1048576)} MB) built in ${Math.round(buildMs)} ms`);
  t.diagnostic(`decision p50 ${ms(quantile(decide, 0.5))} ms, p95 ${ms(quantile(decide, 0.95))} ms; with opening and closing the runtime p50 ${ms(quantile(call, 0.5))} ms, p95 ${ms(quantile(call, 0.95))} ms`);
  assert.ok(averageBytes > 1_000, `receipts are of a realistic size (${averageBytes} B)`);
  assert.ok(quantile(decide, 0.95) < 10, `p95 ${ms(quantile(decide, 0.95))} ms (p50 ${ms(quantile(decide, 0.5))} ms)`);
});
