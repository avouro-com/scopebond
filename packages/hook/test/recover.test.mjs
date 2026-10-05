import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateAttester, SqliteReceiptStore, SqliteCloudOutbox } from "@scopebond/gateway/node";
import { scaffold, connectCloud, createHookRuntime } from "../dist/index.js";
import { mapClaudeToolUse } from "../dist/index.js";
import { recoverEarlierReceipts } from "../dist/recover.js";
import { ENFORCE } from "./enforce-all.mjs";

const policy = {
  vocabulary_version: "1.0", policy_id: "recover-test", version: 1,
  clauses: [{ id: "files", type: "action_allowlist", mode: "enforce", action_types: ["file.read"] }],
};
const proof = JSON.stringify({ challenge: "c1", enrollment_id: "e1", type: "scopebond:gateway-enrollment", version: 1 });
const bundle = { enrollment_token: "sbe_test123", proof_canonical: proof, expires_at: "2027-01-01T00:00:00.000Z" };

async function record(dir, paths) {
  const runtime = createHookRuntime({
    policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"),
    attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db"),
  });
  for (const path of paths) await runtime.evaluate(mapClaudeToolUse({ tool_name: "Read", tool_input: { file_path: path }, cwd: "/repo" }));
}

/** A workspace that refuses `revokedPem` at enrollment (as Cloud does for a revoked key) and
 *  runs the recovery flow: pending until polled `approveAfter` times, then approved. */
function fakeCloud(dir, revokedPem, { approveAfter = 1, keyStatus = "revoked", failUploads = 0 } = {}) {
  const state = { enrolls: 0, uploaded: [], completed: false, polls: 0, asked: null, failed: 0 };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const send = (status, value) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
      if (req.url === "/v1/enroll") {
        state.enrolls += 1;
        const parsed = JSON.parse(body);
        if (parsed.public_key_pem.trim() === revokedPem.trim()) {
          return send(409, { error: "this gateway key was revoked (the gateway was replaced or disconnected); generate a new gateway key and enroll again with the same enrollment token", code: "gateway_key_conflict" });
        }
        const current = loadOrCreateAttester({ file: join(dir, "attester.key") }).attester;
        const agent = loadOrCreateAttester({ file: join(dir, "agent.key") }).attester;
        return send(201, {
          credential_id: "cred-2", credential: "sbm_new", organization_id: "org-1", environment_id: "env-1", gateway_id: "gw-2",
          attester_kid: current.kid, agent_kid: agent.kid, scopes: ["receipt:ingest"], expires_at: "2027-01-01T00:00:00.000Z",
        });
      }
      assert.equal(req.headers.authorization, "Bearer sbm_new");
      if (req.url === "/v1/recover" && req.method === "POST") {
        state.asked = JSON.parse(body);
        if (keyStatus === "valid") return send(409, { error: "that key is still valid", code: "key_not_revoked" });
        return send(202, { id: "r1", status: "pending", approve_url: "https://cloud.test/app/activity?recoveries=1" });
      }
      if (req.url === "/v1/recover/r1" && req.method === "GET") {
        state.polls += 1;
        return send(200, { id: "r1", status: state.polls >= approveAfter ? "approved" : "pending" });
      }
      if (req.url === "/v1/recover/r1/receipts" && state.failed < failUploads) {
        state.failed += 1;
        return send(503, { error: "evidence is durable but its read projection is pending" });
      }
      if (req.url === "/v1/recover/r1/receipts") {
        const receipts = JSON.parse(body).receipts;
        state.uploaded.push(...receipts);
        return send(200, { ok: true, accepted: receipts.length, duplicates: 0, rejected: [], rejected_count: 0 });
      }
      if (req.url === "/v1/recover/r1/complete") { state.completed = true; return send(200, { id: "r1", status: "completed" }); }
      send(404, { error: "not found" });
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    resolve({ url: `http://127.0.0.1:${server.address().port}`, state, close: () => server.close() });
  }));
}

const io = (lines = []) => ({ log: (l) => lines.push(l), fetch, sleep: async () => {}, now: Date.now });

test("a refused key is replaced on reconnect, its queued receipts leave the queue, and recover delivers them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-hook-recover-"));
  scaffold(dir, ENFORCE);
  writeFileSync(join(dir, "policy.json"), JSON.stringify(policy));
  const old = loadOrCreateAttester({ file: join(dir, "attester.key") }).attester;
  await record(dir, ["/repo/a.ts", "/repo/b.ts", "/repo/c.ts"]);
  // The records were queued for the old connection and never delivered.
  const store = new SqliteReceiptStore(join(dir, "receipts.db"));
  const outbox = new SqliteCloudOutbox(join(dir, "receipts.db.cloud-outbox.db"));
  for (const receipt of store.list()) outbox.enqueue(receipt);
  assert.equal(outbox.status().pending, 3);
  outbox.close(); store.close();

  const cloud = await fakeCloud(dir, old.publicKeyPem, { approveAfter: 2 });
  try {
    const connection = await connectCloud(dir, cloud.url, bundle);
    assert.equal(cloud.state.enrolls, 2, "refused once, then enrolled with a fresh key and the same token");
    assert.equal(connection.rotatedFrom, old.kid);
    assert.equal(connection.setAside, 3);
    const current = loadOrCreateAttester({ file: join(dir, "attester.key") }).attester;
    assert.notEqual(current.kid, old.kid);
    assert.equal(readdirSync(join(dir, "retired-keys")).length, 1, "the old key is kept, not deleted");
    const after = new SqliteCloudOutbox(join(dir, "receipts.db.cloud-outbox.db"));
    assert.equal(after.status().pending, 0, "the queue no longer holds receipts the new connection cannot deliver");
    assert.equal(after.status().latestGap.reason, "rekeyed");
    after.close();

    // A record signed by the new key is not part of the recovery.
    await record(dir, ["/repo/d.ts"]);
    const lines = [];
    const result = await recoverEarlierReceipts(dir, connection, io(lines), { wait: true, waitMs: 60_000, pollMs: 1 });
    assert.deepEqual({ accepted: result.accepted, pending: result.pending, failed: result.failed }, { accepted: 3, pending: 0, failed: false });
    assert.equal(cloud.state.asked.source_kid, old.kid);
    assert.equal(cloud.state.asked.claimed_count, 3);
    assert.equal(cloud.state.uploaded.length, 3);
    assert.ok(cloud.state.uploaded.every((r) => r.payload.attester.kid === old.kid), "only the old key's receipts were sent");
    assert.equal(cloud.state.completed, true);
    assert.ok(lines.some((l) => l.includes("approve")), "the person is told where to approve");
  } finally {
    cloud.close();
  }
});

test("recover without waiting reports what awaits approval; a key still valid elsewhere is skipped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-hook-recover-"));
  scaffold(dir, ENFORCE);
  writeFileSync(join(dir, "policy.json"), JSON.stringify(policy));
  const old = loadOrCreateAttester({ file: join(dir, "attester.key") }).attester;
  await record(dir, ["/repo/a.ts", "/repo/b.ts"]);
  const cloud = await fakeCloud(dir, old.publicKeyPem, { approveAfter: 99 });
  try {
    const connection = await connectCloud(dir, cloud.url, bundle);
    const pending = await recoverEarlierReceipts(dir, connection, io(), { wait: false, waitMs: 0, pollMs: 1 });
    assert.equal(pending.pending, 2);
    assert.equal(cloud.state.uploaded.length, 0, "nothing is sent before approval");
  } finally {
    cloud.close();
  }
  const valid = await fakeCloud(dir, "-", { keyStatus: "valid" });
  try {
    const connection = { url: valid.url, credential: "sbm_new" };
    const skipped = await recoverEarlierReceipts(dir, connection, io(), { wait: true, waitMs: 0, pollMs: 1 });
    assert.equal(skipped.skipped, 2);
    assert.equal(valid.state.uploaded.length, 0);
  } finally {
    valid.close();
  }
});

test("a connection whose key is accepted is not rotated", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-hook-recover-"));
  scaffold(dir, ENFORCE);
  const before = loadOrCreateAttester({ file: join(dir, "attester.key") }).attester;
  const cloud = await fakeCloud(dir, "-");
  try {
    const connection = await connectCloud(dir, cloud.url, bundle);
    assert.equal(connection.rotatedFrom, undefined);
    assert.equal(loadOrCreateAttester({ file: join(dir, "attester.key") }).attester.kid, before.kid);
    assert.equal(existsSync(join(dir, "retired-keys")), false);
  } finally {
    cloud.close();
  }
});

test("recover resends a batch through temporary failures instead of stopping", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-hook-recover-"));
  scaffold(dir, ENFORCE);
  writeFileSync(join(dir, "policy.json"), JSON.stringify(policy));
  const old = loadOrCreateAttester({ file: join(dir, "attester.key") }).attester;
  await record(dir, ["/repo/a.ts", "/repo/b.ts"]);
  const cloud = await fakeCloud(dir, old.publicKeyPem, { failUploads: 7 });
  try {
    const connection = await connectCloud(dir, cloud.url, bundle);
    const lines = [];
    const result = await recoverEarlierReceipts(dir, connection, io(lines), { wait: true, waitMs: 60_000, pollMs: 1 });
    assert.equal(cloud.state.failed, 7);
    assert.deepEqual({ accepted: result.accepted, failed: result.failed }, { accepted: 2, failed: false });
    assert.ok(lines.some((l) => l.includes("trying the same batch again")));
  } finally {
    cloud.close();
  }
});
