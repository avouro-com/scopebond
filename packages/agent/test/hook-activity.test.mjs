import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { linkSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { HOOK_ACTIVITY_ROUTE, reportHookActivity, requestOverSocket } from "@scopebond/hook";
import { startControl, TOKEN_HEADER } from "../dist/ipc.js";
import { createHookActivityTracker } from "../dist/hook-activity.js";

const health = (harness = "codex") => ({ harness, presence: "detected", integration: "awaiting_trust",
  entry: true, executable: true, duplicates: false, definition_revision: "a".repeat(64),
  scope: { profile: { id: randomUUID(), state: "bound" }, execution: "windows" },
  runtime: { state: "never_verified", surfaces: ["cli", "desktop"] }, capabilities: { supported: ["shell"], verified: [] },
  license: { state: "unknown", scope: "legacy_computer" }, activity: { state: "unknown" },
});
const report = (at, extra = {}) => ({ version: 1, id: randomUUID(), harness: "codex", event: "decision", sent_at: at, ...extra });

test("callbacks are fresh, bounded, replay-resistant and cannot supply coverage or licensing claims", () => {
  let at = 100_000;
  const current = health();
  const tracker = createHookActivityTracker(() => current, () => at);
  for (const body of [null, [], report(at - 10_001), report(at + 2_001), report(at, { harness: "unknown" }),
    report(at, { event: "verified" }), report(at, { runtime: "verified" }), report(at, { license: "licensed" }),
    report(at, { command: "secret payload" }), report(at, { id: "x".repeat(1000) })]) {
    assert.equal(tracker.accept(body).accepted, false);
  }
  const body = report(at);
  assert.equal(tracker.accept(body).accepted, true);
  at += 1;
  assert.equal(tracker.accept(body).accepted, false);
  const observed = tracker.apply(current);
  assert.equal(observed.activity.last_callback_at, 100_000);
  assert.equal(observed.activity.source, "authenticated_local_callback");
  assert.equal(observed.activity.surface, "unknown");
  assert.deepEqual(observed.runtime, current.runtime);
  assert.deepEqual(observed.capabilities, current.capabilities);
  assert.deepEqual(observed.license, current.license);
  assert.equal(observed.integration, "awaiting_trust", "a direct fixture cannot prove native trust");
  for (let i = 1; i < 128; i++) assert.equal(tracker.accept(report(at)).accepted, true);
  assert.equal(tracker.accept(report(at)).accepted, false, "a flood cannot grow the replay cache without bound");
  at += 12_001;
  assert.equal(tracker.accept(report(at)).accepted, true, "expired replay entries release bounded capacity");
  at += 15 * 60_000 + 1;
  assert.equal(tracker.apply(current).activity.state, "stale");
  at -= 60_000;
  assert.equal(tracker.apply(current).activity.state, "unknown", "clock rollback clears old timing evidence");
});

test("configuration and profile changes invalidate callback activity; restart starts unknown", () => {
  const at = 100_000;
  for (const mutate of [
    (current) => { current.definition_revision = "b".repeat(64); },
    (current) => { current.scope.profile.id = randomUUID(); },
    (current) => { current.scope.execution = "wsl"; },
    (current) => { current.integration = "disabled"; },
    (current) => { current.executable = false; },
  ]) {
    const current = health();
    const tracker = createHookActivityTracker(() => current, () => at);
    assert.equal(tracker.accept(report(at)).accepted, true);
    mutate(current);
    assert.equal(tracker.apply(current).activity.state, "unknown");
    assert.equal(createHookActivityTracker(() => current, () => at).apply(current).activity.state, "unknown");
  }
});

test("a small clock rollback cannot make an already accepted callback replayable", () => {
  let at = 100_000;
  const current = health();
  const tracker = createHookActivityTracker(() => current, () => at);
  const body = report(at);
  assert.equal(tracker.accept(body).accepted, true);
  at -= 1_000;
  assert.equal(tracker.accept(body).accepted, false);
  assert.equal(tracker.apply(current).activity.state, "unknown");
  assert.equal(tracker.accept(report(at)).accepted, true);
});

for (const kind of ["oversized", "linked"]) test(`optional callbacks refuse ${kind} endpoint files`, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "callback-endpoint-"));
  let reports = 0;
  const control = await startControl(dir, "test", { [`POST ${HOOK_ACTIVITY_ROUTE}`]: () => { reports++; return { accepted: true }; } }, { loopback: false });
  t.after(() => control.close());
  const file = join(dir, "agent.json");
  if (kind === "oversized") writeFileSync(file, readFileSync(file, "utf8") + " ".repeat(4096));
  else linkSync(file, join(dir, "other-endpoint.json"));
  assert.equal(await reportHookActivity(dir, "codex", "decision"), false);
  assert.equal(reports, 0, "invalid endpoint metadata must not trigger optional I/O");
});

test("the real local channel rejects unauthenticated and browser requests; hook reports remain unverified", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hook-activity-"));
  const current = health();
  const tracker = createHookActivityTracker(() => current);
  const control = await startControl(dir, "test", { [`POST ${HOOK_ACTIVITY_ROUTE}`]: (body) => tracker.accept(body) }, { loopback: false });
  t.after(() => control.close());
  const send = (headers) => requestOverSocket(control.endpoint.socket, "POST", HOOK_ACTIVITY_ROUTE, headers, report(Date.now()), 1000);
  assert.equal((await send({})).status, 401);
  assert.equal((await send({ [TOKEN_HEADER]: "wrong" })).status, 401);
  assert.equal((await send({ [TOKEN_HEADER]: control.endpoint.token, origin: "https://example.invalid" })).status, 403);
  assert.equal(tracker.apply(current).activity.state, "unknown");
  let accepted = false;
  // Optional telemetry has a 20ms deadline; a busy CI worker may miss a first callback without changing enforcement.
  for (let i = 0; i < 5 && !accepted; i++) accepted = await reportHookActivity(dir, "codex", "decision");
  assert.equal(accepted, true);
  assert.equal(tracker.apply(current).activity.state, "callback_observed");
  assert.equal(tracker.apply(current).runtime.state, "never_verified");
  assert.equal(await reportHookActivity(join(dir, "missing"), "codex", "decision"), false);
  const cli = fileURLToPath(new URL("../../hook/dist/cli.js", import.meta.url));
  const exit = await new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, "codex"], { cwd: dir, windowsHide: true,
      env: { ...process.env, HOME: dir, USERPROFILE: dir, SCOPEBOND_HOME: dir, SCOPEBOND_HOOK_DIR: dir,
        SCOPEBOND_OBSERVATIONS_HEARTBEAT: "off", SCOPEBOND_POLICY_SYNC: "off" }, stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => resolve({ code: -1, stderr: error.message }));
    child.once("close", (code) => resolve({ code, stderr }));
    child.stdin.end(JSON.stringify({ hook_event_name: "SessionStart", session_id: "fixture-only", cwd: dir }));
  });
  assert.equal(exit.code, 0, exit.stderr);
  assert.equal(tracker.apply(current).activity.event, "session_start", "the CLI reports even with Cloud observations off");
  assert.equal(tracker.apply(current).runtime.state, "never_verified", "direct CLI fixtures are not native activation proof");
});
