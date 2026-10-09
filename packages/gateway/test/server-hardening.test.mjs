// The self-hosted gateway server: an allowed http.call reaches only the host its policy checked; request bodies are bounded;
// key and evidence files are readable by their owner alone; anchor proofs do not reveal whether an action happened and do
// not re-hash the log for every caller. No network: fetch is a recorder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createGateway, createHttpExecutor, StaticPrincipalKeyRegistry } from "../dist/index.js";
import { loadOrCreateAttester, openReceiptStore } from "../dist/node.js";
import { createSigner } from "@scopebond/sdk";

// An action the executor refuses as unsendable is thrown as ExecutorInputError (HTTP 400) before policy or dispatch.
async function attempt(gw, signed) {
  try { return await gw.handleAction(signed); }
  catch (error) { if (error?.name === "ExecutorInputError") return { allowed: false, reason: error.message }; throw error; }
}

function setup(policy) {
  const agent = createSigner();
  const keys = new StaticPrincipalKeyRegistry([{ kid: agent.kid, publicKeyPem: agent.publicKeyPem, purposes: ["agent"], status: "active" }]);
  const calls = [];
  const fakeFetch = async (url, init) => { calls.push({ url: String(url), host: new URL(String(url)).host, method: init.method }); return { status: 200, text: async () => "ok" }; };
  const gw = createGateway({ policy, authentication: { keys }, executor: createHttpExecutor({ fetch: fakeFetch }) });
  return { agent, gw, calls };
}

const allowOnly = { vocabulary_version: "1.0", policy_id: "egress", version: 1, clauses: [
  { id: "egress", type: "endpoint_allowlist", mode: "enforce", hosts: ["api.ok.example"], methods: ["GET", "POST"] },
] };

test("an allowed http.call never leaves the allowlisted host, whatever its path", async () => {
  const { agent, gw, calls } = setup(allowOnly);
  for (const path of ["@evil.example/steal", ".evil.example/steal", ":443@evil.example/x", "//evil.example/x"]) {
    const r = await attempt(gw, agent.sign({ action_type: "http.call", params: { host: "api.ok.example", path, method: "POST" } }));
    assert.ok(!r.allowed || calls.every((c) => c.host === "api.ok.example"), `${path}: ${JSON.stringify(r.reason)}`);
  }
  assert.ok(calls.every((c) => c.host === "api.ok.example"), JSON.stringify(calls));
  const ok = await gw.handleAction(agent.sign({ action_type: "http.call", params: { host: "API.ok.example.", path: "/v1/items", method: "GET" } }));
  assert.equal(ok.allowed, true, "case and a trailing dot name the same host");
  assert.equal(calls.at(-1)?.url, "https://api.ok.example/v1/items");
});

test("endpoint_denylist is not bypassed by case, a trailing dot or userinfo", async () => {
  const policy = { vocabulary_version: "1.0", policy_id: "deny", version: 1, clauses: [
    { id: "no-meta", type: "endpoint_denylist", mode: "enforce", hosts: ["metadata.internal"] },
  ] };
  const { agent, gw, calls } = setup(policy);
  for (const host of ["metadata.internal", "METADATA.internal", "metadata.internal.", "x@metadata.internal"]) {
    const r = await attempt(gw, agent.sign({ action_type: "http.call", params: { host, path: "/", method: "GET" } }));
    assert.equal(r.allowed, false, host);
  }
  assert.equal(calls.length, 0);
});

test("request bodies are bounded before they are read, and deep JSON is refused", async () => {
  const gw = createGateway({ policy: allowOnly, authentication: { mode: "insecure-development" } });
  const big = await gw.app.request("/v1/evaluate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ intent: { action_type: "x", params: { pad: "a".repeat(2 * 1024 * 1024) } } }) });
  assert.equal(big.status, 413);
  let deep = {}; for (let i = 0; i < 1000; i++) deep = { d: deep };
  const nested = await gw.app.request("/v1/evaluate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ intent: { action_type: "http.call", params: deep } }) });
  assert.equal(nested.status, 400);
});

test("key, database and log files are readable by their owner alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-perms-"));
  loadOrCreateAttester({ file: join(dir, "attester.key") });
  openReceiptStore({ db: join(dir, "scopebond.db") });
  for (const file of ["attester.key", "scopebond.db"]) {
    const path = join(dir, file);
    if (process.platform === "win32") {
      const acl = execFileSync("icacls", [path], { encoding: "utf8" });
      assert.doesNotMatch(acl, /BUILTIN\\Users|Authenticated Users|Everyone|\(I\)/, `${file}: ${acl}`);
    } else {
      assert.equal(statSync(path).mode & 0o077, 0, `${file} is readable by others`);
    }
  }
});

test("an anchor proof by intent hash needs the control token; by leaf hash it is public", async () => {
  const policy = { vocabulary_version: "1.0", assets: { USDC: { decimals: 2 } }, policy_id: "p", version: 1, clauses: [
    { id: "cap", type: "spend_limit", mode: "enforce", asset: "USDC", max_per_action: 1000000 },
  ] };
  const gw = createGateway({ policy, authentication: { mode: "insecure-development" }, control: { bearerToken: "t".repeat(32) } });
  const done = await gw.handleAction({ intent: { action_type: "payout.create", asset: "USDC", amount: 1 } });
  await gw.anchor();
  const byIntent = await gw.app.request(`/v1/anchors/proof?intent_hash=${done.receipt.payload.intent_hash}`);
  assert.equal(byIntent.status, 401);
  const withToken = await gw.app.request(`/v1/anchors/proof?intent_hash=${done.receipt.payload.intent_hash}`, { headers: { authorization: `Bearer ${"t".repeat(32)}` } });
  assert.equal(withToken.status, 200);
  const { leaf_hash } = await withToken.json();
  const byLeaf = await gw.app.request(`/v1/anchors/proof?leaf=${leaf_hash}`);
  assert.equal(byLeaf.status, 200);
});
