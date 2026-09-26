// SB112 — cross-platform install smoke. Run AFTER the packed tarball is installed
// globally (`npm i -g`). Exercises the once-per-machine install, doctor, the evaluate
// path (deny + allow) and a connect against a fake in-process Cloud — all by spawning
// the globally-installed `scopebond` bin, so it proves the real user experience on
// Windows/macOS/Linux × Node 22/24. Exits non-zero on the first failure.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const isWin = process.platform === "win32";
// Prefer SCOPEBOND_CLI (an absolute path to the *installed* dist/cli.js) so we spawn
// `node <cli.js>` with no shell — robust across Windows/macOS/Linux and still proof the
// global install placed the code. Fall back to the bin shim on PATH.
const CLI = process.env.SCOPEBOND_CLI;
const BIN = process.env.SCOPEBOND_BIN || (isWin ? "scopebond.cmd" : "scopebond");

function sb(args, { env = {}, input } = {}) {
  const opts = { input, encoding: "utf8", env: { ...process.env, ...env }, timeout: 30_000, killSignal: "SIGKILL" };
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

// 6. login is honest that device flow is not available yet.
check("login points at connect instead of pretending device flow works", () => {
  const r = sb(["login"], { env: baseEnv });
  assert.equal(r.status, 0, r.out);
  assert.ok(/not available yet/i.test(r.out) && /connect/.test(r.out), r.out);
});

console.log(failures ? `\n${failures} check(s) failed` : `\nall checks passed`);
process.exit(failures ? 1 : 0);
