// Fail closed on time. A coding agent that waits past its own hook time limit runs the action with no check (a timed-out
// hook is a non-blocking error to Claude Code, Codex and Cursor). So a hook call that has not decided shortly before that
// limit denies by itself. Here the decision path is held up for real (a workspace that accepts the connection and never
// answers, with the rules check and delivery allowed to wait a minute) and the deadline is shortened to prove the deny.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scaffold } from "../dist/index.js";
import { HOOK_DEADLINE_MS, HOT_PATH_STORE_BUSY_MS, WAIT_RESERVE_MS, armHookDeadline, hookDeadlineMs, hookDeadlineRemainingMs, waitWithinDeadline } from "../dist/hook-deadline.js";
import { ENFORCE } from "./enforce-all.mjs";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function connectedDir(port) {
  const dir = mkdtempSync(join(tmpdir(), "sb-deadline-"));
  scaffold(dir, ENFORCE);
  writeFileSync(join(dir, "cloud.json"), JSON.stringify({
    url: `http://127.0.0.1:${port}`, credential: "sbm_x", credential_id: "c", organization_id: "o", environment_id: "e",
    gateway_id: "gw-deadline", attester_kid: "k", scopes: [], expires_at: "2099-01-01T00:00:00Z",
  }));
  return dir;
}

function runHook(dir, harness, event, env) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [cli, harness], {
      env: { ...process.env, SCOPEBOND_HOOK_DIR: dir, SCOPEBOND_POLICY_SYNC: "", SCOPEBOND_POLICY_SYNC_MS: "60000", SCOPEBOND_HOOK_FLUSH_MS: "60000", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.resume();
    child.on("close", (status) => resolve({ status, stdout, ms: Date.now() - started }));
    child.stdin.end(JSON.stringify(event));
  });
}

/** A workspace that takes every request and never answers it. */
async function silentWorkspace() {
  const held = [];
  const server = http.createServer((req, res) => { held.push(res); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, close: () => { for (const res of held) res.destroy(); server.closeAllConnections?.(); server.close(); } };
}

const allowedWrite = { tool_name: "Write", tool_input: { file_path: "src/app.ts", content: "x" }, cwd: process.cwd() };

test("the deadline: shorter than each agent's own limit, longer than the waits the hook takes on purpose; the environment can only shorten it", () => {
  assert.ok(HOOK_DEADLINE_MS.claude > 45_000 && HOOK_DEADLINE_MS.claude < 60_000, "after the 45 s wait in the window, before Claude Code's 60 s");
  assert.ok(HOOK_DEADLINE_MS.codex > 20_000 && HOOK_DEADLINE_MS.codex < 30_000, "after the 20 s wait, before the 30 s the Codex entry says");
  assert.ok(HOOK_DEADLINE_MS.cursor > 20_000);
  assert.ok(HOOK_DEADLINE_MS.copilot > 25_000 && HOOK_DEADLINE_MS.copilot < 60_000, "after the 25 s wait, before the 60 s timeoutSec the Copilot entry says");
  assert.equal(hookDeadlineMs("claude", {}), HOOK_DEADLINE_MS.claude);
  assert.equal(hookDeadlineMs("claude", { SCOPEBOND_HOOK_DEADLINE_MS: "1500" }), 1500);
  assert.equal(hookDeadlineMs("claude", { SCOPEBOND_HOOK_DEADLINE_MS: "600000" }), HOOK_DEADLINE_MS.claude, "never lengthened");
  assert.equal(hookDeadlineMs("codex", { SCOPEBOND_HOOK_DEADLINE_MS: "soon" }), HOOK_DEADLINE_MS.codex);
  assert.equal(hookDeadlineMs("status", {}), null, "only hook calls have a deadline");
  assert.equal(hookDeadlineMs("toString", {}), null);
});

test("the person's wait shrinks to what the deadline leaves, and the lock waits fit beside it", () => {
  assert.equal(hookDeadlineRemainingMs(), Infinity, "no deadline armed: nothing shrinks");
  assert.equal(waitWithinDeadline(45_000), 45_000);
  const disarm = armHookDeadline("claude", { SCOPEBOND_HOOK_DEADLINE_MS: "30000" });
  try {
    const now = Date.now();
    assert.ok(hookDeadlineRemainingMs(now) <= 30_000 && hookDeadlineRemainingMs(now) > 29_000);
    assert.ok(waitWithinDeadline(45_000, now) <= 30_000 - WAIT_RESERVE_MS, "the wait leaves the reserve");
    assert.equal(waitWithinDeadline(5_000, now), 5_000, "a shorter wait is kept");
    assert.equal(waitWithinDeadline(45_000, now + 29_000), 1_000, "never less than a second");
  } finally { disarm(); }
  assert.equal(hookDeadlineRemainingMs(), Infinity);
  // Every agent: the longest wait the hook takes on purpose, then the reserve, fits inside the deadline.
  for (const ms of Object.values(HOOK_DEADLINE_MS)) assert.ok(ms > WAIT_RESERVE_MS + HOT_PATH_STORE_BUSY_MS);
});

for (const [harness, denied] of [
  ["claude", (r) => r.status === 2 && JSON.parse(r.stdout).hookSpecificOutput.permissionDecision === "deny"],
  ["codex", (r) => r.status === 0 && JSON.parse(r.stdout).hookSpecificOutput.permissionDecision === "deny"],
  ["cursor", (r) => r.status === 0 && JSON.parse(r.stdout).permission === "deny"],
  ["copilot", (r) => r.status === 2 && JSON.parse(r.stdout).permissionDecision === "deny"],
]) {
  test(`${harness}: a call still undecided at the deadline is denied, not left to time out`, async () => {
    const workspace = await silentWorkspace();
    try {
      const dir = connectedDir(workspace.port);
      const event = harness === "cursor" ? { hook_event_name: "beforeShellExecution", command: "ls", cwd: process.cwd() }
        : harness === "copilot" ? { hook_event_name: "PreToolUse", session_id: "s", ...allowedWrite } : allowedWrite;
      const r = await runHook(dir, harness, event, { SCOPEBOND_HOOK_DEADLINE_MS: "1500" });
      assert.ok(denied(r), `expected a deny, got exit ${r.status}: ${r.stdout}`);
      assert.match(r.stdout, /no decision within/);
      assert.ok(r.ms < 20_000, `denied at the deadline, not after the minute-long waits (${r.ms} ms)`);
    } finally { workspace.close(); }
  });
}

test("claude: a call that decides in time is not touched by the deadline", async () => {
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith("/v1/policy") && req.method === "GET") { res.writeHead(204).end(); return; }
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const dir = connectedDir(server.address().port);
    const r = await runHook(dir, "claude", allowedWrite, { SCOPEBOND_HOOK_DEADLINE_MS: "20000", SCOPEBOND_POLICY_SYNC_MS: "", SCOPEBOND_HOOK_FLUSH_MS: "" });
    assert.equal(r.status, 0, r.stdout);
    assert.equal(r.stdout.trim(), "", "an allowed action stays silent");
  } finally { server.closeAllConnections?.(); server.close(); }
});
