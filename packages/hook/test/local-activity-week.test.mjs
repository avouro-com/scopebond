// The tray's blocked list holds every block of the day, however many actions the computer recorded since, and folds an
// agent's retries of one block into one row. A store written by a busy day (thousands of receipts) once listed only the blocks
// among its newest 5,000 receipts, while the count covered the whole day: "17 blocked today" over an empty list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BLOCK_NOTES_FILE, foldRetries, localActivity } from "../dist/index.js";

const SCHEMA = `
  CREATE TABLE receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, intent_hash TEXT NOT NULL, policy_hash TEXT NOT NULL,
    realtime_result TEXT NOT NULL, executed INTEGER NOT NULL, timestamp TEXT NOT NULL, receipt_json TEXT NOT NULL, action_id TEXT);
  CREATE INDEX receipts_timestamp ON receipts (timestamp);`;

/** A store of `n` receipts spread over the day so far, denied at the given positions (1-based). */
function store({ n, denied, now, index = true, command = (i) => `rm -rf /data/${i}` }) {
  const dir = mkdtempSync(join(tmpdir(), "sb-week-"));
  const db = new DatabaseSync(join(dir, "receipts.db"));
  db.exec(SCHEMA);
  if (index) db.exec("CREATE INDEX receipts_denied ON receipts (id) WHERE realtime_result = 'deny';");
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const step = (now.getTime() - midnight - 60_000) / n;
  const insert = db.prepare("INSERT INTO receipts (intent_hash, policy_hash, realtime_result, executed, timestamp, receipt_json, action_id) VALUES ('h','p',?,?,?,?,?)");
  db.exec("BEGIN");
  const deny = new Set(denied);
  for (let i = 1; i <= n; i++) {
    const at = new Date(midnight + 30_000 + i * step).toISOString();
    const blocked = deny.has(i);
    const payload = {
      timestamp: at, action_ref: { action_id: `act-${i}` },
      intent: blocked ? { action_type: "shell.exec", params: { program: "rm", argv: command(i).split(" ") } } : { action_type: "shell.exec", params: { program: "ls" } },
      ...(blocked ? { execution: { state: "denied" } } : {}),
    };
    insert.run(blocked ? "deny" : "allow", blocked ? 0 : 1, at, JSON.stringify({ payload }), `act-${i}`);
  }
  db.exec("COMMIT");
  db.close();
  return dir;
}

test("every block of the day is listed, however far back among 20,000 receipts, and the header counts the same blocks", () => {
  const now = new Date();
  now.setHours(23, 0, 0, 0);
  for (const index of [true, false]) {
    const dir = store({ n: 20_000, denied: [1, 10_000, 19_999], now, index });
    const activity = localActivity(dir, { now, limit: 200 });
    assert.ok(activity, "the store is readable");
    assert.deepEqual(activity.recent_blocks.map((b) => b.action_id), ["act-19999", "act-10000", "act-1"], `index ${index}`);
    assert.equal(activity.today.blocked, 3, "the header counts the listed blocks");
    assert.equal(activity.today.blocked, activity.recent_blocks.length);
    assert.equal(activity.today.attempts, 3);
    assert.equal(activity.today.actions, 20_000);
  }
});

test("an agent's retries of one block fold into one row with the number of tries; the header counts distinct blocks", () => {
  const now = new Date();
  now.setHours(12, 0, 0, 0);
  const at = (minutesAgo) => new Date(now.getTime() - minutesAgo * 60_000).toISOString();
  const row = (id, minutesAgo, text, session = "s1") => ({ action_id: id, at: at(minutesAgo), summary: "shell.exec rm", rule: "destructive-shell", action_text: text, harness: "claude", project: "app", session });
  const folded = foldRetries([
    row("d", 1, "rm -rf /data"),
    row("s", 2, "rm -rf /data", "s2"), // another session: its own block
    row("c", 5, "rm -rf /data"), row("b", 12, "rm -rf /data"),
    row("x", 13, "rm -rf /other"),
    row("a", 40, "rm -rf /data"), // 28 minutes before the next try: a new block
  ]);
  assert.deepEqual(folded.map((b) => [b.action_id, b.tries]), [["d", 3], ["s", 1], ["x", 1], ["a", 1]]);
  assert.equal(folded[0].first_at, at(12));
  assert.equal(folded[0].at, at(1), "a folded block shows its newest try");
  assert.ok(!("session" in folded[0]), "the session key stays on this computer's notes");
});

test("the hook's notes give a block its session, so retries fold in the list and count once", () => {
  const now = new Date();
  now.setHours(12, 0, 0, 0);
  const dir = store({ n: 500, denied: [496, 497, 498, 499], now, command: () => "rm -rf /data" });
  const notes = [496, 497, 498, 499].map((i) => ({ id: `act-${i}`, at: now.toISOString(), clause: "safe-shell", rule: "destructive-shell", harness: "claude", project: "app", session: "k1" }));
  writeFileSync(join(dir, BLOCK_NOTES_FILE), JSON.stringify({ notes }));
  const activity = localActivity(dir, { now, limit: 200 });
  assert.equal(activity.recent_blocks.length, 1);
  assert.equal(activity.recent_blocks[0].tries, 4);
  assert.equal(activity.today.blocked, 1);
  assert.equal(activity.today.attempts, 4);
  assert.equal(activity.recent_blocks[0].rule_title, "Run a command that deletes data or shuts down the computer");
});
