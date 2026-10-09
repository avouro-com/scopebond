// `dedupe` keeps exactly one Scopebond decision hook. Asked to keep a Claude Code plugin when no enabled Scopebond plugin is
// found, it changes nothing (and says so) instead of removing every settings entry and leaving the agent unsupervised. A
// settings file it does change is backed up first and replaced whole (a temp file renamed over it), never truncated in place.
// Isolated: HOME/USERPROFILE/APPDATA/LOCALAPPDATA/SCOPEBOND_HOME point at a fresh temp folder before any import; the
// project folder is a temp folder outside any git repository.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(join(tmpdir(), "sb-dedupe-keep-"));
const fakeHome = join(root, "home");
mkdirSync(join(fakeHome, ".claude"), { recursive: true });
for (const k of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]) process.env[k] = fakeHome;
process.env.SCOPEBOND_HOME = join(fakeHome, ".scopebond");
delete process.env.SCOPEBOND_HOOK_DIR;

const { dedupeHooks, duplicateHooks, hookEntries } = await import("../dist/duplicates.js");
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

const entry = (cmd) => ({ matcher: "*", hooks: [{ type: "command", command: cmd }] });
const own = { matcher: "Bash", hooks: [{ type: "command", command: "echo my-own-hook" }] };

function setup(name) {
  const project = join(root, name);
  mkdirSync(join(project, ".claude"), { recursive: true });
  const userFile = join(fakeHome, ".claude", "settings.json");
  const projectFile = join(project, ".claude", "settings.json");
  writeFileSync(userFile, JSON.stringify({ hooks: { PreToolUse: [entry("npx -y @scopebond/hook"), own] } }, null, 2));
  writeFileSync(projectFile, JSON.stringify({ hooks: { PreToolUse: [entry("npx -y @scopebond/hook")] } }, null, 2));
  return { project, userFile, projectFile };
}

test("--keep plugin with no enabled Scopebond plugin changes nothing", () => {
  assert.equal(homedir(), fakeHome, "isolation: homedir() is the temp folder");
  const { project, userFile, projectFile } = setup("no-plugin");
  const before = [readFileSync(userFile, "utf8"), readFileSync(projectFile, "utf8")];
  assert.equal(duplicateHooks("claude", project, fakeHome)?.length, 2, "user + project entries: a duplicate");

  const result = dedupeHooks("claude", "plugin", project, fakeHome);
  assert.equal(result.kept, null);
  assert.deepEqual(result.removed, [], "nothing is removed when nothing would be kept");
  assert.equal(hookEntries("claude", project, fakeHome).length, 2, "both Scopebond decision hooks are still there");
  assert.deepEqual([readFileSync(userFile, "utf8"), readFileSync(projectFile, "utf8")], before, "neither file was touched");
});

test("the CLI says no plugin was found and that nothing changed, and exits non-zero", () => {
  const { project, userFile } = setup("cli");
  const before = readFileSync(userFile, "utf8");
  const env = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome };
  const r = spawnSync(process.execPath, [cli, "dedupe", "--keep", "plugin"], { cwd: project, env, encoding: "utf8" });
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /no enabled Scopebond plugin/i);
  assert.match(r.stdout + r.stderr, /nothing (was )?changed/i);
  assert.doesNotMatch(r.stdout, /^Removed:/m);
  assert.equal(readFileSync(userFile, "utf8"), before);
});

test("a file dedupe changes is backed up first and written whole; the person's own hook stays", () => {
  const { project, userFile, projectFile } = setup("backup");
  const before = readFileSync(projectFile, "utf8");
  const result = dedupeHooks("claude", "user", project, fakeHome);
  assert.equal(result.kept?.scope, "user");
  assert.deepEqual(result.removed.map((e) => e.scope), ["project"]);
  assert.equal(readFileSync(`${projectFile}.scopebond-backup`, "utf8"), before, "the project file as it was is kept beside it");
  assert.deepEqual(JSON.parse(readFileSync(projectFile, "utf8")).hooks.PreToolUse, []);
  assert.deepEqual(JSON.parse(readFileSync(userFile, "utf8")).hooks.PreToolUse.at(-1), own);
  assert.deepEqual(readdirSync(join(project, ".claude")).filter((f) => f.endsWith(".tmp")), [], "no temp file is left behind");
  assert.equal(existsSync(`${userFile}.scopebond-backup`), false, "the kept file had nothing to change, so it was not touched");
});
