// Delivery from the per-call hook never wedges on a record the workspace will never take, and honours a workspace that asks
// it to wait. Runs the real dist/cli.js, one process per tool call as a coding agent runs it, in an isolated home, against a
// stand-in workspace on 127.0.0.1 whose /v1/ingest applies the hosted workspace's size limits (a body over 1 MiB, or any one
// receipt over 128 KiB of canonical JSON, answers 413 batch_too_large for the whole batch) and, in "paused" mode, answers
// 503 ingest_paused with Retry-After: 3600.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { gunzipSync } from "node:zlib";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { canonical } from "@scopebond/gateway";
import { scaffold, queueStatus, readDeliveryState, writeDeliveryState, OUTBOX_FILE } from "../dist/index.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const MiB = 1024 * 1024;
const RECEIPT_MAX = 128 * 1024;

function stub() {
  const seen = { ingest: [], summaries: [] };
  let mode = "limits";
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let raw = Buffer.concat(chunks);
      const url = new URL(req.url, "http://stub");
      const send = (status, body, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(body === undefined ? "" : JSON.stringify(body)); };
      if (url.pathname === "/v1/policy" && req.method === "GET") { res.writeHead(204, { "x-scopebond-evidence-detail": "standard" }); res.end(); return; }
      if (url.pathname === "/v1/policy/ack") return send(200, { recorded: true, revision: 0 });
      if (url.pathname === "/v1/ingest" || url.pathname === "/v1/summaries") {
        if (req.headers["content-encoding"] === "gzip") raw = gunzipSync(raw);
        const body = JSON.parse(raw.toString("utf8") || "{}");
        const list = url.pathname === "/v1/ingest" ? body.receipts ?? [] : body.summaries ?? [];
        const sizes = list.map((r) => Buffer.byteLength(canonical(r)));
        const entry = { at: Date.now(), count: list.length, ids: list.map((r) => r?.payload?.action_ref?.action_id ?? null), sizes, status: 0 };
        (url.pathname === "/v1/ingest" ? seen.ingest : seen.summaries).push(entry);
        if (mode === "paused") { entry.status = 503; return send(503, { error: "the workspace is not accepting records right now", code: "ingest_paused" }, { "retry-after": "3600" }); }
        if (raw.length > MiB || (url.pathname === "/v1/ingest" && sizes.some((n) => n > RECEIPT_MAX))) {
          entry.status = 413;
          return send(413, { error: raw.length > MiB ? "ingest body exceeds 1 MiB" : "receipt exceeds 128 KiB", code: "batch_too_large", remediation: "Send smaller batches." }, { "accept-encoding": "gzip" });
        }
        entry.status = 200;
        return url.pathname === "/v1/ingest"
          ? send(200, { ok: true, ingested: list.length, duplicates: 0 }, { "accept-encoding": "gzip" })
          : send(200, { ok: true, accepted: list.length, duplicates: 0, actions: list.length, rejected: [] });
      }
      send(404, { error: "not_found" });
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, seen, setMode: (m) => { mode = m; },
    posts: () => seen.ingest.length + seen.summaries.length,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  })));
}

function home(stubUrl, tagName) {
  const root = mkdtempSync(join(tmpdir(), `sb-backpressure-${tagName}-`));
  const homeDir = join(root, "home");
  mkdirSync(homeDir, { recursive: true });
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(SCOPEBOND_|CLAUDE_)/.test(k)) delete env[k];
  const dir = join(homeDir, ".scopebond");
  Object.assign(env, { HOME: homeDir, USERPROFILE: homeDir, APPDATA: join(homeDir, "AppData", "Roaming"), LOCALAPPDATA: join(homeDir, "AppData", "Local"), SCOPEBOND_HOME: dir, SCOPEBOND_HOOK_FLUSH_MS: "800" });
  scaffold(dir, {});
  // A connection as `login` writes it, pointing at the stand-in workspace.
  writeFileSync(join(dir, "cloud.json"), JSON.stringify({
    url: stubUrl, credential: "sbm_us_backpressure", credential_id: "cred-backpressure", organization_id: "org-a", environment_id: "env-a",
    gateway_id: "gw-a", installation_id: "gw-a", scopes: ["receipt:ingest", "gateway:heartbeat"], expires_at: new Date(Date.now() + 80 * 86_400_000).toISOString(),
  }, null, 2), { mode: 0o600 });
  const cwd = join(root, "proj");
  mkdirSync(cwd, { recursive: true });
  return { env, dir, cwd };
}

const claude = (tool_name, tool_input, cwd, id) => ({ hook_event_name: "PreToolUse", session_id: "s-backpressure", tool_use_id: id, tool_name, tool_input, cwd, permission_mode: "default" });
// Asynchronous on purpose: the stand-in workspace runs in this process and must answer while the hook waits.
function runCli(h, args, stdin) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { env: h.env, cwd: h.cwd });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on("exit", (status) => { clearTimeout(timer); resolve({ status, stdout: stdout.trim(), stderr: stderr.trim() }); });
    child.stdin.end(stdin ?? "");
  });
}
const hookCall = (h, payload) => runCli(h, ["claude"], JSON.stringify(payload));
function localReceiptSizes(dir) {
  const d = new DatabaseSync(join(dir, "receipts.db"), { readOnly: true });
  try { return d.prepare("SELECT receipt_json FROM receipts ORDER BY id").all().map((r) => Buffer.byteLength(canonical(JSON.parse(r.receipt_json)))); } finally { d.close(); }
}
function ageQueue(dir, ms) {
  const d = new DatabaseSync(join(dir, OUTBOX_FILE));
  try { d.prepare("UPDATE cloud_outbox SET enqueued_at = enqueued_at - ?").run(ms); } finally { d.close(); }
}
// A ~144 KB path of short, letter-only segments (not masked), so the signed receipt passes 128 KiB.
const longUrl = "https://docs.example.com/" + "abcdefgh/".repeat(16_000);

test("an oversized record leaves the delivery queue as an oversize gap, and every record behind it is delivered", async () => {
  const s = await stub();
  try {
    const h = home(s.url, "oversize");
    // 1. The coding agent fetches a long URL. The hook allows it and signs a receipt over the workspace's 128 KiB limit.
    const first = await hookCall(h, claude("WebFetch", { url: longUrl, prompt: "summarise" }, h.cwd, "t-fetch"));
    assert.equal(first.status, 0, first.stderr);
    const sizes = localReceiptSizes(h.dir);
    assert.ok(sizes.at(-1) > RECEIPT_MAX, `the receipt is ${sizes.at(-1)} bytes of canonical JSON`);
    // 2. Ordinary work afterwards, including fetches the workspace must see.
    for (let i = 0; i < 3; i++) assert.equal((await hookCall(h, claude("WebFetch", { url: `https://docs.example.com/page-${i}`, prompt: "x" }, h.cwd, `t-${i}`))).status, 0);
    const accepted = s.seen.ingest.filter((p) => p.status === 200).reduce((n, p) => n + p.count, 0);
    const refused = s.seen.ingest.filter((p) => p.status === 413);
    assert.equal(accepted, 3, `the three later records reached the workspace: ${JSON.stringify(s.seen.ingest.map((p) => [p.status, p.count]))}`);
    assert.equal(refused.length, 1, "the oversized record was sent once, on its own, and never again");
    assert.equal(refused[0].count, 1);
    const queue = queueStatus(h.dir);
    assert.equal(queue.pending, 0, "nothing waits behind the oversized record");
    assert.equal(queue.gapsByReason.oversize, 1, "the oversized record is counted as a gap (reported to the workspace with the queue report)");
    // `status --json` (what the agent and the workspace read) and `status` show it.
    const json = JSON.parse((await runCli(h, ["status", "--json"])).stdout);
    assert.equal(json.delivery.gaps_by_reason.oversize, 1);
    assert.equal(json.delivery.pending, 0);
    assert.match((await runCli(h, ["status"])).stdout, /delivery gaps\s+1 record\(s\) missed normal delivery \(oversize 1\)/);
    // The record stays in this computer's log: evidence is never silently dropped.
    assert.ok(localReceiptSizes(h.dir).some((n) => n > RECEIPT_MAX), "the oversized receipt is still in the local log");
  } finally { await s.close(); }
});

test("a workspace's Retry-After is honoured by the next hook calls, notable and routine, until the wait has passed", async () => {
  const s = await stub();
  try {
    const h = home(s.url, "retry-after");
    s.setMode("paused"); // 503 ingest_paused, Retry-After: 3600
    // The first notable call sends and is asked to wait an hour; the next notable calls do not send again.
    for (let i = 0; i < 3; i++) assert.equal((await hookCall(h, claude("WebFetch", { url: `https://docs.example.com/n-${i}`, prompt: "x" }, h.cwd, `n-${i}`))).status, 0);
    assert.equal(s.posts(), 1, `one request, then the wait the workspace asked for: ${s.posts()} requests`);
    const state = readDeliveryState(h.dir);
    assert.ok(state.backoff_until >= Date.now() + 3_500_000, `the wait is kept for the next process: ${JSON.stringify(state)}`);
    assert.ok(state.backoff_until <= Date.now() + 3_600_000 + 5 * 60_000, "never more than an hour, plus a few minutes of spread");
    assert.match(state.last_error ?? "", /HTTP 503 \(ingest_paused\)/);
    // Routine calls once records have waited 30 minutes: still nothing sent while the wait lasts.
    ageQueue(h.dir, 31 * 60_000);
    for (let i = 0; i < 3; i++) await hookCall(h, claude("Read", { file_path: join(h.cwd, `old-${i}.ts`) }, h.cwd, `o-${i}`));
    assert.equal(s.posts(), 1, "aged routine calls wait too");
    // `status` says when the next try is, and `status --json` carries it.
    const json = JSON.parse((await runCli(h, ["status", "--json"])).stdout);
    assert.equal(json.delivery.backoff_until, readDeliveryState(h.dir).backoff_until);
    assert.match((await runCli(h, ["status"])).stdout, /next try\s+after .*the workspace asked this computer to wait/);
    // Once the wait has passed, the next call sends, and a delivery clears the wait.
    s.setMode("limits");
    writeDeliveryState(h.dir, { backoff_until: Date.now() - 1_000 });
    await hookCall(h, claude("WebFetch", { url: "https://docs.example.com/after", prompt: "x" }, h.cwd, "after"));
    assert.ok(s.seen.ingest.some((p) => p.status === 200), "delivered once the wait passed");
    const after = readDeliveryState(h.dir);
    assert.equal(after.backoff_until, null);
    assert.equal(after.backoff_count, 0);
  } finally { await s.close(); }
});
