// What the hook tells a person to run is in the form this installation runs. Installed by the signed Windows installer
// (the single executable, which may be on a computer with no Node.js), every command is `scopebond-agent hook <sub>` or
// `scopebond-agent <sub>`, never `npx.cmd` or `npm.cmd`; installed from npm, the version-pinned npx form stays.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cliCommand, agentCommand, onboardingSteps, nativeHookProgram, missingHookPrograms, nativeHookCommand, isSingleExecutable } from "../dist/index.js";
import { healthLines } from "../dist/client-health.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const NPM = /\bnpx(\.cmd)?\b|\bnpm(\.cmd)?\b|\.cmd\b/;

test("this test process is not the single executable", () => assert.equal(isSingleExecutable(), false));

test("the hook's own commands: the installer's form, and npm's form on each platform", () => {
  assert.equal(cliCommand("rules", "win32", true), "scopebond-agent hook rules");
  assert.equal(cliCommand("connect <workspace-url> <enrollment>", "win32", true), "scopebond-agent hook connect <workspace-url> <enrollment>");
  assert.equal(cliCommand("status", "darwin", true), "scopebond-agent hook status");
  assert.match(cliCommand("rules", "win32", false), /^npx\.cmd -y @scopebond\/hook@\S+ rules$/);
  assert.match(cliCommand("rules", "linux", false), /^npx -y @scopebond\/hook@\S+ rules$/);
  assert.match(cliCommand("rules", "darwin"), /^npx -y @scopebond\/hook@\S+ rules$/, "npm form by default outside the executable");
});

test("the agent's commands: the installer's program by its plain name, npm's .cmd shim on Windows", () => {
  assert.equal(agentCommand("autostart on", "win32", true), "scopebond-agent autostart on");
  assert.equal(agentCommand("autostart on", "win32", false), "scopebond-agent.cmd autostart on");
  assert.equal(agentCommand("autostart on", "linux", false), "scopebond-agent autostart on");
});

test("next steps after setup: no npm on the installer's form, npm's install on npm's", () => {
  const command = (sub) => cliCommand(sub, "win32", true);
  const native = onboardingSteps({ harness: "claude", command, native: true, platform: "win32" }).join("\n");
  assert.doesNotMatch(native, NPM, native);
  assert.match(native, /scopebond-agent hook login https:\/\/cloud\.scopebond\.com/);
  assert.match(native, /^ {2}scopebond-agent autostart on$/m);
  const npm = onboardingSteps({ harness: "cursor", command: (s) => cliCommand(s, "win32", false), native: false, platform: "win32" }).join("\n");
  assert.match(npm, /npm\.cmd install -g @scopebond\/agent\n {2}scopebond-agent\.cmd autostart on/);
  const mac = onboardingSteps({ harness: "claude", command: (s) => cliCommand(s, "darwin", false), native: false, platform: "darwin" }).join("\n");
  assert.match(mac, /npm install -g @scopebond\/agent\n {2}scopebond-agent autostart on/);
});

test("status and doctor health lines: an update and a stopped agent are fixed without npm on the installer's form", () => {
  const input = { hookVersion: "0.16.0", recommended: { hook: "0.19.2", agent: "0.4.4" }, connected: true, workspaceUrl: "https://cloud.example" };
  const native = healthLines({ ...input, agent: { state: "not_installed" }, native: true, platform: "win32" });
  assert.equal(native.length, 2);
  for (const line of native) assert.doesNotMatch(line.text, NPM, line.text);
  assert.match(native[0].text, /Update: install the newer Scopebond from https:\/\/scopebond\.com\//);
  assert.match(native[1].text, /not running.*Start it: scopebond-agent autostart on$/);
  const stopped = healthLines({ ...input, agent: { state: "stopped" }, native: true, platform: "win32" });
  assert.match(stopped[1].text, /Start it: scopebond-agent autostart on$/);
  const npm = healthLines({ ...input, agent: { state: "not_installed" }, native: false, platform: "win32" });
  assert.match(npm[0].text, /Update: npx\.cmd -y @scopebond\/hook@0\.19\.2 install$/);
  assert.match(npm[1].text, /Install it: npx\.cmd -y @scopebond\/agent@0\.4\.4 setup https:\/\/cloud\.example$/);
  const posix = healthLines({ ...input, agent: { state: "stopped" }, native: false, platform: "linux" });
  assert.match(posix[0].text, /Update: npx -y @scopebond\/hook@0\.19\.2 install$/);
  assert.match(posix[1].text, /Start it: scopebond-agent autostart on$/);
});

test("a hook entry's single executable is read from the entry, and only from that form", () => {
  const exe = "C:\\Program Files\\Scopebond\\scopebond-agent.exe";
  // Without a short name for "Program Files" the path stays quoted; with one it is the shell-plain spelling, read back with backslashes.
  assert.equal(nativeHookProgram(nativeHookCommand("claude", exe, () => null)), exe);
  assert.equal(nativeHookProgram("C:/PROGRA~1/Scopebond/scopebond-agent.exe hook claude"), "C:\\PROGRA~1\\Scopebond\\scopebond-agent.exe");
  assert.equal(nativeHookProgram(`"${exe}" hook codex`), exe);
  assert.equal(nativeHookProgram("npx -y @scopebond/hook@1.0.0 claude"), null);
  assert.equal(nativeHookProgram(`"C:\\node\\node.exe" "C:\\x\\cli.js" claude`), null);
  assert.equal(nativeHookProgram(`"C:\\x\\other.exe" hook claude`), null);
});

function isolatedHome() {
  const home = mkdtempSync(join(tmpdir(), "sb-native-home-"));
  const env = { ...process.env, HOME: home, USERPROFILE: home, SCOPEBOND_HOME: join(home, ".scopebond") };
  delete env.SCOPEBOND_HOOK_DIR;
  delete env.CLAUDE_PROJECT_DIR;
  return { home, env };
}

test("a shared npx hook on a computer without npx: this computer is covered without changing the shared file", async () => {
  const { coverWithoutNpx, placeHook, configuredHookCommands, writeHarnessConfig } = await import("../dist/index.js");
  const { home, env } = isolatedHome();
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  Object.assign(process.env, { HOME: env.HOME, USERPROFILE: env.USERPROFILE });
  try {
    const exe = join(home, "Programs", "Scopebond", "scopebond-agent.exe");
    mkdirSync(join(home, "Programs", "Scopebond"), { recursive: true });
    writeFileSync(exe, "");
    // Claude Code, no user-level hook: the installer's command goes into this computer's settings.local.json.
    const project = mkdtempSync(join(tmpdir(), "sb-native-shared-"));
    const placed = placeHook("claude", project, undefined, { shared: true });
    const lines = coverWithoutNpx("claude", project, { label: "Claude Code", command: nativeHookCommand("claude", exe) });
    assert.match(lines.join("\n"), /no npx \(Node\.js\)/);
    assert.match(lines.join("\n"), /settings\.local\.json \(kept out of git\)/);
    assert.deepEqual(configuredHookCommands(join(project, ".claude", "settings.local.json")), [nativeHookCommand("claude", exe)]);
    assert.match(configuredHookCommands(placed.file)[0], /^npx -y @scopebond\/hook@\S+ claude$/, "the shared file keeps the portable form");
    // Cursor has no personal file: the user-level install is named.
    const cursor = coverWithoutNpx("cursor", project, { label: "Cursor", command: nativeHookCommand("cursor", exe) }).join("\n");
    assert.ok(cursor.includes(cliCommand("install --cursor")), cursor);
    // A user-level hook that starts here already covers it: nothing else is written.
    writeHarnessConfig(join(home, ".cursor", "hooks.json"), "cursor", nativeHookCommand("cursor", exe));
    assert.match(coverWithoutNpx("cursor", project, { label: "Cursor" }).join("\n"), /covered by the user-level hook/);
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test("status and doctor report a hook entry whose program was removed, with the commands that repair it", () => {
  const { home, env } = isolatedHome();
  const gone = join(home, "Program Files", "Scopebond", "scopebond-agent.exe");
  const settings = join(home, ".claude", "settings.json");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: nativeHookCommand("claude", gone) }] }] } }));
  assert.deepEqual(missingHookPrograms(settings).map((m) => m.program), [gone]);
  const project = mkdtempSync(join(tmpdir(), "sb-native-project-"));
  const status = execFileSync(process.execPath, [cli, "status"], { cwd: project, encoding: "utf8", env });
  assert.match(status, /MISSING PROGRAM/);
  assert.ok(status.includes(`points at a missing program (${gone})`), status);
  assert.ok(status.includes(cliCommand("install")) && status.includes(cliCommand("uninstall")), "names the repair in this installation's form");
  let doctor;
  try { doctor = execFileSync(process.execPath, [cli, "doctor"], { cwd: project, encoding: "utf8", env }); } catch (error) { doctor = String(error.stdout ?? ""); }
  assert.match(doctor, /cannot start \(missing program\)/);
  assert.ok(doctor.includes(`points at a missing program (${gone})`), doctor);
  // A program that is there is no problem.
  const present = join(home, "scopebond-agent.exe");
  writeFileSync(present, "");
  writeFileSync(settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: nativeHookCommand("claude", present) }] }] } }));
  assert.deepEqual(missingHookPrograms(settings), []);
  assert.doesNotMatch(execFileSync(process.execPath, [cli, "status"], { cwd: project, encoding: "utf8", env }), /MISSING PROGRAM/);
});
