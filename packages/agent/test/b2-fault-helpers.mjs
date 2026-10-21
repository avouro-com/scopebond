// Shared by the fault-injection specs (b2-fault-*.test.mjs): a computer connected to a workspace whose every answer the test
// decides, hook calls that leave records waiting, and an agent serving it. Imported FIRST by each spec: HOME, USERPROFILE,
// APPDATA and SCOPEBOND_HOME point at a temp folder before any Scopebond module loads, so the real ~/.claude and ~/.scopebond
// are never read or written.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const HOME = mkdtempSync(join(tmpdir(), "sb-b2-fault-home-"));
process.env.HOME = HOME; process.env.USERPROFILE = HOME;
process.env.APPDATA = join(HOME, "AppData", "Roaming"); process.env.LOCALAPPDATA = join(HOME, "AppData", "Local");
mkdirSync(process.env.APPDATA, { recursive: true }); mkdirSync(process.env.LOCALAPPDATA, { recursive: true });
process.env.SCOPEBOND_HOME = join(HOME, ".scopebond");
process.env.SCOPEBOND_AGENT_TRAY = "off";

const { loadOrCreateAttester } = await import("@scopebond/gateway/node");
const hook = await import("@scopebond/hook");
const agent = await import("../dist/index.js");
const { healthOf } = await import("../dist/health.js");
const { trayModel } = await import("../dist/tray-model.js");
export { hook, agent, healthOf, trayModel };

// Claude Code with the Scopebond hook entry in the temp home, so status reads "governing" as on a real laptop.
export const CLAUDE_SETTINGS = join(HOME, ".claude", "settings.json");
mkdirSync(join(HOME, ".claude"), { recursive: true });
writeFileSync(CLAUDE_SETTINGS, "{}");
agent.repairHookEntries(["claude"]);

export const MIN = 60_000;
export const HOUR = 60 * MIN;

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A workspace the test controls: `faults[route]` is an HTTP status, a refusal `{ status, code }`, or "down" (no answer at
 *  all) for that route; every call is
 *  counted. Routes: ingest (records and summaries), policy, self-check, refresh, client-version; a signed release's download
 *  always fails (404). */
export function workspace() {
  const faults = {};
  const calls = { ingest: 0, policy: 0, "self-check": 0, refresh: 0, "client-version": 0, download: 0 };
  const answers = { "self-check": { ok: true, signature_verified: true, failed: [] }, refresh: null, "client-version": null };
  const routeOf = (path) => path === "/v1/ingest" || path === "/v1/summaries" ? "ingest" : path === "/v1/policy" ? "policy" : path === "/v1/self-check" ? "self-check"
    : path === "/v1/credential/refresh" ? "refresh" : path === "/v1/client-version" ? "client-version" : null;
  const fetchImpl = async (url) => {
    const path = new URL(String(url)).pathname;
    // A signed release's files (manifest, signature, installer): the download fails.
    if (path.includes("/agent-native-v")) { calls.download += 1; return new Response("not found", { status: 404 }); }
    const route = routeOf(path);
    if (route) calls[route] += 1;
    const fault = route ? faults[route] : undefined;
    if (fault === "down") throw new TypeError("fetch failed (ECONNREFUSED)");
    if (typeof fault === "number") return json({ error: "fault", message: "injected" }, fault);
    // A refusal with the workspace's code ({ status: 402, code: "not_licensed" }).
    if (fault && typeof fault === "object") return json({ error: fault.code, code: fault.code }, fault.status);
    if (route === "ingest") return json({ ok: true, accepted: 1 });
    if (route === "policy") return new Response(null, { status: 204 });
    if (route === "self-check") return json(answers["self-check"]);
    if (route === "refresh") return json(answers.refresh ?? { refreshed: false });
    if (route === "client-version") return answers["client-version"] ? json(answers["client-version"]) : new Response("{}", { status: 404 });
    return json({});
  };
  return { fetchImpl, faults, calls, answers };
}

/** A Scopebond folder connected to `url`, its credential expiring in `expiresInDays`. */
export function computer({ url = "http://127.0.0.1:9", expiresInDays = 80 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sb-b2-fault-"));
  hook.scaffold(dir);
  const { attester } = loadOrCreateAttester({ file: join(dir, "attester.key") });
  const connection = {
    url, credential: "sbm_us_test", credential_id: "cred-1", organization_id: "org-1", environment_id: "env-1",
    gateway_id: "gw-1", attester_kid: attester.kid, scopes: ["receipt:ingest", "gateway:heartbeat"],
    expires_at: new Date(Date.now() + expiresInDays * 86_400_000).toISOString(),
  };
  writeFileSync(join(dir, "cloud.json"), JSON.stringify(connection));
  // Every receipt sent in full, so each waiting record is one the test can count.
  writeFileSync(join(dir, "managed-meta.json"), JSON.stringify({ evidence_detail: "full" }));
  return { dir, connection };
}

/** `n` hook processes, one tool call each, whose own delivery fails: the records wait for the agent. */
export async function waitingRecords(dir, connection, n) {
  const refuse = async () => { throw new TypeError("fetch failed (hook offline)"); };
  for (let i = 0; i < n; i++) {
    const rt = hook.createHookRuntime({
      policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"), attesterPath: join(dir, "attester.key"),
      dbPath: join(dir, "receipts.db"), cloud: { connection, fetch: refuse, flushTimeoutMs: 200 },
    });
    try {
      await rt.evaluate(hook.mapClaudeToolUse({ tool_name: "Read", tool_input: { file_path: `/repo/f${i}.ts` }, cwd: "/repo" }));
      await rt.flush();
    } finally { rt.exporter?.stop(); rt.close(); }
  }
}

/** The agent for `dir`, with the test's workspace and, when given, its clock. */
export function serve(dir, ws, extra = {}) {
  return agent.startService({ dir, intervalMs: 60 * MIN, fetchImpl: ws.fetchImpl, log: () => {}, maintenance: false, tray: false,
    installKind: "npm", autoSignIn: false, migrate: false, upkeep: async () => null, ...extra });
}

export const tray = async (dir) => (await agent.callAgent(dir, "GET", "/tray", undefined, 10_000)).tray;

/** Wait until `check()` is true (polled every 50 ms), or fail after `ms`. */
export async function until(check, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

/** A tray model input for the pure model specs: connected, rules fresh, nothing waiting; `delivery` and `over` change it. */
export function modelInput(now, delivery = {}, over = {}, statusExtra = {}) {
  const status = {
    schema: "scopebond.status.v1", version: "0.30.0", state: "delivering",
    delivery: { connected: true, last_success_at: now - MIN, last_attempt_at: now - MIN, last_error: null, last_error_code: null, connection_refused_since: null, pending: 0, oldest_pending_age_s: null, gaps_by_reason: {}, queue_error: null, ...delivery },
    identity: { installation_id: "gw-1", generation: 1, key_kid: "key:1", credential_expires_at: null },
    config: { active: "C:/x", others: [], user_connection_shadowed: false },
    agents: { claude: true, cursor: false, codex: false },
    ...statusExtra,
  };
  return {
    status, health: healthOf(status, over.selfCheck ?? null, { kind: "per-user", platform: "win32" }), now, awakeSince: now - 48 * HOUR, working: null,
    rules: { checked_at: now - 3 * MIN, managed: true, block: 9, monitor: 2 },
    today: { actions: 40, blocked: 1, allowed_by_person: 0 },
    version: { agent: "0.11.5", hook: "0.30.0", policy: "recommended", recommendedAgent: null, recommendedHook: null },
    workspace: { name: "Avouro", environment: "Production", computer_url: null }, computerName: "LAPTOP", canReconnect: true,
    ...over,
  };
}

/** What a person sees: the state, whether the header asks anything of them, and the Settings rows. */
export function seen(model) {
  return {
    state: model.state, headline: model.headline, fix: model.fix?.id ?? null, hint: model.hint,
    sendNow: model.actions.some((a) => a.id === "send_now") || model.fix?.id === "send_now",
    row: (label) => model.computer_rows?.find((r) => r.label === label)?.value ?? null,
  };
}
