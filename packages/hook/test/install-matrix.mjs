// SB112 — cross-platform install smoke. Run AFTER the packed tarball is installed
// globally (`npm i -g`). Exercises the once-per-machine install, doctor, the evaluate
// path (deny + allow) and a connect against a fake in-process Cloud — all by spawning
// the globally-installed `scopebond` bin, so it proves the real user experience on
// Windows/macOS/Linux × Node 22/24. Exits non-zero on the first failure.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeCloud } from "./fake-cloud.mjs";

const isWin = process.platform === "win32";
// Prefer SCOPEBOND_CLI (an absolute path to the *installed* dist/cli.js) so we spawn
// `node <cli.js>` with no shell — robust across Windows/macOS/Linux and still proof the
// global install placed the code. Fall back to the bin shim on PATH.
const CLI = process.env.SCOPEBOND_CLI;
const BIN = process.env.SCOPEBOND_BIN || (isWin ? "scopebond.cmd" : "scopebond");

/** Like sb(), but the event loop keeps running, so an in-process fake Cloud can answer. */
function sbAsync(args, { env = {}, input, cwd, onOutput } = {}) {
  return new Promise((resolve) => {
    const opts = { cwd, env: { ...process.env, ...env } };
    const child = CLI ? spawn(process.execPath, [CLI, ...args], opts) : spawn(BIN, args, { ...opts, shell: isWin });
    let out = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    const take = (chunk) => { out += chunk; onOutput?.(out); };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("close", (status, signal) => { clearTimeout(timer); resolve({ status: signal ? -1 : status, out }); });
    child.stdin.end(input ?? "");
  });
}

function sb(args, { env = {}, input, cwd } = {}) {
  const opts = { input, cwd, encoding: "utf8", env: { ...process.env, ...env }, timeout: 30_000, killSignal: "SIGKILL" };
  const res = CLI
    ? spawnSync(process.execPath, [CLI, ...args], opts)
    : spawnSync(BIN, args, { ...opts, shell: isWin });
  if (res.signal) return { status: -1, out: `killed by ${res.signal} (timed out?)\n` + ((res.stdout ?? "") + (res.stderr ?? "")) };
  return { status: res.status, out: (res.stdout ?? "") + (res.stderr ?? "") };
}

const home = mkdtempSync(join(tmpdir(), "sb-home-"));
const sbHome = join(mkdtempSync(join(tmpdir(), "sb-sbhome-")), ".scopebond");
const baseEnv = { HOME: home, USERPROFILE: home, SCOPEBOND_HOME: sbHome };
delete baseEnv.SCOPEBOND_HOOK_DIR;

let failures = 0;
const check = (name, fn) => { try { fn(); console.log(`  ✓ ${name}`); } catch (e) { failures++; console.error(`  ✗ ${name}\n    ${e.message}`); } };

console.log(`install-matrix on ${process.platform} node ${process.versions.node}`);

// 1. Global bin is on PATH and prints help. Asserted on what the help has to contain to be
// useful — the invocation form and the command list — rather than one exact opening phrase.
check("the scopebond bin is installed and runnable", () => {
  const r = sb([]);
  assert.match(r.out, /usage: scopebond-hook <command>/i, `no usage line: ${r.out}`);
  for (const command of ["init", "status", "doctor", "log", "verify", "test"]) {
    assert.match(r.out, new RegExp(`\\n\\s+${command}\\s{2,}\\S`), `help does not list \`${command}\`: ${r.out}`);
  }
});

// 2. User-level install scaffolds the home and writes an absolute-path Claude hook.
check("install scaffolds the user home and configures Claude Code by absolute path", () => {
  const r = sb(["install", "--claude"], { env: baseEnv });
  assert.equal(r.status, 0, r.out);
  assert.ok(existsSync(join(sbHome, "policy.json")), "policy.json in the user home");
  const settings = join(home, ".claude", "settings.json");
  assert.ok(existsSync(settings), "~/.claude/settings.json written");
  const cmd = JSON.parse(readFileSync(settings, "utf8")).hooks.PreToolUse[0].hooks[0].command;
  assert.ok(!cmd.startsWith("npx"), "user-level install uses an absolute path, not npx");
  assert.ok(cmd.trim().endsWith("claude"), "the hook command targets the claude subcommand");
});

// 3. doctor is green against the installed home.
check("doctor reports node ok and finds the policy", () => {
  const r = sb(["doctor"], { env: { ...baseEnv, SCOPEBOND_HOOK_DIR: sbHome } });
  assert.equal(r.status, 0, r.out);
  assert.ok(/All good\./.test(r.out), r.out);
});

// 3b. SB302: a project's own entry beside the user-level one makes the agent ask twice per action.
check("a project entry beside the user-level one is reported, and dedupe keeps the user-level one", () => {
  const proj = mkdtempSync(join(tmpdir(), "sb-dupes-"));
  mkdirSync(join(proj, ".claude"), { recursive: true });
  const projectSettings = join(proj, ".claude", "settings.json");
  writeFileSync(projectSettings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "npx -y @scopebond/hook@0.16.0 claude" }] }] } }));
  const before = sb(["status"], { env: baseEnv, cwd: proj });
  assert.match(before.out, /DUPLICATE\s+Claude Code runs the Scopebond hook 2 times/, before.out);
  const fixed = sb(["dedupe"], { env: baseEnv, cwd: proj });
  assert.equal(fixed.status, 0, fixed.out);
  assert.doesNotMatch(sb(["status"], { env: baseEnv, cwd: proj }).out, /DUPLICATE/);
  const user = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
  assert.equal(user.hooks.PreToolUse.length, 1, "the user-level entry stays");
});

// 4. Evaluate: a protected-branch push is denied (exit 2); a plain command is allowed (exit 0).
check("a push to main is denied through the installed bin", () => {
  const r = sb(["claude"], { env: { ...baseEnv, SCOPEBOND_HOOK_DIR: sbHome }, input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push origin main" } }) });
  assert.equal(r.status, 2, `expected deny (exit 2), got ${r.status}: ${r.out}`);
});
check("a benign command is allowed (exit 0)", () => {
  const r = sb(["claude"], { env: { ...baseEnv, SCOPEBOND_HOOK_DIR: sbHome }, input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls -la" } }) });
  assert.equal(r.status, 0, `expected allow (exit 0), got ${r.status}: ${r.out}`);
});

// 5. connect is wired and fails closed on a bad enrollment without hanging.
//    (A live enrollment against a fake Cloud is covered in-process by cloud.test.mjs.)
check("connect exists and rejects an unreadable enrollment fast (exit 1, no hang)", () => {
  const connectDir = join(mkdtempSync(join(tmpdir(), "sb-connect-")), ".scopebond");
  mkdirSync(connectDir, { recursive: true });
  const r = sb(["connect", "http://127.0.0.1:9", "not-a-valid-bundle", "--no-install"], { env: { ...baseEnv, SCOPEBOND_HOOK_DIR: connectDir } });
  assert.equal(r.status, 1, `expected a graceful exit 1, got ${r.status}: ${r.out}`);
  assert.ok(!existsSync(join(connectDir, "cloud.json")), "no cloud.json on a failed connect");
});

// 6. login without a workspace URL says what it needs.
check("login without a workspace URL explains what it needs", () => {
  const r = sb(["login"], { env: baseEnv });
  assert.equal(r.status, 1, r.out);
  assert.ok(/login <workspace-url>/.test(r.out), r.out);
});

// 7. The real device-code login, end to end: the computer asks for a code, a person approves it
// in the workspace (here through the fake Cloud's control route), and the computer is connected
// in the user's home, not the folder it was run from. Then one action reaches the workspace.
async function checkAsync(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failures++; console.error(`  ✗ ${name}
    ${e.message}`); }
}
const cloud = await startFakeCloud();
const loginHome = mkdtempSync(join(tmpdir(), "sb-login-home-"));
const loginSbHome = join(loginHome, ".scopebond");
const loginEnv = { HOME: loginHome, USERPROFILE: loginHome, SCOPEBOND_HOME: loginSbHome };
const projectFolder = mkdtempSync(join(tmpdir(), "sb-login-project-"));
await checkAsync("login: request a code, approve it in the workspace, cloud.json lands in the home", async () => {
  let approved = false;
  const r = await sbAsync(["login", cloud.url, "--claude"], {
    env: loginEnv, cwd: projectFolder,
    onOutput: (out) => {
      const code = /code\s+([B-Z]{4}-[B-Z]{4})/.exec(out)?.[1];
      if (code && !approved) approved = cloud.approve(code);
    },
  });
  assert.equal(r.status, 0, `${r.out}
workspace saw: ${JSON.stringify(cloud.state())}`);
  assert.ok(approved, `the CLI never showed a code to approve: ${r.out}`);
  assert.match(r.out, /Approved/, r.out);
  assert.ok(existsSync(join(loginSbHome, "cloud.json")), `cloud.json in the home (in the project folder instead: ${existsSync(join(projectFolder, ".scopebond", "cloud.json"))})`);
  assert.ok(!existsSync(join(projectFolder, ".scopebond")), "nothing written to the folder it was run from");
  const settings = join(loginHome, ".claude", "settings.json");
  assert.ok(existsSync(settings), "the hook is in the user-level Claude Code settings");
  assert.equal(cloud.state().code_requests[0]?.harness, "claude");
});
await checkAsync("one record is delivered to the workspace after login", async () => {
  const before = cloud.state().ingested;
  const r = await sbAsync(["claude"], { env: loginEnv, cwd: projectFolder, input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push origin main" }, cwd: projectFolder }) });
  assert.equal(r.status, 2, `expected deny (exit 2): ${r.out}`);
  const f = await sbAsync(["flush"], { env: loginEnv, cwd: projectFolder });
  assert.equal(f.status, 0, f.out);
  const state = cloud.state();
  assert.equal(state.ingested - before, 1, `expected exactly one delivered record, got ${state.ingested - before}: ${f.out}`);
  assert.equal(state.ingested_results.at(-1), "deny");
});
await cloud.close();

console.log(failures ? `\n${failures} check(s) failed` : `\nall checks passed`);
process.exit(failures ? 1 : 0);
