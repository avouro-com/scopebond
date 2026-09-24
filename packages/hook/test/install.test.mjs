import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveConfigDir, writeHarnessConfig, removeHarnessConfig, isHarnessConfigured,
  absoluteHookCommand, userHome, trustProjectPolicy, untrustedProjectPolicy,
} from "../dist/index.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), "sb-install-"));

function withEnv(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) { saved[k] = process.env[k]; if (overrides[k] === undefined) delete process.env[k]; else process.env[k] = overrides[k]; }
  try { return fn(); } finally { for (const k of Object.keys(overrides)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

test("resolveConfigDir: explicit override wins", () => {
  withEnv({ SCOPEBOND_HOOK_DIR: "/explicit/dir" }, () => {
    assert.equal(resolveConfigDir("/some/project"), "/explicit/dir");
  });
});

test("resolveConfigDir: with a user install, a project policy governs only once trusted, and only as trusted", () => {
  const home = tmp(); const project = tmp();
  writeFileSync(join(home, "policy.json"), "{}");
  withEnv({ SCOPEBOND_HOOK_DIR: undefined, SCOPEBOND_HOME: home, CLAUDE_PROJECT_DIR: undefined }, () => {
    // bare project (no .scopebond/policy.json) → the user home
    assert.equal(resolveConfigDir(project), home);
    // a project that brings its own policy (a cloned repo, or one the agent wrote) → still the user home
    mkdirSync(join(project, ".scopebond"), { recursive: true });
    writeFileSync(join(project, ".scopebond", "policy.json"), '{"clauses":[]}');
    assert.equal(resolveConfigDir(project), home, "an untrusted project policy must not override the user's");
    assert.equal(untrustedProjectPolicy(project), join(project, ".scopebond"));
    // the user trusts it → it governs
    trustProjectPolicy(join(project, ".scopebond"));
    assert.equal(resolveConfigDir(project), join(project, ".scopebond"));
    assert.equal(untrustedProjectPolicy(project), null);
    // it is rewritten afterwards (e.g. by the agent) → trust lapses, the user home governs again
    writeFileSync(join(project, ".scopebond", "policy.json"), '{"clauses":[],"weakened":true}');
    assert.equal(resolveConfigDir(project), home, "an edited policy is no longer trusted");
  });
  rmSync(home, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true });
});

test("resolveConfigDir: without a user install, a scaffolded project dir is used (per-project installs)", () => {
  const home = tmp(); const project = tmp();
  mkdirSync(join(project, ".scopebond"), { recursive: true });
  writeFileSync(join(project, ".scopebond", "policy.json"), "{}");
  withEnv({ SCOPEBOND_HOOK_DIR: undefined, SCOPEBOND_HOME: home, CLAUDE_PROJECT_DIR: undefined }, () => {
    assert.equal(resolveConfigDir(project), join(project, ".scopebond"));
  });
  rmSync(home, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true });
});

test("installers refuse to overwrite an agent config that is not valid JSON", () => {
  const dir = tmp();
  const file = join(dir, "settings.json");
  const original = '{ "permissions": { "allow": ["Bash(npm test)"] }, // a comment makes this invalid\n}';
  writeFileSync(file, original);
  assert.throws(() => writeHarnessConfig(file, "claude", "node cli.js claude"), /not valid JSON/);
  assert.equal(readFileSync(file, "utf8"), original, "the user's file is left unchanged");
  rmSync(dir, { recursive: true, force: true });
});

test("resolveConfigDir: $CLAUDE_PROJECT_DIR is consulted when the payload cwd is bare", () => {
  const proj = tmp();
  mkdirSync(join(proj, ".scopebond"), { recursive: true });
  writeFileSync(join(proj, ".scopebond", "policy.json"), "{}");
  withEnv({ SCOPEBOND_HOOK_DIR: undefined, SCOPEBOND_HOME: tmp(), CLAUDE_PROJECT_DIR: proj }, () => {
    assert.equal(resolveConfigDir("/nonexistent/bare"), join(proj, ".scopebond"));
  });
  rmSync(proj, { recursive: true, force: true });
});

test("writeHarnessConfig registers an absolute command and is idempotent + removable", () => {
  const dir = tmp();
  const file = join(dir, "settings.json");
  const cmd = absoluteHookCommand("/abs/path/cli.js", "claude");
  assert.match(cmd, /cli\.js.* claude$/);
  writeHarnessConfig(file, "claude", cmd);
  assert.equal(isHarnessConfigured(file), true);
  const first = readFileSync(file, "utf8");
  writeHarnessConfig(file, "claude", cmd); // idempotent — no duplicate entry
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(parsed.hooks.PreToolUse.length, 1);
  assert.equal(readFileSync(file, "utf8"), first);
  removeHarnessConfig(file);
  assert.equal(isHarnessConfigured(file), false);
  rmSync(dir, { recursive: true, force: true });
});

test("writeHarnessConfig preserves unrelated user config", () => {
  const dir = tmp(); const file = join(dir, "settings.json");
  writeFileSync(file, JSON.stringify({ theme: "dark", hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-own-hook" }] }] } }));
  writeHarnessConfig(file, "claude", absoluteHookCommand("/abs/cli.js", "claude"));
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(parsed.theme, "dark");
  assert.equal(parsed.hooks.PreToolUse.length, 2); // the user's hook plus ours
  rmSync(dir, { recursive: true, force: true });
});

test("writeHarnessConfig installs a Codex PreToolUse hook with a clear status", () => {
  const dir = tmp(); const file = join(dir, "hooks.json");
  writeHarnessConfig(file, "codex", absoluteHookCommand("/abs/cli.js", "codex"));
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(parsed.hooks.PreToolUse.length, 1);
  assert.equal(parsed.hooks.PreToolUse[0].matcher, undefined, "no matcher means every Codex tool");
  assert.match(parsed.hooks.PreToolUse[0].hooks[0].command, /cli\.js.* codex$/);
  assert.equal(parsed.hooks.PreToolUse[0].hooks[0].statusMessage, "Checking this action with Scopebond");
  assert.equal(parsed.hooks.PreToolUse[0].hooks[0].timeout, 30);
  writeHarnessConfig(file, "codex", absoluteHookCommand("/abs/cli.js", "codex"));
  assert.equal(JSON.parse(readFileSync(file, "utf8")).hooks.PreToolUse.length, 1, "reinstall is idempotent");
  removeHarnessConfig(file);
  assert.equal(isHarnessConfigured(file), false);
  rmSync(dir, { recursive: true, force: true });
});

// --- CLI end-to-end: install / status / doctor / uninstall against a temp HOME ---

function runCli(args, env) {
  try {
    const stdout = execFileSync(process.execPath, [cli, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
    return { status: 0, stdout };
  } catch (error) { return { status: error.status, stdout: String(error.stdout ?? "") + String(error.stderr ?? "") }; }
}

test("install writes the user home + an absolute-path Claude hook, then uninstall removes it", () => {
  const home = tmp();          // agent config home (HOME/USERPROFILE)
  const sbHome = join(tmp(), ".scopebond");
  const env = { HOME: home, USERPROFILE: home, SCOPEBOND_HOME: sbHome, SCOPEBOND_HOOK_DIR: "" };
  delete env.SCOPEBOND_HOOK_DIR;

  const install = runCli(["install", "--claude"], env);
  assert.equal(install.status, 0, install.stdout);
  assert.ok(existsSync(join(sbHome, "policy.json")), "scaffolds the user home");
  const settings = join(home, ".claude", "settings.json");
  assert.ok(existsSync(settings), "writes ~/.claude/settings.json");
  const cfg = JSON.parse(readFileSync(settings, "utf8"));
  const cmd = cfg.hooks.PreToolUse[0].hooks[0].command;
  assert.ok(cmd.includes("cli.js") && cmd.trim().endsWith("claude"), `absolute command: ${cmd}`);
  assert.ok(!cmd.startsWith("npx"), "user-level install uses an absolute path, not npx");

  const status = runCli(["status"], env);
  assert.match(status.stdout, /Claude Code\s+configured/);

  const uninstall = runCli(["uninstall", "--yes"], env);
  assert.equal(uninstall.status, 0, uninstall.stdout);
  const after = JSON.parse(readFileSync(settings, "utf8"));
  assert.equal((after.hooks.PreToolUse ?? []).length, 0, "uninstall removes our entry");
  assert.ok(existsSync(join(sbHome, "policy.json")), "uninstall keeps keys without --purge");

  rmSync(home, { recursive: true, force: true }); rmSync(sbHome, { recursive: true, force: true });
});

test("doctor reports node ok and finds the installed policy", () => {
  const home = tmp(); const sbHome = join(tmp(), ".scopebond");
  const env = { HOME: home, USERPROFILE: home, SCOPEBOND_HOME: sbHome };
  runCli(["install", "--claude"], env);
  const doctor = runCli(["doctor"], { ...env, SCOPEBOND_HOOK_DIR: sbHome });
  assert.equal(doctor.status, 0, doctor.stdout);
  assert.match(doctor.stdout, /node\s+\d+\.\d+\.\d+ ok/);
  assert.match(doctor.stdout, /All good\./);
  rmSync(home, { recursive: true, force: true }); rmSync(sbHome, { recursive: true, force: true });
});

test("install --codex writes ~/.codex/hooks.json and explains the one approval step", () => {
  const home = tmp(); const sbHome = join(tmp(), ".scopebond");
  const env = { HOME: home, USERPROFILE: home, SCOPEBOND_HOME: sbHome };
  const install = runCli(["install", "--codex"], env);
  assert.equal(install.status, 0, install.stdout);
  const hooks = join(home, ".codex", "hooks.json");
  assert.ok(existsSync(hooks));
  assert.match(install.stdout, /run `\/hooks`/i);
  assert.match(install.stdout, /choose Trust/i);
  const status = runCli(["status"], env);
  assert.match(status.stdout, /Codex\s+configured/);
  runCli(["uninstall", "--yes"], env);
  assert.equal(JSON.parse(readFileSync(hooks, "utf8")).hooks.PreToolUse.length, 0);
  rmSync(home, { recursive: true, force: true }); rmSync(sbHome, { recursive: true, force: true });
});

test("login points at connect and does not pretend device flow works", () => {
  const r = runCli(["login"], {});
  assert.equal(r.status, 0);
  assert.match(r.stdout, /not available yet/i);
  assert.match(r.stdout, /connect/);
});
