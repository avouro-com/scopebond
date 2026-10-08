// Runs windows-journey.ps1 in Windows PowerShell 5.1 and in PowerShell 7 against freshly packed
// hook and agent tarballs. Only on Windows in CI: the journey turns the agent's autostart on and
// off for the signed-in user, which must never touch a developer's own computer.
// It has its own entry in the hook test script: the journey outlasts the per-file time limit.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = join(here, "..", "..", "..");
const script = join(here, "windows-journey.ps1");
// SCOPEBOND_WINDOWS_JOURNEY=0 leaves the journeys out of the unit run (a CI job that runs them on its own, in parallel).
const enabled = process.platform === "win32" && process.env.SCOPEBOND_WINDOWS_JOURNEY !== "0" && (process.env.CI === "true" || process.env.SCOPEBOND_WINDOWS_JOURNEY === "1");

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
  const hook = find("hook");
  return { hook, agent: withHookFrom(find("agent"), hook, dest) };
}

// The agent and the hook are released together; the packed agent names the hook by version, which
// npm would fetch from the registry (the last release, not this one). Point it at this hook instead.
function withHookFrom(agentTgz, hookTgz, dest) {
  const work = mkdtempSync(join(tmpdir(), "sb-journey-agent-"));
  // Windows' own tar: Git's GNU tar, often first on PATH, reads "C:" as a remote host.
  const tar = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\Windows", "System32", "tar.exe") : "tar";
  const untar = spawnSync(tar, ["-xzf", agentTgz, "-C", work], { encoding: "utf8" });
  assert.equal(untar.status, 0, `tar: ${untar.stderr}`);
  const manifest = join(work, "package", "package.json");
  const pkg = JSON.parse(readFileSync(manifest, "utf8"));
  pkg.dependencies["@scopebond/hook"] = "file:" + hookTgz.replace(/\\/g, "/");
  writeFileSync(manifest, JSON.stringify(pkg, null, 2));
  const out = mkdtempSync(join(dest, "agent-"));
  const repack = spawnSync("npm", ["pack", join(work, "package"), "--pack-destination", out], { encoding: "utf8", shell: true });
  assert.equal(repack.status, 0, `npm pack agent: ${repack.stdout}${repack.stderr}`);
  return join(out, readdirSync(out).find((f) => f.endsWith(".tgz")));
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
    // Outside CI (SCOPEBOND_WINDOWS_JOURNEY=1 on a developer's computer) the journey uses a throwaway profile
    // folder and leaves the agent alone: it never touches that person's own Run key, agent or settings.
    const local = process.env.CI !== "true" ? ["-IsolatedHome", "-SkipAgent"] : [];
    // The edge cases (unusual profile paths, OneDrive, an old Node) are the same in either shell: run them once.
    if (shell === "pwsh.exe") local.push("-SkipEdgeCases");
    const r = spawnSync(shell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-HookPackage", packed.hook, "-AgentPackage", packed.agent, ...local], {
      encoding: "utf8", timeout: 14 * 60_000, env: journeyEnv(),
    });
    process.stdout.write(r.stdout ?? "");
    assert.equal(r.status, 0, `${shell} journey failed:\n${r.stdout}${r.stderr}`);
  });
}

// The same journey as a standard (non-administrator) user, the way most people run Windows:
// a throwaway local account on the CI machine runs it through a scheduled task, with Node on
// PATH and npm's global folder in that user's own profile (%APPDATA%\npm), as the Node installer
// sets it up. The account and the task are removed afterwards; the password is random and never printed.
test("the Windows journey passes for a standard (non-administrator) user", { skip: !enabled || process.env.CI !== "true" ? "Windows CI only: it creates a local user account" : false, timeout: 20 * 60_000 }, async () => {
  const { randomBytes } = await import("node:crypto");
  const { copyFileSync, existsSync, mkdirSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  packed ??= pack();
  const user = "sbjourney";
  // 13 characters: `net user` stops to ask a yes/no question for a password over 14.
  const password = `Sb!${randomBytes(6).toString("base64url")}9a`;
  const shared = join(process.env.SystemDrive ?? "C:", "\\", `sb-journey-${randomBytes(4).toString("hex")}`);
  mkdirSync(shared, { recursive: true });
  copyFileSync(join(here, "windows-journey.ps1"), join(shared, "windows-journey.ps1"));
  // The copied folder cannot resolve the workspace package by name, so the stand-in workspace is
  // started from the built package by its absolute path.
  const { pathToFileURL } = await import("node:url");
  const fakeCloudIndex = pathToFileURL(join(root, "packages", "fake-cloud", "dist", "index.js")).href;
  writeFileSync(join(shared, "fake-cloud.mjs"), [
    `import { writeFileSync } from "node:fs";`,
    `import { startFakeCloud } from ${JSON.stringify(fakeCloudIndex)};`,
    `const i = process.argv.indexOf("--url-file");`,
    `const cloud = await startFakeCloud({ autoApprove: process.argv.includes("--auto-approve") });`,
    `if (i > 0 && process.argv[i + 1]) writeFileSync(process.argv[i + 1], cloud.url);`,
    `console.log(cloud.url);`,
    "",
  ].join("\n"));
  const hook = join(shared, "hook.tgz");
  copyFileSync(packed.hook, hook);
  // The packed agent names the hook tarball in this account's temp folder, which the standard
  // user cannot read: point it at the shared copy.
  const agent = withHookFrom(packed.agent, hook, shared);
  const quiet = { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] };
  const run = (cmd, args) => spawnSync(cmd, args, quiet);
  try {
    assert.equal(run("net", ["user", user, password, "/add"]).status, 0, "could not create the standard user");
    run("icacls", [shared, "/grant", `${user}:(OI)(CI)M`, "/T"]);
    // A scheduled task that runs as a user with a stored password needs "Log on as a batch job".
    // Windows Server (the CI image) grants it only to administrators and operators, so the task
    // never starts; a person's Windows 10/11 computer is not involved. Grant it to the throwaway user.
    const granted = run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", batchLogonScript(user, shared)]);
    assert.equal(granted.status, 0, `could not let the standard user run a scheduled task: ${granted.stdout}${granted.stderr}`);
    const nodeDir = dirname(process.execPath);
    const log = join(shared, "journey.log"), exit = join(shared, "journey.exit");
    writeFileSync(join(shared, "run.cmd"), [
      "@echo off",
      `echo started> "${join(shared, "journey.started")}"`,
      `set "PATH=${nodeDir};%PATH%"`,
      String.raw`set "npm_config_prefix=%APPDATA%\npm"`,
      String.raw`set "npm_config_cache=%LOCALAPPDATA%\npm-cache"`,
      `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${join(shared, "windows-journey.ps1")}" -HookPackage "${hook}" -AgentPackage "${agent}" -SkipEdgeCases > "${log}" 2>&1`,
      // Redirect first: `echo 0> file` would redirect handle 0 and write "ECHO is off.".
      `> "${exit}" echo %ERRORLEVEL%`,
      "",
    ].join("\r\n"));
    const created = run("schtasks", ["/Create", "/TN", "ScopebondJourney", "/TR", `cmd.exe /d /c "${join(shared, "run.cmd")}"`, "/SC", "ONCE", "/ST", "23:59", "/RU", user, "/RP", password, "/RL", "LIMITED", "/F"]);
    assert.equal(created.status, 0, `could not schedule the journey: ${created.stdout}${created.stderr}`);
    assert.equal(run("schtasks", ["/Run", "/TN", "ScopebondJourney"]).status, 0, "could not start the journey task");
    const started = join(shared, "journey.started");
    // The user's first logon creates its profile, which took over four minutes on a busy runner: the task shows Running
    // while it does, so that counts as starting. Only a task still not running after six minutes is taken as refused.
    const until = Date.now() + 18 * 60_000, startBy = Date.now() + 6 * 60_000;
    const taskRunning = () => /Status:\s+Running/.test(run("schtasks", ["/Query", "/TN", "ScopebondJourney", "/V", "/FO", "LIST"]).stdout ?? "");
    while (!existsSync(exit) && Date.now() < until) {
      // A task Windows refused to start never writes its first line: say why instead of waiting 18 minutes.
      if (!existsSync(started) && Date.now() > startBy && !taskRunning()) break;
      await new Promise((r) => setTimeout(r, 2_000));
    }
    if (!existsSync(started)) {
      const task = run("schtasks", ["/Query", "/TN", "ScopebondJourney", "/V", "/FO", "LIST"]);
      assert.fail(`the standard user's task never started:\n${task.stdout}${task.stderr}`);
    }
    const output = existsSync(log) ? readFileSync(log, "utf8") : "(no log)";
    process.stdout.write(output);
    assert.ok(existsSync(exit), `the standard user's journey did not finish:\n${output}`);
    assert.equal(readFileSync(exit, "utf8").trim(), "0", `the standard user's journey failed:\n${output}`);
  } finally {
    run("schtasks", ["/Delete", "/TN", "ScopebondJourney", "/F"]);
    run("net", ["user", user, "/delete"]);
  }
});

/** PowerShell that adds a user to "Log on as a batch job" with secedit (no extra tools). */
function batchLogonScript(user, dir) {
  const cfg = join(dir, "rights.inf"), db = join(dir, "rights.sdb");
  return [
    `$sid = (New-Object System.Security.Principal.NTAccount('${user}')).Translate([System.Security.Principal.SecurityIdentifier]).Value`,
    `secedit /export /cfg '${cfg}' /areas USER_RIGHTS | Out-Null`,
    `$lines = Get-Content -LiteralPath '${cfg}'`,
    "if ($lines -match '^SeBatchLogonRight') { $lines = $lines -replace '^(SeBatchLogonRight\\s*=.*)$', ('$1,*' + $sid) } else { $lines = $lines -replace '^\\[Privilege Rights\\]$', ('[Privilege Rights]' + [Environment]::NewLine + 'SeBatchLogonRight = *' + $sid) }",
    `Set-Content -LiteralPath '${cfg}' -Value $lines -Encoding Unicode`,
    `secedit /configure /db '${db}' /cfg '${cfg}' /areas USER_RIGHTS | Out-Null`,
    "exit $LASTEXITCODE",
  ].join("; ");
}
