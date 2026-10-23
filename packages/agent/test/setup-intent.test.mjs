import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { startFakeCloud } from "@scopebond/fake-cloud";
import { writeIntegrationIntent } from "@scopebond/hook";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../../hook/dist/cli.js", import.meta.url));
const bundle = JSON.stringify({ enrollment_token: "sbe_fake_fixture", proof_canonical: JSON.stringify({ challenge: "fixture", enrollment_id: "enr-fixture", type: "scopebond:gateway-enrollment", version: 1 }) });
function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "setup-intent-")));
  const state = join(home, "state"); mkdirSync(state);
  const env = { ...process.env, HOME: home, USERPROFILE: home, SCOPEBOND_HOME: state, SCOPEBOND_HOOK_DIR: state, COPILOT_HOME: join(home, ".copilot") };
  return { home, state, run: (args) => run(process.execPath, [cli, ...args], { cwd: home, env, windowsHide: true, timeout: 30_000 }) };
}

for (const harness of ["claude", "codex", "cursor", "copilot"]) test(`connect preserves the ${harness} exclusion`, async (t) => {
  const f = fixture(), cloud = await startFakeCloud(); t.after(() => cloud.close());
  writeIntegrationIntent({ version: 1, automatic: true, excluded: [harness] }, f.state);
  const result = await f.run(["connect", cloud.url, bundle, `--${harness}`]);
  assert.equal(cloud.state().enrolled, 1);
  assert.equal(existsSync(join(f.state, "cloud.json")), true);
  assert.equal(existsSync(join(f.home, `.${harness}`, harness === "claude" ? "settings.json" : harness === "copilot" ? "hooks/scopebond.json" : "hooks.json")), false);
  assert.match(result.stdout, /integration left unchanged/i);
  assert.doesNotMatch(result.stdout, /first action appears|already configured|configured in/);
});

test("connect preserves native disablement and automatic enrollment off", async (t) => {
  const cloud = await startFakeCloud(); t.after(() => cloud.close());
  for (const automatic of [true, false]) {
    const f = fixture(); mkdirSync(join(f.home, ".codex"));
    const file = join(f.home, ".codex", "hooks.json"), original = automatic ? '{"disableAllHooks":true,"theme":"dark"}' : '{"theme":"dark"}';
    writeFileSync(file, original);
    writeIntegrationIntent({ version: 1, automatic, excluded: [] }, f.state);
    const result = await f.run(["connect", cloud.url, bundle, "--codex"]);
    assert.equal(readFileSync(file, "utf8"), original);
    assert.match(result.stdout, /integration left unchanged/i);
  }
});

test("an explicit install selection preserves exclusions in both preview and repair", async () => {
  const f = fixture(); mkdirSync(join(f.home, ".codex"));
  writeIntegrationIntent({ version: 1, automatic: true, excluded: ["codex"] }, f.state);
  const preview = await f.run(["install", "--codex", "--dry-run"]);
  assert.doesNotMatch(preview.stdout, /Would create.*hooks.json/);
  await f.run(["install", "--codex"]);
  assert.equal(existsSync(join(f.home, ".codex", "hooks.json")), false);
});
