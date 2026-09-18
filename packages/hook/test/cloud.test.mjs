import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateAttester } from "@scopebond/gateway/node";
import { scaffold, connectCloud, loadConnection, connectionPath, createHookRuntime } from "../dist/index.js";
import { mapClaudeToolUse } from "../dist/index.js";

// A minimal in-process Cloud: /v1/enroll issues a scoped credential bound to the
// enrolling attester's kid; /v1/ingest records the receipts it receives. This
// exercises the connector's real HTTP client path (enroll + durable export) over
// localhost, without the full Cloud Worker.
function startFakeCloud(attesterKid) {
  const ingested = [];
  let authSeen = null;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      if (req.url === "/v1/enroll" && req.method === "POST") {
        const parsed = JSON.parse(body);
        assert.ok(typeof parsed.enrollment_token === "string", "enroll: token");
        assert.ok(typeof parsed.public_key_pem === "string", "enroll: public key");
        assert.ok(typeof parsed.signature === "string", "enroll: signature");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          credential_id: "cred-1", credential: "sbm_test_credential",
          organization_id: "org-1", environment_id: "env-1", gateway_id: "gw-1",
          attester_kid: attesterKid, scopes: ["ingest"], expires_at: "2027-01-01T00:00:00.000Z",
        }));
        return;
      }
      if (req.url === "/v1/ingest" && req.method === "POST") {
        authSeen = req.headers.authorization ?? null;
        const parsed = JSON.parse(body);
        for (const r of parsed.receipts ?? []) ingested.push(r);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, ingested, auth: () => authSeen, close: () => server.close() });
    });
  });
}

const canonicalProof = JSON.stringify({
  challenge: "c1", enrollment_id: "e1", type: "scopebond:gateway-enrollment", version: 1,
});
const bundle = { enrollment_token: "sbe_test123", proof_canonical: canonicalProof, expires_at: "2027-01-01T00:00:00.000Z" };

const policy = {
  vocabulary_version: "1.0", policy_id: "cloud-test", version: 1,
  clauses: [
    { id: "branch", type: "action_allowlist", mode: "enforce", action_types: ["git.push"], param_bounds: { ref: { pattern: "^(?!(?:main|master)$).+" } } },
    { id: "files", type: "action_allowlist", mode: "enforce", action_types: ["file.write", "file.read"] },
  ],
};

test("connect persists a scoped credential and auto-exports receipts to Cloud", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-hook-cloud-"));
  scaffold(dir);
  writeFileSync(join(dir, "policy.json"), JSON.stringify(policy));
  const { attester } = loadOrCreateAttester({ file: join(dir, "attester.key") });
  const cloud = await startFakeCloud(attester.kid);
  try {
    // connect: enroll and persist the connection.
    const connection = await connectCloud(dir, cloud.url, bundle);
    assert.equal(connection.credential, "sbm_test_credential");
    assert.equal(connection.organization_id, "org-1");
    assert.ok(existsSync(connectionPath(dir)), "cloud.json written");
    assert.match(readFileSync(connectionPath(dir), "utf8"), /sbm_test_credential/);
    assert.deepEqual(loadConnection(dir), connection);

    // evaluate two actions through a connected runtime, then flush.
    const runtime = createHookRuntime({
      policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"),
      attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db"),
      cloud: { connection },
    });
    const allow = await runtime.evaluate(mapClaudeToolUse({ tool_name: "Read", tool_input: { file_path: "/repo/src/app.ts" }, cwd: "/repo" }));
    assert.equal(allow.decision, "allow");
    const deny = await runtime.evaluate(mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "git push origin main" } }));
    assert.equal(deny.decision, "deny");
    await runtime.exporter.flush();

    // Both receipts reached Cloud, authenticated with the scoped credential.
    assert.equal(cloud.auth(), "Bearer sbm_test_credential");
    assert.ok(cloud.ingested.length >= 2, `expected >= 2 ingested receipts, got ${cloud.ingested.length}`);
    const results = cloud.ingested.map((r) => r.payload?.realtime_result);
    assert.ok(results.includes("deny"), "the denied action was exported");
  } finally {
    cloud.close();
  }
});

test("receipts survive when Cloud is unreachable and export is best-effort", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-hook-cloud-off-"));
  scaffold(dir);
  writeFileSync(join(dir, "policy.json"), JSON.stringify(policy));
  // A connection pointing at a closed port: enqueue must not throw and the decision stands.
  const connection = {
    url: "http://127.0.0.1:1", credential: "sbm_x", credential_id: "c", organization_id: "o",
    environment_id: "e", gateway_id: "g", attester_kid: "k", scopes: [], expires_at: "2027-01-01T00:00:00.000Z",
  };
  const runtime = createHookRuntime({
    policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"),
    attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db"),
    cloud: { connection, flushTimeoutMs: 200 },
  });
  const decision = await runtime.evaluate(mapClaudeToolUse({ tool_name: "Read", tool_input: { file_path: "/repo/x.ts" }, cwd: "/repo" }));
  assert.equal(decision.decision, "allow");
  await runtime.flush(); // bounded; must resolve despite the unreachable Cloud
  assert.ok(runtime.exporter.pending() >= 1, "the undelivered receipt is retained in the durable outbox");
});
