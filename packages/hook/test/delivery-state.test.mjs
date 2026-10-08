import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDeliveryState, recordDeliveryAttempt, recordRulesCredential, httpStatusOf } from "../dist/delivery-state.js";
import { describeDelivery } from "../dist/delivery-report.js";
import { cliCommand } from "../dist/version.js";
import { writeHarnessConfig } from "../dist/index.js";

const fresh = () => mkdtempSync(join(tmpdir(), "sb-delivery-"));
const url = "https://cloud.example.com";

test("a refused credential (401) marks the connection invalid until a delivery succeeds again", () => {
  const dir = fresh();
  assert.equal(httpStatusOf("ingest failed: HTTP 401"), 401);
  recordDeliveryAttempt(dir, { lastSuccessAt: null, lastError: "ingest failed: HTTP 401", pending: 3 }, 1_000);
  let state = readDeliveryState(dir);
  assert.equal(state.invalid_since, 1_000);
  assert.equal(state.invalid_source, "delivery");
  assert.equal(state.last_status, 401);
  // A later refusal keeps the first time it stopped working.
  recordDeliveryAttempt(dir, { lastSuccessAt: null, lastError: "ingest failed: HTTP 401", pending: 3 }, 2_000);
  assert.equal(readDeliveryState(dir).invalid_since, 1_000);
  // An accepted delivery clears it.
  recordDeliveryAttempt(dir, { lastSuccessAt: 3_000, lastError: null, pending: 0 }, 3_000, null);
  state = readDeliveryState(dir);
  assert.equal(state.invalid_since, null);
  assert.equal(state.last_success_at, 3_000);
  assert.equal(state.last_error, null);
});

test("an attempt with nothing new accepted is not counted as a delivery", () => {
  const dir = fresh();
  recordDeliveryAttempt(dir, { lastSuccessAt: 500, lastError: null, pending: 0 }, 1_000, 500);
  assert.equal(readDeliveryState(dir).last_success_at, null);
  assert.equal(readDeliveryState(dir).last_attempt_at, 1_000);
});

test("the rules check reports a refused connection, and a working one clears only its own report", () => {
  const dir = fresh();
  recordRulesCredential(dir, false, 1_000);
  assert.equal(readDeliveryState(dir).invalid_source, "rules");
  recordRulesCredential(dir, true, 2_000);
  assert.equal(readDeliveryState(dir).invalid_since, null);
  recordDeliveryAttempt(dir, { lastSuccessAt: null, lastError: "ingest failed: HTTP 401", pending: 1 }, 3_000);
  recordRulesCredential(dir, true, 4_000);
  assert.equal(readDeliveryState(dir).invalid_since, 3_000, "a delivery refusal is not cleared by the rules check");
});

test("status names the one fix when the connection was refused", () => {
  const dir = fresh();
  recordDeliveryAttempt(dir, { lastSuccessAt: null, lastError: "ingest failed: HTTP 401", pending: 0 }, Date.now());
  const report = describeDelivery(dir, { url });
  assert.match(report.lines[0], /^NOT DELIVERING since /);
  assert.ok(report.fix?.includes(`login ${url}`));
  assert.ok(report.lines.some((line) => line.startsWith("fix: run ")));
  assert.equal(report.problems.length, 1);
});

test("a healthy computer reports when it last delivered and nothing waiting", () => {
  const dir = fresh();
  recordDeliveryAttempt(dir, { lastSuccessAt: Date.now() - 120_000, lastError: null, pending: 0 }, Date.now(), null);
  const report = describeDelivery(dir, { url });
  assert.equal(report.fix, null);
  assert.deepEqual(report.problems, []);
  assert.ok(report.lines.some((line) => /^last delivered\s+2 minutes ago/.test(line)), report.lines.join("\n"));
  assert.ok(report.lines.some((line) => /^waiting to send\s+0 record\(s\)$/.test(line)));
});

test("printed commands use npx.cmd on Windows, where PowerShell refuses npx.ps1", () => {
  assert.match(cliCommand("status", "win32"), /^npx\.cmd -y @scopebond\/hook@\S+ status$/);
  assert.match(cliCommand("status", "linux"), /^npx -y @scopebond\/hook@\S+ status$/);
  assert.match(cliCommand("status", "darwin"), /^npx -y /);
});

test("a settings file that already holds the hook is left byte-for-byte untouched", () => {
  const dir = fresh();
  const file = join(dir, "settings.json");
  writeHarnessConfig(file, "claude", "npx -y @scopebond/hook@0.12.0 claude");
  const content = readFileSync(file, "utf8");
  // Reformat by hand: identical meaning, different bytes. A no-op write must not normalize it.
  const custom = JSON.stringify(JSON.parse(content));
  writeFileSync(file, custom);
  const before = statSync(file).mtimeMs;
  const backups = readdirSync(dir).length;
  writeHarnessConfig(file, "claude", "npx -y @scopebond/hook@0.12.0 claude");
  assert.equal(readFileSync(file, "utf8"), custom);
  assert.equal(statSync(file).mtimeMs, before);
  assert.equal(readdirSync(dir).length, backups, "no backup for a no-op");
  // A real change is still written.
  writeHarnessConfig(file, "claude", "npx -y @scopebond/hook@0.13.0 claude");
  assert.match(readFileSync(file, "utf8"), /0\.13\.0/);
  assert.ok(existsSync(file));
});

test("the delivery queue keeps every record: no 7-day expiry and no cap that drops the newest", async () => {
  const { SqliteCloudOutbox } = await import("@scopebond/gateway/node");
  const { LOSSLESS_OUTBOX } = await import("../dist/delivery-report.js");
  const dir = fresh();
  let now = 1_000;
  const outbox = new SqliteCloudOutbox(join(dir, "q.db"), { ...LOSSLESS_OUTBOX, now: () => now });
  try {
    const receipt = (id) => ({ payload: { action_ref: { action_id: id } }, signature: "s" });
    for (let i = 0; i < 25; i++) assert.equal(outbox.enqueue(receipt(`a${i}`)).queued, true);
    now += 400 * 24 * 60 * 60 * 1000; // more than a year offline
    assert.equal(outbox.peek(100, now).length, 25);
    assert.equal(outbox.status().gaps, 0);
  } finally { outbox.close(); }
});

test("status says the delivery queue is unusable instead of 'nothing waiting' when it cannot be opened", async () => {
  const { chmodSync } = await import("node:fs");
  const { SqliteCloudOutbox } = await import("@scopebond/gateway/node");
  const dir = mkdtempSync(join(tmpdir(), "sb-hook-queue-ro-"));
  const outbox = join(dir, "receipts.db.cloud-outbox.db");
  new SqliteCloudOutbox(outbox).close();
  chmodSync(outbox, 0o444);
  try {
    let unwritable = true;
    try { new SqliteCloudOutbox(outbox).close(); unwritable = false; } catch { /* read-only, as intended */ }
    if (!unwritable) return; // root on Linux writes read-only files: nothing to show there
    const report = describeDelivery(dir, { url: "https://cloud.example" });
    assert.match(report.lines.join("\n"), /DELIVERY QUEUE UNUSABLE/);
    assert.doesNotMatch(report.lines.join("\n"), /waiting to send {2}0 record/);
    assert.match(report.problems.join("\n"), /actions stay allowed and are recorded on this computer/);
    const { buildStatusJson } = await import("../dist/status-json.js");
    const json = buildStatusJson({ version: "test", activeDir: dir, candidateDirs: [dir], hasPolicy: true, agents: { claude: true, cursor: false, codex: false } });
    assert.notEqual(json.state, "delivering", "an unusable queue is never reported as delivering");
    assert.equal(json.delivery.last_error_code, "queue_unusable");
    assert.match(json.delivery.queue_error, /receipts\.db\.cloud-outbox\.db/);
  } finally {
    for (const file of [outbox, outbox + "-wal", outbox + "-shm"]) if (existsSync(file)) chmodSync(file, 0o644);
  }
});

test("a bounded attempt cut off with records waiting is recorded as a timeout, not as nothing", () => {
  const dir = fresh();
  // What the hook saw on a slow workspace: no error, nothing accepted, records still queued.
  recordDeliveryAttempt(dir, { lastSuccessAt: null, lastError: null, pending: 46 }, 1_000, null, 800);
  let state = readDeliveryState(dir);
  assert.equal(state.last_attempt_at, 1_000);
  assert.match(state.last_error, /did not finish within 800 ms.*\(timeout\)$/);
  assert.equal(state.last_status, null);
  // An attempt with nothing waiting was not cut off, and a delivery clears the timeout.
  const idle = fresh();
  recordDeliveryAttempt(idle, { lastSuccessAt: null, lastError: null, pending: 0 }, 1_000, null, 800);
  assert.equal(readDeliveryState(idle).last_error, null);
  recordDeliveryAttempt(dir, { lastSuccessAt: 2_000, lastError: null, pending: 0 }, 2_000, null, 800);
  state = readDeliveryState(dir);
  assert.equal(state.last_error, null);
  assert.equal(state.last_success_at, 2_000);
  // A timeout never clears a refused connection: it says nothing about the credential.
  recordDeliveryAttempt(dir, { lastSuccessAt: null, lastError: "ingest failed: HTTP 401", pending: 1 }, 3_000);
  recordDeliveryAttempt(dir, { lastSuccessAt: null, lastError: null, pending: 1 }, 4_000, null, 800);
  assert.equal(readDeliveryState(dir).invalid_since, 3_000);
});

test("after a recent delivery a cut-off hook call is history, not the last problem (SB385)", () => {
  const dir = fresh();
  const minute = 60_000;
  // The agent delivered at 10:00; a hook call at 10:02 was cut off at 800 ms while records waited.
  recordDeliveryAttempt(dir, { lastSuccessAt: 10 * 60 * minute, lastError: null, pending: 0 }, 10 * 60 * minute, null);
  recordDeliveryAttempt(dir, { lastSuccessAt: null, lastError: null, pending: 3 }, 10 * 60 * minute + 2 * minute, null, 800);
  let state = readDeliveryState(dir);
  assert.equal(state.last_error, null, "green stays green");
  assert.equal(state.last_timeout_at, 10 * 60 * minute + 2 * minute, "kept as history");
  // Nothing delivered for 20 minutes: now the timeout is the problem.
  recordDeliveryAttempt(dir, { lastSuccessAt: null, lastError: null, pending: 3 }, 10 * 60 * minute + 20 * minute, null, 800);
  state = readDeliveryState(dir);
  assert.match(state.last_error, /\(timeout\)$/);
});

/** A computer whose queue holds `count` records queued `ageMs` ago. */
async function queued(count, ageMs) {
  const { SqliteCloudOutbox } = await import("@scopebond/gateway/node");
  const { LOSSLESS_OUTBOX, OUTBOX_FILE } = await import("../dist/delivery-report.js");
  const dir = fresh();
  const at = Date.now() - ageMs;
  const outbox = new SqliteCloudOutbox(join(dir, OUTBOX_FILE), { ...LOSSLESS_OUTBOX, now: () => at });
  try { for (let i = 0; i < count; i++) outbox.enqueue({ payload: { action_ref: { action_id: `q${i}` } }, signature: "s" }); }
  finally { outbox.close(); }
  return dir;
}

test("records that have never been delivered are a problem after a few minutes, even with no error recorded", async () => {
  // The reported case: "last delivered never; last tried 4 seconds ago", 46 waiting, no error, and doctor said "All good."
  const dir = await queued(46, 10 * 60_000);
  writeFileSync(join(dir, "delivery.json"), JSON.stringify({ last_attempt_at: Date.now() - 4_000, last_success_at: null, last_error: null }));
  const report = describeDelivery(dir, { url });
  assert.match(report.lines[0], /^NOT DELIVERING: nothing from this computer has ever reached the workspace, and 46 record\(s\) wait/);
  assert.equal(report.problems.length, 1, "doctor cannot say All good");
  assert.match(report.problems[0], /no attempt recorded an error/);
  assert.ok(report.problems[0].includes(cliCommand("flush")), "names the command that sends with no time limit");
  // The same with the cause known.
  recordDeliveryAttempt(dir, { lastSuccessAt: null, lastError: null, pending: 46 }, Date.now(), null, 800);
  assert.match(describeDelivery(dir, { url }).problems[0], /\(timeout\)/);
  assert.ok(describeDelivery(dir, { url }).lines.some((line) => /^last problem\s+delivery did not finish within 800 ms/.test(line)));
});

test("records queued a moment ago, or after the last delivery but behind a recent one, are not yet a problem", async () => {
  const young = await queued(3, 30_000);
  assert.deepEqual(describeDelivery(young, { url }).problems, []);
  // Older records, but the workspace accepted something after they were queued: the queue is draining.
  const draining = await queued(3, 10 * 60_000);
  recordDeliveryAttempt(draining, { lastSuccessAt: Date.now() - 60_000, lastError: null, pending: 3 }, Date.now(), null);
  assert.deepEqual(describeDelivery(draining, { url }).problems, []);
  // Delivered before they were queued, and nothing since: stalled.
  const stalled = await queued(3, 10 * 60_000);
  recordDeliveryAttempt(stalled, { lastSuccessAt: Date.now() - 60 * 60_000, lastError: null, pending: 3 }, Date.now(), null);
  const report = describeDelivery(stalled, { url });
  assert.equal(report.problems.length, 1);
  assert.match(report.lines[0], /nothing has reached the workspace since 60 minutes ago/);
});
