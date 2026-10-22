import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expectedHarnesses, integrationHealth, missingHookEntries, localChecks, repairHookEntries, maintainHookEntries } from "../dist/index.js";
import { ADAPTERS, HARNESSES, isHarness, writeHarnessConfig, removeHarnessConfig, writeIntegrationIntent } from "@scopebond/hook";
import { editHarnessConfig } from "../../hook/dist/config-edit.js";

function profile(t) {
  const root = mkdtempSync(join(tmpdir(), "integration-health-"));
  const saved = {};
  for (const key of ["HOME", "USERPROFILE", "SCOPEBOND_HOME", "COPILOT_HOME"]) saved[key] = process.env[key];
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  process.env.SCOPEBOND_HOME = join(root, "state");
  process.env.COPILOT_HOME = join(root, ".copilot");
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  mkdirSync(join(root, "state"));
  return root;
}

test("a detected Codex without hooks.json needs enrollment", (t) => {
  const root = profile(t);
  mkdirSync(join(root, ".codex"));
  assert.deepEqual(missingHookEntries(["codex"]), ["codex"]);
});

test("a Claude entry cannot certify a missing Codex integration", (t) => {
  const root = profile(t);
  mkdirSync(join(root, ".claude"));
  mkdirSync(join(root, ".codex"));
  writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [
    { matcher: "*", hooks: [{ type: "command", command: "npx -y @scopebond/hook claude" }] },
  ] } }));
  const checks = localChecks(join(root, "state"), {}, ["claude", "codex"]);
  assert.equal(checks.find((c) => c.id === "hook_entry").ok, false);
  assert.equal(checks.find((c) => c.id === "hook_starts").ok, false);
});

test("registry includes all adapters while absent tools and Copilot Chat alone are not enrolled", (t) => {
  const root = profile(t);
  assert.deepEqual(HARNESSES, ["claude", "cursor", "codex", "copilot"]);
  assert.deepEqual(ADAPTERS.codex.surfaces, ["cli", "desktop"]);
  assert.equal(isHarness("__proto__"), false);
  assert.equal(isHarness("future-tool"), false);
  assert.deepEqual(missingHookEntries(["claude", "codex", "cursor"]), []);
  assert.deepEqual(repairHookEntries(["claude", "codex", "cursor"]), []);
  assert.equal(existsSync(join(root, ".claude")), false);
  mkdirSync(join(root, ".copilot"));
  writeFileSync(join(root, ".copilot", "settings.json"), "{}");
  assert.ok(expectedHarnesses().includes("copilot"));
});

test("enrollment creates the missing file; configuration does not prove activation", (t) => {
  const root = profile(t);
  mkdirSync(join(root, ".codex"));
  assert.equal(repairHookEntries(["codex"]).length, 1);
  const file = join(root, ".codex", "hooks.json");
  const raw = readFileSync(file, "utf8");
  assert.equal(JSON.parse(raw).hooks.PreToolUse.length, 1);
  assert.deepEqual(repairHookEntries(["codex"]), []);
  assert.equal(readFileSync(file, "utf8"), raw);
  const health = integrationHealth(["codex"])[0];
  assert.equal(health.entry, true);
  assert.equal(health.integration, "awaiting_trust");
  assert.equal(health.runtime.state, "never_verified");
  assert.deepEqual(health.capabilities.verified, []);
  assert.equal(health.license.state, "unknown");
});

test("exclusion and automatic enrollment off survive repair and upkeep", (t) => {
  const root = profile(t);
  mkdirSync(join(root, ".codex"));
  const state = join(root, "state");
  writeIntegrationIntent({ version: 1, automatic: true, excluded: ["codex"] }, state);
  assert.deepEqual(repairHookEntries(["codex"]), []);
  assert.equal(integrationHealth(["codex"])[0].reason, "excluded");
  writeIntegrationIntent({ version: 1, automatic: false, excluded: [] }, state);
  assert.deepEqual(repairHookEntries(["codex"]), []);
  assert.deepEqual(maintainHookEntries(["codex"]), []);
  assert.equal(existsSync(join(root, ".codex", "hooks.json")), false);
});

test("each adapter preserves unrelated configuration and removes duplicate owned entries", (t) => {
  const root = profile(t);
  for (const harness of HARNESSES) {
    const file = join(root, `${harness}.json`);
    writeFileSync(file, JSON.stringify({ theme: "test", hooks: { unrelated: [{ command: "other-check" }] } }));
    writeHarnessConfig(file, harness, `npx -y @scopebond/hook ${harness}`);
    const config = JSON.parse(readFileSync(file, "utf8"));
    const event = ADAPTERS[harness].decisionEvents[0];
    config.hooks[event].push(structuredClone(config.hooks[event][0]));
    writeFileSync(file, JSON.stringify(config));
    writeHarnessConfig(file, harness, `npx -y @scopebond/hook ${harness}`);
    const fixed = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(fixed.hooks[event].length, 1);
    assert.equal(fixed.theme, "test");
    removeHarnessConfig(file);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).hooks.unrelated, [{ command: "other-check" }]);
  }
});

test("malformed, concurrently edited, locked and linked configurations are not overwritten", (t) => {
  const root = profile(t);
  const file = join(root, "config.json");
  writeFileSync(file, "not json");
  assert.throws(() => writeHarnessConfig(file, "codex", "scopebond-hook codex"), /valid JSON/);
  assert.equal(readFileSync(file, "utf8"), "not json");
  writeFileSync(file, "{}");
  let calls = 0;
  editHarnessConfig(file, (config) => {
    if (++calls === 1) writeFileSync(file, '{"theme":"concurrent"}');
    config.enrolled = true;
  });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { theme: "concurrent", enrolled: true });
  writeFileSync(`${file}.scopebond-lock`, "another writer");
  const before = readFileSync(file, "utf8");
  assert.throws(() => writeHarnessConfig(file, "codex", "scopebond-hook codex"), /EEXIST/);
  assert.equal(readFileSync(file, "utf8"), before);
  const outside = join(root, "outside");
  mkdirSync(outside);
  const linked = join(root, "linked");
  symlinkSync(outside, linked, "junction");
  assert.throws(() => writeHarnessConfig(join(linked, "hooks.json"), "codex", "scopebond-hook codex"), /unsafe/);
  assert.equal(existsSync(join(outside, "hooks.json")), false);
});

test("health distinguishes missing programs, disabled native hooks and changed definitions", (t) => {
  const root = profile(t);
  mkdirSync(join(root, ".codex"));
  const file = join(root, ".codex", "hooks.json");
  writeHarnessConfig(file, "codex", "C:/absent/scopebond-agent.exe hook codex");
  const broken = integrationHealth(["codex"])[0];
  assert.equal(broken.reason, "executable_missing");
  writeHarnessConfig(file, "codex", "npx -y @scopebond/hook codex");
  const changed = integrationHealth(["codex"])[0];
  assert.notEqual(changed.definition_revision, broken.definition_revision);
  assert.equal(changed.runtime.state, "never_verified");
  const config = JSON.parse(readFileSync(file, "utf8"));
  config.disableAllHooks = true;
  writeFileSync(file, JSON.stringify(config));
  assert.equal(integrationHealth(["codex"])[0].reason, "native_disabled");
});
