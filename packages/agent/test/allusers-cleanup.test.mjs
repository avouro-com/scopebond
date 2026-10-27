// Removal for every user (allusers-cleanup.ts): removing an install for every user leaves a copy of the agent in Program
// Files\Scopebond Cleanup and an Active Setup entry, so each person's next sign-in runs the agent's uninstall for them; a new
// install for every user takes both away. Nothing here writes the registry or Program Files: reg.exe and the files are
// stand-ins.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACTIVE_SETUP_KEY, activeSetupVersion, cleanupFolder, registerCleanup, runCleanupCommand, signedInCleanup, stubPath, unregisterCleanup,
} from "../dist/index.js";

const PF = "C:\\Program Files";
const FOLDER = `${PF}\\Scopebond Cleanup`;
const CONHOST = "C:\\Windows\\System32\\conhost.exe";

function fakeFiles(present = []) {
  const files = new Set(present.map((p) => p.toLowerCase()));
  const log = [];
  return {
    log,
    files,
    exists: (p) => files.has(p.toLowerCase()),
    mkdir: (d) => { log.push(["mkdir", d]); files.add(d.toLowerCase()); },
    copy: (from, to) => { log.push(["copy", from, to]); files.add(to.toLowerCase()); },
    unlink: (p) => { log.push(["unlink", p]); files.delete(p.toLowerCase()); },
    rmdir: (d) => {
      const prefix = `${d.toLowerCase()}\\`;
      if ([...files].some((f) => f.startsWith(prefix))) throw new Error("not empty");
      log.push(["rmdir", d]); files.delete(d.toLowerCase());
    },
  };
}

function fakeReg(ok = true) {
  const calls = [];
  return { calls, reg: (args) => { calls.push(args); return typeof ok === "function" ? ok(args) : ok; } };
}

test("the folder must be an absolute Windows path named Scopebond Cleanup, with no quotes or trailing separator", () => {
  assert.equal(cleanupFolder(FOLDER), FOLDER);
  for (const bad of [undefined, "", "Scopebond Cleanup", `${FOLDER}\\`, `"${FOLDER}"`, "C:\\Program Files\\Scopebond", "\\\\server\\share\\Scopebond Cleanup", "C:\\Windows"]) {
    assert.equal(cleanupFolder(bad), null, String(bad));
  }
});

test("each removal gets a newer Active Setup version, as four numbers", () => {
  assert.equal(activeSetupVersion(new Date(Date.UTC(2026, 9, 27, 9, 5, 7))), "2026,1027,905,7");
  assert.ok(activeSetupVersion(new Date(Date.UTC(2026, 11, 31, 23, 59, 59))) > activeSetupVersion(new Date(Date.UTC(2026, 9, 27))));
});

test("the sign-in command runs the copy's uninstall --signed-in under conhost --headless (no window)", () => {
  assert.equal(stubPath(FOLDER, CONHOST), `"${CONHOST}" --headless "${FOLDER}\\scopebond-agent.exe" uninstall --signed-in`);
});

test("register copies the agent into the folder and writes the Active Setup entry", () => {
  const files = fakeFiles();
  const { calls, reg } = fakeReg();
  const lines = registerCleanup({ folder: FOLDER, self: `${PF}\\Scopebond\\scopebond-agent.exe`, now: new Date(Date.UTC(2026, 9, 27, 9, 5, 7)), reg, files, conhost: CONHOST, programFiles: PF });
  assert.deepEqual(files.log, [["mkdir", FOLDER], ["copy", `${PF}\\Scopebond\\scopebond-agent.exe`, `${FOLDER}\\scopebond-agent.exe`]]);
  assert.ok(calls.every((c) => c[0] === "add" && c[1] === ACTIVE_SETUP_KEY && c.at(-1) === "/f"));
  const value = (name) => calls.find((c) => c[3] === name);
  assert.equal(value("StubPath").at(-2), stubPath(FOLDER, CONHOST));
  assert.equal(value("Version").at(-2), "2026,1027,905,7");
  assert.deepEqual(value("IsInstalled").slice(4), ["/t", "REG_DWORD", "/d", "1", "/f"]);
  assert.match(lines[0], /next sign-in/);
});

test("register refuses a folder that is not directly in Program Files, before writing anything", () => {
  for (const folder of ["C:\\Users\\Public\\Scopebond Cleanup", "C:\\Program Files\\Other\\Scopebond Cleanup", "D:\\Scopebond Cleanup"]) {
    const files = fakeFiles();
    const { calls, reg } = fakeReg();
    assert.throws(() => registerCleanup({ folder, self: "x.exe", reg, files, conhost: CONHOST, programFiles: PF }), /not directly in/);
    assert.deepEqual(files.log, []);
    assert.deepEqual(calls, []);
  }
  // Program Files named with a trailing separator or another case is the same folder.
  assert.doesNotThrow(() => registerCleanup({ folder: FOLDER, self: "x.exe", reg: fakeReg().reg, files: fakeFiles(), conhost: CONHOST, programFiles: "c:\\program files\\" }));
});

test("register fails loudly when the registry cannot be written", () => {
  const { reg } = fakeReg(false);
  assert.throws(() => registerCleanup({ folder: FOLDER, self: "x.exe", reg, files: fakeFiles(), conhost: CONHOST, programFiles: PF }), /could not write/);
});

test("unregister removes the entry, the copy and the empty folder, and nothing else", () => {
  const exe = `${FOLDER}\\scopebond-agent.exe`;
  const files = fakeFiles([FOLDER, exe]);
  const { calls, reg } = fakeReg();
  const lines = unregisterCleanup({ folder: FOLDER, reg, files });
  assert.deepEqual(calls, [["delete", ACTIVE_SETUP_KEY, "/f"]]);
  assert.deepEqual(files.log, [["unlink", exe], ["rmdir", FOLDER]]);
  assert.equal(lines.length, 3);

  // A file someone else put there stays, and so does the folder.
  const other = fakeFiles([FOLDER, exe, `${FOLDER}\\notes.txt`]);
  const kept = unregisterCleanup({ folder: FOLDER, reg: fakeReg().reg, files: other });
  assert.ok(other.exists(`${FOLDER}\\notes.txt`));
  assert.match(kept.at(-1), /Kept .*other files/);

  // Nothing waiting: said so, nothing deleted.
  const none = fakeFiles();
  assert.deepEqual(unregisterCleanup({ folder: FOLDER, reg: fakeReg(false).reg, files: none }), ["No removal for each user was waiting."]);
  assert.deepEqual(none.log, []);
});

test("at sign-in: nothing for someone who never used Scopebond, nothing when it is installed again, else the uninstall", () => {
  const dir = "C:\\Users\\ana\\.scopebond";
  const none = () => null;
  assert.equal(signedInCleanup({ dir, exists: () => false, readValue: none }), "no-folder");
  assert.equal(signedInCleanup({ dir, exists: (p) => p === dir, readValue: none }), "run");
  // An install for this person (HKCU) or for everyone (HKLM) whose program is there: keep it.
  const installed = `${PF}\\Scopebond`;
  for (const hive of ["HKLM", "HKCU"]) {
    const readValue = (key, name) => (key.startsWith(hive) && name === "InstallPath" ? `${installed}\\` : null);
    assert.equal(signedInCleanup({ dir, exists: (p) => p === dir || p === `${installed}\\scopebond-agent.exe`, readValue }), "installed", hive);
  }
  // A stale InstallPath whose program is gone does not count.
  assert.equal(signedInCleanup({ dir, exists: (p) => p === dir, readValue: () => installed }), "run");
});

test("the command checks its arguments and reports a failure with exit code 1, never throwing", () => {
  const said = [];
  assert.equal(runCleanupCommand(["register"], (l) => said.push(l)), 2);
  assert.equal(runCleanupCommand(["delete", FOLDER], (l) => said.push(l)), 2);
  assert.equal(runCleanupCommand(["register", "C:\\Windows"], (l) => said.push(l)), 2);
  assert.match(said[0], /usage/);
  const out = [];
  assert.equal(runCleanupCommand(["register", "C:\\Temp\\Scopebond Cleanup"], (l) => out.push(l), { self: "x.exe", reg: fakeReg().reg, files: fakeFiles(), conhost: CONHOST, programFiles: PF }), 1);
  assert.match(out[0], /Could not register/);
  const ok = [];
  assert.equal(runCleanupCommand(["unregister", FOLDER], (l) => ok.push(l), { reg: fakeReg().reg, files: fakeFiles() }), 0);
});
