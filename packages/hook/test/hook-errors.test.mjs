// The hook keeps a local record of its own failures (fail-closed blocks, missed deadlines), redacted and rotated, and
// `status` and `doctor` say how many actions it blocked that way in the last day.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scaffold } from "../dist/index.js";
import { HOOK_ERRORS_FILE, hookErrorLine, hookErrorSummary, recordHookError, redactHookError } from "../dist/hook-errors.js";
import { ENFORCE } from "./enforce-all.mjs";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

test("a failure is recorded with its kind, redacted, and summed for the last day", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-hook-errors-"));
  const ctx = { dir, harness: "claude", version: "9.9.9" };
  const now = Date.parse("2026-10-17T12:00:00Z");
  recordHookError("fail_closed", "token=abc123 sbm_us_0_secretvalue failed", now - 2 * 86_400_000, ctx);
  recordHookError("deadline", "no decision within 50 s", now - 60_000, ctx);
  const summary = hookErrorSummary(dir, now);
  assert.equal(summary.last24h, 1);
  assert.equal(summary.newest.kind, "deadline");
  const text = readFileSync(join(dir, HOOK_ERRORS_FILE), "utf8");
  assert.doesNotMatch(text, /sbm_us_0_secretvalue|abc123/);
  assert.match(hookErrorLine(dir, now), /^1 action\(s\) blocked in the last 24 h because the hook itself failed; newest .* \(deadline\): no decision within 50 s$/);
  assert.equal(hookErrorLine(mkdtempSync(join(tmpdir(), "sb-hook-errors-empty-")), now), null);
  assert.equal(redactHookError("Bearer abc.def"), "[removed]");
  assert.equal(redactHookError("password: hunter2 key=abc"), "[removed] [removed]");
  // A parser's own words keep their detail: "token" or "key" counts only with = or : after it.
  assert.equal(redactHookError("Unexpected token 'b', \"{ broken\" is not valid JSON"), "Unexpected token 'b', \"{ broken\" is not valid JSON");
  assert.equal(redactHookError("open '/x/agent.key' failed"), "open '/x/agent.key' failed");
});

test("failures in the rotated file still count for the last day", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-hook-errors-rot-count-"));
  const now = Date.parse("2026-10-17T12:00:00Z");
  const line = (at) => JSON.stringify({ at: new Date(at).toISOString(), version: null, harness: "claude", kind: "fail_closed", message: "x" });
  writeFileSync(join(dir, `${HOOK_ERRORS_FILE}.1`), `${line(now - 2 * 86_400_000)}\n${line(now - 3_600_000)}\n`);
  writeFileSync(join(dir, HOOK_ERRORS_FILE), `${line(now - 60_000)}\n`);
  const summary = hookErrorSummary(dir, now);
  assert.equal(summary.last24h, 2);
  assert.equal(summary.newest.at, new Date(now - 60_000).toISOString());
});

test("the file is rotated past 256 KB, keeping one older file", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-hook-errors-rot-"));
  const ctx = { dir, harness: "claude", version: null };
  writeFileSync(join(dir, HOOK_ERRORS_FILE), "x".repeat(300 * 1024));
  recordHookError("fail_closed", "after rotation", Date.now(), ctx);
  assert.ok(existsSync(join(dir, `${HOOK_ERRORS_FILE}.1`)));
  assert.ok(statSync(join(dir, HOOK_ERRORS_FILE)).size < 1024);
});

test("a fail-closed block of a real hook call is recorded and status says so", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-hook-errors-e2e-"));
  scaffold(dir, ENFORCE);
  writeFileSync(join(dir, "policy.json"), "{ broken");
  const env = { ...process.env, SCOPEBOND_HOOK_DIR: dir };
  try { execFileSync(process.execPath, [cli, "claude"], { input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: "a.ts" } }), encoding: "utf8", env }); } catch { /* exit 2: blocked */ }
  const lines = readFileSync(join(dir, HOOK_ERRORS_FILE), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].kind, "fail_closed");
  assert.equal(lines[0].harness, "claude");
  assert.match(lines[0].message, /is not valid JSON/);
  let out;
  try { out = execFileSync(process.execPath, [cli, "status"], { encoding: "utf8", env }); } catch (error) { out = String(error.stdout ?? ""); }
  assert.match(out, /hook failures +1 action\(s\) blocked in the last 24 h because the hook itself failed/);
});

test("a fail-closed block of a Cursor hook call is recorded too", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-hook-errors-cursor-"));
  scaffold(dir, ENFORCE);
  writeFileSync(join(dir, "policy.json"), "{ broken");
  const out = execFileSync(process.execPath, [cli, "cursor"], { input: JSON.stringify({ hook_event_name: "beforeShellExecution", cwd: dir, command: "ls" }), encoding: "utf8", env: { ...process.env, SCOPEBOND_HOOK_DIR: dir } });
  assert.equal(JSON.parse(out).permission, "deny");
  const lines = readFileSync(join(dir, HOOK_ERRORS_FILE), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].harness, "cursor");
  assert.equal(lines[0].kind, "fail_closed");
});

test("the rules check reports the last day's count and the newest kind, never the message", async () => {
  const { policyBuilds, syncPolicy, HOOK_CAPABILITIES } = await import("../dist/index.js");
  const { HOOK_FAILURES_HEADER, hookFailuresHeaderValue } = await import("../dist/hook-errors.js");
  const dir = mkdtempSync(join(tmpdir(), "sb-hook-failures-"));
  const { agentKid } = scaffold(dir, ENFORCE);
  writeFileSync(join(dir, "cloud.json"), JSON.stringify({ url: "https://cloud.example.test", credential: "sbm_x", credential_id: "c", organization_id: "org-h", environment_id: "env-1", gateway_id: "gw-h", attester_kid: "k", scopes: [], expires_at: "2099-01-01T00:00:00Z" }));
  const check = async () => {
    const calls = [];
    const fetchImpl = async (url, init = {}) => { calls.push({ url: String(url), headers: init.headers ?? {} }); return new Response(null, { status: 204 }); };
    await syncPolicy(dir, { agentKid, hookVersion: "0.40.0", policyBuilds, fetchImpl });
    return calls.find((c) => c.url.endsWith("/v1/policy")).headers;
  };
  assert.equal(hookFailuresHeaderValue(dir), null);
  assert.equal(HOOK_FAILURES_HEADER in await check(), false, "no failure, no header");
  const ctx = { dir, harness: "claude", version: "9.9.9" };
  recordHookError("fail_closed", "secret path ~/projects/x failed", Date.now() - 120_000, ctx);
  recordHookError("deadline", "no decision within 50 s", Date.now() - 60_000, ctx);
  const headers = await check();
  assert.equal(headers[HOOK_FAILURES_HEADER], "2;deadline");
  assert.doesNotMatch(JSON.stringify(headers), /projects|no decision/, "the message stays on the computer");
  assert.ok(HOOK_CAPABILITIES.includes("hook_failures"), "the workspace can read a missing header as none");
});
