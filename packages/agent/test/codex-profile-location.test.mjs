import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { automaticHarnesses, userHarnessFile, wireLifecycleHooks, writeHarnessConfig, removeHarnessConfig } from "@scopebond/hook";
import { discoverTools } from "../dist/tools.js";
import { repairSetup } from "../dist/service.js";
import { integrationHealth } from "../dist/integration-health.js";
import { startDiscoveryLoop } from "../dist/discovery-loop.js";

function profile(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "codex-location-")));
  const home = join(root, "profile"), other = join(root, "other");
  const settings = { HOME: home, USERPROFILE: home, SCOPEBOND_HOME: join(home, "state"), CODEX_HOME: join(home, "apps", "codex"), COPILOT_HOME: join(home, ".copilot") };
  const saved = { ...process.env };
  for (const directory of [home, other, settings.CODEX_HOME, settings.SCOPEBOND_HOME]) mkdirSync(directory, { recursive: true });
  Object.assign(process.env, settings);
  t.after(() => { for (const key of Object.keys(settings)) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  } });
  return { home, other, codex: settings.CODEX_HOME };
}
const discover = (env = process.env) => discoverTools({ env, npmRoots: [], findProgram: () => null });

test("enrollment and discovery use the active Codex home without claiming native trust", async (t) => {
  const { home, codex } = profile(t);
  writeFileSync(join(codex, "config.toml"), '[mcp_servers.fixture]\ncommand="fixture"\n');
  assert.equal(userHarnessFile("codex"), join(codex, "hooks.json"));
  assert.deepEqual(automaticHarnesses(["codex"]), ["codex"]);
  repairSetup(["codex"]);
  assert.equal(existsSync(join(codex, "hooks.json")), true);
  assert.equal(existsSync(join(home, ".codex")), false);
  const health = integrationHealth(["codex"])[0];
  assert.equal(health.integration, "awaiting_trust");
  assert.equal(health.runtime.state, "never_verified");
  const found = await discover();
  assert.equal(found.tools.find((tool) => tool.id === "codex")?.settings_present, true);
  assert.ok(found.mcp_servers.some((server) => server.name === "fixture"));
  removeHarnessConfig(userHarnessFile("codex"), "codex");
  assert.equal(integrationHealth(["codex"])[0].entry, false);
});

test("a Codex home outside the selected profile cannot authorize repair or inventory reads", async (t) => {
  const { other } = profile(t);
  process.env.CODEX_HOME = other;
  writeFileSync(join(other, "config.toml"), '[mcp_servers.private_fixture]\ncommand="fixture"\n');
  assert.deepEqual(automaticHarnesses(["codex"]), []);
  assert.deepEqual(repairSetup(["codex"]).repaired, []);
  assert.equal(existsSync(join(other, "hooks.json")), false);
  assert.equal(integrationHealth(["codex"])[0].reason, "profile_boundary");
  const found = await discover();
  assert.equal(found.tools.some((tool) => tool.id === "codex"), false);
  assert.equal(found.mcp_servers.some((server) => server.name === "private_fixture"), false);
});

test("an explicit discovery environment selects one Codex config and ignores dormant defaults", async (t) => {
  const { home, codex } = profile(t);
  const legacy = join(home, ".codex"); mkdirSync(legacy);
  writeFileSync(join(legacy, "config.toml"), '[mcp_servers.dormant]\ncommand="fixture"\n');
  writeFileSync(join(codex, "config.toml"), '[mcp_servers.active]\ncommand="fixture"\n');
  writeHarnessConfig(join(codex, "hooks.json"), "codex", "scopebond-hook codex");
  process.env.CODEX_HOME = legacy;
  const found = await discover({ ...process.env, CODEX_HOME: codex });
  assert.equal(found.tools.find((tool) => tool.id === "codex")?.governed, true);
  assert.ok(found.mcp_servers.some((server) => server.name === "active"));
  assert.equal(found.mcp_servers.some((server) => server.name === "dormant"), false);
});

test("discovery watches a relocated Codex directory but never its linked replacement", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { home, other, codex } = profile(t);
  const watched = [];
  const loop = startDiscoveryLoop({ reconcile: async () => {}, watchDirectory: directory => { watched.push(directory); return { close() {} }; } });
  t.after(loop.stop);
  t.mock.timers.tick(1); await new Promise(setImmediate);
  assert.ok(watched.includes(codex));
  loop.stop();
  const alias = join(home, "linked-codex");
  symlinkSync(other, alias, process.platform === "win32" ? "junction" : "dir");
  process.env.CODEX_HOME = alias;
  writeFileSync(join(other, "config.toml"), '[mcp_servers.outside]\ncommand="fixture"\n');
  const linkedWatched = [];
  const linkedLoop = startDiscoveryLoop({ reconcile: async () => {}, watchDirectory: directory => { linkedWatched.push(directory); return { close() {} }; } });
  t.after(linkedLoop.stop);
  t.mock.timers.tick(1); await new Promise(setImmediate);
  assert.equal(linkedWatched.includes(alias), false);
  assert.equal(linkedWatched.includes(other), false);
  assert.equal((await discover()).mcp_servers.some((server) => server.name === "outside"), false);
});

test("Codex session-end handlers fit the native timeout without changing other lifecycle handlers", (t) => {
  const { codex } = profile(t);
  const file = join(codex, "hooks.json");
  wireLifecycleHooks(file, "scopebond-hook codex", "codex");
  const { hooks } = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(hooks.SessionEnd[0].hooks[0].timeout, 3);
  assert.equal(hooks.SessionStart[0].hooks[0].timeout, 30);
});
