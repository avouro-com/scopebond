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

test("DIC-1: a batch the workspace refuses entirely, for good, never blocks the records after it", async () => {
  const ws = await workspace();
  try {
    const pc = computer(ws.url);
    let first = true;
    ws.answer((receipts) => {
      if (!first) return { status: 200, body: { ok: true } };
      first = false;
      return { status: 400, body: { error: "invalid", code: "invalid_receipt", rejected: receipts.map((r, index) => ({ index, code: "invalid_receipt", action_id: r.payload.action_ref.action_id })) } };
    });
    await pc.act(2);
    await pc.act(1);
    const s = pc.status();
    assert.equal(s.delivery.pending, 0, "nothing is left queued behind the refused batch");
    assert.equal(s.delivery.gaps_by_reason.rejected, 2);
    assert.equal(ws.received.length, 1);
  } finally { ws.close(); }
});

test("DIC-1: a reused action id is found and refused alone; the records around it deliver", async () => {
  const ws = await workspace();
  try {
    const pc = computer(ws.url);
    let reused = null;
    ws.answer((receipts) => {
      reused ??= receipts[0].payload.action_ref.action_id;
      return receipts.some((r) => r.payload.action_ref.action_id === reused)
        ? { status: 409, body: { error: "conflict", code: "id_conflict" } }
        : { status: 200, body: { ok: true } };
    });
    await pc.act(3);
    const s = pc.status();
    assert.equal(s.delivery.pending, 0);
    assert.equal(s.delivery.gaps_by_reason.id_conflict, 1);
    assert.equal(ws.received.length, 2);
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

// SB290: identity changes while records wait. A workspace that accepts only the credential it issued last.
function strictWorkspace() {
  const received = [];
  let accepted = "sbm_us_first";
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      if (req.url !== "/v1/ingest") { res.writeHead(404); res.end("{}"); return; }
      if (req.headers.authorization !== `Bearer ${accepted}`) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized", code: "credential_refused" }));
        return;
      }
      received.push(...(JSON.parse(raw).receipts ?? []).map((r) => r.payload.action_ref.action_id));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, received,
    issue: (credential) => { accepted = credential; },
    close: () => server.close(),
  })));
}

/** One tool call per run on `dir`, delivering with `credential` (what a sign-in writes to cloud.json). */
async function actAs(dir, url, credential, n) {
  const { attester } = loadOrCreateAttester({ file: join(dir, "attester.key") });
  const connection = {
    url, credential, credential_id: credential, organization_id: "org-1", environment_id: "env-1",
    gateway_id: "gw-1", installation_id: "gw-1", installation_generation: 1, attester_kid: attester.kid,
    scopes: ["receipt:ingest"], expires_at: new Date(Date.now() + 80 * DAY).toISOString(),
  };
  writeFileSync(join(dir, "cloud.json"), JSON.stringify(connection));
  const rt = createHookRuntime({
    policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"), attesterPath: join(dir, "attester.key"),
    dbPath: join(dir, "receipts.db"), cloud: { connection, flushTimeoutMs: 5_000 },
  });
  try {
    for (let i = 0; i < n; i++) await rt.evaluate(mapClaudeToolUse({ tool_name: "Read", tool_input: { file_path: `/repo/${credential}-${Date.now()}-${i}.ts` }, cwd: "/repo" }));
    await rt.flush();
  } finally { rt.exporter?.stop(); rt.close(); }
}
const pendingIn = (dir) => buildStatusJson({ version: "test", activeDir: dir, candidateDirs: [dir], hasPolicy: true, agents: { claude: true, cursor: false, codex: false } }).delivery.pending;

test("SB290: a key revoked mid-queue keeps every record; signing in again delivers them all, once", async () => {
  const ws = await strictWorkspace();
  try {
    const dir = mkdtempSync(join(tmpdir(), "sb-sb290-revoke-"));
    scaffold(dir);
    await actAs(dir, ws.url, "sbm_us_first", 2);
    assert.equal(ws.received.length, 2);
    ws.issue("sbm_us_second"); // revoked in the workspace; the computer does not know yet
    await actAs(dir, ws.url, "sbm_us_first", 3);
    assert.equal(ws.received.length, 2, "nothing is accepted on the revoked credential");
    assert.ok(pendingIn(dir) >= 3, "the records wait on the computer");
    await actAs(dir, ws.url, "sbm_us_second", 0); // signed in again: nothing new, just deliver
    assert.equal(pendingIn(dir), 0);
    assert.equal(ws.received.length, 5);
    assert.equal(new Set(ws.received).size, 5, "each record delivered once");
  } finally { ws.close(); }
});

test("SB290: signing in again three times while records wait loses nothing and sends nothing twice", async () => {
  const ws = await strictWorkspace();
  try {
    const dir = mkdtempSync(join(tmpdir(), "sb-sb290-relogin-"));
    scaffold(dir);
    ws.issue("sbm_us_none"); // offline from the computer's point of view
    for (const credential of ["sbm_us_a", "sbm_us_b", "sbm_us_c"]) await actAs(dir, ws.url, credential, 2);
    assert.equal(ws.received.length, 0);
    ws.issue("sbm_us_c");
    await actAs(dir, ws.url, "sbm_us_c", 0);
    assert.equal(pendingIn(dir), 0);
    assert.equal(ws.received.length, 6);
    assert.equal(new Set(ws.received).size, 6);
  } finally { ws.close(); }
});

test("SB290: two configurations on one computer each deliver their own records, with their own credential", async () => {
  const ws = await strictWorkspace();
  try {
    const home = mkdtempSync(join(tmpdir(), "sb-sb290-home-"));
    const project = mkdtempSync(join(tmpdir(), "sb-sb290-project-"));
    scaffold(home); scaffold(project);
    ws.issue("sbm_us_home");
    await actAs(home, ws.url, "sbm_us_home", 2);
    await actAs(project, ws.url, "sbm_us_project", 2);
    assert.equal(ws.received.length, 2, "only the home's records reached the workspace that accepts the home's credential");
    assert.equal(pendingIn(home), 0);
    assert.ok(pendingIn(project) >= 2, "the project's records wait in the project's own queue, not the home's");
  } finally { ws.close(); }
});

test("SB290: a clock ahead of the workspace keeps the record; it is delivered once the time passes, the others at once", async () => {
  const ws = await workspace();
  try {
    const pc = computer(ws.url);
    let ahead = true;
    let first = null;
    ws.answer((receipts) => {
      first ??= receipts[0].payload.action_ref.action_id;
      const refused = ahead ? receipts.flatMap((r, index) => (r.payload.action_ref.action_id === first ? [{ index, code: "future_timestamp", action_id: first }] : [])) : [];
      if (refused.length === receipts.length) return { status: 400, body: { error: "future", code: "invalid_receipt", rejected: refused } };
      return { status: 200, body: { ok: true, ...(refused.length ? { rejected: refused } : {}) } };
    });
    await pc.act(3);
    assert.equal(pc.status().delivery.pending, 1, "the record ahead waits; the other two went");
    assert.deepEqual(pc.status().delivery.gaps_by_reason, {}, "nothing is settled as lost");
    ahead = false; // the workspace's clock caught up
    await pc.deliverOnly();
    assert.equal(pc.status().delivery.pending, 0);
  } finally { ws.close(); }
});

test("SB290: a queue that cannot be written (a full disk) fails closed naming the file and the fix; delivery resumes when it can write", async () => {
  const { chmodSync, existsSync } = await import("node:fs");
  const ws = await workspace();
  try {
    const pc = computer(ws.url);
    await pc.act(1);
    const outbox = join(pc.dir, "receipts.db.cloud-outbox.db");
    assert.ok(existsSync(outbox));
    chmodSync(outbox, 0o444);
    try {
      // The hook fails closed (the CLI denies): it cannot keep the record it would deliver. The error
      // names the queue and what fixes it, never "run init", which would not.
      await assert.rejects(pc.act(1), (error) => error.name === "DeliveryQueueError" && error.message.includes(outbox) && /Free some disk space/.test(error.repair) && /-wal and -shm/.test(error.repair) && /do not delete it/.test(error.repair));
    } finally {
      // The repair: the queue and the -wal/-shm files SQLite created beside it with its permissions.
      for (const file of [outbox, outbox + "-wal", outbox + "-shm"]) if (existsSync(file)) chmodSync(file, 0o644);
    }
    const before = ws.received.length;
    await pc.act(2);
    assert.equal(pc.status().delivery.pending, 0);
    assert.ok(ws.received.length >= before + 2, "records after the disk freed up are delivered");
  } finally { ws.close(); }
});
