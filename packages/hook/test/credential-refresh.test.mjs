import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verify } from "node:crypto";
import { loadOrCreateAttester } from "@scopebond/gateway/node";
import { refreshIfDue, refreshProof } from "../dist/credential-refresh.js";

const DAY = 86_400_000;
function setup(expiresInDays) {
  const dir = mkdtempSync(join(tmpdir(), "sb-refresh-"));
  const { attester } = loadOrCreateAttester({ file: join(dir, "attester.key") });
  const connection = {
    url: "https://cloud.example.com", credential: "sbm_us_old", credential_id: "cred-1", organization_id: "org-1",
    environment_id: "env-1", gateway_id: "gw-1", attester_kid: attester.kid, scopes: ["receipt:ingest"],
    expires_at: new Date(Date.now() + expiresInDays * DAY).toISOString(),
  };
  writeFileSync(join(dir, "cloud.json"), JSON.stringify(connection));
  return { dir, connection, attester };
}

test("a credential far from expiry is left alone and nothing is sent", async () => {
  const { dir, connection } = setup(80);
  let called = false;
  const outcome = await refreshIfDue(dir, connection, { fetchImpl: async () => { called = true; return new Response("{}"); } });
  assert.equal(outcome, "not_due");
  assert.equal(called, false);
});

test("in its last 30 days the credential is renewed with a proof only this computer's key can make", async () => {
  const { dir, connection, attester } = setup(10);
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, auth: init.headers.authorization, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ refreshed: true, id: "cred-2", credential: "sbm_us_new", expires_at: "2027-01-01T00:00:00.000Z" }));
  };
  assert.equal(await refreshIfDue(dir, connection, { fetchImpl }), "renewed");
  assert.equal(seen.url, "https://cloud.example.com/v1/credential/refresh");
  assert.equal(seen.auth, "Bearer sbm_us_old");
  assert.ok(verify(null, Buffer.from(refreshProof("cred-1", "gw-1")), attester.publicKeyPem, Buffer.from(seen.body.signature, "base64url")));
  const saved = JSON.parse(readFileSync(join(dir, "cloud.json"), "utf8"));
  assert.equal(saved.credential, "sbm_us_new");
  assert.equal(saved.credential_id, "cred-2");
  assert.equal(saved.expires_at, "2027-01-01T00:00:00.000Z");
  assert.equal(saved.gateway_id, "gw-1", "everything else in the connection is kept");
});

test("a refusal or an outage leaves the saved connection unchanged", async () => {
  const { dir, connection } = setup(5);
  const before = readFileSync(join(dir, "cloud.json"), "utf8");
  assert.equal(await refreshIfDue(dir, connection, { fetchImpl: async () => new Response("{}", { status: 401 }) }), "refused");
  assert.equal(await refreshIfDue(dir, connection, { fetchImpl: async () => { throw new Error("offline"); } }), "unavailable");
  assert.equal(readFileSync(join(dir, "cloud.json"), "utf8"), before);
});
