// Runs windows-journey.ps1 in Windows PowerShell 5.1 and in PowerShell 7 against freshly packed
// hook and agent tarballs. Only on Windows in CI: the journey turns the agent's autostart on and
// off for the signed-in user, which must never touch a developer's own computer.
// It has its own entry in the hook test script: the journey outlasts the per-file time limit.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = join(here, "..", "..", "..");
const script = join(here, "windows-journey.ps1");
const enabled = process.platform === "win32" && (process.env.CI === "true" || process.env.SCOPEBOND_WINDOWS_JOURNEY === "1");

function pack() {
  const dest = mkdtempSync(join(tmpdir(), "sb-journey-pack-"));
  for (const pkg of ["hook", "agent"]) {
    // The hook's tests run before the agent's own build in `pnpm -r test`: build it, or the tarball has no dist/.
    const built = spawnSync("pnpm", ["--dir", join(root, "packages", pkg), "run", "build"], { encoding: "utf8", shell: true });
    assert.equal(built.status, 0, `pnpm build ${pkg}: ${built.stdout}${built.stderr}`);
    // pnpm rewrites the workspace dependencies to the versions a published package names.
    const r = spawnSync("pnpm", ["--dir", join(root, "packages", pkg), "pack", "--pack-destination", dest], { encoding: "utf8", shell: true });
    assert.equal(r.status, 0, `pnpm pack ${pkg}: ${r.stdout}${r.stderr}`);
  }
  const files = readdirSync(dest);
  const find = (name) => join(dest, files.find((f) => f.startsWith(`scopebond-${name}-`) && f.endsWith(".tgz")));
  return { hook: find("hook"), agent: find("agent") };
}

function hasShell(exe) {
  return spawnSync(exe, ["-NoProfile", "-Command", "exit 0"], { encoding: "utf8" }).status === 0;
}

// A person's terminal, not a package script: each PowerShell finds its own modules (one started
// with the other's PSModulePath cannot load Set-ExecutionPolicy), and none of the variables pnpm
// sets for a running script (npm_config_recursive, npm_lifecycle_*, …) reach npm.cmd.
const KEEP_NPM = new Set(["npm_config_prefix", "npm_config_cache", "npm_config_registry"]);
function journeyEnv() {
  const env = { ...process.env, CLAUDECODE: "" };
  for (const key of Object.keys(env)) {
    const k = key.toLowerCase();
    if (k === "psmodulepath" || k === "init_cwd" || k.startsWith("pnpm_") || (k.startsWith("npm_") && !KEEP_NPM.has(k))) delete env[key];
  }
  return env;
}

let packed = null;
for (const shell of ["powershell.exe", "pwsh.exe"]) {
  test(`the Windows journey passes in ${shell}`, { skip: !enabled ? "Windows CI only (set SCOPEBOND_WINDOWS_JOURNEY=1 to run it here)" : !hasShell(shell) && `${shell} is not installed`, timeout: 15 * 60_000 }, () => {
    packed ??= pack();
    // -ExecutionPolicy Bypass only lets this file start; the journey then sets Restricted for itself.
    const r = spawnSync(shell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-HookPackage", packed.hook, "-AgentPackage", packed.agent], {
      encoding: "utf8", timeout: 14 * 60_000, env: journeyEnv(),
    });
    process.stdout.write(r.stdout ?? "");
    assert.equal(r.status, 0, `${shell} journey failed:\n${r.stdout}${r.stderr}`);
  });
}
