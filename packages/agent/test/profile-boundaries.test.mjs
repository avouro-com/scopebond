import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { automaticHarnesses, integrationProfile, INTEGRATION_PROFILE_FILE, writeIntegrationIntent, writeHarnessConfig, removeHarnessConfig, userHarnessFile } from "@scopebond/hook";
import { useNativeHookEntries } from "../dist/hook-entries.js";
import { startFirstSignIn } from "../dist/signin.js";
import { startFakeCloud } from "@scopebond/fake-cloud";
import { executionEnvironment } from "../dist/execution-environment.js";
import { repairSetup } from "../dist/service.js";
import { integrationHealth } from "../dist/integration-health.js";
import { startDiscoveryLoop } from "../dist/discovery-loop.js";

function profiles(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "profile-boundary-")));
  const home = join(root, "first"), other = join(root, "second");
  mkdirSync(home); mkdirSync(other); mkdirSync(join(home, "state"));
  const previous = { ...process.env };
  Object.assign(process.env, { HOME: home, USERPROFILE: home, SCOPEBOND_HOME: join(home, "state"), COPILOT_HOME: join(home, ".copilot") });
  t.after(() => { for (const key of ["HOME", "USERPROFILE", "SCOPEBOND_HOME", "COPILOT_HOME"]) {
    if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  } });
  return { root, home, other };
}

test("automatic repair does not enroll a tool in another user profile", (t) => {
  const { other } = profiles(t);
  process.env.COPILOT_HOME = join(other, ".copilot");
  mkdirSync(process.env.COPILOT_HOME);
  const settings = join(process.env.COPILOT_HOME, "settings.json");
  writeFileSync(settings, '{"theme":"dark"}');
  assert.deepEqual(automaticHarnesses(["copilot"]), []);
  assert.deepEqual(repairSetup(["copilot"]).repaired, []);
  assert.equal(existsSync(join(process.env.COPILOT_HOME, "hooks", "scopebond.json")), false);
  assert.equal(readFileSync(settings, "utf8"), '{"theme":"dark"}');
  const health = integrationHealth(["copilot"])[0];
  assert.equal(health.reason, "profile_boundary");
  assert.equal(health.presence, "unknown");
  assert.deepEqual(health.capabilities.verified, []);
});

test("discovery never watches another profile or a linked tool directory", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { home, other } = profiles(t);
  process.env.COPILOT_HOME = join(other, ".copilot");
  mkdirSync(process.env.COPILOT_HOME);
  symlinkSync(other, join(home, ".codex"), process.platform === "win32" ? "junction" : "dir");
  const watched = [];
  const loop = startDiscoveryLoop({ reconcile: async () => {}, watchDirectory: (directory) => { watched.push(directory); return { close() {} }; } });
  t.after(loop.stop);
  t.mock.timers.tick(1); await new Promise(setImmediate);
  assert.deepEqual(watched, [home]);
});

test("an explicit tool home inside the selected profile remains eligible", (t) => {
  const { home } = profiles(t);
  process.env.COPILOT_HOME = join(home, "apps", "copilot-config");
  mkdirSync(process.env.COPILOT_HOME, { recursive: true });
  writeFileSync(join(process.env.COPILOT_HOME, "settings.json"), "{}");
  assert.deepEqual(automaticHarnesses(["copilot"]), ["copilot"]);
  repairSetup(["copilot"]);
  assert.equal(existsSync(join(process.env.COPILOT_HOME, "hooks", "scopebond.json")), true);
});

test("a missing profile does not broaden discovery to its parent", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { home } = profiles(t);
  const missing = join(home, "not-created");
  process.env.HOME = missing; process.env.USERPROFILE = missing;
  process.env.COPILOT_HOME = join(missing, ".copilot");
  const watched = [];
  const loop = startDiscoveryLoop({ reconcile: async () => {}, watchDirectory: (directory) => { watched.push(directory); return { close() {} }; } });
  t.after(loop.stop);
  t.mock.timers.tick(1); await new Promise(setImmediate);
  assert.deepEqual(watched, []);
});

test("profile identity is stable across channels but a copied state directory cannot authorize another profile", (t) => {
  const { home, other } = profiles(t);
  const dir = join(home, "state");
  const first = integrationProfile(dir);
  assert.equal(first.state, "bound"); assert.match(first.id, /^[a-f0-9-]{36}$/);
  assert.deepEqual(integrationProfile(dir), first);
  const health = integrationHealth(["claude", "codex"]);
  assert.deepEqual(health.map((h) => h.scope.profile.id), [first.id, first.id]);
  assert.equal(JSON.stringify(health).includes(home), false);
  assert.equal(readFileSync(join(dir, INTEGRATION_PROFILE_FILE), "utf8").includes(home), false);
  process.env.HOME = other; process.env.USERPROFILE = other;
  assert.deepEqual(integrationProfile(dir), { id: null, state: "mismatch" });
  assert.deepEqual(automaticHarnesses(["claude", "codex"], dir), []);
  assert.equal(integrationHealth(["claude"], Date.now(), dir)[0].reason, "profile_boundary");
  const otherState = join(other, "state"); mkdirSync(otherState);
  const second = integrationProfile(otherState);
  assert.equal(second.state, "bound"); assert.notEqual(second.id, first.id);
});

test("unreadable profile bindings never get silently replaced or authorize repair", (t) => {
  const { home } = profiles(t);
  const dir = join(home, "state"), file = join(dir, INTEGRATION_PROFILE_FILE);
  writeFileSync(file, "bad binding");
  assert.deepEqual(integrationProfile(dir), { id: null, state: "unknown" });
  assert.deepEqual(automaticHarnesses(["claude"], dir), []);
  assert.equal(readFileSync(file, "utf8"), "bad binding");
});

test("installation preview does not create a profile binding", (t) => {
  const { home } = profiles(t);
  mkdirSync(join(home, ".codex"));
  const output = execFileSync(process.execPath, [fileURLToPath(new URL("../../hook/dist/cli.js", import.meta.url)), "install", "--dry-run"], { encoding: "utf8", env: process.env });
  assert.match(output, /Would create.*hooks.json/);
  assert.equal(existsSync(join(home, "state", INTEGRATION_PROFILE_FILE)), false);
});

test("environment facts name only this execution environment and keep other hosts unverified", (t) => {
  profiles(t);
  assert.equal(executionEnvironment("win32", {}), "windows");
  assert.equal(executionEnvironment("linux", { WSL_INTEROP: "private socket" }), "wsl");
  assert.equal(executionEnvironment("linux", { WSL_DISTRO_NAME: "private distro", container: "docker" }), "container");
  assert.equal(executionEnvironment("linux", { REMOTE_CONTAINERS: "private value" }), "container");
  assert.equal(executionEnvironment("linux", { SSH_TTY: "private terminal" }), "remote");
  const health = integrationHealth(["codex"])[0];
  assert.equal(health.scope.coverage, "current_environment_only");
  assert.equal(health.scope.other_environments, "not_verified");
  assert.equal(health.scope.action, "install_on_execution_host");
  assert.equal(health.runtime.state, "never_verified");
});

test("repair and native entry migration honor intent in the selected state directory", (t) => {
  const { home } = profiles(t);
  const dir = join(home, "alternate-state"); mkdirSync(dir);
  mkdirSync(join(home, ".codex"));
  writeIntegrationIntent({ version: 1, automatic: true, excluded: ["codex"] }, dir);
  assert.deepEqual(repairSetup(["codex"], null, Date.now(), dir).repaired, []);
  assert.equal(existsSync(userHarnessFile("codex")), false);
  writeHarnessConfig(userHarnessFile("codex"), "codex", "scopebond-hook codex");
  const before = readFileSync(userHarnessFile("codex"), "utf8");
  assert.deepEqual(useNativeHookEntries(["codex"], "C:/Programs/scopebond-agent.exe", dir), []);
  assert.equal(readFileSync(userHarnessFile("codex"), "utf8"), before);
});

test("first sign-in preserves exclusions and native hook disablement", async (t) => {
  const { home } = profiles(t);
  const dir = join(home, "state");
  mkdirSync(join(home, ".codex")); mkdirSync(join(home, ".claude"));
  const disabled = '{"disableAllHooks":true}';
  writeFileSync(userHarnessFile("claude"), disabled);
  writeIntegrationIntent({ version: 1, automatic: true, excluded: ["codex"] }, dir);
  const cloud = await startFakeCloud(); t.after(() => cloud.close());
  const origin = "https://workspace.example.test";
  const fetchImpl = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.origin, origin);
    return fetch(`${cloud.url}${url.pathname}${url.search}`, init);
  };
  const first = await startFirstSignIn(dir, origin, { fetchImpl, open: () => {}, harnesses: ["claude", "codex"] });
  assert.ok(cloud.approve(first.started.user_code));
  assert.equal(await first.done, true);
  assert.equal(existsSync(userHarnessFile("codex")), false);
  assert.equal(readFileSync(userHarnessFile("claude"), "utf8"), disabled);
});

test("uninstall honors the shared writer lock, including an otherwise removable owned file", (t) => {
  profiles(t);
  for (const harness of ["claude", "copilot"]) {
    const file = userHarnessFile(harness);
    writeHarnessConfig(file, harness, `scopebond-hook ${harness}`);
    const before = readFileSync(file, "utf8");
    writeFileSync(`${file}.scopebond-lock`, "another writer");
    assert.throws(() => removeHarnessConfig(file), /EEXIST/);
    assert.equal(readFileSync(file, "utf8"), before);
    assert.equal(readFileSync(`${file}.scopebond-lock`, "utf8"), "another writer");
  }
});

test("uninstall leaves unrelated settings byte-for-byte and removes only an empty owned hook file", (t) => {
  const { home } = profiles(t);
  const file = userHarnessFile("claude"); mkdirSync(join(home, ".claude"));
  const original = '{ "theme" : "dark", "hooks": {"PreToolUse": [{"command":"other-tool"}]} }';
  writeFileSync(file, original); removeHarnessConfig(file);
  assert.equal(readFileSync(file, "utf8"), original);
  const owned = userHarnessFile("copilot");
  writeHarnessConfig(owned, "copilot", "scopebond-hook copilot");
  assert.equal(removeHarnessConfig(owned), true); assert.equal(existsSync(owned), false);
  assert.equal(removeHarnessConfig(owned), false);
  const unfamiliar = '{"version":1,"hooks":"unrecognized configuration"}';
  writeFileSync(owned, unfamiliar);
  assert.equal(removeHarnessConfig(owned), false);
  assert.equal(readFileSync(owned, "utf8"), unfamiliar);
});

test("a refused uninstall does not purge state needed by a remaining hook", (t) => {
  const { home } = profiles(t);
  const file = userHarnessFile("claude"), retained = join(home, "state", "retained.txt");
  writeHarnessConfig(file, "claude", "scopebond-hook claude");
  writeFileSync(`${file}.scopebond-lock`, "another writer");
  writeFileSync(retained, "local evidence");
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../../hook/dist/cli.js", import.meta.url)), "uninstall", "--purge", "--yes"], { encoding: "utf8", env: process.env, cwd: home });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Some hook settings could not be changed/);
  assert.equal(result.stdout.includes("purged"), false);
  assert.equal(readFileSync(retained, "utf8"), "local evidence");
});
