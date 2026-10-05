import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateAttester } from "@scopebond/gateway/node";
import { scaffold, createHookRuntime, mapClaudeToolUse, STATUS_SCHEMA } from "@scopebond/hook";
import {
  runCycle, startService, callAgent, readEndpoint, repairHookEntries, missingHookEntries,
  windowsRunCommand, macLaunchAgent, linuxUserUnit, AGENT_FILE,
} from "../dist/index.js";

function workspace() {
  const received = [];
  let ingestStatus = 200;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      if (req.url === "/v1/ingest") {
        if (ingestStatus === 200) received.push(...(JSON.parse(raw).receipts ?? []));
        res.writeHead(ingestStatus, { "content-type": "application/json" });
        res.end(JSON.stringify(ingestStatus === 200 ? { ok: true } : { error: "down", code: "unavailable" }));
        return;
      }
      if (req.url === "/v1/policy") { res.writeHead(204); res.end(); return; }
      if (req.url === "/v1/policy/ack") { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); return; }
      res.writeHead(404); res.end("{}");
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, received, setIngest: (s) => { ingestStatus = s; }, close: () => server.close(),
  })));
}

async function computerWithQueue(url, n) {
  const dir = mkdtempSync(join(tmpdir(), "sb-agent-"));
  scaffold(dir);
  const { attester } = loadOrCreateAttester({ file: join(dir, "attester.key") });
  const connection = {
    url, credential: "sbm_us_test", credential_id: "cred-1", organization_id: "org-1", environment_id: "env-1",
    gateway_id: "gw-1", attester_kid: attester.kid, scopes: ["receipt:ingest", "gateway:heartbeat"],
    expires_at: new Date(Date.now() + 80 * 86_400_000).toISOString(),
  };
  writeFileSync(join(dir, "cloud.json"), JSON.stringify(connection));
  // The hook records n actions while the workspace is down, so they wait in the queue.
  const rt = createHookRuntime({
    policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"), attesterPath: join(dir, "attester.key"),
    dbPath: join(dir, "receipts.db"), cloud: { connection, fetch: async () => new Response("{}", { status: 503 }) },
  });
  try {
    for (let i = 0; i < n; i++) await rt.evaluate(mapClaudeToolUse({ tool_name: "Read", tool_input: { file_path: `/repo/a${i}.ts` }, cwd: "/repo" }));
    await rt.flush();
  } finally { rt.exporter?.stop(); rt.close(); }
  return dir;
}

test("a cycle delivers what the hook queued and runs the rules check", async () => {
  const ws = await workspace();
  try {
    const dir = await computerWithQueue(ws.url, 3);
    const result = await runCycle({ dir });
    assert.equal(result.connected, true);
    assert.equal(result.delivered, 3);
    assert.equal(result.pending, 0);
    assert.equal(result.deliveryError, null);
    assert.equal(result.rules, "own_rules");
    assert.equal(ws.received.length, 3);
  } finally { ws.close(); }
});

test("the running agent answers on its token-protected local channel, and only one runs per computer", async () => {
  const ws = await workspace();
  const dir = await computerWithQueue(ws.url, 1);
  const logs = [];
  const service = await startService({ dir, intervalMs: 60 * 60_000, log: (l) => logs.push(l) });
  try {
    const endpoint = readEndpoint(dir);
    assert.ok(endpoint && endpoint.port > 0 && endpoint.token.length > 20);
    const status = await callAgent(dir, "GET", "/status");
    assert.equal(status.schema, STATUS_SCHEMA);
    assert.equal(status.delivery.pending, 0, "the first cycle delivered the waiting record");
    assert.ok(status.agent.last_cycle);
    // Without the token, nothing.
    const anonymous = await fetch(`http://127.0.0.1:${endpoint.port}/status`);
    assert.equal(anonymous.status, 401);
    // A second agent for the same computer refuses to start.
    await assert.rejects(startService({ dir, intervalMs: 60 * 60_000, log: () => {} }), /already running/);
    // Flush on request.
    ws.setIngest(200);
    const flushed = await callAgent(dir, "POST", "/flush", {});
    assert.equal(flushed.cycle.connected, true);
  } finally {
    await service.stop();
    ws.close();
  }
  assert.equal(existsSync(join(dir, AGENT_FILE)), false, "a stopped agent removes its endpoint file");
});

test("repair puts the hook back into agent settings that lost it, and touches nothing else", () => {
  const home = mkdtempSync(join(tmpdir(), "sb-agent-home-"));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home; process.env.USERPROFILE = home;
  try {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ model: "opus", hooks: { PreToolUse: [] } }));
    assert.deepEqual(missingHookEntries(["claude"]), ["claude"]);
    const repaired = repairHookEntries(["claude"]);
    assert.equal(repaired.length, 1);
    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    assert.equal(settings.model, "opus");
    assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /@scopebond\/hook@\S+ claude$/);
    assert.deepEqual(missingHookEntries(["claude"]), []);
    assert.deepEqual(repairHookEntries(["claude"]), [], "nothing to repair the second time");
  } finally {
    process.env.HOME = saved.HOME; process.env.USERPROFILE = saved.USERPROFILE;
  }
});

test("autostart entries pin this Node and this agent, quoted for each platform", () => {
  assert.equal(windowsRunCommand("C:\\Program Files\\nodejs\\node.exe", "C:\\Users\\a b\\cli.js"), `"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\a b\\cli.js" run`);
  const plist = macLaunchAgent("/usr/local/bin/node", "/opt/a&b/cli.js", "/var/tmp/scopebond-agent.log");
  assert.match(plist, /<string>com\.scopebond\.agent<\/string>/);
  assert.match(plist, /<string>\/opt\/a&amp;b\/cli\.js<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  const unit = linuxUserUnit("/usr/bin/node", "/opt/scopebond/cli.js");
  assert.match(unit, /^ExecStart="\/usr\/bin\/node" "\/opt\/scopebond\/cli\.js" run$/m);
  assert.match(unit, /WantedBy=default\.target/);
});
