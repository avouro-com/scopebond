// From an npm install to the macOS package: the npm agent is stopped through its control channel, autostart becomes the
// package's LaunchAgent (which takes the npm agent's own LaunchAgent and launcher away), every Scopebond hook entry runs
// the package's executable, and the person is told once how to remove the npm package. launchd and the running agent are
// stand-ins; HOME and SCOPEBOND_HOME are temporary folders. The paths are macOS's, so it runs where they are (not Windows).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "sb-npm-migration-mac-"));
const userHome = join(root, "home");
mkdirSync(userHome, { recursive: true });
const saved = { ...process.env };
Object.assign(process.env, { HOME: userHome, USERPROFILE: userHome, SCOPEBOND_HOME: join(userHome, "state") });
after(() => { for (const k of ["HOME", "USERPROFILE", "SCOPEBOND_HOME"]) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const { userHarnessFile } = await import("@scopebond/hook");
const { autostartPaths, findNpmInstall, hasNpmInstall, isNpmLauncher, launcherPackageDir, launcherPath, macLaunchAgent, migrateFromNpm, npmRemovalCommand, posixLauncher, readMigration } = await import("../dist/index.js");

const EXE = "/usr/local/bin/scopebond-agent";
const npmGlobal = join(root, "lib", "node_modules");
const CLI = join(npmGlobal, "@scopebond", "agent", "dist", "cli.js");
const mac = { skip: process.platform === "win32" && "macOS paths" };
const NPM_HOOK = (h) => `"/opt/homebrew/bin/node" "${join(npmGlobal, "@scopebond", "hook", "dist", "cli.js")}" ${h}`;

/** What an npm install left: its launcher and LaunchAgent, the package, and Claude Code's hook entry running npm's hook. */
function npmMac() {
  const dir = mkdtempSync(join(root, "sb-"));
  writeFileSync(launcherPath(dir, "darwin"), posixLauncher("/opt/homebrew/bin/node", CLI), { mode: 0o700 });
  const plist = autostartPaths().macPlist;
  mkdirSync(join(userHome, "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(plist, macLaunchAgent(launcherPath(dir, "darwin"), join(dir, "agent.log")));
  mkdirSync(join(npmGlobal, "@scopebond", "agent"), { recursive: true });
  writeFileSync(join(npmGlobal, "@scopebond", "agent", "package.json"), JSON.stringify({ name: "@scopebond/agent", version: "0.11.0" }));
  mkdirSync(join(userHome, ".claude"), { recursive: true });
  writeFileSync(userHarnessFile("claude"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: NPM_HOOK("claude") }] }] } }, null, 2));
  return dir;
}

function deps(over = {}) {
  return {
    reg: () => { throw new Error("no registry on macOS"); },
    exists: (p) => { try { readFileSync(p); return true; } catch { return false; } },
    readText: (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } },
    harnesses: () => ["claude"], exe: EXE, npmGlobal: null, platform: "darwin",
    enableAutostart: () => "the Scopebond package's LaunchAgent (/Library/LaunchAgents/com.scopebond.agent.plist) starts the agent with your sign-in",
    sleep: async () => {}, now: () => 1_000, callAgent: async () => null, ...over,
  };
}

test("an npm launcher is told from the single executable's, and names its package", mac, () => {
  assert.equal(isNpmLauncher(posixLauncher("/opt/homebrew/bin/node", CLI)), true);
  assert.equal(isNpmLauncher(posixLauncher(EXE, "")), false, "the package's executable starts itself");
  assert.equal(launcherPackageDir(posixLauncher("/opt/homebrew/bin/node", CLI)), join(npmGlobal, "@scopebond", "agent"));
  assert.equal(launcherPackageDir(posixLauncher("/n", "/opt/o'neil/lib/node_modules/@scopebond/agent/dist/cli.js")), "/opt/o'neil/lib/node_modules/@scopebond/agent");
  assert.equal(launcherPackageDir(posixLauncher(EXE, "")), null);
  assert.equal(npmRemovalCommand("darwin"), "npm uninstall -g @scopebond/agent");
  assert.equal(npmRemovalCommand("win32"), "npm.cmd uninstall -g @scopebond/agent");
});

test("macOS: what an npm install left is found without a registry", mac, () => {
  const dir = npmMac();
  const found = findNpmInstall(dir, deps());
  assert.deepEqual(found, { runValue: false, npmLauncher: true, npmLaunchAgent: true, appsEntry: false, uninstallScript: false, packageDir: join(npmGlobal, "@scopebond", "agent"), hookEntries: ["claude"] });
  assert.equal(hasNpmInstall(found), true);
});

test("macOS: the package takes over: npm agent stopped first, autostart the package's, hook entries moved, told once how to remove npm's", mac, async () => {
  const dir = npmMac();
  const order = [];
  let running = true;
  const callAgent = async (_dir, method, path) => {
    if (method === "GET" && path === "/status") return running ? { agent: { install_kind: "npm" } } : null;
    if (method === "POST" && path === "/stop") { order.push("stop"); running = false; return { ok: true }; }
    return null;
  };
  const lines = [];
  const steps = await migrateFromNpm(dir, "per-machine", null, (l) => lines.push(l), deps({ callAgent, enableAutostart: () => { order.push("autostart"); return "the package's LaunchAgent starts the agent"; } }));
  assert.deepEqual(order, ["stop", "autostart"], "the npm agent stops before autostart moves");
  assert.equal(steps[0], "stopped the Scopebond Agent installed with npm");
  assert.equal(steps[1], "the package's LaunchAgent starts the agent");
  assert.ok(steps.some((s) => s.includes(userHarnessFile("claude"))), steps.join("\n"));
  const commands = JSON.parse(readFileSync(userHarnessFile("claude"), "utf8")).hooks.PreToolUse.flatMap((m) => m.hooks.map((h) => h.command));
  assert.deepEqual(commands, [`"${EXE}" hook claude`], "the hook entry runs the package's executable");
  assert.ok(lines.some((l) => l === "the Scopebond Agent installed with npm is no longer used; remove it with: npm uninstall -g @scopebond/agent"), lines.join("\n"));
  assert.equal(readMigration(dir)?.package_dir, join(npmGlobal, "@scopebond", "agent"));
  // Once: a second start says nothing more about removing it.
  const again = [];
  await migrateFromNpm(dir, "per-machine", null, (l) => again.push(l), deps());
  assert.ok(!again.some((l) => l.includes("remove it with")), again.join("\n"));
});

test("macOS: an npm install of the same package as this agent's is not taken over by itself", mac, async () => {
  const dir = mkdtempSync(join(root, "sb-"));
  writeFileSync(launcherPath(dir, "darwin"), posixLauncher(EXE, ""), { mode: 0o700 });
  const found = findNpmInstall(dir, deps({ harnesses: () => [] }));
  assert.equal(hasNpmInstall(found), false);
  assert.deepEqual(await migrateFromNpm(dir, "per-machine", null, () => {}, deps({ harnesses: () => [] })), []);
});
