// The agent's delivery loop never stalls for good on a request that does not answer, and its own delivery error is not
// replaced by a hook call's cut-off. HOME/USERPROFILE/APPDATA/SCOPEBOND_HOME point at temp dirs before any Scopebond module loads, so the real
// ~/.claude and ~/.scopebond are never read or written, and no real installed agent is called (each test's agent.json lives in
// its own temp dir).
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "sb-b2c-home-"));
process.env.HOME = HOME; process.env.USERPROFILE = HOME;
process.env.APPDATA = join(HOME, "AppData", "Roaming"); process.env.LOCALAPPDATA = join(HOME, "AppData", "Local");
mkdirSync(process.env.APPDATA, { recursive: true }); mkdirSync(process.env.LOCALAPPDATA, { recursive: true });
process.env.SCOPEBOND_HOME = join(HOME, ".scopebond");
process.env.SCOPEBOND_AGENT_TRAY = "off";

const { loadOrCreateAttester } = await import("@scopebond/gateway/node");
const { createSigner } = await import("@scopebond/sdk");
const { scaffold, createHookRuntime, mapClaudeToolUse, syncPolicy, policyBuilds, hookVersion, readDeliveryState } = await import("@scopebond/hook");
const { runCycle, startService, callAgent, localChecks, repairHookEntries, computerStatus } = await import("../dist/index.js");
const { healthOf } = await import("../dist/health.js");
// The isolated home has Claude Code with the Scopebond hook entry, so status reads "governing" as on a real laptop.
mkdirSync(join(HOME, ".claude"), { recursive: true });
writeFileSync(join(HOME, ".claude", "settings.json"), "{}");
repairHookEntries(["claude"]);

const out = () => {};

/** A workspace that answers everything except ingest/summaries, which `hang` decides; records every rules-check header. */
function workspace() {
  const policyCalls = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      if (req.url === "/v1/ingest") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true })); return; }
      if (req.url === "/v1/policy") { policyCalls.push({ at: Date.now(), lastError: req.headers["x-scopebond-last-error"] ?? null, pending: req.headers["x-scopebond-pending"] ?? null }); res.writeHead(204); res.end(); return; }
      if (req.url === "/v1/policy/ack") { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); return; }
      res.writeHead(404); res.end("{}");
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, policyCalls, close: () => server.close(),
  })));
}

/** A fetch whose ingest/summary requests never settle while `hanging` is on (a TCP connection open, no answer). */
function hangingFetch() {
  const held = [];
  const state = { hanging: false, ingestCalls: 0, held };
  const impl = async (url, init) => {
    const u = String(url);
    if (u.endsWith("/v1/ingest") || u.endsWith("/v1/summaries")) {
      state.ingestCalls += 1;
      if (state.hanging) return new Promise((_resolve, reject) => {
        held.push(reject);
        // A real connection is abandoned when the request's signal fires; `ignoreSignal` models one that is not.
        if (!state.ignoreSignal) init?.signal?.addEventListener("abort", () => reject(init.signal.reason ?? new Error("aborted")));
      });
    }
    return fetch(url, init);
  };
  state.signals = [];
  const wrapped = async (url, init) => { if (String(url).endsWith("/v1/ingest")) state.signals.push(init?.signal ?? null); return impl(url, init); };
  return { fetchImpl: wrapped, state, release: () => { for (const r of held.splice(0)) r(new TypeError("fetch failed (released by test)")); } };
}

function computer(url) {
  const dir = mkdtempSync(join(tmpdir(), "sb-b2c-agent-"));
  scaffold(dir);
  const { attester } = loadOrCreateAttester({ file: join(dir, "attester.key") });
  const connection = {
    url, credential: "sbm_us_test", credential_id: "cred-1", organization_id: "org-1", environment_id: "env-1",
    gateway_id: "gw-1", attester_kid: attester.kid, scopes: ["receipt:ingest", "gateway:heartbeat"],
    expires_at: new Date(Date.now() + 80 * 86_400_000).toISOString(),
  };
  writeFileSync(join(dir, "cloud.json"), JSON.stringify(connection));
  // These tests watch individual records leave, so the computer sends every receipt in full (not the standard summaries).
  writeFileSync(join(dir, "managed-meta.json"), JSON.stringify({ evidence_detail: "full" }));
  return { dir, connection };
}

/** One hook process per tool call: record n actions, then the bounded per-call flush (800 ms, like cli-main). */
async function hookCalls(dir, connection, n, fetchImpl) {
  for (let i = 0; i < n; i++) {
    const rt = createHookRuntime({
      policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"), attesterPath: join(dir, "attester.key"),
      dbPath: join(dir, "receipts.db"), cloud: { connection, fetch: fetchImpl, flushTimeoutMs: 800 },
    });
    try {
      await rt.evaluate(mapClaudeToolUse({ tool_name: "Read", tool_input: { file_path: `/repo/b${i}.ts` }, cwd: "/repo" }));
      await rt.flush();
    } finally { rt.exporter?.stop(); rt.close(); }
  }
}

/** The hook's own rules check (syncIfDue on a tool call): what it tells the workspace about delivery. */
async function hookRulesCheck(dir) {
  const agentKid = createSigner({ privateKeyPem: readFileSync(join(dir, "agent.key"), "utf8") }).kid;
  return syncPolicy(dir, { agentKid, hookVersion: hookVersion(), policyBuilds, timeoutMs: 3_000 });
}

const settledWithin = (p, ms) => Promise.race([p.then(() => true, () => true), new Promise((r) => setTimeout(() => r(false), ms))]);

test("a delivery request that never answers is abandoned at its time limit, and the agent keeps trying", async () => {
  const ws = await workspace();
  const { dir, connection } = computer(ws.url);
  const net = hangingFetch();
  const service = await startService({ dir, intervalMs: 200, fetchImpl: net.fetchImpl, log: () => {}, maintenance: false, tray: false, deliveryTimeoutMs: 300 });
  try {
    net.state.hanging = true;
    await hookCalls(dir, connection, 2, net.fetchImpl);
    const before = net.state.ingestCalls;
    await new Promise((r) => setTimeout(r, 3_000));
    assert.ok(net.state.ingestCalls - before >= 2, `the agent tried again (${net.state.ingestCalls - before} attempts in 3 s)`);
    assert.ok(net.state.signals.length > 0 && net.state.signals.every((sig) => sig !== null), "every delivery request carries a time limit");
    const status = await callAgent(dir, "GET", "/status", undefined, 3_000);
    assert.ok("cycle_started_at" in status.agent, "status says whether a cycle is under way");
  } finally { net.release(); await service.stop(); ws.close(); }
});

test("a cycle that runs past its limit is left behind: the loop goes on, Send now answers and stop does not wait", async () => {
  const ws = await workspace();
  const { dir, connection } = computer(ws.url);
  const net = hangingFetch();
  net.state.ignoreSignal = true;
  await hookCalls(dir, connection, 2, async () => new Response("{}", { status: 503 }));
  net.state.hanging = true;
  const service = await startService({ dir, intervalMs: 200, fetchImpl: net.fetchImpl, log: () => {}, maintenance: false, tray: false, deliveryTimeoutMs: 60_000, cycleLimitMs: 400 });
  try {
    const before = net.state.ingestCalls;
    await new Promise((r) => setTimeout(r, 3_000));
    assert.ok(net.state.ingestCalls - before >= 2, `a new cycle started after the stuck one (${net.state.ingestCalls - before} attempts)`);
    const flushed = await callAgent(dir, "POST", "/flush", {}, 3_000);
    assert.ok(flushed, "Send now answers within the cycle limit");
    assert.match(String(readDeliveryState(dir).last_error), /delivery cycle did not finish/, "the stuck cycle is named, not a hook cut-off");
    const stopping = service.stop();
    assert.equal(await settledWithin(stopping, 3_000), true, "stop does not wait on the stuck cycle");
  } finally { net.release(); ws.close(); }
});

test("the agent's real delivery error survives the next hook call's cut-off, locally and in what the workspace hears", async () => {
  const ws = await workspace();
  const { dir, connection } = computer(ws.url);
  await hookCalls(dir, connection, 3, async () => new Response("{}", { status: 503 }));
  const agentFetch = async (url, init) => {
    if (String(url).endsWith("/v1/ingest")) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    return fetch(url, init);
  };
  await runCycle({ dir, fetchImpl: agentFetch });
  assert.equal(readDeliveryState(dir).last_error, "fetch failed");
  const net = hangingFetch(); net.state.hanging = true;
  await hookCalls(dir, connection, 1, net.fetchImpl);
  assert.equal(readDeliveryState(dir).last_error, "fetch failed", "the agent's cause stands");
  assert.ok(readDeliveryState(dir).last_timeout_at, "the cut-off is still kept as history");
  const before = ws.policyCalls.length;
  await hookRulesCheck(dir);
  assert.equal(ws.policyCalls[before]?.lastError, "fetch failed");
  net.release(); ws.close();
});
