// SB302: an agent that would ask Scopebond more than once per action is found, and `dedupe` keeps one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { decisionEntries, dedupeHooks, duplicateHooks, hookEntries } from "../dist/index.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const HOOK = "npx -y @scopebond/hook@0.16.0 claude";
const OTHER = { matcher: "Bash", hooks: [{ type: "command", command: "other-tool check" }] };
const ours = (command = HOOK) => ({ matcher: "*", hooks: [{ type: "command", command }] });

function computer() {
  const home = mkdtempSync(join(tmpdir(), "sb-dupes-home-"));
  const project = mkdtempSync(join(tmpdir(), "sb-dupes-project-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(project, ".claude"), { recursive: true });
  return { home, project, env: { ...process.env, HOME: home, USERPROFILE: home } };
}
const write = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2));
function withHome(home, fn) {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home; process.env.USERPROFILE = home;
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test("one entry is not a duplicate; observation hooks beside it do not count", () => {
  const { home, project } = computer();
  write(join(home, ".claude", "settings.json"), { hooks: { PreToolUse: [ours(), OTHER], PostToolUse: [ours()], SessionStart: [ours()] } });
  withHome(home, () => {
    assert.equal(hookEntries("claude", project, home).length, 1);
    assert.equal(duplicateHooks("claude", project, home), null);
  });
});

test("user settings plus a project's: found, and dedupe keeps the user entry and the other tool's hook", () => {
  const { home, project } = computer();
  const user = join(home, ".claude", "settings.json");
  const shared = join(project, ".claude", "settings.json");
  write(user, { theme: "dark", hooks: { PreToolUse: [ours()] } });
  write(shared, { hooks: { PreToolUse: [OTHER, ours()], PostToolUse: [ours()] } });
  withHome(home, () => {
    assert.deepEqual(duplicateHooks("claude", project, home).map((e) => e.scope), ["user", "project"]);
    const result = dedupeHooks("claude", "user", project, home);
    assert.equal(result.kept.scope, "user");
    assert.deepEqual(result.removed.map((e) => e.scope), ["project"]);
    assert.equal(duplicateHooks("claude", project, home), null);
  });
  const after = JSON.parse(readFileSync(shared, "utf8"));
  assert.deepEqual(after.hooks.PreToolUse, [OTHER], "the other tool's hook stays");
  assert.deepEqual(after.hooks.PostToolUse, [], "Scopebond's observation hook leaves with it");
  assert.equal(JSON.parse(readFileSync(user, "utf8")).theme, "dark");
});

test("two entries in one file: the second goes", () => {
  const { home, project } = computer();
  const user = join(home, ".claude", "settings.json");
  write(user, { hooks: { PreToolUse: [ours(), OTHER, ours('"C:/node.exe" "C:/x/cli.js" claude')] } });
  withHome(home, () => {
    assert.equal(duplicateHooks("claude", project, home).length, 2);
    dedupeHooks("claude", "user", project, home);
    assert.deepEqual(decisionEntries(user, "claude"), [HOOK]);
  });
  assert.equal(JSON.parse(readFileSync(user, "utf8")).hooks.PreToolUse.length, 2, "ours once, plus the other tool's");
});

test("an enabled Claude Code plugin beside a settings entry is found; a disabled one is not", () => {
  const { home, project } = computer();
  const pluginHooks = join(home, ".claude", "plugins", "marketplaces", "acme", "plugins", "scopebond-guard", "hooks");
  mkdirSync(pluginHooks, { recursive: true });
  write(join(pluginHooks, "hooks.json"), { hooks: { PreToolUse: [ours()] } });
  const user = join(home, ".claude", "settings.json");
  write(user, { enabledPlugins: { "scopebond-guard@acme": false }, hooks: { PreToolUse: [ours()] } });
  withHome(home, () => assert.equal(duplicateHooks("claude", project, home), null));
  write(user, { enabledPlugins: { "scopebond-guard@acme": true }, hooks: { PreToolUse: [ours()] } });
  withHome(home, () => {
    assert.deepEqual(duplicateHooks("claude", project, home).map((e) => e.scope), ["user", "plugin"]);
    const result = dedupeHooks("claude", "user", project, home);
    assert.equal(result.plugins.length, 1, "a plugin cannot be edited from here, so it is named");
    const keepPlugin = dedupeHooks("claude", "plugin", project, home);
    assert.equal(keepPlugin.removed[0].scope, "user");
    assert.equal(duplicateHooks("claude", project, home), null);
  });
});

test("status and doctor say so with the one command; dedupe fixes it", () => {
  const { home, project, env } = computer();
  write(join(home, ".claude", "settings.json"), { hooks: { PreToolUse: [ours()] } });
  write(join(project, ".claude", "settings.json"), { hooks: { PreToolUse: [ours()] } });
  const run = (args) => spawnSync(process.execPath, [cli, ...args], { cwd: project, env, encoding: "utf8" });
  const runner = process.platform === "win32" ? "npx.cmd" : "npx";
  const status = run(["status"]);
  assert.match(status.stdout, /DUPLICATE\s+Claude Code runs the Scopebond hook 2 times for each action/);
  assert.ok(status.stdout.includes(`${runner} -y @scopebond/hook@`) && status.stdout.includes("dedupe"), status.stdout);
  const doctor = run(["doctor"]);
  assert.match(doctor.stdout, /runs more than once for each action/);
  const fixed = run(["dedupe"]);
  assert.equal(fixed.status, 0, fixed.stderr);
  assert.match(fixed.stdout, /Kept: user settings/);
  assert.match(fixed.stdout, /Removed: project settings/);
  assert.doesNotMatch(run(["status"]).stdout, /DUPLICATE/);
});

test("a project settings file the team shares through git is never edited by dedupe", () => {
  const { home, project, env } = computer();
  write(join(home, ".claude", "settings.json"), { hooks: { PreToolUse: [ours()] } });
  const shared = join(project, ".claude", "settings.json");
  write(shared, { hooks: { PreToolUse: [ours()] } });
  const git = (args) => spawnSync("git", args, { cwd: project, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });
  if (git(["init", "-q"]).status !== 0) return; // no git on this machine
  git(["add", ".claude/settings.json"]);
  git(["commit", "-qm", "team hook"]);
  const before = readFileSync(shared, "utf8");
  const run = (args) => spawnSync(process.execPath, [cli, ...args], { cwd: project, env, encoding: "utf8" });
  const result = run(["dedupe"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Left alone: project settings .* shared with the team through git/);
  assert.equal(readFileSync(shared, "utf8"), before, "the team's file is unchanged");
  assert.equal(decisionEntries(join(home, ".claude", "settings.json"), "claude").length, 1, "the user-level entry is kept too");
  const doctor = run(["doctor"]);
  assert.doesNotMatch(doctor.stdout, /runs more than once for each action \(see DUPLICATE/, "not a problem this person can fix");
});

test("one enabled plugin is one place, even when Claude Code keeps its marketplace copy and its installed copy", () => {
  const { home, project } = computer();
  for (const dir of [["marketplaces", "acme", "plugins", "scopebond-guard", "hooks"], ["cache", "acme", "scopebond-guard", "1.0.0", "hooks"], ["cache", "acme", "scopebond-guard", "0.9.0", "hooks"]]) {
    const hooks = join(home, ".claude", "plugins", ...dir);
    mkdirSync(hooks, { recursive: true });
    write(join(hooks, "hooks.json"), { hooks: { PreToolUse: [ours()] } });
  }
  write(join(home, ".claude", "settings.json"), { enabledPlugins: { "scopebond-guard@acme": true } });
  withHome(home, () => {
    const entries = hookEntries("claude", project, home);
    assert.deepEqual(entries.map((e) => e.scope), ["plugin"], "the plugin alone is not a duplicate of itself");
    assert.match(entries[0].file, /cache/, "the installed copy is the one counted");
  });
});

test("dedupe removes only Scopebond's command from a group it shares with a person's own hook", () => {
  const { home, project } = computer();
  const userFile = join(home, ".claude", "settings.json");
  const projectFile = join(project, ".claude", "settings.json");
  write(userFile, { hooks: { PreToolUse: [ours()] } });
  const shared = { matcher: "Bash", hooks: [{ type: "command", command: HOOK }, { type: "command", command: "./my-guard.sh" }] };
  write(projectFile, { hooks: { PreToolUse: [shared] } });
  withHome(home, () => { dedupeHooks("claude", "user", project, home); });
  const after = JSON.parse(readFileSync(projectFile, "utf8"));
  assert.deepEqual(after.hooks.PreToolUse, [{ matcher: "Bash", hooks: [{ type: "command", command: "./my-guard.sh" }] }], "the person's own hook stays");
});

test("dedupe leaves a file it has nothing to change in exactly as it was", () => {
  const { home, project } = computer();
  const userFile = join(home, ".claude", "settings.json");
  const original = `{"hooks":{"PreToolUse":[${JSON.stringify(ours())}]},"theme":"dark"}`;
  writeFileSync(userFile, original);
  write(join(project, ".claude", "settings.json"), { hooks: { PreToolUse: [ours()] } });
  withHome(home, () => { dedupeHooks("claude", "user", project, home); });
  assert.equal(readFileSync(userFile, "utf8"), original, "the kept file is not reformatted");
});
