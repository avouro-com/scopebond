// A trusted project is keyed by its canonical path: the same folder reached through a link (a symlink, a Windows junction,
// or macOS's /var, which is /private/var, where the temp folder lives) is the same project. Before, the key was the path as
// written, so a project trusted from its real path was untrusted when reached through the link, and the other way round.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { scaffold, trustProjectPolicy, isTrustedProject, resolveConfigDir, canonicalPath, samePath, trustedProjectsFile } from "../dist/index.js";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "sb-trust-link-"));
  const home = join(root, "home");
  const real = join(root, "real-project");
  const link = join(root, "linked-project");
  mkdirSync(real);
  // A junction needs no privilege on Windows; elsewhere it is an ordinary directory symlink.
  symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");
  scaffold(home);
  scaffold(join(real, ".scopebond"));
  return { root, home, real, link };
}

function withHome(home, fn) {
  const saved = process.env.SCOPEBOND_HOME;
  const savedDir = process.env.SCOPEBOND_HOOK_DIR;
  process.env.SCOPEBOND_HOME = home;
  delete process.env.SCOPEBOND_HOOK_DIR;
  try { return fn(); } finally {
    if (saved === undefined) delete process.env.SCOPEBOND_HOME; else process.env.SCOPEBOND_HOME = saved;
    if (savedDir !== undefined) process.env.SCOPEBOND_HOOK_DIR = savedDir;
  }
}

test("canonicalPath follows links in the nearest existing ancestor and keeps the missing rest", () => {
  const { root, real, link } = setup();
  try {
    assert.equal(canonicalPath(link), realpathSync.native(real));
    assert.equal(canonicalPath(join(link, "not-yet", "file.txt")), join(realpathSync.native(real), "not-yet", "file.txt"));
    assert.ok(samePath(link, real));
    assert.ok(samePath(join(link, ".scopebond"), join(real, ".scopebond")));
    assert.ok(!samePath(join(link, "a"), join(real, "b")));
    // The temp folder itself may be behind a link (macOS): the canonical form of a path is its own canonical form.
    assert.equal(canonicalPath(canonicalPath(root)), canonicalPath(root));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a project trusted through a link is trusted at its real path, and the other way round", () => {
  const { root, home, real, link } = setup();
  try {
    withHome(home, () => {
      assert.equal(resolveConfigDir(real), home, "untrusted: the user-level install governs");
      trustProjectPolicy(join(link, ".scopebond"));
      assert.equal(isTrustedProject(join(real, ".scopebond")), true, "trusted at its real path");
      assert.equal(isTrustedProject(join(link, ".scopebond")), true, "and through the link");
      assert.equal(resolveConfigDir(real), join(real, ".scopebond"));
      assert.equal(resolveConfigDir(link), join(link, ".scopebond"));
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a trust pin written before (keyed by the path as written) is still honoured", () => {
  const { root, home, real } = setup();
  try {
    withHome(home, () => {
      const dir = join(real, ".scopebond");
      trustProjectPolicy(dir);
      const digest = Object.values(JSON.parse(readFileSync(trustedProjectsFile(), "utf8")))[0];
      writeFileSync(trustedProjectsFile(), JSON.stringify({ [resolve(dir).replace(/\\/g, "/").toLowerCase()]: digest }));
      assert.equal(isTrustedProject(dir), true);
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
