// Every hook entry the installer writes must start the same way whichever shell the coding agent runs it under. On
// Windows that is cmd.exe (Codex's and Cursor's default), Windows PowerShell or PowerShell 7 (Codex runs hooks through the
// session's shell, and a user can choose PowerShell), or Git Bash (Claude Code). A quoted path that starts a command is a
// string to PowerShell ("Unexpected token"), and a coding agent treats a hook that cannot start as a non-blocking error:
// the action runs with no check. The first half checks the generated entries anywhere; the second runs them, on Windows,
// through each shell and requires each to start the hook and deny `scopebond-agent stop`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  shellPlainWindowsPath, windowsHookCommandLine, codexHookEntry, codexWindowsCommand, nativeHookProgram, isScopebondHookCommand,
  isMachineSpecificCommand, writeHarnessConfig, removeHarnessConfig, isHarnessConfigured, configuredHookCommands, absoluteHookCommand,
  nativeHookCommand, windowsShortPath,
} from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "dist", "cli.js");

const fakeShort = (map) => (path) => map[path] ?? null;

test("a Windows path is spelled without quotes, with forward slashes", () => {
  assert.equal(shellPlainWindowsPath("C:\\tools\\node\\node.exe", fakeShort({})), "C:/tools/node/node.exe");
  assert.equal(shellPlainWindowsPath("D:/a/sb/.scopebond/runtime/0.6.0/node_modules/@scopebond/hook/dist/cli.js", fakeShort({})),
    "D:/a/sb/.scopebond/runtime/0.6.0/node_modules/@scopebond/hook/dist/cli.js");
  assert.equal(shellPlainWindowsPath("/usr/bin/node", fakeShort({})), null, "not a drive path");
  assert.equal(shellPlainWindowsPath("\\\\server\\share\\cli.js", fakeShort({})), null, "a network path has no drive");
});

test("only the folders up to the last one a shell would misread take their short name; the file name stays", () => {
  const short = fakeShort({
    "C:\\Program Files": "C:\\PROGRA~1",
    "D:\\Teams\\Pat O'Neil\\My (work)": "D:\\Teams\\PATONE~1\\MYWORK~1",
  });
  assert.equal(shellPlainWindowsPath("C:\\Program Files\\nodejs\\node.exe", short), "C:/PROGRA~1/nodejs/node.exe");
  assert.equal(shellPlainWindowsPath("D:\\Teams\\Pat O'Neil\\My (work)\\scopebond\\scopebond-agent.exe", short),
    "D:/Teams/PATONE~1/MYWORK~1/scopebond/scopebond-agent.exe");
  assert.equal(shellPlainWindowsPath("C:\\Program Files (x86)\\x\\cli.js", short), null, "no short name: no plain spelling");
  assert.equal(shellPlainWindowsPath("C:\\Program Files\\x\\cli.js", fakeShort({ "C:\\Program Files": "C:\\Program Files" })), null,
    "8.3 names switched off: cmd gives the long name back, which is refused");
  assert.equal(shellPlainWindowsPath("C:\\a b\\cli.js", fakeShort({ "C:\\a b": "D:\\AB~1" })), null, "a short name on another drive is refused");
  for (const bad of ["$x", "a&b", "a;b", "a%b", "a`b", "a'b", "a(b"]) {
    assert.equal(shellPlainWindowsPath(`C:\\${bad}\\cli.js`, fakeShort({})), null, `${bad} is never written unquoted`);
  }
});

test("the command line is plain only when every path is", () => {
  const short = fakeShort({ "C:\\Program Files": "C:\\PROGRA~1" });
  assert.equal(windowsHookCommandLine(["C:\\Program Files\\nodejs\\node.exe", "C:\\sb\\cli.js"], "codex", short), "C:/PROGRA~1/nodejs/node.exe C:/sb/cli.js codex");
  assert.equal(windowsHookCommandLine(["C:\\Program Files\\nodejs\\node.exe", "C:\\a b\\cli.js"], "codex", short), null);
});

test("a Codex entry carries its Windows command: npx.cmd for the portable form, the command itself on Windows", () => {
  const npx = codexHookEntry("npx -y @scopebond/hook@1.2.3 codex", "linux");
  assert.equal(npx.command, "npx -y @scopebond/hook@1.2.3 codex");
  assert.equal(npx.commandWindows, "npx.cmd -y @scopebond/hook@1.2.3 codex");
  assert.equal(npx.timeout, 30);
  assert.equal(npx.statusMessage, "Checking this action with Scopebond");
  assert.equal(codexHookEntry("/usr/bin/node /opt/sb/cli.js codex", "linux").commandWindows, undefined, "a POSIX path means nothing on Windows");
  assert.equal(codexWindowsCommand("C:/PROGRA~1/nodejs/node.exe C:/sb/cli.js codex", "win32"), "C:/PROGRA~1/nodejs/node.exe C:/sb/cli.js codex");
  assert.equal(codexWindowsCommand("npx -y @scopebond/hook@1.2.3 codex --from-repo", "darwin"), "npx.cmd -y @scopebond/hook@1.2.3 codex --from-repo");
});

test("the plain forms are recognised as Scopebond's, so uninstall and upgrade find them as well as the quoted ones", () => {
  const forms = [
    "C:/PROGRA~1/nodejs/node.exe D:/Teams/PATONE~1/.scopebond/runtime/0.23.0/node_modules/@scopebond/hook/dist/cli.js claude",
    "C:/PROGRA~1/nodejs/node.exe D:/x/node_modules/@scopebond/hook/dist/cli.js codex",
    "C:/PROGRA~1/Scopebond/scopebond-agent.exe hook cursor",
    `"C:\\Program Files\\nodejs\\node.exe" "D:\\Teams\\Pat\\.scopebond\\runtime\\0.22.0\\node_modules\\@scopebond\\hook\\dist\\cli.js" codex`,
    `"C:\\Program Files\\Scopebond\\scopebond-agent.exe" hook claude`,
  ];
  for (const form of forms) {
    assert.equal(isScopebondHookCommand(form), true, form);
    assert.equal(isMachineSpecificCommand(form), true, form);
  }
  assert.equal(nativeHookProgram("C:/PROGRA~1/Scopebond/scopebond-agent.exe hook cursor"), "C:\\PROGRA~1\\Scopebond\\scopebond-agent.exe");
  assert.equal(nativeHookProgram("C:/x/other.exe hook claude"), null);

  const dir = mkdtempSync(join(tmpdir(), "sb-winshell-"));
  try {
    const file = join(dir, "hooks.json");
    // An entry the previous release wrote (quoted), beside another tool's hook.
    writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [
      { hooks: [{ type: "command", command: forms[3], timeout: 30 }] },
      { hooks: [{ type: "command", command: "my-own-hook" }] },
    ] } }));
    writeHarnessConfig(file, "codex", forms[1]);
    const upgraded = JSON.parse(readFileSync(file, "utf8")).hooks.PreToolUse;
    assert.equal(upgraded.length, 2, "the quoted entry is replaced, not duplicated");
    assert.equal(upgraded[0].hooks[0].command, forms[1]);
    assert.deepEqual(configuredHookCommands(file), [forms[1]]);
    removeHarnessConfig(file);
    assert.equal(isHarnessConfigured(file), false);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).hooks.PreToolUse, [{ hooks: [{ type: "command", command: "my-own-hook" }] }]);
    // An entry whose only Scopebond command is its Windows one is still Scopebond's.
    writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "echo", commandWindows: forms[1] }] }] } }));
    assert.equal(isHarnessConfigured(file), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- On Windows: run each entry through each shell. ---

const win = process.platform === "win32";
const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
const gitBash = () => ["C:\\Program Files\\Git\\bin\\bash.exe", join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe")].find((p) => existsSync(p)) ?? null;
const pwsh = () => {
  const r = spawnSync("pwsh.exe", ["-NoProfile", "-Command", "$PSHOME"], { encoding: "utf8" });
  return r.status === 0 ? join(r.stdout.trim(), "pwsh.exe") : null;
};

/** How each shell runs a hook command line: the way the coding agents start it. */
function shells() {
  const list = [
    // Codex's default on Windows: %COMSPEC% /C "<command>", the command passed as is.
    { name: "cmd.exe", run: (command) => [join(systemRoot, "System32", "cmd.exe"), ["/d", "/s", "/c", `"${command}"`], true] },
    { name: "powershell.exe", run: (command) => [join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-Command", command], false] },
  ];
  const ps7 = pwsh();
  if (ps7) list.push({ name: "pwsh.exe", run: (command) => [ps7, ["-NoProfile", "-Command", command], false] });
  const bash = gitBash();
  if (bash) list.push({ name: "Git Bash", run: (command) => [bash, ["-c", command], false] });
  return list;
}

/** The payload each coding agent sends for `scopebond-agent stop`, and how its deny reads. */
const STOP = "scopebond-agent stop";
const asks = {
  claude: (cwd) => ({ hook_event_name: "PreToolUse", session_id: "s", tool_name: "Bash", tool_input: { command: STOP }, cwd }),
  codex: (cwd) => ({ hook_event_name: "PreToolUse", session_id: "s", tool_name: "Bash", tool_input: { command: STOP }, cwd }),
  cursor: (cwd) => ({ hook_event_name: "beforeShellExecution", command: STOP, cwd }),
  copilot: (cwd) => ({ sessionId: "s", cwd, toolName: "bash", toolArgs: JSON.stringify({ command: STOP }) }),
};
const denied = (harness, stdout) => (harness === "cursor" ? /"permission"\s*:\s*"deny"/ : /"permissionDecision"\s*:\s*"deny"/).test(stdout);

/** Each command line the installer writes for each coding agent on this computer, read back from the settings it wrote,
 *  with the shells that agent may run it under. */
function writtenCommands(cliPath, dir) {
  const out = [];
  const read = (file) => JSON.parse(readFileSync(file, "utf8")).hooks;
  for (const harness of ["claude", "cursor", "codex", "copilot"]) {
    const file = join(dir, `${harness}.json`);
    writeHarnessConfig(file, harness, absoluteHookCommand(cliPath, harness));
    const hooks = read(file);
    if (harness === "claude") out.push({ harness, field: "command", command: hooks.PreToolUse[0].hooks[0].command });
    if (harness === "codex") out.push({ harness, field: "commandWindows", command: hooks.PreToolUse[0].hooks[0].commandWindows });
    if (harness === "cursor") out.push({ harness, field: "command", command: hooks.beforeShellExecution[0].command });
    if (harness === "copilot") {
      const entry = hooks.PreToolUse[0];
      out.push({ harness, field: "command", command: entry.command });
      out.push({ harness, field: "bash", command: entry.bash, only: ["Git Bash"] });
      out.push({ harness, field: "powershell", command: entry.powershell, only: ["powershell.exe", "pwsh.exe"] });
    }
  }
  return out;
}

function setUp() {
  const root = mkdtempSync(join(tmpdir(), "sb-winshell-"));
  const project = join(root, "project");
  mkdirSync(project);
  const env = { ...process.env, HOME: root, USERPROFILE: root, SCOPEBOND_HOME: join(root, "home"), SCOPEBOND_HOOK_DIR: join(project, "hookdir") };
  const init = spawnSync(process.execPath, [cli, "init", "--no-install", "--yes"], { encoding: "utf8", cwd: project, env });
  assert.equal(init.status, 0, init.stderr);
  return { root, project, env };
}

function runEverywhere(t, cliPath, label) {
  const { root, project, env } = setUp();
  try {
    const commands = writtenCommands(cliPath, join(root, "settings"));
    for (const { harness, field, command, only } of commands) {
      assert.ok(command, `${harness} ${field} written`);
      assert.doesNotMatch(command, /^"/, `${harness} ${field} does not start with a quoted path: ${command}`);
      for (const shell of shells()) {
        if (only && !only.includes(shell.name)) continue;
        const [program, args, verbatim] = shell.run(command);
        const r = spawnSync(program, args, { cwd: project, env, encoding: "utf8", input: JSON.stringify(asks[harness](project)), windowsVerbatimArguments: verbatim, timeout: 60_000 });
        const where = `${label}: ${harness} ${field} under ${shell.name} (${command}) exit ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`;
        assert.doesNotMatch(r.stderr ?? "", /Unexpected token|not recognized|No such file|MODULE_NOT_FOUND|cannot find/i, where);
        assert.ok(denied(harness, r.stdout ?? ""), `starts and denies ${STOP} — ${where}`);
      }
    }
    t.diagnostic(`${label}: ${commands.length} entries × ${shells().map((s) => s.name).join(", ")}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("on Windows every entry starts under cmd.exe, PowerShell and Git Bash and denies scopebond-agent stop", { skip: !win && "Windows only" }, (t) => {
  runEverywhere(t, cli, "hook in place");
});

test("on Windows a hook under a folder with a space in its name starts in every shell too", { skip: !win && "Windows only" }, (t) => {
  // A junction to this package under a folder name with a space, like a user folder with a space or `C:\Program Files\…`.
  const root = mkdtempSync(join(tmpdir(), "sb-winshell-space-"));
  try {
    const spaced = join(root, "with space");
    mkdirSync(spaced);
    const link = join(spaced, "hook");
    const made = spawnSync(join(systemRoot, "System32", "cmd.exe"), ["/d", "/s", "/c", `"mklink /J "${link}" "${join(here, "..")}""`], { windowsVerbatimArguments: true, encoding: "utf8" });
    assert.equal(made.status, 0, made.stderr);
    if (!windowsShortPath(spaced) || /\s/.test(windowsShortPath(spaced))) { t.skip("8.3 short names are switched off on this volume: the quoted form is the fallback here"); return; }
    const cliPath = join(link, "dist", "cli.js");
    assert.match(absoluteHookCommand(cliPath, "codex"), /~\d\/hook\/dist\/cli\.js codex$/);
    runEverywhere(t, cliPath, "hook under a spaced folder");
    // The single executable's form takes the same spelling.
    assert.doesNotMatch(nativeHookCommand("claude", join(spaced, "scopebond-agent.exe")), /"/);
  } finally {
    // The junction goes first, on its own (rmdir removes the link, never what it points at).
    spawnSync(join(systemRoot, "System32", "cmd.exe"), ["/d", "/s", "/c", `"rmdir "${join(root, "with space", "hook")}""`], { windowsVerbatimArguments: true });
    assert.ok(existsSync(cli), "the package itself is untouched");
    rmSync(root, { recursive: true, force: true });
  }
});
