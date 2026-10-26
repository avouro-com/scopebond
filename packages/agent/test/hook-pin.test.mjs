// The hook entry is pinned to the exact command this agent writes: any other program, other arguments, a wrapper, a missing
// entry, Claude Code's disableAllHooks or an unreadable integration-intent file is tamper, reported with what differs (never
// the file's contents) and put back where a repair may change it.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadOrCreateAttester } from "@scopebond/gateway/node";
import { INTEGRATION_INTENT_FILE, wireLifecycleHooks, writeHarnessConfig, userHarnessFile } from "@scopebond/hook";
import {
  hookPins, integrationHealth, integrationIntentState, maintainedHookCommand, noteTamper, runSelfCheck, tamperFindings,
} from "../dist/index.js";
import { repairSetup } from "../dist/service.js";

function profile(t) {
  const root = mkdtempSync(join(tmpdir(), "hook-pin-"));
  const saved = {};
  for (const key of ["HOME", "USERPROFILE", "SCOPEBOND_HOME", "COPILOT_HOME"]) saved[key] = process.env[key];
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  process.env.SCOPEBOND_HOME = join(root, "state");
  process.env.COPILOT_HOME = join(root, ".copilot");
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  mkdirSync(join(root, "state"));
  mkdirSync(join(root, ".claude"));
  return { root, state: join(root, "state"), file: join(root, ".claude", "settings.json") };
}

/** Claude Code's settings with the exact entry this agent writes, then `change` applied to its command. */
function claudeEntry(file, change = (command) => command) {
  const expected = maintainedHookCommand("claude");
  writeHarnessConfig(file, "claude", expected);
  const config = JSON.parse(readFileSync(file, "utf8"));
  config.hooks.PreToolUse[0].hooks[0].command = change(expected);
  writeFileSync(file, JSON.stringify(config, null, 2));
  return expected;
}

const claudePin = (state) => hookPins(["claude"], { dir: state }).tools[0];
const commandOf = (file) => JSON.parse(readFileSync(file, "utf8")).hooks.PreToolUse[0].hooks[0].command;

test("the exact entry is intact, and a repair leaves it byte for byte", (t) => {
  const { state, file } = profile(t);
  claudeEntry(file);
  const before = readFileSync(file, "utf8");
  const pin = claudePin(state);
  assert.equal(pin.state, "intact");
  assert.deepEqual(pin.deviations, []);
  assert.deepEqual(pin.installed_digests, [pin.expected_digest]);
  assert.equal(integrationHealth(["claude"], Date.now(), state)[0].pin.state, "intact");
  const done = repairSetup(["claude"], null, Date.now(), state);
  assert.deepEqual(done.tamper, []);
  assert.deepEqual(done.pinned, []);
  assert.equal(readFileSync(file, "utf8"), before);
});

for (const [name, change, deviation] of [
  ["changed arguments", (c) => c.replace(/ claude$/, " --quiet claude"), "arguments"],
  ["a wrapper around the command", (c) => `${process.platform === "win32" ? "C:/tools/wrap.exe" : "/usr/local/bin/wrap"} ${c}`, "wrapper"],
  ["another program", () => `${process.platform === "win32" ? "C:/other/node.exe C:/other/@scopebond/hook/dist/cli.js" : "/opt/other/node /opt/other/@scopebond/hook/dist/cli.js"} claude`, "program"],
]) {
  test(`${name} is tamper, reported without the command and put back`, (t) => {
    const { state, file } = profile(t);
    const expected = claudeEntry(file, change);
    const pin = claudePin(state);
    assert.equal(pin.state, "tampered");
    assert.deepEqual(pin.deviations, [deviation]);
    assert.notEqual(pin.installed_digests[0], pin.expected_digest);
    assert.equal(JSON.stringify(pin).includes(expected), false, "no command in the report");
    const health = integrationHealth(["claude"], Date.now(), state)[0];
    assert.equal(health.pin.state, "tampered");
    assert.deepEqual(health.pin.deviations, [deviation]);
    const done = repairSetup(["claude"], null, Date.now(), state);
    assert.deepEqual(done.pinned, ["claude"]);
    assert.equal(done.tamper.length, 1);
    assert.deepEqual({ ...done.tamper[0], first_seen_at: 0 }, {
      tool: "claude", deviations: [deviation], expected_digest: pin.expected_digest, installed_digests: pin.installed_digests, first_seen_at: 0, repaired: true,
    });
    assert.equal(commandOf(file), expected);
    assert.equal(claudePin(state).state, "intact");
  });
}

test("a missing entry is tamper and put back", (t) => {
  const { state, file } = profile(t);
  writeFileSync(file, JSON.stringify({ theme: "dark" }));
  const pin = claudePin(state);
  assert.equal(pin.state, "tampered");
  assert.deepEqual(pin.deviations, ["missing_entry"]);
  assert.deepEqual(pin.installed_digests, []);
  const done = repairSetup(["claude"], null, Date.now(), state);
  assert.deepEqual(done.tamper.map((f) => [f.tool, f.deviations, f.repaired]), [["claude", ["missing_entry"], true]]);
  assert.equal(commandOf(file), maintainedHookCommand("claude"));
  assert.equal(JSON.parse(readFileSync(file, "utf8")).theme, "dark");
});

test("Claude Code's disableAllHooks is tamper, reported while the person's own switch stays", (t) => {
  const { state, file } = profile(t);
  claudeEntry(file);
  const config = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...config, disableAllHooks: true }));
  const before = readFileSync(file, "utf8");
  const pin = claudePin(state);
  assert.equal(pin.state, "tampered");
  assert.deepEqual(pin.deviations, ["hooks_disabled"]);
  const done = repairSetup(["claude"], null, Date.now(), state);
  assert.deepEqual(done.tamper.map((f) => [f.tool, f.deviations, f.repaired]), [["claude", ["hooks_disabled"], false]]);
  assert.equal(readFileSync(file, "utf8"), before, "native disablement is not overwritten");
});

test("a corrupt integration-intent file is tamper: written again, and the entries it stopped are repaired", (t) => {
  const { state, file } = profile(t);
  claudeEntry(file, (c) => c.replace(/ claude$/, " --quiet claude"));
  writeFileSync(join(state, INTEGRATION_INTENT_FILE), "{not json");
  const pins = hookPins(["claude"], { dir: state });
  assert.equal(pins.intent, "unreadable");
  assert.deepEqual(pins.tools[0].deviations, ["arguments", "intent_unreadable"]);
  const done = repairSetup(["claude"], null, Date.now(), state);
  assert.deepEqual(done.tamper.map((f) => [f.tool, f.deviations, f.repaired]), [
    ["integration_intent", ["intent_unreadable"], true],
    ["claude", ["arguments", "intent_unreadable"], true],
  ]);
  assert.equal(integrationIntentState(state), "ok");
  assert.deepEqual(JSON.parse(readFileSync(join(state, INTEGRATION_INTENT_FILE), "utf8")), { version: 1, automatic: true, excluded: [] });
  assert.equal(commandOf(file), maintainedHookCommand("claude"));
  assert.equal(claudePin(state).state, "intact");
});

test("a wrapper on a session entry alone is found, and the session entries are written again", (t) => {
  const { state, file } = profile(t);
  const expected = maintainedHookCommand("claude");
  writeHarnessConfig(file, "claude", expected);
  wireLifecycleHooks(file, expected, "claude");
  const config = JSON.parse(readFileSync(file, "utf8"));
  config.hooks.SessionStart[0].hooks[0].command = `/usr/local/bin/wrap ${expected}`;
  writeFileSync(file, JSON.stringify(config));
  assert.deepEqual(claudePin(state).deviations, ["wrapper"]);
  repairSetup(["claude"], null, Date.now(), state);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).hooks.SessionStart[0].hooks[0].command, expected);
  assert.equal(claudePin(state).state, "intact");
});

test("each coding tool's exact entry is intact, field by field", (t) => {
  const { root, state } = profile(t);
  mkdirSync(join(root, ".codex")); mkdirSync(join(root, ".cursor")); mkdirSync(join(root, ".copilot"));
  writeFileSync(join(root, ".copilot", "settings.json"), "{}");
  for (const harness of ["claude", "codex", "cursor", "copilot"]) writeHarnessConfig(userHarnessFile(harness), harness, maintainedHookCommand(harness));
  const pins = hookPins(["claude", "codex", "cursor", "copilot"], { dir: state });
  assert.deepEqual(pins.tools.map((p) => [p.harness, p.state]), [["claude", "intact"], ["codex", "intact"], ["cursor", "intact"], ["copilot", "intact"]]);
  assert.equal(new Set(pins.tools.map((p) => p.expected_digest)).size, 4, "each digest is bound to its tool");
  // Copilot runs `powershell` on Windows: a different one there is tamper even with `bash` exact.
  const copilot = userHarnessFile("copilot");
  const config = JSON.parse(readFileSync(copilot, "utf8"));
  config.hooks.PreToolUse[0].powershell = `C:/tools/wrap.exe ${config.hooks.PreToolUse[0].powershell}`;
  writeFileSync(copilot, JSON.stringify(config));
  assert.deepEqual(hookPins(["copilot"], { dir: state }).tools[0].deviations, ["wrapper"]);
});

test("the self-check carries the hook integrity report and the tamper found earlier, in new fields only", async (t) => {
  const { state, file } = profile(t);
  claudeEntry(file, (c) => `/usr/local/bin/wrap ${c}`);
  loadOrCreateAttester({ file: join(state, "attester.key") });
  const before = hookPins(["claude"], { dir: state });
  const done = repairSetup(["claude"], null, Date.now(), state);
  const found = noteTamper([], done.tamper);
  // A tamper still there when the check runs is in `tools` too.
  claudeEntry(file, (c) => c.replace(/ claude$/, " --quiet claude"));
  let body = null;
  const fetchImpl = async (_url, init) => { body = JSON.parse(init.body); return new Response(JSON.stringify({ ok: true, signature_verified: true, failed: [] }), { status: 200 }); };
  const connection = { url: "https://workspace.example", credential: "sbc_test", credential_id: "cred-1", gateway_id: "gw-1" };
  const result = await runSelfCheck(state, connection, ["claude"], "0.0.0-test", { fetchImpl, tamper: found, discover: async () => ({ tools: [], mcp_servers: [] }) });
  assert.equal(result.integrity_reported, true);
  for (const key of ["signature", "day", "checks", "hook_version", "agent_version", "install_kind", "tools", "mcp_servers"]) assert.ok(key in body, key);
  assert.equal(body.hook_integrity.version, 1);
  assert.equal(body.hook_integrity.intent, "absent");
  assert.deepEqual(body.hook_integrity.tools.map((p) => [p.harness, p.state, p.deviations]), [["claude", "tampered", ["arguments"]]]);
  assert.deepEqual(body.hook_integrity.found.map((f) => [f.tool, f.deviations, f.repaired]), [["claude", ["wrapper"], true]]);
  assert.equal(body.hook_integrity.found[0].expected_digest, before.tools[0].expected_digest);
  assert.equal(JSON.stringify(body.hook_integrity).includes(maintainedHookCommand("claude")), false, "no command in the report");
  // A workspace that does not take it: kept for the next report.
  const refused = await runSelfCheck(state, connection, ["claude"], "0.0.0-test", { fetchImpl: async () => new Response("no", { status: 500 }), tamper: found, discover: async () => ({ tools: [], mcp_servers: [] }) });
  assert.equal(refused.integrity_reported, false);
});

test("findings are merged per tool and keep the latest repair outcome", () => {
  const at = 1;
  const seen = tamperFindings({ intent: "absent", tools: [{ harness: "claude", state: "tampered", expected_digest: "e", installed_digests: ["a"], deviations: ["wrapper"] }] }, null, at);
  assert.equal(seen[0].repaired, false);
  const later = tamperFindings(
    { intent: "absent", tools: [{ harness: "claude", state: "tampered", expected_digest: "e", installed_digests: ["b"], deviations: ["arguments"] }] },
    { intent: "absent", tools: [{ harness: "claude", state: "intact", expected_digest: "e", installed_digests: ["e"], deviations: [] }] }, 2);
  const merged = noteTamper(seen, later);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].deviations, ["arguments", "wrapper"]);
  assert.deepEqual(merged[0].installed_digests, ["a", "b"]);
  assert.equal(merged[0].first_seen_at, 1);
  assert.equal(merged[0].repaired, true);
});
