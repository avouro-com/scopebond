// On Windows a program started by a bare name ("reg", "cmd.exe") is looked up in the current folder before PATH unless
// NoDefaultCurrentDirectoryInExePath is set, and Windows does not set it by default. The agent's commands are often run
// from a terminal open in a project, so the Windows tools it starts are named by their full path in the system folder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, win32 } from "node:path";
import { spawnSync } from "node:child_process";
import { startCommands, windowsTool } from "../dist/index.js";
import { npmOnPath } from "../dist/update.js";

const windows = process.platform === "win32";

test("the Windows tools the agent starts are full paths in the system folder", () => {
  for (const name of ["cmd", "conhost", "msiexec", "powershell", "reg"]) {
    const file = windowsTool(name);
    assert.ok(win32.isAbsolute(file) && /\\System32\\/i.test(file), `${name}: ${file}`);
  }
  assert.match(windowsTool("explorer"), /^[A-Za-z]:\\[^\\]+\\explorer\.exe$/i);
  const launcher = String.raw`D:\home\agent-launch.cmd`;
  for (const [program, args] of startCommands(launcher, "win32")) {
    assert.ok(win32.isAbsolute(program), `started by full path: ${program}`);
    for (const arg of args) if (/\.exe$/i.test(arg)) assert.ok(win32.isAbsolute(arg), `the program conhost starts is a full path: ${arg}`);
  }
});

test("npm on PATH is started by its full path from an absolute PATH folder, through the system cmd.exe on Windows", () => {
  const root = mkdtempSync(join(tmpdir(), "sb-npm-on-path-"));
  const before = process.cwd();
  try {
    const bin = join(root, "bin");
    mkdirSync(bin);
    const npm = join(bin, windows ? "npm.cmd" : "npm");
    writeFileSync(npm, windows ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n");
    if (!windows) chmodSync(npm, 0o755);
    writeFileSync(join(root, windows ? "npm.cmd" : "npm"), "");
    process.chdir(root);
    const sep = windows ? ";" : ":";
    assert.equal(npmOnPath(["install"], { PATH: `.${sep}` }), null, "the current folder is not searched");
    const run = npmOnPath(["install", "-g"], { PATH: `.${sep}${bin}` });
    assert.deepEqual(run, windows
      ? { program: `"${npm}"`, args: ['"install"', '"-g"'], shell: windowsTool("cmd") }
      : { program: npm, args: ["install", "-g"], shell: false });
  } finally {
    process.chdir(before);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows: the agent's registry checks never start a reg.exe planted in the current folder", { skip: !windows && "Windows-only program search" }, () => {
  const cwd = mkdtempSync(join(tmpdir(), "sb-hostile-cwd-"));
  const home = mkdtempSync(join(tmpdir(), "sb-hostile-home-"));
  try {
    copyFileSync(process.execPath, join(cwd, "reg.exe"));
    const preload = join(home, "preload.cjs");
    writeFileSync(preload, [
      `const { basename, join } = require("node:path");`,
      `const name = basename(process.execPath).toLowerCase();`,
      `if (name !== ${JSON.stringify(basename(process.execPath).toLowerCase())}) require("node:fs").writeFileSync(join(${JSON.stringify(home)}, name + ".ran"), "");`,
    ].join("\n"));
    const probe = join(home, "probe.mjs");
    writeFileSync(probe, `
      const { autostartHealth } = await import(${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)});
      process.stdout.write(JSON.stringify(autostartHealth(${JSON.stringify(home)}, "win32", null)));
    `);
    const env = {};
    for (const [k, v] of Object.entries(process.env)) if (k.toLowerCase() !== "nodefaultcurrentdirectoryinexepath" && k.toUpperCase() !== "NODE_OPTIONS") env[k] = v;
    Object.assign(env, { NODE_OPTIONS: `--require ${JSON.stringify(preload)}`, HOME: home, USERPROFILE: home, SCOPEBOND_HOME: home, SCOPEBOND_AGENT_TRAY: "off" });
    const r = spawnSync(process.execPath, [probe], { cwd, env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readdirSync(home).filter((f) => f.endsWith(".ran")), [], "the planted reg.exe did not run");
  } finally {
    for (const d of [cwd, home]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* a planted copy still closing */ } }
  }
});
