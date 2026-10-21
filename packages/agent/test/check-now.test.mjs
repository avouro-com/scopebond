// "Check now" checks the rules and packs again (a whole cycle) and never installs an update: it used to run upkeep, which
// did not re-check the rules and could install an update.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateAttester } from "@scopebond/gateway/node";
import { scaffold } from "@scopebond/hook";
import { callAgent } from "../dist/index.js";
import { serviceFor } from "./tray-helpers.mjs";

test("Check now runs the rules check and asks nothing about updates", async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    const path = new URL(String(url)).pathname;
    seen.push(path);
    if (path === "/v1/client-version") return new Response(JSON.stringify({ policy: "recommended", agent: "99.0.0", hook: "99.0.0" }), { status: 200, headers: { "content-type": "application/json" } });
    if (path === "/v1/policy") return new Response(null, { status: 204 });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  const dir = mkdtempSync(join(tmpdir(), "sb-check-now-"));
  scaffold(dir);
  const { attester } = loadOrCreateAttester({ file: join(dir, "attester.key") });
  writeFileSync(join(dir, "cloud.json"), JSON.stringify({
    url: "http://127.0.0.1:9", credential: "sbm_us_test", credential_id: "cred-1", organization_id: "org-1", environment_id: "env-1",
    gateway_id: "gw-1", attester_kid: attester.kid, scopes: ["receipt:ingest", "gateway:heartbeat"], expires_at: new Date(Date.now() + 80 * 86_400_000).toISOString(),
  }));
  const service = await serviceFor(dir, { fetchImpl });
  try {
    seen.length = 0;
    const answer = await callAgent(dir, "POST", "/check", {}, 30_000);
    assert.ok(seen.includes("/v1/policy"), `the rules were checked: ${seen.join(", ")}`);
    assert.ok(!seen.includes("/v1/client-version"), "no update check, so no update can install");
    assert.equal(typeof answer.text, "string");
  } finally { await service.stop(); }
});
