// A signed install that was never connected signs in with no terminal: the workspace the installer named (HKCU, then
// HKLM, else Scopebond Cloud; https only), the approval page opened on that workspace only, the code in the tray, and once
// approved the rest of a first-time setup (hook entries, autostart). On its very first start it does this by itself, once.
// HOME, USERPROFILE and SCOPEBOND_HOME point at temporary folders; the workspace is the fake cloud; autostart and the
// browser are stand-ins.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "sb-first-signin-"));
const userHome = join(root, "home");
mkdirSync(userHome, { recursive: true });
const saved = { ...process.env };
Object.assign(process.env, { HOME: userHome, USERPROFILE: userHome, APPDATA: join(userHome, "AppData", "Roaming"), LOCALAPPDATA: join(userHome, "AppData", "Local"), SCOPEBOND_HOME: join(userHome, ".scopebond"), SCOPEBOND_AGENT_TRAY: "off" });
after(() => { for (const k of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SCOPEBOND_HOME", "SCOPEBOND_AGENT_TRAY"]) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const { startFakeCloud } = await import("@scopebond/fake-cloud");
const { configuredHookCommands, loadConnection, userHarnessFile } = await import("@scopebond/hook");
const { installedWorkspace, httpsOrigin, runCycle, startFirstSignIn, startService, callAgent, DEFAULT_WORKSPACE, FIRST_SIGNIN_FILE } = await import("../dist/index.js");
const { trayModel } = await import("../dist/tray-model.js");
const { healthOf } = await import("../dist/health.js");

/** A registry with these values: { "HKCU\\...": "https://…" }. */
const registry = (values) => (key, name) => (name === "Workspace" && key in values ? values[key] : null);
const HKCU = "HKCU\\Software\\Avouro\\Scopebond";
const HKLM = "HKLM\\Software\\Avouro\\Scopebond";

test("the workspace: this user's setting, then the machine's, else Scopebond Cloud; only an https origin", () => {
  assert.deepEqual(installedWorkspace(registry({})), { origin: DEFAULT_WORKSPACE, from: "default" });
  assert.equal(DEFAULT_WORKSPACE, "https://cloud.scopebond.com");
  assert.deepEqual(installedWorkspace(registry({ [HKLM]: "https://acme.example.test/app" })), { origin: "https://acme.example.test", from: HKLM });
  assert.deepEqual(installedWorkspace(registry({ [HKCU]: " https://mine.example.test ", [HKLM]: "https://acme.example.test" })), { origin: "https://mine.example.test", from: HKCU });
  for (const bad of ["http://acme.example.test", "javascript:alert(1)", "file:///C:/x", "https://user:pw@acme.example.test", "acme.example.test"]) {
    assert.match(installedWorkspace(registry({ [HKCU]: bad })).error ?? "", /not an https address/, bad);
    assert.equal(httpsOrigin(bad), null, bad);
  }
  assert.deepEqual(installedWorkspace(registry({ [HKCU]: "" , [HKLM]: "https://acme.example.test" })).origin, "https://acme.example.test", "an empty value counts as none");
});

/** The fake cloud under an https name: the agent only ever sees https://workspace.example.test. */
async function httpsWorkspace(options = {}) {
  const cloud = await startFakeCloud(options);
  const origin = "https://workspace.example.test";
  const fetchImpl = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== origin) throw new Error(`unexpected request to ${url.origin}`);
    return fetch(`${cloud.url}${url.pathname}${url.search}`, init);
  };
  return { cloud, origin, fetchImpl };
}

test("a first sign-in: the code, the approval page on that workspace, then the connection, the hook entries and autostart", async () => {
  const dir = mkdtempSync(join(root, "home-a-"));
  const { cloud, origin, fetchImpl } = await httpsWorkspace();
  try {
    const opened = [];
    const autostarts = [];
    let outcome = null;
    const first = await startFirstSignIn(dir, origin, { fetchImpl, open: (u) => opened.push(u), harnesses: ["claude"], autostart: () => { autostarts.push(dir); return "autostart on"; }, onDone: (o) => { outcome = o; } });
    assert.match(first.started.user_code, /^[A-Z]{4}-[A-Z]{4}$/);
    assert.equal(cloud.state().code_requests[0].harness, "claude");
    // The fake cloud names its own address for the page: not this workspace's origin, so it is not opened.
    assert.deepEqual(opened, [], "a page on another origin is never opened");
    assert.equal(first.started.verification_url, origin);
    assert.ok(cloud.approve(first.started.user_code));
    assert.equal(await first.done, true, JSON.stringify(outcome));
    assert.equal(loadConnection(dir)?.url.startsWith(origin), true);
    assert.equal(configuredHookCommands(userHarnessFile("claude")).length, 1, "the hook entry for Claude Code");
    assert.deepEqual(autostarts, [dir], "autostart, as setup does");
    assert.ok(outcome.lines.some((l) => /put the Scopebond hook in/.test(l)));
  } finally { await cloud.close(); }
});

test("the approval page opens when it is on the workspace; a denied sign-in connects nothing", async () => {
  const dir = mkdtempSync(join(root, "home-b-"));
  const origin = "https://workspace.example.test";
  let polls = 0;
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/v1/device/code")) return Response.json({ device_code: "d", user_code: "BCDF-GHJK", verification_uri_complete: `${origin}/app/device?code=BCDF-GHJK`, interval: 1, expires_in: 60 });
    polls += 1;
    return Response.json({ error: "access_denied" }, { status: 400 });
  };
  const opened = [];
  const first = await startFirstSignIn(dir, origin, { fetchImpl, open: (u) => opened.push(u), harnesses: ["claude"] });
  assert.deepEqual(opened, [`${origin}/app/device?code=BCDF-GHJK`]);
  assert.equal(await first.done, false);
  assert.equal(polls, 1);
  assert.equal(loadConnection(dir), null);
  const unreachable = await startFirstSignIn(dir, origin, { fetchImpl: async () => { throw new Error("getaddrinfo ENOTFOUND"); } });
  assert.match(unreachable.error, /could not reach/);
});

test("the tray offers Sign in… (the reconnect route, so the tray shows the code) to a computer never connected", () => {
  const NOW = Date.now();
  const status = {
    schema: "scopebond.status.v1", version: "0.21.0", state: "not_governing",
    delivery: { connected: false, last_success_at: null, last_attempt_at: null, last_error: null, last_error_code: null, connection_refused_since: null, pending: 0, oldest_pending_age_s: null, gaps_by_reason: {}, queue_error: null },
    identity: { installation_id: null, generation: 0, key_kid: null, credential_expires_at: null }, config: { active: "C:/x", others: [], user_connection_shadowed: false },
    agents: { claude: false, cursor: false, codex: false },
  };
  const base = { status, now: NOW, awakeSince: NOW, working: null, rules: null, today: null, version: { agent: "0.6.0", hook: "0.21.0", policy: "unknown", recommendedAgent: null, recommendedHook: null }, workspace: null, computerName: "PC" };
  const signed = trayModel({ ...base, health: healthOf(status, null, { kind: "per-user", platform: "win32" }), canSignIn: true });
  assert.equal(signed.state, "disconnected");
  assert.deepEqual(signed.fix, { id: "reconnect", label: "Sign in…", route: "/reconnect" });
  const waiting = trayModel({ ...base, health: healthOf(status, null, { kind: "per-user", platform: "win32" }), canSignIn: true, signingIn: { user_code: "BCDF-GHJK", verification_url: "https://x.example.test" } });
  assert.equal(waiting.state, "working");
  assert.match(waiting.headline, /BCDF-GHJK/);
  assert.equal(waiting.fix?.label, "Sign in…", "asked again, it shows the code and opens the page again");
  const npm = trayModel({ ...base, health: healthOf(status, null, { kind: "npm", platform: "win32" }) });
  assert.notEqual(npm.fix?.id, "reconnect");
});

test("the very first start of a signed install signs in by itself, once; the tray shows the code; approved, it is connected", async () => {
  const dir = mkdtempSync(join(root, "home-c-"));
  const { cloud, fetchImpl } = await httpsWorkspace();
  const opened = [];
  const autostarts = [];
  const options = {
    dir, intervalMs: 60 * 60_000, log: () => {}, maintenance: false, tray: false, fetchImpl, installKind: "per-user", migrate: false,
    signIn: { registry: registry({ [HKCU]: "https://workspace.example.test" }), open: (u) => opened.push(u), autostart: () => { autostarts.push(1); return "autostart on"; } },
  };
  let service = await startService(options);
  try {
    let tray = null;
    for (let i = 0; i < 40; i++) {
      tray = (await callAgent(dir, "GET", "/tray"))?.tray;
      if (tray?.state === "working" && /code/.test(tray.headline)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.match(tray.headline, /Approve this computer in your workspace: code [A-Z]{4}-[A-Z]{4}/);
    assert.ok(existsSync(join(dir, FIRST_SIGNIN_FILE)), "noted before it started, so it never loops");
    assert.equal(cloud.state().code_requests.length, 1);
    // Sign in… while it waits: the same code, no second sign-in.
    const again = await callAgent(dir, "POST", "/reconnect", {});
    assert.ok(tray.headline.endsWith(again.user_code));
    assert.equal(cloud.state().code_requests.length, 1);
    assert.ok(cloud.approve(again.user_code));
    for (let i = 0; i < 60 && !loadConnection(dir); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(loadConnection(dir), "connected once approved");
    for (let i = 0; i < 40 && !autostarts.length; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(autostarts.length, 1);
    await service.stop();
    // Started again (never connected or not): it does not sign in by itself a second time.
    service = await startService(options);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(cloud.state().code_requests.length, 1);
  } finally { await service.stop(); await cloud.close(); }
});

test("an npm install never signs in by itself, and its Reconnect still asks for a terminal when never connected", async () => {
  const dir = mkdtempSync(join(root, "home-d-"));
  const { cloud, fetchImpl } = await httpsWorkspace();
  const service = await startService({ dir, intervalMs: 60 * 60_000, log: () => {}, maintenance: false, tray: false, fetchImpl, installKind: "npm" });
  try {
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(cloud.state().code_requests.length, 0);
    assert.equal(existsSync(join(dir, FIRST_SIGNIN_FILE)), false);
    const answer = await callAgent(dir, "POST", "/reconnect", {});
    assert.match(answer.error, /never connected/);
    assert.match(answer.error, /login https:\/\/<your-workspace>/);
  } finally { await service.stop(); await cloud.close(); }
});

test("the machine id: the sign-in carries it unscoped, the enrollment and the agent's check-ins in the approved workspace's scope", async () => {
  const dir = mkdtempSync(join(root, "home-m-"));
  const { cloud, origin, fetchImpl } = await httpsWorkspace();
  try {
    const first = await startFirstSignIn(dir, origin, { fetchImpl, open: () => {}, harnesses: ["claude"], autostart: () => "autostart on" });
    assert.ok(cloud.approve(first.started.user_code));
    assert.equal(await first.done, true);
    // This computer's own id (a hash of it), or none where the OS gives none. The sign-in does not know the workspace yet.
    const signIn = cloud.state().code_requests[0].machine_id;
    if (signIn !== null) assert.match(signIn, /^m1:[A-Za-z0-9_-]{43}$/);
    // The approval named the workspace (org-fake): the enrollment carries the id in its scope, and it is kept in that scope.
    const kept = JSON.parse(readFileSync(join(dir, "machine-id.json"), "utf8"));
    assert.equal(kept.scope, "org-fake");
    assert.equal(cloud.state().enroll_machine_ids[0], kept.machine_id);
    assert.equal(kept.machine_id === null, signIn === null);
    if (signIn !== null) assert.notEqual(kept.machine_id, signIn, "a workspace's scope gives a different id");
    await runCycle({ dir, fetchImpl, timeoutMs: 5000 });
    const policy = cloud.state().checkin_machine_ids.filter((c) => c.route === "policy");
    assert.ok(policy.length >= 1, "the rules were checked");
    for (const c of policy) assert.equal(c.machine_id, kept.machine_id);
  } finally { await cloud.close(); }
});
