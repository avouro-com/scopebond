import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expectedHarnesses, integrationHealth, missingHookEntries, localChecks, repairHookEntries, maintainHookEntries } from "../dist/index.js";
import { repairSetup } from "../dist/service.js";
import { ADAPTERS, HARNESSES, isHarness, writeHarnessConfig, removeHarnessConfig, writeIntegrationIntent, pruneHarnessEntries, wireLifecycleHooks, unwireLifecycleHooks, userHarnessFile } from "@scopebond/hook";
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

test("an unreadable settings target stays a visible failed repair", (t) => {
  const root = profile(t);
  mkdirSync(join(root, ".claude", "settings.json"), { recursive: true });
  assert.deepEqual(repairSetup(["claude"]).failed, ["claude"]);
  assert.equal(integrationHealth(["claude"])[0].reason, "invalid_configuration");
});

test("a selected profile alias is canonicalized while links inside the tool directory remain refused", (t) => {
  const root = profile(t); const selected = join(root, "selected"); const alias = join(root, "alias");
  mkdirSync(join(selected, ".codex"), { recursive: true });
  symlinkSync(selected, alias, process.platform === "win32" ? "junction" : "dir");
  process.env.HOME = alias; process.env.USERPROFILE = alias;
  const file = userHarnessFile("codex");
  writeHarnessConfig(file, "codex", "scopebond-hook codex");
  assert.equal(existsSync(join(selected, ".codex", "hooks.json")), true);
  const other = join(root, "other"); mkdirSync(other);
  symlinkSync(other, join(selected, ".cursor"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => writeHarnessConfig(userHarnessFile("cursor"), "cursor", "scopebond-hook cursor"), /unsafe/);
});

test("native disablement is preserved and lifecycle-only configuration still needs a decision hook", (t) => {
  const root = profile(t);
  mkdirSync(join(root, ".codex"));
  const file = join(root, ".codex", "hooks.json");
  writeFileSync(file, JSON.stringify({ disableAllHooks: true }));
  assert.deepEqual(missingHookEntries(["codex"]), []);
  writeFileSync(file, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "scopebond-hook codex" }] }] } }));
  assert.deepEqual(missingHookEntries(["codex"]), ["codex"]);
  writeFileSync(file, " ".repeat(4 * 1024 * 1024 + 1));
  assert.equal(integrationHealth(["codex"])[0].reason, "invalid_configuration");
  assert.throws(() => writeHarnessConfig(file, "codex", "scopebond-hook codex"), /too large/);
});

test("automatic install and upkeep preserve exclusions and native disablement", (t) => {
  const root = profile(t);
  mkdirSync(join(root, ".codex")); mkdirSync(join(root, ".claude"));
  const file = join(root, ".claude", "settings.json");
  const disabled = JSON.stringify({ disableAllHooks: true, hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "npx @scopebond/hook claude" }] }] } });
  writeFileSync(file, disabled);
  writeIntegrationIntent({ version: 1, automatic: true, excluded: ["codex"] }, join(root, "state"));
  assert.deepEqual(maintainHookEntries(["claude", "codex"]), []);
  assert.equal(readFileSync(file, "utf8"), disabled);
  const output = execFileSync(process.execPath, [new URL("../../hook/dist/cli.js", import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, ""), "install", "--dry-run"], { encoding: "utf8", env: process.env });
  assert.equal(output.includes("Would create"), false);
  assert.equal(output.includes("Would modify"), false);
});

test("automatic pruning and lifecycle removal preserve another command in a shared group", (t) => {
  const root = profile(t); const file = join(root, "hooks.json");
  const other = { type: "command", command: "other-tool verify" };
  writeFileSync(file, JSON.stringify({ theme: "dark", hooks: { PreToolUse: [{ matcher: "*", hooks: [other, { type: "command", command: "scopebond-hook claude" }] }] } }));
  assert.equal(pruneHarnessEntries(file, () => true), 1);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).hooks.PreToolUse[0].hooks, [other]);
  wireLifecycleHooks(file, "scopebond-hook claude");
  const config = JSON.parse(readFileSync(file, "utf8")); config.hooks.SessionStart[0].hooks.push(other);
  writeFileSync(file, JSON.stringify(config));
  assert.equal(unwireLifecycleHooks(file), 4);
  const remaining = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(remaining.hooks.SessionStart[0].hooks, [other]); assert.equal(remaining.theme, "dark");
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
