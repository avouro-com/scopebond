import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
for (const [command, flags] of [["init", ["--yes", "--npx"]], ["install", []]]) {
  test(`${command}: guides a local user to a workspace and desktop agent without enrolling or starting it`, () => {
    const project = mkdtempSync(join(tmpdir(), "sb-onboarding-"));
    const home = mkdtempSync(join(tmpdir(), "sb-onboarding-home-"));
    const scopeHome = join(home, ".scopebond");
    const env = { ...process.env, HOME: home, USERPROFILE: home, SCOPEBOND_HOME: scopeHome };
    delete env.SCOPEBOND_HOOK_DIR;
    const output = execFileSync(process.execPath, [cli, command, ...flags, "--cursor", "--no-install"], {
      cwd: project, encoding: "utf8", env,
    });
    assert.match(output, /Start free with one agent: https:\/\/cloud\.scopebond\.com\/app/);
    assert.match(output, /login https:\/\/cloud\.scopebond\.com --cursor/);
    if (command === "init") assert.match(output, /--cursor --project/);
    assert.match(output, /get-started#desktop-agent/);
    assert.match(output, process.platform === "win32" ? /npm\.cmd install.*\n.*scopebond-agent\.cmd autostart on/ : /npm install.*\n.*scopebond-agent autostart on/);
    assert.equal(existsSync(join(scopeHome, "cloud.json")), false, "no implicit enrollment");
    assert.equal(existsSync(join(scopeHome, "agent.json")), false, "no implicit resident process");
  });
}

test("install on a computer already connected keeps the connection and does not ask to sign up again", async () => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const project = mkdtempSync(join(tmpdir(), "sb-onboarding-"));
  const home = mkdtempSync(join(tmpdir(), "sb-onboarding-home-"));
  const scopeHome = join(home, ".scopebond");
  mkdirSync(scopeHome, { recursive: true });
  writeFileSync(join(scopeHome, "cloud.json"), JSON.stringify({ url: "https://workspace.example", credential: "x" }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, SCOPEBOND_HOME: scopeHome };
  delete env.SCOPEBOND_HOOK_DIR;
  const output = execFileSync(process.execPath, [cli, "install", "--cursor", "--no-install"], { cwd: project, encoding: "utf8", env });
  assert.match(output, /workspace\s+connected to https:\/\/workspace\.example \(kept\)/);
  assert.doesNotMatch(output, /Start free with one agent/);
  assert.doesNotMatch(output, /login https:\/\/cloud\.scopebond\.com/);
  assert.match(output, /get-started#desktop-agent/, "no agent running here: the agent is still suggested");
});
