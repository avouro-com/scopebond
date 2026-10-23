// From an npm install to the signed Windows install: the npm agent is stopped through its control channel before the
// signed one takes the lock, its sign-in entry, launcher, Apps entry and uninstall script go, and every Scopebond hook
// entry is pointed at the signed executable (other tools' entries untouched). The npm package itself is left to the person,
// who is told once how to remove it. The registry and the running agent are stand-ins; HOME, USERPROFILE and
// SCOPEBOND_HOME are temporary folders.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "sb-npm-migration-"));
const userHome = join(root, "home");
mkdirSync(userHome, { recursive: true });
const saved = { ...process.env };
Object.assign(process.env, { HOME: userHome, USERPROFILE: userHome, APPDATA: join(userHome, "AppData", "Roaming"), LOCALAPPDATA: join(userHome, "AppData", "Local"), SCOPEBOND_HOME: join(userHome, "state") });
after(() => { for (const k of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SCOPEBOND_HOME"]) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const { configuredHookCommands, nativeHookCommand, userHarnessFile } = await import("@scopebond/hook");
const { findNpmInstall, hasNpmInstall, migrateFromNpm, readMigration, useNativeHookEntries, missingPrograms, UNINSTALL_KEY, UNINSTALL_SCRIPT, windowsLauncher } = await import("../dist/index.js");

const EXE = "C:\\Users\\Pat\\AppData\\Local\\Programs\\Scopebond\\scopebond-agent.exe";
const NPM_CMD = (h) => `"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Pat\\AppData\\Roaming\\npm\\node_modules\\@scopebond\\hook\\dist\\cli.js" ${h}`;

function settings() {
  const claude = userHarnessFile("claude");
  mkdirSync(join(userHome, ".claude"), { recursive: true });
  writeFileSync(claude, JSON.stringify({
    theme: "dark",
    hooks: {
      PreToolUse: [
        { matcher: "*", hooks: [{ type: "command", command: NPM_CMD("claude") }] },
        { matcher: "Bash", hooks: [{ type: "command", command: "other-tool check" }] },
        { matcher: "*", hooks: [{ type: "command", command: "npx -y @scopebond/hook@0.20.0 claude" }] },
      ],
      SessionStart: [{ hooks: [{ type: "command", command: NPM_CMD("claude") }] }],
    },
  }, null, 2));
  mkdirSync(join(userHome, ".cursor"), { recursive: true });
  writeFileSync(userHarnessFile("cursor"), JSON.stringify({ version: 1, hooks: { beforeShellExecution: [{ command: NPM_CMD("cursor") }] } }));
}

/** A registry with these values present; records every call. */
function fakeReg(present) {
  const calls = [];
  const reg = (args) => {
    calls.push(args.join(" "));
    const [verb, key, flag, name] = args;
    const id = flag === "/v" ? `${key}:${name}` : key;
    if (verb === "query") return present.has(id);
    if (verb === "delete") return present.delete(id);
    return true;
  };
  return { reg, calls, present };
}

function npmComputer() {
  const dir = mkdtempSync(join(root, "sb-"));
  writeFileSync(join(dir, "agent-launch.cmd"), windowsLauncher("C:\\Program Files\\nodejs\\node.exe", "C:\\Users\\Pat\\AppData\\Roaming\\npm\\node_modules\\@scopebond\\agent\\dist\\cli.js", join(dir, "agent.log")));
  writeFileSync(join(dir, UNINSTALL_SCRIPT), "# npm uninstall script");
  const npmGlobal = join(root, `npm-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(npmGlobal, "@scopebond", "agent"), { recursive: true });
  writeFileSync(join(npmGlobal, "@scopebond", "agent", "package.json"), JSON.stringify({ name: "@scopebond/agent", version: "0.6.4" }));
  settings();
  return { dir, npmGlobal };
}

function deps(over) {
  const { reg } = over;
  return {
    reg, exists: existsSync, readText: (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } },
    harnesses: () => ["claude", "cursor"], exe: EXE, enableAutostart: () => "added ScopebondAgent (this executable)", sleep: async () => {}, now: () => 1_000,
    callAgent: async () => null, ...over,
  };
}

test("the signed install takes over: npm agent stopped first, sign-in entry, launcher, Apps entry and script gone, hook entries moved", async () => {
  const { dir, npmGlobal } = npmComputer();
  const r = fakeReg(new Set(["HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run:ScopebondAgent", UNINSTALL_KEY]));
  const order = [];
  let running = true;
  const callAgent = async (_dir, method, route) => {
    order.push(`${method} ${route}`);
    if (method === "POST" && route === "/stop") { running = false; return { stopping: true }; }
    return running ? { agent: { pid: 77, version: "agent/0.6.4" } } : null; // an npm agent does not say what it is
  };
  const found = findNpmInstall(dir, deps({ reg: r.reg, npmGlobal }));
  assert.ok(hasNpmInstall(found));
  assert.deepEqual(found.hookEntries, ["claude", "cursor"]);
  const logs = [];
  const tray = "C:\\Users\\Pat\\AppData\\Local\\Programs\\Scopebond\\scopebond-tray.exe";
  const steps = await migrateFromNpm(dir, "per-user", tray, (l) => logs.push(l), deps({ reg: r.reg, npmGlobal, callAgent }));
  assert.deepEqual(order.slice(0, 2), ["GET /status", "POST /stop"], "the running npm agent is asked to stop first");
  assert.equal(running, false);
  assert.ok(!r.present.has("HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run:ScopebondAgent"), "its sign-in entry is gone");
  assert.ok(!r.present.has(UNINSTALL_KEY), "its Settings -> Apps entry is gone");
  assert.equal(existsSync(join(dir, "agent-launch.cmd")), false, "its launcher is gone (the tray starts the agent)");
  assert.equal(existsSync(join(dir, UNINSTALL_SCRIPT)), false, "its uninstall script is gone");

  const claude = JSON.parse(readFileSync(userHarnessFile("claude"), "utf8"));
  assert.deepEqual([...new Set(configuredHookCommands(userHarnessFile("claude")))], [nativeHookCommand("claude", EXE)], "every Scopebond entry runs the signed executable");
  const ours = (list) => (list ?? []).filter((e) => JSON.stringify(e).includes("scopebond-agent.exe"));
  assert.equal(ours(claude.hooks.PreToolUse).length, 1, "one before each tool call: the npx copy is gone too");
  assert.equal(ours(claude.hooks.SessionStart).length, 1, "the session observations keep running, with the same command");
  assert.equal(claude.theme, "dark", "the rest of the file is kept");
  assert.ok(JSON.stringify(claude).includes("other-tool check"), "another tool's entry is untouched");
  assert.deepEqual([...new Set(configuredHookCommands(userHarnessFile("cursor")))], [nativeHookCommand("cursor", EXE)]);
  assert.ok(steps.length >= 4, steps.join("\n"));
  assert.equal(logs.filter((l) => /npm\.cmd uninstall -g @scopebond\/agent/.test(l)).length, 1, "told once how to remove the npm copy");
  assert.equal(readMigration(dir)?.package_dir, join(npmGlobal, "@scopebond", "agent"));

  // Again (the next start): nothing left to move, nothing said twice.
  const later = [];
  assert.deepEqual(await migrateFromNpm(dir, "per-user", tray, (l) => later.push(l), deps({ reg: r.reg, npmGlobal, callAgent })), []);
  assert.deepEqual(later.filter((l) => /uninstall -g/.test(l)), []);
  assert.deepEqual(useNativeHookEntries(["claude", "cursor"], EXE), [], "entries already in the signed form are left byte for byte");
});

test("a signed agent already running is never stopped; an npm install does nothing; without the tray autostart moves to this executable", async () => {
  const { dir, npmGlobal } = npmComputer();
  const r = fakeReg(new Set());
  const posted = [];
  const nativeRunning = async (_d, method, route) => { if (method === "POST") posted.push(route); return { agent: { pid: 5, version: "agent/0.7.0", install_kind: "per-user" } }; };
  await migrateFromNpm(dir, "per-user", "C:\\x\\scopebond-tray.exe", () => {}, deps({ reg: r.reg, npmGlobal, callAgent: nativeRunning }));
  assert.deepEqual(posted, [], "a signed agent is not the npm one");
  assert.deepEqual(await migrateFromNpm(dir, "npm", null, () => {}, deps({ reg: r.reg, npmGlobal })), [], "only the signed install takes over");

  const second = npmComputer();
  let autostart = 0;
  const steps = await migrateFromNpm(second.dir, "per-user", null, () => {}, deps({ reg: r.reg, npmGlobal: second.npmGlobal, enableAutostart: () => { autostart += 1; return "added ScopebondAgent (this executable)"; } }));
  assert.equal(autostart, 1);
  assert.ok(steps.includes("added ScopebondAgent (this executable)"));
});

test("a hook entry whose program is gone names the missing file", () => {
  const exists = (f) => !f.includes("Gone");
  assert.deepEqual(missingPrograms([`"C:\\Program Files\\Gone\\scopebond-agent.exe" hook claude`, nativeHookCommand("claude", EXE)], exists), ["C:\\Program Files\\Gone\\scopebond-agent.exe"]);
  assert.deepEqual(missingPrograms(["npx -y @scopebond/hook@1.0.0 claude"], () => false), [], "an npx form names no file");
});

test("an executable path no hook shell could start is recorded per coding agent, not thrown (Windows)", { skip: process.platform !== "win32" && "Windows only" }, async () => {
  const { hasForeignHookEntries } = await import("../dist/index.js");
  settings();
  // A `$` in a folder that has no short name (it does not exist): only the quoted form would be left, and Git Bash would
  // expand the `$` in it. Each coding agent's entry is reported as not moved; nothing throws, nothing is rewritten.
  const bad = "D:\\no such\\$dir\\scopebond-agent.exe";
  const before = readFileSync(userHarnessFile("claude"), "utf8");
  const changes = useNativeHookEntries(["claude", "cursor"], bad);
  assert.deepEqual(changes.map((c) => c.harness), ["claude", "cursor"]);
  for (const c of changes) assert.match(c.reason, /could not be moved to the signed install: .*even inside quotes/);
  assert.equal(readFileSync(userHarnessFile("claude"), "utf8"), before, "the settings are left as they were");
  assert.equal(hasForeignHookEntries("claude", bad), false);
});
