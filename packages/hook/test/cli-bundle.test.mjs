// The command line as the package build ships it (scripts/bundle-cli.mjs): dist/cli.js loads one bundled file instead of
// about a hundred modules, keeps Node's compiled code beside the package on hook calls, and still fails closed when the
// bundle cannot load. Each case runs a copy of cli.js and the bundle with nothing else beside them, so the copy proves the
// bundle needs no other file. Skipped after a plain `tsc` (cli.js then loads the separate modules): `pnpm run build` or the
// package's `test` script bundles first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scaffold } from "../dist/index.js";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(pkg, "dist");
const cliText = readFileSync(join(dist, "cli.js"), "utf8");
const bundled = existsSync(join(dist, "cli-bundle.js")) && cliText.includes('import("./cli-bundle.js")');
const skip = bundled ? false : "dist/cli.js is a plain tsc build; run `pnpm run build` to bundle the command line";

/** A copy of the package with only package.json, dist/cli.js and dist/cli-bundle.js (or `bundleText` in its place). */
function lonePackage(bundleText) {
  const root = mkdtempSync(join(tmpdir(), "sb-cli-bundle-"));
  const copy = join(root, "pkg");
  mkdirSync(join(copy, "dist"), { recursive: true });
  copyFileSync(join(pkg, "package.json"), join(copy, "package.json"));
  copyFileSync(join(dist, "cli.js"), join(copy, "dist", "cli.js"));
  if (bundleText === undefined) copyFileSync(join(dist, "cli-bundle.js"), join(copy, "dist", "cli-bundle.js"));
  else writeFileSync(join(copy, "dist", "cli-bundle.js"), bundleText);
  const project = join(root, "project");
  const home = join(root, "home");
  mkdirSync(project, { recursive: true });
  mkdirSync(home, { recursive: true });
  const dir = join(project, ".scopebond");
  scaffold(dir);
  const env = { ...process.env, HOME: home, USERPROFILE: home, SCOPEBOND_HOME: join(home, ".scopebond"), SCOPEBOND_HOOK_DIR: dir };
  delete env.NODE_COMPILE_CACHE;
  delete env.NODE_DISABLE_COMPILE_CACHE;
  return { copy, cli: join(copy, "dist", "cli.js"), project, env };
}

const events = {
  claude: (cwd) => ({ hook_event_name: "PreToolUse", session_id: "s", cwd, tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "toolu_1" }),
  codex: (cwd) => ({ hook_event_name: "PreToolUse", session_id: "s", cwd, tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "call_1" }),
  cursor: (cwd) => ({ hook_event_name: "beforeShellExecution", command: "ls", cwd, conversation_id: "c", generation_id: "g1" }),
  copilot: (cwd) => ({ hook_event_name: "PreToolUse", session_id: "s", cwd, tool_name: "bash", tool_input: { command: "ls" } }),
};
const call = (lone, harness) => spawnSync(process.execPath, [lone.cli, harness], {
  cwd: lone.project, env: lone.env, input: JSON.stringify(events[harness](lone.project)), encoding: "utf8",
});

test("the built cli.js loads the bundle in place of the separate modules, and the bundle loads nothing by path", { skip }, () => {
  assert.equal(cliText.split('import("./cli-bundle.js")').length - 1, 2, "both of cli.js's imports point at the bundle");
  assert.doesNotMatch(cliText, /import\("\.\/(cli-main|hook-deadline)\.js"\)/);
  const bundle = readFileSync(join(dist, "cli-bundle.js"), "utf8");
  assert.doesNotMatch(bundle, /\bimport\(\s*["'`]\.{1,2}\//, "no relative import() left in the bundle");
  assert.doesNotMatch(bundle, /\brequire\(\s*["'`]\.{1,2}\//, "no relative require() left in the bundle");
});

test("a hook call decides from cli.js and the bundle alone, prints nothing extra, and keeps a compile cache beside the package", { skip }, () => {
  const lone = lonePackage();
  for (const harness of ["claude", "codex", "cursor", "copilot"]) {
    const run = call(lone, harness);
    assert.equal(run.status, 0, `${harness}: ${run.stdout}${run.stderr}`);
    assert.doesNotMatch(run.stdout, /deny|failed closed/i, harness);
    assert.equal(run.stderr, "", `${harness} writes nothing to stderr on an allowed call`);
  }
  const cache = join(lone.copy, ".compile-cache");
  assert.ok(existsSync(cache) && readdirSync(cache).length > 0, "the hook call left Node's compile cache beside the package");
  // The next call reads it and decides the same.
  const again = call(lone, "claude");
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stderr, "");
});

test("only hook calls keep the compile cache: other commands leave the package folder as it was", { skip }, () => {
  const lone = lonePackage();
  const help = spawnSync(process.execPath, [lone.cli, "help"], { cwd: lone.project, env: lone.env, encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.equal(existsSync(join(lone.copy, ".compile-cache")), false);
});

test("a package folder the hook cannot write to: no cache, the same decision, nothing on stderr", {
  skip: skip || (process.platform === "win32" ? "POSIX permissions" : process.getuid?.() === 0 ? "root can write anywhere" : false),
}, () => {
  const lone = lonePackage();
  chmodSync(join(lone.copy, "dist"), 0o555);
  chmodSync(lone.copy, 0o555);
  try {
    const run = call(lone, "claude");
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    assert.equal(run.stderr, "");
    assert.equal(existsSync(join(lone.copy, ".compile-cache")), false);
  } finally {
    chmodSync(lone.copy, 0o755);
    chmodSync(join(lone.copy, "dist"), 0o755);
  }
});

test("a bundle that cannot load fails closed with each agent's deny", { skip }, () => {
  for (const [label, text] of [["throws", 'throw new Error("broken bundle");\n'], ["does not parse", "export const = ;\n"]]) {
    const lone = lonePackage(text);
    const claude = call(lone, "claude");
    assert.equal(claude.status, 2, `${label}: Claude Code blocks only on exit 2: ${claude.stderr}`);
    assert.equal(JSON.parse(claude.stdout).hookSpecificOutput.permissionDecision, "deny");
    assert.match(claude.stderr, /Scopebond hook failed closed/);
    const codex = call(lone, "codex");
    assert.equal(JSON.parse(codex.stdout).hookSpecificOutput.permissionDecision, "deny", label);
    const cursor = call(lone, "cursor");
    assert.equal(JSON.parse(cursor.stdout).permission, "deny", label);
    const copilot = call(lone, "copilot");
    assert.equal(copilot.status, 2, `${label}: Copilot denies on exit 2`);
    assert.equal(JSON.parse(copilot.stdout).permissionDecision, "deny", label);
  }
});
