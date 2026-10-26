// `flush` with summary records on: routine records wait on purpose for their five-minute window to close, then leave as one
// signed summary. They are reported apart and do not fail the flush; records left undelivered, or a failed attempt, do.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffold, connectCloud, createHookRuntime, mapClaudeToolUse, flushOutcome } from "../dist/index.js";
import { loadOrCreateAttester } from "@scopebond/gateway/node";
import { ENFORCE } from "./enforce-all.mjs";

const local = (at) => {
  const d = new Date(Math.ceil(at / 60_000) * 60_000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

test("flushOutcome: only routine records held for the summary window exit 0 and say until when", () => {
  const until = Date.parse("2026-10-13T10:05:30Z");
  const out = flushOutcome({ pending: 3, lastError: null, backoff: null }, { routine: 3, until }, Date.parse("2026-10-13T10:03:00Z"));
  assert.equal(out.exitCode, 0);
  assert.equal(out.pending, 0);
  assert.equal(out.held, 3);
  assert.equal(out.lines[0], "flushed; 0 receipt(s) still pending");
  assert.ok(out.lines[1].startsWith(`3 routine record(s) held for the summary window until ${local(until)}; `), out.lines[1]);
});

test("flushOutcome: a notable record still waiting exits 1, and is not counted as held", () => {
  const out = flushOutcome({ pending: 3, lastError: null, backoff: null }, { routine: 2, until: Date.now() + 60_000 });
  assert.equal(out.exitCode, 1);
  assert.equal(out.pending, 1);
  assert.equal(out.held, 2);
  assert.equal(out.lines[0], "flushed; 1 receipt(s) still pending");
});

test("flushOutcome: a failed attempt exits 1, even when only routine records are left", () => {
  const out = flushOutcome({ pending: 2, lastError: "HTTP 500", backoff: null }, { routine: 2, until: Date.now() + 60_000 });
  assert.equal(out.exitCode, 1);
  assert.match(out.lines[0], /last error: HTTP 500/);
  const none = flushOutcome({ pending: 0, lastError: "HTTP 503", backoff: null }, { routine: 0, until: null });
  assert.equal(none.exitCode, 1);
});

test("flushOutcome: without held counts (an exporter without summaries) every waiting record counts, as before", () => {
  assert.deepEqual(flushOutcome({ pending: 0, lastError: null, backoff: null }, undefined), { lines: ["flushed; 0 receipt(s) still pending"], exitCode: 0, pending: 0, held: 0 });
  const out = flushOutcome({ pending: 4, lastError: null, backoff: null }, undefined);
  assert.equal(out.exitCode, 1);
  assert.equal(out.lines.length, 1);
  // A held count above the queue's own total never goes negative.
  assert.equal(flushOutcome({ pending: 1, lastError: null, backoff: null }, { routine: 5, until: null }).pending, 0);
});

/** A workspace that enrolls this computer and answers ingest with `ingestStatus`. */
function startWorkspace(ingestStatus, kids) {
  const ingested = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      if (req.url === "/v1/enroll") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          credential_id: "cred-1", credential: "sbm_test_credential", organization_id: "org-1", environment_id: "env-1", gateway_id: "gw-1",
          attester_kid: kids.attester, agent_kid: kids.agent, scopes: ["receipt:ingest"], expires_at: "2027-01-01T00:00:00.000Z",
        }));
        return;
      }
      if (req.url === "/v1/ingest") {
        if (ingestStatus !== 200) { res.writeHead(ingestStatus, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "unavailable" })); return; }
        for (const r of JSON.parse(body).receipts ?? []) ingested.push(r);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${server.address().port}`, ingested, close: () => server.close() })));
}

const bundle = {
  enrollment_token: "sbe_test123", expires_at: "2027-01-01T00:00:00.000Z",
  proof_canonical: JSON.stringify({ challenge: "c1", enrollment_id: "e1", type: "scopebond:gateway-enrollment", version: 1 }),
};
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

/** A connected computer (summary records on, the default) with the given actions evaluated; then `flush` from the CLI. */
async function flushAfter(ingestStatus, inputs) {
  const dir = mkdtempSync(join(tmpdir(), "sb-hook-flush-held-"));
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  scaffold(dir, ENFORCE);
  const kids = { attester: loadOrCreateAttester({ file: join(dir, "attester.key") }).attester.kid, agent: loadOrCreateAttester({ file: join(dir, "agent.key") }).attester.kid };
  const ws = await startWorkspace(ingestStatus, kids);
  try {
    const connection = await connectCloud(dir, ws.url, bundle);
    const runtime = createHookRuntime({
      policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"),
      attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db"), cloud: { connection },
    });
    for (const input of inputs) await runtime.evaluate(mapClaudeToolUse(input));
    runtime.exporter.stop();
    const result = await new Promise((resolve) => {
      execFile(process.execPath, [cli, "flush"], {
        cwd: dir, timeout: 30_000,
        // Its own home: nothing here reads or writes the real one.
        env: { ...process.env, SCOPEBOND_HOOK_DIR: dir, HOME: home, USERPROFILE: home, SCOPEBOND_HOME: join(home, ".scopebond") },
      }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
    });
    return { ...result, ingested: ws.ingested };
  } finally { ws.close(); }
}

test("flush: only routine records held for the summary window exits 0 and names them apart", async () => {
  const out = await flushAfter(200, [{ tool_name: "Read", tool_input: { file_path: "/repo/src/app.ts" }, cwd: "/repo" }]);
  assert.equal(out.code, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /flushed; 0 receipt\(s\) still pending/);
  assert.match(out.stdout, /1 routine record\(s\) held for the summary window until \d\d:\d\d; /);
  assert.equal(out.ingested.length, 0, "the routine record waits for its summary");
});

test("flush: a notable record the workspace did not take exits 1", async () => {
  const out = await flushAfter(503, [
    { tool_name: "Read", tool_input: { file_path: "/repo/src/app.ts" }, cwd: "/repo" },
    { tool_name: "Bash", tool_input: { command: "git push origin main" }, cwd: "/repo" },
  ]);
  assert.equal(out.code, 1, out.stdout + out.stderr);
  assert.match(out.stdout, /flushed; 1 receipt\(s\) still pending \(last error: /);
  assert.match(out.stdout, /1 routine record\(s\) held for the summary window/);
});
