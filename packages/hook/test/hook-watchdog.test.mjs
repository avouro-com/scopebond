// The deadline holds when the main thread is stuck. A timer cannot fire while synchronous work (a regular expression that
// backtracks, a loop that does not end) holds the thread that decides, and an agent that waits past its own limit runs the
// action unchecked. The deadline's watchdog thread interrupts the main thread instead and the deny is written in each agent's
// own format. Here the real command line is run with a preload that stalls the main thread for good once the event is read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { scaffold } from "../dist/index.js";
import { ENFORCE } from "./enforce-all.mjs";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const preload = pathToFileURL(fileURLToPath(new URL("./fixtures/stall-main-thread.mjs", import.meta.url))).href;
const MARKER = "scopebond-test-stall-main-thread";
const DEADLINE_MS = 1500;
/** Past this the call is counted as never answered (the agent would have run the action). */
const GIVE_UP_MS = 20_000;

function runStalled(harness, event, stall) {
  const root = mkdtempSync(join(tmpdir(), "sb-watchdog-"));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const dir = join(root, "project", ".scopebond");
  scaffold(dir, ENFORCE);
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, ["--import", preload, cli, harness], {
      env: {
        ...process.env, HOME: home, USERPROFILE: home, SCOPEBOND_HOME: join(home, ".scopebond"), SCOPEBOND_HOOK_DIR: dir,
        SCOPEBOND_HOOK_FLUSH_MS: "0", SCOPEBOND_HOOK_DEADLINE_MS: String(DEADLINE_MS), SCOPEBOND_TEST_STALL: stall,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const giveUp = setTimeout(() => child.kill("SIGKILL"), GIVE_UP_MS);
    child.on("close", (status, signal) => { clearTimeout(giveUp); resolve({ status, signal, stdout, stderr, ms: Date.now() - started }); });
    child.stdin.end(JSON.stringify(event));
  });
}

const write = { tool_name: "Write", tool_input: { file_path: "src/app.ts", content: MARKER }, cwd: process.cwd() };
const cases = [
  ["claude", write, (r) => r.status === 2 && JSON.parse(r.stdout).hookSpecificOutput.permissionDecision === "deny"],
  ["codex", write, (r) => r.status === 0 && JSON.parse(r.stdout).hookSpecificOutput.permissionDecision === "deny"],
  ["cursor", { hook_event_name: "beforeShellExecution", command: `echo ${MARKER}`, cwd: process.cwd() }, (r) => r.status === 0 && JSON.parse(r.stdout).permission === "deny"],
  ["copilot", { hook_event_name: "PreToolUse", session_id: "s", ...write }, (r) => r.status === 2 && JSON.parse(r.stdout).permissionDecision === "deny"],
];

for (const [harness, event, denied] of cases) {
  test(`${harness}: a main thread stuck in a loop that never ends is still denied at the deadline`, async () => {
    const r = await runStalled(harness, event, "loop");
    assert.ok(r.signal === null, `answered before the test gave up after ${GIVE_UP_MS} ms (killed: ${r.signal}, ${r.ms} ms)`);
    assert.ok(denied(r), `expected a deny, got exit ${r.status}: ${r.stdout} ${r.stderr}`);
    assert.match(r.stdout, /no decision within 2 s/);
    assert.ok(r.ms < DEADLINE_MS + 8_000, `denied near the deadline (${r.ms} ms)`);
  });
}

test("claude: a main thread stuck in a regular expression that backtracks is still denied at the deadline", async () => {
  const r = await runStalled("claude", write, "regex");
  assert.ok(r.signal === null, `answered before the test gave up (killed: ${r.signal}, ${r.ms} ms)`);
  assert.equal(r.status, 2, r.stderr);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.match(r.stderr, /no decision within/);
});

test("a call that decides is not touched by the watchdog, and the process does not wait for it", async () => {
  const root = mkdtempSync(join(tmpdir(), "sb-watchdog-"));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const dir = join(root, "project", ".scopebond");
  scaffold(dir, ENFORCE);
  const r = await new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [cli, "claude"], {
      env: { ...process.env, HOME: home, USERPROFILE: home, SCOPEBOND_HOME: join(home, ".scopebond"), SCOPEBOND_HOOK_DIR: dir, SCOPEBOND_HOOK_FLUSH_MS: "0", SCOPEBOND_HOOK_DEADLINE_MS: "3000" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.resume();
    child.on("close", (status) => resolve({ status, stdout, ms: Date.now() - started }));
    child.stdin.end(JSON.stringify({ ...write, tool_input: { file_path: "src/app.ts", content: "x" } }));
  });
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.stdout.trim(), "", "an allowed action stays silent");
  assert.ok(r.ms < 3000, `exited on its decision, not at the deadline (${r.ms} ms)`);
});
