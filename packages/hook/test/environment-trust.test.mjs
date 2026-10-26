// What a hook call believes of its environment.
//
// - A signed build (the single executable, the signed engine bundle) reads SCOPEBOND_HOME, SCOPEBOND_POLICY_KEYS_JSON,
//   SCOPEBOND_PACK_ENGINE_LEVEL and SCOPEBOND_POLICY_SYNC… only from the hook's command line (`--setting NAME=VALUE`, where
//   the installer puts them); an npm install keeps reading them from the environment. SCOPEBOND_AS_SIGNED_BUILD=1 reads them
//   as the signed build does, which is how these tests reach that path.
// - A hook call refuses to decide while NODE_OPTIONS or NODE_PATH is set (they load code into the deciding process); the
//   other commands still run, and doctor names the variable.
// - Scopebond's own home is in the operating system account's home folder, not wherever HOME or USERPROFILE points.
// - Setting any of these variables for a coding agent, or for every later session, is a configuration change.
// - With SCOPEBOND_HOOK_DIR naming a trusted project, what may let a blocked action through still comes from the user home.
//
// Every spawned hook here gets its own Scopebond home (SCOPEBOND_HOME, or `--setting SCOPEBOND_HOME=…` in the signed
// reading), so nothing reads or writes this computer's own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  scaffold, mapClaudeToolUse, createHookRuntime, trustProjectPolicy, userHome, engineHome, homeFolders, policyKeys, packEngineLevel,
  setting, settingsEnv, commandLineSettings, withoutSettingArgs, ignoredSettings, accountHome, codeLoadingVariables, MANAGED_DOC_FILE, digestRules,
} from "../dist/index.js";
import { actionKey } from "../dist/override.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const PUSH = "git push origin main";

/** Run `fn` with these environment variables (undefined removes one), then put them back. */
function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

/** The environment a spawned hook gets: this one without anything that would change what it reads, plus `extra`. */
function cleanEnv(profile, extra = {}) {
  const env = { ...process.env, HOME: profile, USERPROFILE: profile, SCOPEBOND_POLICY_SYNC: "off", SCOPEBOND_TELEMETRY: "off", SCOPEBOND_OBSERVATIONS_HEARTBEAT: "off" };
  for (const k of Object.keys(env)) {
    if (["NODE_OPTIONS", "NODE_PATH", "SCOPEBOND_HOOK_DIR", "CLAUDE_PROJECT_DIR", "SCOPEBOND_AS_SIGNED_BUILD", "SCOPEBOND_HOME"].includes(k.toUpperCase())) delete env[k];
  }
  return { ...env, ...extra };
}

/** One Claude Code PreToolUse call of `command` from `cwd`; "deny" or "allow", with the raw result. */
function claude(env, cwd, args = [], command = PUSH) {
  const r = spawnSync(process.execPath, [cli, "claude", ...args], {
    input: JSON.stringify({ hook_event_name: "PreToolUse", cwd, tool_name: "Bash", tool_input: { command }, tool_use_id: "t1", session_id: "s1" }),
    encoding: "utf8", env, cwd, timeout: 60_000,
  });
  const out = r.stdout.trim() ? JSON.parse(r.stdout) : null;
  return { decision: out?.hookSpecificOutput?.permissionDecision === "deny" ? "deny" : "allow", reason: out?.hookSpecificOutput?.permissionDecisionReason ?? "", r };
}

// ---- 1. signed builds read these settings from the command line only ---------------------------------------------------

test("a signed build reads each setting from the hook's command line, never from the environment; npm reads both", () => {
  const env = {
    SCOPEBOND_HOME: "/env/home", SCOPEBOND_POLICY_KEYS_JSON: "[]", SCOPEBOND_PACK_ENGINE_LEVEL: "1",
    SCOPEBOND_POLICY_SYNC: "off", SCOPEBOND_POLICY_SYNC_MS: "1", SCOPEBOND_POLICY_SYNC_LATER: "x",
  };
  for (const name of Object.keys(env)) {
    assert.equal(setting(name, env, [], true), undefined, `${name}: the environment is not read by a signed build`);
    assert.equal(setting(name, env, [], false), env[name], `${name}: an npm install reads the environment`);
    assert.equal(setting(name, env, ["claude", "--setting", `${name}=from-installer`], true), "from-installer", `${name}: the command line is read`);
  }
  // Only these settings are taken from the command line, and the commands never see the flags.
  assert.deepEqual([...commandLineSettings(["claude", "--setting", "SCOPEBOND_HOME=/a", "--setting", "PATH=/x", "--setting", "bad"])], [["SCOPEBOND_HOME", "/a"]]);
  assert.deepEqual(withoutSettingArgs(["claude", "--setting", "SCOPEBOND_HOME=/a", "--strict"]), ["claude", "--strict"]);
  assert.deepEqual(withoutSettingArgs(["claude", "--setting", "PATH=/x"]), ["claude", "--setting", "PATH=/x"]);
  // What doctor reports as not used.
  assert.deepEqual(ignoredSettings({ SCOPEBOND_HOME: "/x", SCOPEBOND_POLICY_SYNC: "off", PATH: "/bin" }, true), ["SCOPEBOND_HOME", "SCOPEBOND_POLICY_SYNC"]);
  assert.deepEqual(ignoredSettings({ SCOPEBOND_HOME: "/x" }, false), []);
});

test("read as the signed build reads them, extra rules keys and a lower pack engine level in the environment do nothing", () => {
  const { publicKey } = generateKeyPairSync("ed25519");
  const extra = { key_id: "pol_test_env", public_key: publicKey.export({ type: "spki", format: "pem" }).toString(), not_before: "2026-01-01T00:00:00Z", not_after: "2030-01-01T00:00:00Z" };
  const vars = { SCOPEBOND_POLICY_KEYS_JSON: JSON.stringify([extra]), SCOPEBOND_PACK_ENGINE_LEVEL: "1" };
  withEnv({ ...vars, SCOPEBOND_AS_SIGNED_BUILD: undefined }, () => {
    assert.ok(policyKeys().some((k) => k.key_id === "pol_test_env"), "an npm install trusts the key the environment adds");
    assert.equal(packEngineLevel(), 1);
  });
  withEnv({ ...vars, SCOPEBOND_AS_SIGNED_BUILD: "1" }, () => {
    assert.ok(!policyKeys().some((k) => k.key_id === "pol_test_env"), "the signed build does not");
    assert.ok(packEngineLevel() > 1, "nor lowers its pack engine level");
    assert.deepEqual(settingsEnv(), {});
  });
});

test("a signed build's hook call uses the home its command line names, not SCOPEBOND_HOME", () => {
  const root = mkdtempSync(join(tmpdir(), "sb-envtrust-home-"));
  try {
    const profile = join(root, "profile");
    const envHome = join(root, "env-home");
    const argvHome = join(root, "argv-home");
    const work = join(root, "work");
    for (const d of [profile, work]) mkdirSync(d, { recursive: true });
    scaffold(envHome, { enforce: ["protect-branches"] });
    scaffold(argvHome);
    const npm = cleanEnv(profile, { SCOPEBOND_HOME: envHome });
    assert.equal(claude(npm, work).decision, "deny", "an npm install reads SCOPEBOND_HOME: that home's rule blocks the push");
    const signed = cleanEnv(profile, { SCOPEBOND_HOME: envHome, SCOPEBOND_AS_SIGNED_BUILD: "1" });
    const call = claude(signed, work, ["--setting", `SCOPEBOND_HOME=${argvHome}`]);
    assert.equal(call.r.status, 0, call.r.stderr);
    assert.equal(call.decision, "allow", "the signed reading uses the installer's home, whose rules let the push through");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---- 2. NODE_OPTIONS / NODE_PATH ---------------------------------------------------------------------------------------

test("a hook call refuses to decide while NODE_OPTIONS or NODE_PATH is set; doctor and status still run and doctor names it", () => {
  const root = mkdtempSync(join(tmpdir(), "sb-envtrust-node-"));
  try {
    const profile = join(root, "profile");
    const home = join(profile, ".scopebond");
    mkdirSync(profile, { recursive: true });
    scaffold(home);
    const base = cleanEnv(profile, { SCOPEBOND_HOME: home });
    assert.equal(claude(base, root, [], "ls").decision, "allow", "without them, an ordinary action is allowed");

    const withOptions = claude({ ...base, NODE_OPTIONS: "--max-old-space-size=512" }, root, [], "ls");
    assert.equal(withOptions.decision, "deny");
    assert.equal(withOptions.r.status, 2);
    assert.match(withOptions.reason, /NODE_OPTIONS/);
    assert.match(withOptions.reason, /Remove it/);

    const cursor = spawnSync(process.execPath, [cli, "cursor"], {
      input: JSON.stringify({ hook_event_name: "beforeShellExecution", command: "ls", cwd: root }),
      encoding: "utf8", env: { ...base, NODE_PATH: root }, cwd: root, timeout: 60_000,
    });
    const answer = JSON.parse(cursor.stdout);
    assert.equal(answer.permission, "deny");
    assert.match(answer.agentMessage, /NODE_PATH/);

    const env = { ...base, NODE_OPTIONS: "--max-old-space-size=512", NODE_PATH: root };
    const doctor = spawnSync(process.execPath, [cli, "doctor", "--json"], { encoding: "utf8", env, cwd: root, timeout: 120_000 });
    const report = JSON.parse(doctor.stdout);
    const check = report.checks.find((c) => c.name === "environment");
    assert.equal(check.ok, false);
    assert.match(check.detail, /NODE_OPTIONS, NODE_PATH/);
    assert.match(check.fix, /remove them/);
    const status = spawnSync(process.execPath, [cli, "status", "--json"], { encoding: "utf8", env, cwd: root, timeout: 120_000 });
    assert.ok(JSON.parse(status.stdout), status.stderr);
    assert.deepEqual(codeLoadingVariables({ NODE_OPTIONS: " ", NODE_PATH: "" }), [], "blank values load nothing");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---- 3. the home folder is the operating system account's ----------------------------------------------------------------

test("Scopebond's home is in the account's home folder, wherever HOME and USERPROFILE point; doctor says when they differ", () => {
  const account = userInfo().homedir;
  assert.equal(accountHome(), account);
  const elsewhere = mkdtempSync(join(tmpdir(), "sb-envtrust-moved-"));
  try {
    withEnv({ HOME: elsewhere, USERPROFILE: elsewhere, SCOPEBOND_HOME: undefined, SCOPEBOND_AS_SIGNED_BUILD: undefined }, () => {
      assert.equal(userHome(), join(account, ".scopebond"), "only paths are worked out here: nothing is read");
      assert.equal(engineHome(), join(account, ".scopebond"));
      assert.equal(engineHome({}), join(account, ".scopebond"));
      assert.equal(homeFolders()[0], account.replace(/\\/g, "/").replace(/\/+$/, ""), "the account's home is masked first");
    });
    const home = join(elsewhere, "sb-home");
    scaffold(home);
    const doctor = spawnSync(process.execPath, [cli, "doctor"], { encoding: "utf8", env: cleanEnv(elsewhere, { SCOPEBOND_HOME: home }), cwd: elsewhere, timeout: 120_000 });
    assert.match(doctor.stdout, /home folder\s+.*HOME\/USERPROFILE names .*which Scopebond does not use/);
  } finally { rmSync(elsewhere, { recursive: true, force: true }); }
});

// ---- 4. these variables are configuration changes -------------------------------------------------------------------------

test("starting a coding agent with, or setting for every later session, a variable that changes what a hook call trusts is a switch-off", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-envtrust-moves-"));
  try {
    scaffold(dir);
    const runtime = createHookRuntime({ policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"), attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db") });
    const decide = async (command) => (await runtime.evaluate(mapClaudeToolUse({ tool_name: "Bash", tool_input: { command }, cwd: "/repo" }))).decision;
    for (const command of [
      "setx NODE_OPTIONS --require=C:\\tmp\\x.js",
      "setx NODE_PATH C:\\tmp\\mods",
      "setx SCOPEBOND_POLICY_KEYS_JSON []",
      "setx SCOPEBOND_PACK_ENGINE_LEVEL 1",
      "launchctl setenv SCOPEBOND_POLICY_SYNC off",
      "launchctl setenv SCOPEBOND_POLICY_SYNC_MS 1",
      "NODE_OPTIONS=--require=/tmp/x.js claude -p hi",
      "export SCOPEBOND_POLICY_KEYS_JSON='[]' && codex exec x",
      "SCOPEBOND_POLICY_SYNC=off claude -p hi",
    ]) {
      assert.equal(await decide(command), "deny", command);
    }
    for (const command of ["NODE_OPTIONS=--max-old-space-size=4096 node build.js", "setx EDITOR vim"]) {
      assert.equal(await decide(command), "allow", command);
    }
    runtime.close?.();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- 5. SCOPEBOND_HOOK_DIR naming a trusted project ------------------------------------------------------------------------

const rulesDoc = (installation) => {
  const rules = {
    "push-protected": { mode: "override", override: { reason_min: 10, minutes: 0, daily_limit: 50, harness_prompt: false } },
    "force-push-protected": { mode: "block" }, "destructive-shell": { mode: "block" }, "secret-read": { mode: "block" }, "ci-config-write": { mode: "block" }, "network-egress": { mode: "monitor" },
  };
  return { type: "scopebond:managed-rules", version: 1, revision: 1, export_id: `rev-1-${installation}`, environment_id: "env-x", agent_id: "agent-x", installation_id: installation, rules_digest: digestRules(rules), rules };
};
/** "A person may allow pushes", and a standing allowance for this push, in `folder`. */
function plantGrant(folder) {
  const key = actionKey(mapClaudeToolUse({ cwd: "/repo", tool_name: "Bash", tool_input: { command: PUSH } }).find((m) => m.intent.action_type === "git.push").intent);
  writeFileSync(join(folder, MANAGED_DOC_FILE), JSON.stringify(rulesDoc("x")));
  const now = Date.now();
  writeFileSync(join(folder, "allowances.json"), JSON.stringify({ version: 1, items: [{
    id: "alw_AAAAAAAAAAAAAAAAAAAAAA", rule: "push-protected", action_key: key, scope: "computer", os_user_digest: null,
    state: "active", once: false, reason_digest: "1".repeat(64), reason_length: 20, created_by: "workspace",
    created_at: new Date(now).toISOString(), expires_at: new Date(now + 365 * 864e5).toISOString(), uses: 0,
  }] }));
}

test("with SCOPEBOND_HOOK_DIR naming a trusted project, allowances and rules documents there are not honoured; the home's are", () => {
  const root = mkdtempSync(join(tmpdir(), "sb-envtrust-hookdir-"));
  try {
    const profile = join(root, "profile");
    const home = join(profile, ".scopebond");
    const project = join(root, "repo");
    const config = join(project, ".scopebond");
    mkdirSync(profile, { recursive: true });
    scaffold(home);
    scaffold(config, { enforce: ["protect-branches"] });
    withEnv({ SCOPEBOND_HOME: home, SCOPEBOND_HOOK_DIR: undefined }, () => trustProjectPolicy(config));
    const env = cleanEnv(profile, { SCOPEBOND_HOME: home, SCOPEBOND_HOOK_DIR: config });
    assert.equal(claude(env, project).decision, "deny", "the trusted project's policy governs through the override and blocks the push");
    plantGrant(config);
    assert.equal(claude(env, project).decision, "deny", "files beside the trusted policy never allow what it blocks");
    assert.equal(JSON.parse(readFileSync(join(config, "allowances.json"), "utf8")).items[0].uses, 0, "the planted allowance was never used");
    plantGrant(home);
    assert.equal(claude(env, project).decision, "allow", "the person's own allowance, in the user home, applies");
    assert.equal(JSON.parse(readFileSync(join(home, "allowances.json"), "utf8")).items[0].uses, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
