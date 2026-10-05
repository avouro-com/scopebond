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
  windowsRunCommand, windowsLauncher, posixLauncher, launcherPath, macLaunchAgent, linuxUserUnit, AGENT_FILE,
  compareVersions, commandHookVersion, maintainHookEntries, fetchClientVersion, localChecks, runSelfCheck, selfCheckProof,
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
  const service = await startService({ dir, intervalMs: 60 * 60_000, log: (l) => logs.push(l), maintenance: false });
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
    await assert.rejects(startService({ dir, intervalMs: 60 * 60_000, log: () => {}, maintenance: false }), /already running/);
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

test("autostart starts a launcher that finds Node and the agent each time, with no window on Windows", () => {
  assert.match(launcherPath(join("x", "sb"), "win32"), /agent-launch\.cmd$/);
  assert.match(launcherPath(join("x", "sb"), "linux"), /agent-launch\.sh$/);
  assert.equal(windowsRunCommand("C:\\Users\\a b\\.scopebond\\agent-launch.cmd"), `conhost.exe --headless cmd.exe /d /c "C:\\Users\\a b\\.scopebond\\agent-launch.cmd"`);
  const cmd = windowsLauncher("C:\\Program Files\\nodejs\\node.exe", "C:\\npm\\cli.js", "C:\\sb\\agent.log");
  assert.ok(cmd.includes(`set "NODE=C:\\Program Files\\nodejs\\node.exe"`));
  assert.match(cmd, /where node/, "falls back to the Node on PATH");
  assert.match(cmd, /npm\.cmd root -g/, "falls back to the globally installed agent");
  assert.match(cmd, /\r\n/, "Windows line endings");
  const sh = posixLauncher("/opt/node's/bin/node", "/opt/scopebond/cli.js");
  assert.match(sh, /^#!\/bin\/sh/);
  assert.ok(sh.includes(`NODE='/opt/node'\\''s/bin/node'`), "single quotes escaped");
  assert.match(sh, /nvm\.sh/);
  assert.ok(sh.includes(`exec "$NODE" "$CLI" run`));
  const plist = macLaunchAgent("/opt/a&b/agent-launch.sh", "/var/tmp/scopebond-agent.log");
  assert.match(plist, /<string>com\.scopebond\.agent<\/string>/);
  assert.ok(plist.includes("<string>/bin/sh</string><string>/opt/a&amp;b/agent-launch.sh</string>"));
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  const unit = linuxUserUnit("/opt/scopebond/agent-launch.sh");
  assert.match(unit, /^ExecStart=\/bin\/sh "\/opt\/scopebond\/agent-launch\.sh"$/m);
  assert.match(unit, /WantedBy=default\.target/);
});

test("versions compare numerically and hook commands name the version they run", () => {
  assert.ok(compareVersions("0.10.0", "0.9.9") > 0);
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
  assert.ok(compareVersions("0.1.0", "0.2.0") < 0);
  assert.equal(commandHookVersion("npx -y @scopebond/hook@0.15.0 claude"), "0.15.0");
  assert.equal(commandHookVersion(`"C:\\n\\node.exe" "C:\\sb\\runtime\\0.14.0\\cli.js" claude`), "0.14.0");
  assert.equal(commandHookVersion("my-own-hook claude"), null);
});

test("hook upkeep moves older Scopebond entries forward, repairs broken ones, holds when asked, and leaves other hooks alone", () => {
  const home = mkdtempSync(join(tmpdir(), "sb-agent-home-"));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home; process.env.USERPROFILE = home;
  try {
    mkdirSync(join(home, ".claude"), { recursive: true });
    const file = join(home, ".claude", "settings.json");
    const write = (command) => writeFileSync(file, JSON.stringify({ model: "opus", hooks: { PreToolUse: [
      { matcher: "*", hooks: [{ type: "command", command }] },
      { matcher: "Bash", hooks: [{ type: "command", command: "my-own-hook --strict" }] },
    ] } }));
    const commands = () => JSON.parse(readFileSync(file, "utf8")).hooks.PreToolUse.flatMap((m) => m.hooks.map((h) => h.command));
    write("npx -y @scopebond/hook@0.14.0 claude");
    assert.deepEqual(maintainHookEntries(["claude"], "0.15.0", false), [], "held: an older working entry stays");
    const moved = maintainHookEntries(["claude"], "0.15.0");
    assert.equal(moved.length, 1);
    assert.match(moved[0].reason, /moved to hook 0\.15\.0/);
    assert.ok(commands().includes("npx -y @scopebond/hook@0.15.0 claude"));
    assert.ok(commands().includes("my-own-hook --strict"), "another tool's hook is untouched");
    assert.equal(JSON.parse(readFileSync(file, "utf8")).model, "opus");
    assert.deepEqual(maintainHookEntries(["claude"], "0.15.0"), [], "nothing to do the second time");
    write(`"${join(home, "gone", "node.exe")}" "${join(home, "gone", "runtime", "0.15.0", "cli.js")}" claude`);
    const repaired = maintainHookEntries(["claude"], "0.15.0", false);
    assert.equal(repaired.length, 1, "a broken entry is repaired even while held");
    assert.match(repaired[0].reason, /could not start/);
  } finally {
    process.env.HOME = saved.HOME; process.env.USERPROFILE = saved.USERPROFILE;
  }
});

test("the agent reads the versions its workspace names, and treats anything odd as no answer", async () => {
  const answers = [
    { status: 200, body: { policy: "recommended", hook: "0.15.0", agent: "0.2.0" } },
    { status: 200, body: { policy: "hold", hook: null, agent: null } },
    { status: 200, body: { policy: "recommended", hook: "latest; rm -rf", agent: "0.2.0" } },
    { status: 401, body: { error: "revoked" } },
  ];
  const seen = [];
  const fake = async (url, init) => {
    seen.push({ url, auth: init.headers.authorization });
    const next = answers.shift();
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { "content-type": "application/json" } });
  };
  const connection = { url: "https://workspace.example", credential: "sbm_test" };
  assert.deepEqual(await fetchClientVersion(connection, fake), { policy: "recommended", hook: "0.15.0", agent: "0.2.0" });
  assert.deepEqual(await fetchClientVersion(connection, fake), { policy: "hold", hook: null, agent: null });
  assert.deepEqual(await fetchClientVersion(connection, fake), { policy: "recommended", hook: null, agent: "0.2.0" }, "a malformed version is dropped");
  assert.equal(await fetchClientVersion(connection, fake), null);
  assert.equal(seen[0].url, "https://workspace.example/v1/client-version");
  assert.equal(seen[0].auth, "Bearer sbm_test");
});

test("the self-check names what is broken locally and sends a signed proof to the workspace", async () => {
  const home = mkdtempSync(join(tmpdir(), "sb-agent-home-"));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home; process.env.USERPROFILE = home;
  try {
    const dir = await computerWithQueue("https://workspace.example", 0);
    const connection = { url: "https://workspace.example", credential: "sbm_test", credential_id: "cred_1", gateway_id: "gw_1", expires_at: new Date(Date.now() + 2 * 86400_000).toISOString() };
    const checks = localChecks(dir, connection, ["claude"]);
    const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
    assert.equal(byId.hook_entry.ok, false, "no agent setting holds the hook in this empty home");
    assert.equal(byId.queue.ok, true);
    assert.equal(byId.credential.ok, false, "expiring in two days without renewal");
    let posted = null;
    const fake = async (url, init) => {
      posted = { url, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ ok: false, signature_verified: true, failed: ["hook_entry", "credential"] }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const result = await runSelfCheck(dir, connection, ["claude"], "0.2.0", { fetchImpl: fake });
    assert.equal(posted.url, "https://workspace.example/v1/self-check");
    assert.equal(posted.body.agent_version, "0.2.0");
    assert.match(posted.body.day, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(typeof posted.body.signature, "string");
    assert.ok(selfCheckProof("cred_1", "gw_1", posted.body.day).includes("scopebond:self-check"));
    assert.equal(result.signature_verified, true);
    assert.deepEqual(result.failed, ["hook_entry", "credential"]);
    const offline = await runSelfCheck(dir, connection, ["claude"], "0.2.0", { fetchImpl: async () => { throw new Error("offline"); } });
    assert.equal(offline.ok, false);
    assert.match(offline.failed[0], /^workspace_unreachable/);
  } finally {
    process.env.HOME = saved.HOME; process.env.USERPROFILE = saved.USERPROFILE;
  }
});
