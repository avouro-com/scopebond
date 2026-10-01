// A live evaluation reads only the history its policy can see (historyNeed): nothing for
// a stateless policy, an indexed timestamp range for a windowed one. These tests pin that
// the decisions are the ones the full history gives, and that per-evaluation cost stops
// growing with the size of the local log.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { createGateway, evaluate } from "../dist/index.js";
import { SqliteReceiptStore } from "../dist/node.js";

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), "scopebond-bounded-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const valid = (clauses) => ({ vocabulary_version: "1.0", policy_id: "bounded", version: 1, clauses });
const windowed = valid([
  { id: "al", type: "action_allowlist", mode: "enforce", action_types: ["payout.create", "beneficiary.update", "fs.read"] },
  { id: "rl", type: "rate_limit", mode: "enforce", action_types: ["payout.create"], max_count: 3, window: "PT2H" },
  { id: "sp", type: "spend_limit", mode: "enforce", asset: "USDC", max_per_window: 120, window: "PT6H", scope: "principal" },
  { id: "sq", type: "sequence", mode: "enforce", first_action_types: ["beneficiary.update"], then_action_types: ["payout.create"], forbidden_within: "PT1H" },
]);
// The coding-agent starter shape: allowlists, a force-push guard, no history.
const starter = valid([
  { id: "reads", type: "action_allowlist", mode: "enforce", action_types: ["fs.read", "fs.write", "shell.exec"] },
  { id: "observe", type: "action_allowlist", mode: "monitor", action_types: ["net.fetch"] },
  { id: "push", type: "force_push_guard", mode: "enforce" },
]);

test("SqliteReceiptStore: the timestamp index is created idempotently", () => {
  const { dir, cleanup } = tmp();
  try {
    const path = join(dir, "r.db");
    new SqliteReceiptStore(path).close();
    new SqliteReceiptStore(path).close();
    const db = new DatabaseSync(path);
    const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'receipts'`).all();
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT receipt_json FROM receipts INDEXED BY receipts_timestamp WHERE timestamp >= ? ORDER BY id`).all("x");
    db.close();
    assert.deepEqual(rows.map((r) => r.name), ["receipts_timestamp"]);
    assert.ok(plan.some((p) => /receipts_timestamp/.test(String(p.detail))), "the range query uses the index");
  } finally { cleanup(); }
});

test("SqliteReceiptStore.executed honours the scope: none reads nothing, since reads the tail", async () => {
  const { dir, cleanup } = tmp();
  try {
    const store = new SqliteReceiptStore(join(dir, "r.db"));
    let clock = Date.parse("2026-09-01T00:00:00.000Z");
    const gateway = createGateway({ policy: windowed, store, mode: "check_only", authentication: { mode: "insecure-development" }, now: () => new Date(clock).toISOString() });
    for (let i = 0; i < 6; i++) {
      await gateway.check({ intent: { action_type: "fs.read", params: {} } });
      clock += 60 * 60_000;
    }
    assert.equal(store.executed().length, 6);
    assert.deepEqual(store.executed({ kind: "none" }), []);
    const tail = store.executed({ kind: "since", since: "2026-09-01T03:00:00.000Z" });
    assert.deepEqual(tail.map((r) => r.timestamp), ["2026-09-01T03:00:00.000Z", "2026-09-01T04:00:00.000Z", "2026-09-01T05:00:00.000Z"]);
    store.close();
  } finally { cleanup(); }
});

// Drive one gateway through a long history and, before every action, compute the
// decision the full, unbounded history gives. They must agree at every step — including
// when `now()` writes offset timestamps that do not sort as text like `Z` ones.
for (const format of ["utc", "offset"]) {
  test(`live decisions equal full-history decisions across windows (${format} timestamps)`, async () => {
    const { dir, cleanup } = tmp();
    try {
      const store = new SqliteReceiptStore(join(dir, "r.db"));
      let clock = Date.parse("2026-09-01T00:00:00.000Z");
      const stamp = (ms) => format === "utc"
        ? new Date(ms).toISOString()
        : new Date(ms + 5.5 * 3_600_000).toISOString().replace("Z", "+05:30");
      const gateway = createGateway({
        policy: windowed, store, mode: "check_only", authentication: { mode: "insecure-development" }, now: () => stamp(clock),
      });
      let seed = 7;
      const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
      const outcomes = { allow: 0, deny: 0 };
      for (let i = 0; i < 160; i++) {
        clock += Math.floor(rand() * 50 * 60_000);
        const roll = rand();
        const intent = roll < 0.6 ? { action_type: "payout.create", asset: "USDC", amount: Math.floor(rand() * 50) }
          : roll < 0.75 ? { action_type: "beneficiary.update", params: {} }
          : { action_type: "fs.read", params: {} };
        const at = stamp(clock);
        const reference = evaluate(windowed, store.executed(), { intent, intent_hash: "ref" }, at,
          { gatewaysComplete: false, cooperative: true });
        const live = await gateway.check({ intent });
        assert.equal(live.allowed, reference.allow, `step ${i}: ${reference.verdict.explanation}`);
        assert.equal(live.verdict?.clause_id ?? null, reference.verdict.clause_id, `step ${i}: clause`);
        outcomes[live.allowed ? "allow" : "deny"]++;
      }
      assert.ok(outcomes.allow > 20 && outcomes.deny > 20, `the history exercises both outcomes: ${JSON.stringify(outcomes)}`);
      store.close();
    } finally { cleanup(); }
  });
}

/** Seed `n` copies of a real receipt, all old, straight into the table. */
function seed(path, receipt, n) {
  const db = new DatabaseSync(path);
  const insert = db.prepare(`INSERT INTO receipts (intent_hash,policy_hash,realtime_result,executed,timestamp,receipt_json) VALUES (?,?,?,?,?,?)`);
  db.exec("BEGIN");
  for (let i = 0; i < n; i++) {
    const copy = structuredClone(receipt);
    copy.payload.timestamp = new Date(Date.parse("2026-01-01T00:00:00.000Z") + i * 60_000).toISOString();
    copy.payload.action_ref.action_id = `seed-${i}`;
    const p = copy.payload;
    insert.run(p.intent_hash, p.policy_hash, p.realtime_result, p.executed ? 1 : 0, p.timestamp, JSON.stringify(copy));
  }
  db.exec("COMMIT");
  db.close();
}

async function medianEvaluationMs(policy, stored) {
  const { dir, cleanup } = tmp();
  try {
    const path = join(dir, "r.db");
    const store = new SqliteReceiptStore(path);
    const gateway = createGateway({ policy, store, mode: "check_only", authentication: { mode: "insecure-development" } });
    const first = await gateway.check({ intent: { action_type: "fs.read", params: { path: "a" } } });
    if (stored > 1) seed(path, first.receipt, stored - 1);
    const times = [];
    for (let i = 0; i < 25; i++) {
      const t0 = performance.now();
      await gateway.check({ intent: { action_type: "fs.read", params: { path: "a" } } });
      times.push(performance.now() - t0);
    }
    store.close();
    times.sort((a, b) => a - b);
    return times[Math.floor(times.length / 2)];
  } finally { cleanup(); }
}

// The measured problem: every tool call parsed and validated the whole log, so a call's
// cost grew with every receipt ever stored. With the bound, 10,000 stored receipts cost
// about what 100 do — for a stateless policy (no query) and a windowed one (whose window
// holds none of the old receipts).
for (const [name, policy] of [["starter (no history)", starter], ["windowed", valid([
  { id: "reads", type: "action_allowlist", mode: "enforce", action_types: ["fs.read"] },
  { id: "rl", type: "rate_limit", mode: "enforce", action_types: ["fs.read"], max_count: 1000, window: "PT1H" },
])]]) {
  test(`per-evaluation time stays flat as the store grows: ${name}`, async () => {
    const small = await medianEvaluationMs(policy, 100);
    const large = await medianEvaluationMs(policy, 10_000);
    assert.ok(large < small * 3 + 5, `median ${large.toFixed(2)} ms at 10,000 receipts vs ${small.toFixed(2)} ms at 100`);
  });
}
