import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateAttester } from "@scopebond/gateway/node";
import { createMcpProxy, connectCloud, loadMcpConnection, connectionFileFor, openExporter, starterMcpPolicy } from "../dist/index.js";

function startFakeCloud(attesterKid) {
  const ingested = [];
  let auth = null;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      if (req.url === "/v1/enroll" && req.method === "POST") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          credential_id: "cred-1", credential: "sbm_mcp_credential",
          organization_id: "org-1", environment_id: "env-1", gateway_id: "gw-1",
          attester_kid: attesterKid, scopes: ["ingest"], expires_at: "2027-01-01T00:00:00.000Z",
        }));
        return;
      }
      if (req.url === "/v1/ingest" && req.method === "POST") {
        auth = req.headers.authorization ?? null;
        for (const r of (JSON.parse(body).receipts ?? [])) ingested.push(r);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404); res.end("{}");
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    resolve({ url: `http://127.0.0.1:${server.address().port}`, ingested, auth: () => auth, close: () => server.close() });
  }));
}

const bundle = {
  enrollment_token: "sbe_test123",
  proof_canonical: JSON.stringify({ challenge: "c1", enrollment_id: "e1", type: "scopebond:gateway-enrollment", version: 1 }),
  expires_at: "2027-01-01T00:00:00.000Z",
};

test("connect enrolls the proxy key and openExporter mirrors PEP receipts to Cloud", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-mcp-cloud-"));
  const keyPath = join(dir, "scopebond-agent.key");
  const { attester } = loadOrCreateAttester({ file: keyPath });
  const cloud = await startFakeCloud(attester.kid);
  try {
    const connection = await connectCloud(keyPath, cloud.url, bundle);
    assert.equal(connection.credential, "sbm_mcp_credential");
    assert.ok(existsSync(connectionFileFor(keyPath)));
    assert.match(readFileSync(connectionFileFor(keyPath), "utf8"), /sbm_mcp_credential/);
    assert.deepEqual(loadMcpConnection(keyPath), connection);

    const exporter = openExporter(keyPath, connection);
    // A proxy whose receipts are enqueued to the exporter, against an injected upstream.
    let forwarded = false;
    const proxy = createMcpProxy({
      policy: starterMcpPolicy("filesystem"),
      principal: { subject: "client:test", issuer: "scopebond:mcp-proxy" },
      server: "filesystem",
      attesterKeyPem: readFileSync(keyPath, "utf8"),
      upstream: { call: async () => { forwarded = true; return { jsonrpc: "2.0", id: 1, result: { ok: true } }; } },
      onReceipt: (r) => exporter.enqueue(r),
    });
    // Allowed tool call: forwarded + a PEP receipt emitted and exported.
    const allowed = await proxy.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_file", arguments: { path: "x" } } });
    assert.ok(!allowed.error, "allowed call has no error");
    assert.ok(forwarded, "allowed call forwarded upstream");
    // Denied tool call: not forwarded, still a receipt.
    forwarded = false;
    const denied = await proxy.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "delete_file", arguments: { path: "x" } } });
    assert.ok(denied.error, "denied call returns a JSON-RPC error");
    assert.ok(!forwarded, "denied call never forwarded");

    await exporter.flush();
    assert.equal(cloud.auth(), "Bearer sbm_mcp_credential");
    assert.ok(cloud.ingested.length >= 2, `expected >= 2 ingested, got ${cloud.ingested.length}`);
    const classes = cloud.ingested.map((r) => r.payload?.evidence_class);
    assert.ok(classes.every((c) => c === "pep_authorized"), "the proxy emits pep_authorized receipts");
    exporter.stop();
  } finally {
    cloud.close();
  }
});
