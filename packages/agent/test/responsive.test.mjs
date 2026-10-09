// The agent keeps answering while it works: a long queue is sent a minute at a time with the event loop free between
// batches, and the local store's upkeep (synchronous SQLite work for up to 30 s) runs in a process of its own.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadOrCreateAttester } from "@scopebond/gateway/node";
import { scaffold, createHookRuntime, mapClaudeToolUse } from "@scopebond/hook";
import { runCycle, runUpkeepApart, startService, callAgent } from "../dist/index.js";

function workspace(delayMs = 0) {
  let batches = 0;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const answer = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
      if (req.url === "/v1/ingest") { batches++; setTimeout(() => answer(200, { ok: true, accepted: JSON.parse(raw).receipts.length }), delayMs); return; }
      if (req.url === "/v1/policy") { res.writeHead(204); res.end(); return; }
      answer(404, {});
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, batches: () => batches, close: () => server.close(),
  })));
}

async function computerWithQueue(url, n) {
  const dir = mkdtempSync(join(tmpdir(), "sb-agent-busy-"));
  scaffold(dir);
  const { attester } = loadOrCreateAttester({ file: join(dir, "attester.key") });
  const connection = {
    url, credential: "sbm_us_test", credential_id: "cred-1", organization_id: "org-1", environment_id: "env-1",
    gateway_id: "gw-1", attester_kid: attester.kid, scopes: ["receipt:ingest", "gateway:heartbeat"],
    expires_at: new Date(Date.now() + 80 * 86_400_000).toISOString(),
  };
  writeFileSync(join(dir, "cloud.json"), JSON.stringify(connection));
  // These tests measure sending records in full; with the standard detail (the default) routine records wait for their
  // five-minute summary window instead.
  writeFileSync(join(dir, "managed-meta.json"), JSON.stringify({ evidence_detail: "full" }));
  const rt = createHookRuntime({
    policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"), attesterPath: join(dir, "attester.key"),
    dbPath: join(dir, "receipts.db"), cloud: { connection, fetch: async () => new Response("{}", { status: 503 }) },
  });
  try {
    for (let i = 0; i < n; i++) await rt.evaluate(mapClaudeToolUse({ tool_name: "Read", tool_input: { file_path: `/repo/a${i}.ts` }, cwd: "/repo" }));
    await rt.flush();
  } finally { rt.exporter?.stop(); rt.close(); }
  return dir;
}

/** The longest stretch the event loop went without running a 10 ms timer while `work` ran. */
async function longestStall(work) {
  let last = performance.now();
  let longest = 0;
  const timer = setInterval(() => { const at = performance.now(); longest = Math.max(longest, at - last); last = at; }, 10);
  try { return { result: await work(), longest: () => longest }; } finally { clearInterval(timer); }
}

test("one cycle sends for at most its sending time; the rest waits for the next cycle, which is started at once", async () => {
  const ws = await workspace(80);
  try {
    const dir = await computerWithQueue(ws.url, 250);
    const first = await runCycle({ dir, deliveryMs: 50 });
    assert.equal(first.deliveryError, null);
    assert.equal(first.more, true, "the queue is not empty and the time ran out");
    assert.ok(first.pending > 0 && first.pending < 250, `some records sent, some waiting (${first.pending})`);
    const second = await runCycle({ dir });
    assert.equal(second.pending, 0);
    assert.equal(second.more, false);
    assert.equal(first.delivered + second.delivered, 250);
  } finally { ws.close(); }
});

test("sending a long queue leaves the event loop free between batches", async () => {
  const ws = await workspace(5);
  try {
    const dir = await computerWithQueue(ws.url, 1_200);
    const { result, longest } = await longestStall(() => runCycle({ dir }));
    assert.equal(result.pending, 0);
    assert.equal(result.delivered, 1_200);
    assert.ok(ws.batches() >= 12);
    // A request to the agent waits at most one batch's work, not the whole queue.
    assert.ok(longest() < 750, `the event loop stalled for ${Math.round(longest())} ms`);
  } finally { ws.close(); }
});

test("the store upkeep runs in its own process: the agent's event loop keeps running while it works", async () => {
  const slow = [process.execPath, ["-e", "const end = Date.now() + 1500; while (Date.now() < end) {} console.log(JSON.stringify({ migrated: 2, more: false }))"]];
  const { result, longest } = await longestStall(() => runUpkeepApart(tmpdir(), { command: slow }));
  assert.deepEqual(result, { migrated: 2, more: false });
  assert.ok(longest() < 300, `the event loop stalled for ${Math.round(longest())} ms`);
});

test("an upkeep pass that fails or overruns is reported, never taken for a result", async () => {
  await assert.rejects(runUpkeepApart(tmpdir(), { command: [process.execPath, ["-e", "console.error('database is locked'); process.exit(3)"]] }), /exited with 3: database is locked/);
  await assert.rejects(runUpkeepApart(tmpdir(), { command: [process.execPath, ["-e", "setTimeout(() => {}, 10000)"]], timeoutMs: 200 }), /did not finish within/);
  await assert.rejects(runUpkeepApart(tmpdir(), { command: [process.execPath, ["-e", "console.log('not json')"]] }), /gave no report/);
});

test("scopebond-agent upkeep reports one pass as JSON, and null for a home with no store", () => {
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const home = mkdtempSync(join(tmpdir(), "sb-agent-upkeep-"));
  const run = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", cli, "upkeep"], { env: { ...process.env, SCOPEBOND_HOME: home }, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), "null");
});

test("while a maintenance pass runs its upkeep, the agent still answers status", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-agent-answers-"));
  let release;
  const upkeep = () => new Promise((resolve) => { release = () => resolve(null); });
  const service = await startService({ dir, maintenance: false, tray: false, upkeep, log: () => {} });
  try {
    const pass = service.maintainNow();
    const started = Date.now();
    const answer = await callAgent(dir, "GET", "/status", undefined, 2_000);
    assert.ok(answer, "the agent answered");
    assert.ok(Date.now() - started < 1_000);
    release();
    const result = await pass;
    assert.equal(result.store, null);
  } finally { await service.stop(); }
});
