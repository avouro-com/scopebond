// The programs Scopebond starts are found in PATH's absolute folders only, never in the current folder: on Windows a
// spawn by bare name looks there first, and the current folder of a hook or a check is a project anyone can write to.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { findProgram, programPath, isBareProgramName, windowsSystemProgram } from "../dist/node.js";

const windows = process.platform === "win32";
const exe = (name) => (windows ? `${name}.exe` : name);

function program(dir, name, mode = 0o755) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, exe(name));
  writeFileSync(file, windows ? "" : "#!/bin/sh\nexit 0\n");
  if (!windows) chmodSync(file, mode);
  return file;
}

test("a program in the current folder, or in a relative or empty PATH entry, is never found", () => {
  const root = mkdtempSync(join(tmpdir(), "sb-find-program-"));
  const before = process.cwd();
  try {
    const cwd = join(root, "project");
    program(cwd, "sbtool");
    program(join(cwd, "bin"), "sbtool");
    const sep = windows ? ";" : ":";
    process.chdir(cwd);
    assert.equal(findProgram("sbtool", { env: { PATH: ["", ".", "bin", windows ? ".\\bin" : "./bin"].join(sep) } }), null);
    assert.throws(() => programPath("sbtool", { env: { PATH: `.${sep}bin` } }), /sbtool was not found in a folder on PATH/);
    const real = program(join(root, "tools"), "sbtool");
    const later = program(join(root, "later"), "sbtool");
    assert.equal(findProgram("sbtool", { env: { PATH: [".", "bin", join(root, "tools"), join(root, "later")].join(sep) } }), real, "the first absolute PATH folder that has it");
    assert.equal(findProgram("sbtool", { env: { PATH: [join(root, "later"), join(root, "tools")].join(sep) } }), later);
    assert.equal(findProgram("nosuchtool", { env: { PATH: join(root, "tools") } }), null);
  } finally {
    process.chdir(before);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a folder named like the program, or (outside Windows) a file that is not executable, is skipped", () => {
  const root = mkdtempSync(join(tmpdir(), "sb-find-program-"));
  try {
    mkdirSync(join(root, "a", exe("sbtool")), { recursive: true });
    if (!windows) program(join(root, "b"), "sbtool", 0o644);
    const real = program(join(root, "c"), "sbtool");
    const sep = windows ? ";" : ":";
    assert.equal(findProgram("sbtool", { env: { PATH: [join(root, "a"), join(root, "b"), join(root, "c")].join(sep) } }), real);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Windows: PATH is read whatever its case, quoted entries are unquoted, and .com and .exe are tried as a spawn tries them", { skip: !windows && "Windows-only search rules" }, () => {
  const root = mkdtempSync(join(tmpdir(), "sb-find-program-"));
  try {
    writeFileSync(join(root, "sbtool.com"), "");
    writeFileSync(join(root, "sbtool.exe"), "");
    writeFileSync(join(root, "sbtool.cmd"), "");
    writeFileSync(join(root, "sbtool"), "");
    assert.equal(findProgram("sbtool", { env: { Path: `"${root}"` } }), join(root, "sbtool.com"), "no extension: .com, then .exe");
    assert.equal(findProgram("sbtool.cmd", { env: { Path: root } }), join(root, "sbtool.cmd"), "a name with an extension is tried as it is");
    assert.equal(findProgram("sbtool", { env: { Path: `C:relative;${root}` } }), join(root, "sbtool.com"), "a drive-relative entry is skipped");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Windows: an App Execution Alias on PATH (Store Python, winget, wt) is found, as the shell finds it", { skip: !windows && "Windows-only aliases" }, (t) => {
  // The aliases in the per-user WindowsApps folder are reparse points Node cannot stat; a spawn by name starts them.
  const apps = join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WindowsApps");
  let aliases = [];
  try { aliases = readdirSync(apps).filter((f) => /\.exe$/i.test(f) && lstatSync(join(apps, f)).isSymbolicLink()); } catch { /* no such folder */ }
  if (!aliases.length) { t.skip("no App Execution Alias on this computer"); return; }
  const root = mkdtempSync(join(tmpdir(), "sb-find-program-"));
  try {
    for (const file of aliases.slice(0, 5)) {
      const name = file.replace(/\.exe$/i, "");
      const path = `${join(root, "missing")};${apps}`;
      assert.equal(findProgram(name, { env: { PATH: path } })?.toLowerCase(), join(apps, file).toLowerCase(), file);
      assert.equal(programPath(file, { env: { PATH: path } }).toLowerCase(), join(apps, file).toLowerCase(), file);
    }
    // An ordinary program earlier on PATH still comes first, and a folder named like the program is still skipped.
    const name = aliases[0].replace(/\.exe$/i, "");
    mkdirSync(join(root, "a", `${name}.exe`), { recursive: true });
    const first = program(join(root, "b"), name);
    assert.equal(findProgram(name, { env: { PATH: [join(root, "a"), join(root, "b"), apps].join(";") } }), first);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("only bare program names are searched for", () => {
  assert.equal(isBareProgramName("git"), true);
  assert.equal(isBareProgramName("git.exe"), true);
  for (const name of ["", ".", "..", "./git", "bin/git"]) assert.equal(isBareProgramName(name), false, name);
  for (const name of ["bin\\git", "C:git.exe", "C:\\Git\\git.exe"]) assert.equal(isBareProgramName(name, "win32"), false, name);
  assert.throws(() => findProgram("./git"), TypeError);
});

test("Windows' own tools are full paths under the system folder, whatever PATH or the current folder hold", () => {
  assert.equal(windowsSystemProgram("icacls", { SystemRoot: "D:\\Win" }), "D:\\Win\\System32\\icacls.exe");
  assert.equal(windowsSystemProgram("reg", { SYSTEMROOT: "D:\\Win" }), "D:\\Win\\System32\\reg.exe", "the variable's case does not matter");
  assert.equal(windowsSystemProgram("powershell", { windir: "E:\\W" }), "E:\\W\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.equal(windowsSystemProgram("explorer", { SystemRoot: "D:\\Win" }), "D:\\Win\\explorer.exe");
  assert.equal(windowsSystemProgram("cmd", { SystemRoot: "Windows" }), "C:\\Windows\\System32\\cmd.exe", "a relative system folder is not used");
  assert.equal(windowsSystemProgram("conhost", {}), "C:\\Windows\\System32\\conhost.exe");
  assert.ok(win32.isAbsolute(windowsSystemProgram("msiexec")));
});
