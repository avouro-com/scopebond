// Delivery and identity conformance (DIC-1): the scenarios every connector must survive, run
// against the real runtime, queue and status contract with a workspace that fails on purpose.
// Each scenario ends with every record either delivered or accounted for: nothing lost, nothing
// stuck behind a record that can never be accepted.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadOrCreateAttester } from "@scopebond/gateway/node";
import { scaffold, createHookRuntime, mapClaudeToolUse } from "../dist/index.js";
import { buildStatusJson, STATUS_SCHEMA } from "../dist/status-json.js";

const DAY = 86_400_000;

/** A workspace whose answer to /v1/ingest the scenario sets. */
function workspace() {
  const received = [];
  let answer = () => ({ status: 200, body: { ok: true } });
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      if (req.url === "/v1/ingest") {
        const receipts = JSON.parse(raw).receipts ?? [];
        const { status, body } = answer(receipts);
        if (status === 200) received.push(...receipts.filter((_, i) => !(body.rejected ?? []).some((r) => r.index === i)));
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
        return;
      }
      res.writeHead(404); res.end("{}");
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    url: `http://127.0.0.1:${server.address().port}`,
    received,
    answer: (fn) => { answer = fn; },
    close: () => server.close(),
  })));
}

function computer(url) {
  const dir = mkdtempSync(join(tmpdir(), "sb-dic1-"));
  scaffold(dir);
  const { attester } = loadOrCreateAttester({ file: join(dir, "attester.key") });
  const connection = {
    url, credential: "sbm_us_test", credential_id: "cred-1", organization_id: "org-1", environment_id: "env-1",
    gateway_id: "gw-1", installation_id: "gw-1", installation_generation: 1, attester_kid: attester.kid,
    scopes: ["receipt:ingest"], expires_at: new Date(Date.now() + 80 * DAY).toISOString(),
  };
  writeFileSync(join(dir, "cloud.json"), JSON.stringify(connection));
  const runtime = () => createHookRuntime({
    policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"), attesterPath: join(dir, "attester.key"),
    dbPath: join(dir, "receipts.db"), cloud: { connection, flushTimeoutMs: 5_000 },
  });
  // One tool call per run, as the hook works: decide, deliver what is queued, exit.
  const act = async (n) => {
    const rt = runtime();
    try {
      for (let i = 0; i < n; i++) await rt.evaluate(mapClaudeToolUse({ tool_name: "Read", tool_input: { file_path: `/repo/f${Date.now()}-${i}.ts` }, cwd: "/repo" }));
      await rt.flush();
    } finally { rt.exporter?.stop(); rt.close(); }
  };
  const deliverOnly = async () => {
    const rt = runtime();
    try { await rt.flush(); } finally { rt.exporter?.stop(); rt.close(); }
  };
  const status = () => buildStatusJson({ version: "test", activeDir: dir, candidateDirs: [dir], hasPolicy: true, agents: { claude: true, cursor: false, codex: false } });
  return { dir, act, deliverOnly, status };
}

test("DIC-1: a refused connection keeps every record and says so; they deliver once it works again", async () => {
  const ws = await workspace();
  try {
    const pc = computer(ws.url);
    ws.answer(() => ({ status: 401, body: { error: "unauthorized", code: "credential_refused", remediation: "Sign it in again." } }));
    await pc.act(3);
    let s = pc.status();
    assert.equal(s.schema, STATUS_SCHEMA);
    assert.equal(s.state, "recording_locally");
    assert.equal(s.delivery.last_error_code, "credential_refused");
    assert.ok(s.delivery.connection_refused_since !== null);
    assert.ok(s.delivery.pending >= 3);
    ws.answer(() => ({ status: 200, body: { ok: true } }));
    await pc.deliverOnly();
    s = pc.status();
    assert.equal(s.state, "delivering");
    assert.equal(s.delivery.pending, 0);
    assert.equal(s.delivery.connection_refused_since, null);
    assert.ok(ws.received.length >= 3);
  } finally { ws.close(); }
});

test("DIC-1: an outage (5xx) keeps the queue intact and it drains afterwards", async () => {
  const ws = await workspace();
  try {
    const pc = computer(ws.url);
    ws.answer(() => ({ status: 503, body: { error: "unavailable", code: "unavailable" } }));
    await pc.act(2);
    assert.ok(pc.status().delivery.pending >= 2);
    ws.answer(() => ({ status: 200, body: { ok: true } }));
    await pc.deliverOnly();
    assert.equal(pc.status().delivery.pending, 0);
    assert.deepEqual(pc.status().delivery.gaps_by_reason, {});
  } finally { ws.close(); }
});

test("DIC-1: eight days offline loses nothing", async () => {
  const ws = await workspace();
  try {
    const pc = computer(ws.url);
    ws.answer(() => ({ status: 503, body: {} }));
    await pc.act(4);
    // Age the queue past the old 7-day expiry.
    const db = new DatabaseSync(join(pc.dir, "receipts.db.cloud-outbox.db"));
    db.prepare("UPDATE cloud_outbox SET enqueued_at = enqueued_at - ?").run(8 * DAY);
    db.close();
    assert.ok(pc.status().delivery.oldest_pending_age_s >= 8 * 86_400);
    ws.answer(() => ({ status: 200, body: { ok: true } }));
    await pc.deliverOnly();
    assert.equal(pc.status().delivery.pending, 0);
    assert.equal(pc.status().delivery.gaps_by_reason.expired, undefined);
    assert.ok(ws.received.length >= 4);
  } finally { ws.close(); }
});

test("DIC-1: a record refused on its own never blocks the records behind it", async () => {
  const ws = await workspace();
  try {
    const pc = computer(ws.url);
    // The workspace refuses the first record of each batch and stores the rest.
    ws.answer((receipts) => ({ status: 200, body: { ok: true, ingested: receipts.length - 1, rejected: [{ index: 0, code: "invalid_receipt", action_id: null }] } }));
    await pc.act(3);
    const s = pc.status();
    assert.equal(s.delivery.pending, 0, "nothing is left queued behind the refused record");
    assert.equal(s.delivery.gaps_by_reason.rejected, 1);
    assert.ok(ws.received.length >= 2);
  } finally { ws.close(); }
});

test("DIC-1: no agent wired to the hook is reported as not governing", async () => {
  const ws = await workspace();
  try {
    const pc = computer(ws.url);
    const s = buildStatusJson({ version: "test", activeDir: pc.dir, candidateDirs: [pc.dir], hasPolicy: true, agents: { claude: false, cursor: false, codex: false } });
    assert.equal(s.state, "not_governing");
    assert.equal(s.identity.installation_id, "gw-1");
    assert.ok(s.identity.key_kid);
  } finally { ws.close(); }
});
