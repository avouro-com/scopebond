import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { discoverTools } from "../dist/tools.js";

function profile(t) {
  const home = mkdtempSync(join(tmpdir(), "passive-discovery-"));
  const saved = { ...process.env };
  const settings = { HOME: home, USERPROFILE: home, SCOPEBOND_HOME: join(home, "state"), APPDATA: join(home, "AppData"), COPILOT_HOME: join(home, ".copilot") };
  Object.assign(process.env, settings);
  mkdirSync(join(home, ".codex"));
  t.after(() => { for (const key of Object.keys(settings)) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  } });
  return home;
}

test("a matching program name on PATH is not authority to execute a version probe", async (t) => {
  profile(t);
  // Node is an actual executable with a --version response, but is not the discovered coding tool.
  const found = await discoverTools({ npmRoots: [], findProgram: (name) => name === "codex" ? process.execPath : null });
  assert.deepEqual(found.tools.find((tool) => tool.id === "codex"), {
    id: "codex", settings_present: true, governed: false, version: null,
  });
});

test("passive discovery still reads an installed package manifest without probing", async (t) => {
  const home = profile(t);
  const root = join(home, "global", "node_modules");
  const pkg = join(root, "@openai", "codex");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@openai/codex", version: "1.2.3" }));
  const found = await discoverTools({ npmRoots: [root], findProgram: () => null, runVersion: async () => { assert.fail("manifest needs no execution"); } });
  assert.equal(found.tools.find((tool) => tool.id === "codex")?.version, "1.2.3");
});

test("missing package metadata does not launch npm or a tool during discovery", async (t) => {
  const home = profile(t);
  const calls = [];
  t.mock.method(childProcess, "execFile", (program, args, _options, callback) => {
    calls.push({ program, args });
    callback(null, "", "");
    return { stdin: { end() {} } };
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const found = await discoverTools({ env: { ...process.env, npm_config_prefix: join(home, "empty-prefix") }, findProgram: () => null });
  assert.equal(found.tools.find((tool) => tool.id === "codex")?.version, null);
  assert.deepEqual(calls, []);
});
