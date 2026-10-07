// The handover after a self-update: the updated agent starts, whatever started the old one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  handoverPlan, launcherPath, windowsLauncher, launcherIsCurrent, refreshLauncher, startCommands, startControl,
  AFTER_PID_ENV, REFRESH_LAUNCHER_ENV, AGENT_LOG_ENV, FALLBACK_LOG,
} from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, "..", "dist");

// The Windows launcher as agent 0.4.6 and earlier wrote it: the agent's output redirected into agent.log by cmd.
const legacyLauncher = (node, cli) => [
  "@echo off", "chcp 65001 >nul",
  "rem Scopebond Agent launcher: finds Node and the agent each time, so a Node upgrade never stops it.",
  "setlocal", `set "NODE=${node}"`, `if not exist "%NODE%" set "NODE="`, `set "CLI=${cli}"`, "if not defined NODE exit /b 1",
  "set /a TRIES=0", ":run",
  `"%NODE%" --disable-warning=ExperimentalWarning "%CLI%" run >> "%~dp0agent.log" 2>&1`,
  `set "CODE=%ERRORLEVEL%"`, "if %CODE% EQU 0 exit /b 0", "set /a TRIES+=1",
  `echo %DATE% %TIME% the agent stopped with exit code %CODE%; restarting in 30 seconds (attempt %TRIES% of 50) >> "%~dp0agent.log"`,
  "if %TRIES% GEQ 50 exit /b 1", "ping -n 31 127.0.0.1 >nul", "goto run", "",
].join("\r\n");

test("the updated agent starts through a current launcher, directly under an older one, and by systemd under systemd", () => {
  const dir = join("C:", "Users", "a b", ".scopebond");
  const base = { dir, cli: "C:\\npm\\cli.js", pid: 4242, execPath: "C:\\node\\node.exe", platform: "win32", env: { PATH: "x" } };
  const current = handoverPlan({ ...base, launcherText: windowsLauncher("C:\\node\\node.exe", "C:\\npm\\cli.js", join(dir, "agent.log")) });
  const [command, args] = startCommands(launcherPath(dir, "win32"), "win32")[1];
  assert.deepEqual(current, { kind: "spawn", command, args, verbatim: true, env: { PATH: "x", [AFTER_PID_ENV]: "4242", [AGENT_LOG_ENV]: join(dir, "agent.log") } },
    "the launcher's own start command, quoted as cmd reads it");
  const older = handoverPlan({ ...base, launcherText: legacyLauncher("C:\\node\\node.exe", "C:\\npm\\cli.js") });
  assert.equal(older.command, "C:\\node\\node.exe");
  assert.deepEqual(older.args, ["--disable-warning=ExperimentalWarning", "C:\\npm\\cli.js", "run"]);
  assert.equal(older.env[REFRESH_LAUNCHER_ENV], "1", "the replacement rewrites the older launcher");
  const none = handoverPlan({ ...base, launcherText: null });
  assert.equal(none.command, "C:\\node\\node.exe");
  assert.equal(none.env[REFRESH_LAUNCHER_ENV], undefined, "no autostart: nothing to rewrite");
  assert.equal(none.env[AGENT_LOG_ENV], join(dir, "agent.log"), "a replacement started directly still writes the log");
  const mac = handoverPlan({ ...base, dir: "/opt/sb", platform: "darwin", launcherText: "#!/bin/sh\n" });
  assert.equal(mac.command, "/bin/sh");
  assert.deepEqual(mac.args, [launcherPath("/opt/sb", "darwin")]);
  assert.deepEqual(handoverPlan({ ...base, platform: "linux", env: { INVOCATION_ID: "abc" }, launcherText: "#!/bin/sh\n" }), { kind: "service-restart" },
    "systemd stops a detached child with the service, so it restarts the service instead");
});

test("an older Windows launcher is rewritten once, keeping its paths; a current one is left alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-handover-refresh-"));
  writeFileSync(launcherPath(dir, "win32"), legacyLauncher("C:\\node\\node.exe", "C:\\npm\\cli.js"));
  assert.equal(launcherIsCurrent(readFileSync(launcherPath(dir, "win32"), "utf8"), "win32"), false);
  assert.equal(refreshLauncher(dir, "C:\\npm\\cli.js", "C:\\node\\node.exe", "win32"), true);
  const text = readFileSync(launcherPath(dir, "win32"), "utf8");
  assert.equal(launcherIsCurrent(text, "win32"), true);
  assert.ok(text.includes(`set "NODE=C:\\node\\node.exe"`) && text.includes(`set "CLI=C:\\npm\\cli.js"`));
  assert.doesNotMatch(text, />> "%~dp0agent\.log" 2>&1/, "no redirect into the log on the agent's line");
  assert.equal(refreshLauncher(dir, "C:\\npm\\cli.js", "C:\\node\\node.exe", "win32"), false);
  assert.equal(refreshLauncher(mkdtempSync(join(tmpdir(), "sb-handover-none-")), "C:\\npm\\cli.js", "C:\\node\\node.exe", "win32"), false, "no launcher, no autostart to keep");
});

test("the agent writes its own log, and an error that ends it is in the log with a failing exit code", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-handover-log-"));
  const log = join(dir, "agent.log");
  writeFileSync(log, "earlier line\n");
  const script = `const { writeOutputTo } = await import(${JSON.stringify(pathToFileURL(join(dist, "log-file.js")).href)});
writeOutputTo(${JSON.stringify(log)});
console.log("a line"); console.error("a problem"); process.stdout.write("no newline", () => process.stdout.write(" then the rest\\n"));
setTimeout(() => { throw new Error("broken"); }, 50);`;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(run.status, 1, run.stderr);
  assert.equal(run.stdout, "", "nothing on the console");
  const text = readFileSync(log, "utf8");
  assert.match(text, /^earlier line\na line\na problem\nno newline then the rest\n/);
  assert.match(text, /the agent stopped on an error: Error: broken/);
  assert.equal(existsSync(join(dir, FALLBACK_LOG)), false);
});

test("check waits for the updated agent and says which version runs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-handover-check-"));
  let version = "agent/0.4.6";
  const control = await startControl(dir, version, {
    "GET /status": () => ({ agent: { version } }),
    "POST /maintain": () => { setTimeout(() => { version = "agent/0.9.9"; }, 1_500); return { updatedTo: "0.9.9", error: null }; },
  });
  try {
    const child = spawn(process.execPath, [join(dist, "cli.js"), "check"], { env: { ...process.env, SCOPEBOND_HOME: dir, HOME: dir, USERPROFILE: dir }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    const code = await new Promise((r) => child.on("exit", r));
    assert.equal(code, 0, out);
    assert.match(out, /"updatedTo": "0\.9\.9"/);
    assert.match(out, /The Scopebond Agent 0\.9\.9 is running\./);
  } finally { await control.close(); }
});

// The real thing on Windows: a launcher starts an "agent" that hands over the way the agent does after an update.
const windows = process.platform === "win32";

/** A stand-in agent: started without a handover, it hands over at once and exits; started as the replacement, it takes over and notes it. */
function fakeAgent(dir) {
  const cli = join(dir, "fake-cli.mjs");
  writeFileSync(cli, `import { appendFileSync } from "node:fs";
const { spawnReplacement, takeOver, writeOutputTo } = await import(${JSON.stringify(pathToFileURL(join(dist, "index.js")).href)});
const home = ${JSON.stringify(dir)};
if (process.env.SCOPEBOND_AGENT_LOG) writeOutputTo(process.env.SCOPEBOND_AGENT_LOG);
if (!process.env.SCOPEBOND_AGENT_AFTER_PID) {
  console.log("old agent " + process.pid);
  spawnReplacement(home, ${JSON.stringify(cli)});
  setTimeout(() => process.exit(0), 500);
} else {
  await takeOver(home, ${JSON.stringify(cli)});
  console.log("replacement " + process.pid);
  appendFileSync(${JSON.stringify(join(dir, "marker.txt"))}, "replacement " + process.pid + "\\n");
}
`);
  return cli;
}

async function startLauncher(dir) {
  const [command, args] = startCommands(launcherPath(dir, "win32"), "win32")[1];
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, SCOPEBOND_HOME: dir };
  delete env[AFTER_PID_ENV]; delete env[REFRESH_LAUNCHER_ENV]; delete env[AGENT_LOG_ENV];
  spawn(command, args, { env, detached: true, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true }).unref();
  const marker = join(dir, "marker.txt");
  for (let i = 0; i < 80 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 250));
  return existsSync(marker) ? readFileSync(marker, "utf8") : "";
}

const logs = (dir) => ["agent.log", FALLBACK_LOG].map((f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : "")).join("");

test("on Windows, an agent started by its launcher hands over to its update, and both write the one log", { skip: !windows && "Windows only" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-handover-win-"));
  const cli = fakeAgent(dir);
  writeFileSync(launcherPath(dir, "win32"), windowsLauncher(process.execPath, cli, join(dir, "agent.log")));
  const marker = await startLauncher(dir);
  assert.match(marker, /^replacement \d+/, `the replacement never started; log:\n${logs(dir)}`);
  const log = readFileSync(join(dir, "agent.log"), "utf8");
  assert.match(log, /old agent \d+/);
  assert.match(log, /replacement \d+/);
});

test("on Windows, an agent started by an older launcher still hands over, and the launcher is rewritten", { skip: !windows && "Windows only" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-handover-old-"));
  const cli = fakeAgent(dir);
  writeFileSync(launcherPath(dir, "win32"), legacyLauncher(process.execPath, cli));
  const marker = await startLauncher(dir);
  assert.match(marker, /^replacement \d+/, `the replacement never started; log:\n${logs(dir)}`);
  assert.equal(launcherIsCurrent(readFileSync(launcherPath(dir, "win32"), "utf8"), "win32"), true, "rewritten once the old agent was gone");
  assert.match(logs(dir), /replacement \d+/, "the replacement's lines are in a log");
});

test("the single executable starts its update as itself with `run`, with no cli.js and no Node options", () => {
  const plan = handoverPlan({ dir: "/opt/sb", cli: "/opt/sb/scopebond-agent", pid: 7, execPath: "/opt/sb/scopebond-agent", platform: "linux", env: {}, launcherText: null, singleExecutable: true });
  assert.equal(plan.command, "/opt/sb/scopebond-agent");
  assert.deepEqual(plan.args, ["run"]);
});
