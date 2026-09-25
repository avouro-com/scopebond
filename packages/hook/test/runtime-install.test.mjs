// Pinning the hook to a durable path is what removes ~900 ms from every tool call, and
// its failure mode (a config entry that cannot start) is worse than the slowness it
// replaces. So: the ephemeral/durable decision, the copy, and the "can this command
// actually start" check all get direct coverage.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureDurableRuntime, isEphemeralPath, nodeModulesRootOf, pinnedCliPath, runtimeDirFor,
  hookCommandResolves, isScopebondHookCommand, absoluteHookCommand,
} from "../dist/index.js";

/** A throwaway node_modules tree shaped like the one npx materialises. */
function fakeTree(root, { scope = ["hook", "gateway", "sdk", "verify"] } = {}) {
  const nm = join(root, "node_modules");
  for (const pkg of scope) mkdirSync(join(nm, "@scopebond", pkg, "dist"), { recursive: true });
  for (const pkg of scope) writeFileSync(join(nm, "@scopebond", pkg, "dist", "cli.js"), "// stub\n");
  return join(nm, "@scopebond", "hook", "dist", "cli.js");
}

test("isEphemeralPath recognises npm's throwaway npx cache, and nothing else", () => {
  assert.equal(isEphemeralPath(join("C:", "cache", "_npx", "abc", "node_modules", "x", "cli.js")), true);
  assert.equal(isEphemeralPath("/opt/agent/.npm/_npx/abc/node_modules/x/cli.js"), true);
  assert.equal(isEphemeralPath("/opt/agent/.scopebond/runtime/0.6.0/node_modules/x/cli.js"), false);
  assert.equal(isEphemeralPath("/repo/node_modules/@scopebond/hook/dist/cli.js"), false);
  // A directory merely containing the letters "npx" is not the cache.
  assert.equal(isEphemeralPath("/repo/mynpxtools/cli.js"), false);
});

test("nodeModulesRootOf finds the tree root, and refuses an unexpected layout", () => {
  const root = mkdtempSync(join(tmpdir(), "sb-nmroot-"));
  const cli = fakeTree(root);
  assert.equal(nodeModulesRootOf(cli), join(root, "node_modules"));
  assert.equal(nodeModulesRootOf(join(root, "loose", "cli.js")), null);
  rmSync(root, { recursive: true, force: true });
});

test("a CLI already in a durable location is pinned as it stands — no copy", () => {
  const root = mkdtempSync(join(tmpdir(), "sb-durable-"));
  const cli = fakeTree(root);
  const home = mkdtempSync(join(tmpdir(), "sb-home-"));
  const prev = process.env.SCOPEBOND_HOME;
  process.env.SCOPEBOND_HOME = home;
  try {
    const result = ensureDurableRuntime(cli, "9.9.9");
    assert.equal(result.how, "already-durable");
    assert.equal(result.cli, cli);
    assert.ok(!existsSync(runtimeDirFor("9.9.9")), "nothing is copied when the source is already durable");
  } finally {
    if (prev === undefined) delete process.env.SCOPEBOND_HOME; else process.env.SCOPEBOND_HOME = prev;
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("a CLI in the npx cache is copied into the Scopebond home, then reused", () => {
  const cache = mkdtempSync(join(tmpdir(), "sb-cache-"));
  const ephemeral = join(cache, "_npx", "deadbeef");
  mkdirSync(ephemeral, { recursive: true });
  const cli = fakeTree(ephemeral);
  assert.equal(isEphemeralPath(cli), true, "precondition: the source looks ephemeral");
  const home = mkdtempSync(join(tmpdir(), "sb-home-"));
  const prev = process.env.SCOPEBOND_HOME;
  process.env.SCOPEBOND_HOME = home;
  try {
    const first = ensureDurableRuntime(cli, "9.9.9");
    assert.equal(first.how, "pinned");
    assert.equal(first.cli, pinnedCliPath("9.9.9"));
    assert.ok(existsSync(first.cli), "the pinned CLI is really on disk");
    // The sibling packages the hook imports at startup must have come across too.
    for (const pkg of ["gateway", "sdk"]) {
      assert.ok(existsSync(join(runtimeDirFor("9.9.9"), "node_modules", "@scopebond", pkg)), `${pkg} was copied`);
    }
    // Second call reuses the copy instead of copying again.
    const second = ensureDurableRuntime(cli, "9.9.9");
    assert.equal(second.how, "reused");
    assert.equal(second.cli, first.cli);
    // No staging directory is left behind.
    assert.ok(!existsSync(`${runtimeDirFor("9.9.9")}.incoming-${process.pid}`), "staging dir cleaned up");
  } finally {
    if (prev === undefined) delete process.env.SCOPEBOND_HOME; else process.env.SCOPEBOND_HOME = prev;
    rmSync(cache, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("an incomplete pinned copy is not reused — a half tree would fail every call", () => {
  const cache = mkdtempSync(join(tmpdir(), "sb-cache2-"));
  const ephemeral = join(cache, "_npx", "feedface");
  mkdirSync(ephemeral, { recursive: true });
  // Source tree with the hook but none of the packages it imports.
  const cli = fakeTree(ephemeral, { scope: ["hook"] });
  const home = mkdtempSync(join(tmpdir(), "sb-home-"));
  const prev = process.env.SCOPEBOND_HOME;
  process.env.SCOPEBOND_HOME = home;
  try {
    const result = ensureDurableRuntime(cli, "9.9.9");
    assert.equal(result.cli, null, "an incomplete tree must not be pinned");
    assert.equal(result.how, "unavailable");
    assert.ok(!existsSync(runtimeDirFor("9.9.9")), "the incomplete copy is removed, not left to be reused");
  } finally {
    if (prev === undefined) delete process.env.SCOPEBOND_HOME; else process.env.SCOPEBOND_HOME = prev;
    rmSync(cache, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("a missing source degrades to the npx fallback rather than throwing", () => {
  const result = ensureDurableRuntime(join(tmpdir(), "definitely-absent", "cli.js"), "9.9.9");
  assert.equal(result.cli, null);
  assert.equal(result.how, "unavailable");
});

test("hookCommandResolves: npx always starts; a pinned path only while it exists", () => {
  assert.equal(hookCommandResolves("npx -y @scopebond/hook@0.6.0 claude"), true);
  assert.equal(hookCommandResolves("npx.cmd -y @scopebond/hook@0.6.0 claude"), true);
  const root = mkdtempSync(join(tmpdir(), "sb-resolve-"));
  const cli = fakeTree(root);
  assert.equal(hookCommandResolves(`"${process.execPath}" "${cli}" claude`), true);
  rmSync(root, { recursive: true, force: true });
  assert.equal(hookCommandResolves(`"${process.execPath}" "${cli}" claude`), false, "a deleted pin is reported broken");
});

test("the pinned command survives a shell that treats backslash as an escape", () => {
  // A harness runs the command through a shell that may be bash even on Windows. Both
  // paths must be quoted there, or a Windows path loses its separators.
  const command = absoluteHookCommand(join("C:", "tools", "sb", "cli.js"), "claude");
  if (process.platform === "win32") {
    const quoted = command.match(/"/g) ?? [];
    assert.equal(quoted.length, 4, `both paths quoted on Windows: ${command}`);
  }
  assert.match(command, /\sclaude$/);
});

test("every command form the installer has written is recognised as ours", () => {
  const forms = [
    "npx -y @scopebond/hook@0.6.0 claude",
    "scopebond-hook claude",
    `"/usr/bin/node" "/opt/agent/.scopebond/runtime/0.6.0/node_modules/@scopebond/hook/dist/cli.js" cursor`,
    `"C:\\Program Files\\nodejs\\node.exe" "D:\\agents\\sb\\.scopebond\\runtime\\0.6.0\\node_modules\\@scopebond\\hook\\dist\\cli.js" claude`,
  ];
  for (const form of forms) assert.ok(isScopebondHookCommand(form), `recognised: ${form}`);
  for (const other of ["echo hi", "npx -y some-other-tool claude", ""]) {
    assert.ok(!isScopebondHookCommand(other), `not ours: ${other}`);
  }
  // A command whose last argument is not one of our subcommands is not ours, even if it
  // mentions us — otherwise `uninstall` could strip an unrelated entry.
  assert.ok(!isScopebondHookCommand("echo scopebond is installed"));
  assert.ok(!isScopebondHookCommand("node ./other-cli.js build"));
});

test("the command matcher stays linear on adversarial input", () => {
  // The previous single-regex matcher backtracked polynomially on a long run of
  // "\tscopebond\t" (CodeQL js/polynomial-redos). A config file is not attacker input,
  // but the check should still not be quadratic in the length of a string.
  const hostile = `${"\tscopebond\t".repeat(20000)}claude`;
  const started = process.hrtime.bigint();
  isScopebondHookCommand(hostile);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 250, `matcher must not blow up on a hostile string (took ${ms.toFixed(0)}ms)`);
  // Oversized input is refused outright rather than scanned.
  assert.equal(isScopebondHookCommand("x".repeat(5000)), false);
});
