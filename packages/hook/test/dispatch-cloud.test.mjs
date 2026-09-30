// The hook's dispatch boundary with the workspace as an approval source: an approval a person
// granted in the workspace is consumed at dispatch, nothing runs when it is refused or the
// workspace cannot be reached, and the offline path stays as it was.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHookRuntime, mapClaudeToolUse } from "../dist/index.js";
import { makeHome } from "./observation-helpers.mjs";

async function workspace(answer) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      calls.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body: body ? JSON.parse(body) : null });
      const a = answer(calls[calls.length - 1]);
      res.writeHead(a.status, { "content-type": "application/json" });
      res.end(JSON.stringify(a.body));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { calls, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }) };
}

const open = (dir) => createHookRuntime({ policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"), attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db") });
const shell = (command) => mapClaudeToolUse({ tool_name: "Bash", tool_input: { command } });
const setup = (url, extra = {}) => {
  const home = makeHome({ url });
  writeFileSync(join(home.dir, "dispatch.json"), JSON.stringify({ require_approval: ["shell.exec"], ...extra }));
  mkdirSync(join(home.dir, "approvals"), { recursive: true });
  writeFileSync(join(home.dir, "approvals", "grant.json"), JSON.stringify({ cloud_approval_id: "appr-workspace-1" }));
  return home;
};

test("a workspace approval is consumed at dispatch with an opaque target id and the machine credential", async () => {
  const ws = await workspace(() => ({ status: 200, body: { ok: true, approval_id: "appr-workspace-1", consumed_at: 1 } }));
  const home = setup(ws.url);
  const rt = open(home.dir);
  const d = await rt.evaluate(shell("git status"), { groupKey: "call-1" });
  rt.close();
  assert.equal(d.decision, "allow", d.reason);
  const consume = ws.calls.find((c) => c.url === "/v1/monitoring/approvals/consume");
  assert.ok(consume, "the workspace was asked");
  assert.equal(consume.authorization, "Bearer sbm_test-credential");
  assert.deepEqual(Object.keys(consume.body).sort(), ["action_type", "approval_id", "client_time", "policy_digest", "request_hash", "target_id"]);
  assert.match(consume.body.request_hash, /^[0-9a-f]{64}$/);
  assert.match(consume.body.policy_digest, /^[0-9a-f]{64}$/, "the policy digest is a SHA-256 the workspace accepts");
  assert.match(consume.body.target_id, /^sbt_[0-9a-f]{32}$/);
  assert.ok(!JSON.stringify(consume.body).includes("git"), "no command or path text leaves the machine");
  await ws.close();
});

test("a refused or unreachable workspace blocks the action before it runs", async () => {
  const refusing = await workspace(() => ({ status: 409, body: { ok: false, reason: "expired" } }));
  const home = setup(refusing.url);
  let rt = open(home.dir);
  let d = await rt.evaluate(shell("git status"), { groupKey: "call-1" });
  rt.close();
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /approval_rejected/);
  assert.match(d.reason, /expired/);
  await refusing.close();

  // The same machine with the workspace gone: enforce means deny.
  rt = open(home.dir);
  d = await rt.evaluate(shell("git status"), { groupKey: "call-2" });
  rt.close();
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /approval_unavailable/);
});

test('"cloud": false keeps approvals local: a workspace reference approves nothing and the workspace is never called', async () => {
  const ws = await workspace(() => ({ status: 200, body: { ok: true } }));
  const home = setup(ws.url, { cloud: false });
  const rt = open(home.dir);
  const d = await rt.evaluate(shell("git status"), { groupKey: "call-1" });
  rt.close();
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /approval_required/);
  assert.equal(ws.calls.length, 0);
  await ws.close();
});

test("a connection without observations:write is not a workspace source", async () => {
  const ws = await workspace(() => ({ status: 200, body: { ok: true } }));
  const home = makeHome({ url: ws.url, scopes: ["receipts:write"] });
  writeFileSync(join(home.dir, "dispatch.json"), JSON.stringify({ require_approval: ["shell.exec"] }));
  mkdirSync(join(home.dir, "approvals"), { recursive: true });
  writeFileSync(join(home.dir, "approvals", "grant.json"), JSON.stringify({ cloud_approval_id: "appr-workspace-1" }));
  const rt = open(home.dir);
  const d = await rt.evaluate(shell("git status"), { groupKey: "call-1" });
  rt.close();
  assert.equal(d.decision, "deny");
  assert.equal(ws.calls.filter((c) => c.url.startsWith("/v1/monitoring")).length, 0);
  await ws.close();
});
