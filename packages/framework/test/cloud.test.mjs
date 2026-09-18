import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { attesterFromPrivateKeyPem } from "@scopebond/gateway";
import { createToolGuard, generateAgentKey, connectCloud } from "../dist/index.js";

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
          credential_id: "cred-1", credential: "sbm_fw_credential",
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

const policy = {
  vocabulary_version: "1.0", policy_id: "fw-cloud", version: 1,
  clauses: [{ id: "tools", type: "action_allowlist", mode: "enforce", action_types: ["tool.search"], description: "search only" }],
};

test("a connected guard exports signed-intent receipts to Cloud", async () => {
  const agentKeyPem = generateAgentKey();
  const attesterKeyPem = generateAgentKey();
  const attesterKid = attesterFromPrivateKeyPem(attesterKeyPem).kid;
  const cloud = await startFakeCloud(attesterKid);
  try {
    const connection = await connectCloud(attesterKeyPem, cloud.url, bundle);
    assert.equal(connection.credential, "sbm_fw_credential");

    const guard = createToolGuard({ policy, agentKeyPem, attesterKeyPem, cloud: { connection } });
    const allow = await guard.check("search", { q: "x" });
    assert.equal(allow.allowed, true);
    const deny = await guard.check("deleteAll", {});
    assert.equal(deny.allowed, false);
    await guard.flush();
    guard.stop();

    assert.equal(cloud.auth(), "Bearer sbm_fw_credential");
    assert.ok(cloud.ingested.length >= 2, `expected >= 2 ingested, got ${cloud.ingested.length}`);
    const classes = cloud.ingested.map((r) => r.payload?.evidence_class);
    assert.ok(classes.every((c) => c === "signed_intent"), "the guard emits signed-intent receipts");
  } finally {
    cloud.close();
  }
});
