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
  let out = "";
  try { out = execFileSync(process.execPath, [cli, "status"], { encoding: "utf8", env }); } catch (error) { out = String(error.stdout ?? ""); }
  assert.match(out, /hook failures +1 action\(s\) blocked in the last 24 h because the hook itself failed/);
});
