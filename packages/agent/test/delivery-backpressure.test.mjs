// The agent's delivery cycle never wedges on a record the workspace will never take, and honours a wait the workspace asked
// for, whether a hook call or an earlier cycle recorded it (each cycle makes a new exporter).
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical } from "@scopebond/gateway";
import { loadOrCreateAttester } from "@scopebond/gateway/node";
import { scaffold, createHookRuntime, mapClaudeToolUse, queueStatus, readDeliveryState } from "@scopebond/hook";
import { runCycle } from "../dist/index.js";

/** A workspace with the hosted size limits (a receipt over 128 KiB of canonical JSON is refused whole with 413
 *  batch_too_large); while `paused`, it answers 503 ingest_paused with Retry-After: 3600. */
function workspace() {
  const posts = [];
  let paused = false;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const send = (status, body, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
      if (req.url === "/v1/ingest") {
        const receipts = JSON.parse(raw).receipts ?? [];
        const post = { count: receipts.length, status: 200 };
        posts.push(post);
        if (paused) { post.status = 503; return send(503, { error: "paused", code: "ingest_paused" }, { "retry-after": "3600" }); }
        if (receipts.some((r) => Buffer.byteLength(canonical(r)) > 128 * 1024)) { post.status = 413; return send(413, { error: "receipt exceeds 128 KiB", code: "batch_too_large" }); }
        return send(200, { ok: true, ingested: receipts.length, duplicates: 0 });
      }
      if (req.url === "/v1/policy") { res.writeHead(204); res.end(); return; }
      if (req.url === "/v1/policy/ack") return send(200, {});
      res.writeHead(404); res.end("{}");
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, posts, pause: (on) => { paused = on; }, close: () => server.close(),
  })));
}

/** A connected computer whose hook recorded `tools` while delivery failed with `answer`, so the records wait in the queue. */
async function computerWithQueue(url, tools, answer = () => new Response("{}", { status: 503 })) {
  const dir = mkdtempSync(join(tmpdir(), "sb-agent-backpressure-"));
  scaffold(dir);
  const { attester } = loadOrCreateAttester({ file: join(dir, "attester.key") });
  const connection = {
    url, credential: "sbm_us_test", credential_id: "cred-1", organization_id: "org-1", environment_id: "env-1",
    gateway_id: "gw-1", attester_kid: attester.kid, scopes: ["receipt:ingest", "gateway:heartbeat"],
    expires_at: new Date(Date.now() + 80 * 86_400_000).toISOString(),
  };
  writeFileSync(join(dir, "cloud.json"), JSON.stringify(connection));
  // Every receipt goes in full (not the standard summaries), so the records can be counted one by one.
  writeFileSync(join(dir, "managed-meta.json"), JSON.stringify({ evidence_detail: "full" }));
  const rt = createHookRuntime({
    policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"), attesterPath: join(dir, "attester.key"),
    dbPath: join(dir, "receipts.db"), cloud: { connection, fetch: async () => answer() },
  });
  try {
    for (const tool of tools) await rt.evaluate(mapClaudeToolUse({ ...tool, cwd: "/repo" }));
    await rt.flush();
  } finally { rt.exporter?.stop(); rt.close(); }
  return dir;
}

const read = (i) => ({ tool_name: "Read", tool_input: { file_path: `/repo/a${i}.ts` } });
// A ~144 KB path of short, letter-only segments (not masked), so the signed receipt passes 128 KiB.
const longFetch = { tool_name: "WebFetch", tool_input: { url: "https://docs.example.com/" + "abcdefgh/".repeat(16_000), prompt: "summarise" } };

test("a cycle settles an oversized record as an oversize gap and delivers the records behind it", async () => {
  const ws = await workspace();
  try {
    const dir = await computerWithQueue(ws.url, [longFetch, read(1), read(2), read(3)]);
    assert.equal(queueStatus(dir).pending, 4);
    const first = await runCycle({ dir });
    assert.equal(first.deliveryError, null, first.deliveryError ?? "");
    assert.equal(first.pending, 0, "nothing waits behind the oversized record");
    assert.equal(ws.posts.filter((p) => p.status === 200).reduce((n, p) => n + p.count, 0), 3);
    assert.equal(ws.posts.filter((p) => p.status === 413).length, 1, "the oversized record was sent once, on its own");
    assert.equal(queueStatus(dir).gapsByReason.oversize, 1);
    // The next cycle has nothing to send: the record is not sent again.
    const before = ws.posts.length;
    await runCycle({ dir });
    assert.equal(ws.posts.length, before);
  } finally { ws.close(); }
});

test("a cycle honours a wait the workspace asked for, recorded by a hook call or an earlier cycle", async () => {
  const ws = await workspace();
  try {
    // A hook call was told to wait an hour (503 with Retry-After: 3600).
    const dir = await computerWithQueue(ws.url, [read(1), read(2)], () => new Response(JSON.stringify({ code: "ingest_paused" }), { status: 503, headers: { "retry-after": "3600" } }));
    const recorded = readDeliveryState(dir).backoff_until;
    assert.ok(recorded >= Date.now() + 3_500_000, `the hook call kept the wait: ${recorded}`);
    // The agent's cycles send nothing while it lasts.
    const quiet = await runCycle({ dir });
    assert.equal(ws.posts.length, 0, "no request before the wait ends");
    assert.equal(quiet.pending, 2);
    assert.equal(quiet.deliveryError, null);
    // Once it has passed, a cycle sends; the workspace is still paused and asks again, and the next cycle waits again.
    ws.pause(true);
    const later = recorded + 1_000;
    const asked = await runCycle({ dir, now: () => later });
    assert.equal(ws.posts.length, 1);
    assert.match(asked.deliveryError ?? "", /HTTP 503 \(ingest_paused\)/);
    const again = readDeliveryState(dir).backoff_until;
    assert.ok(again >= later + 3_600_000, "the new wait is kept for the next cycle");
    await runCycle({ dir, now: () => later + 60_000 });
    assert.equal(ws.posts.length, 1, "the next cycle, a minute later, waits");
    // After it, the workspace takes the records and the wait is cleared.
    ws.pause(false);
    const done = await runCycle({ dir, now: () => again + 1_000 });
    assert.equal(done.delivered, 2);
    assert.equal(done.pending, 0);
    assert.equal(readDeliveryState(dir).backoff_until, null);
  } finally { ws.close(); }
});
