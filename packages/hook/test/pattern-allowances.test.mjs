// Pattern allowances: "Similar commands in this project". A person who may unblock an action may instead allow the actions
// like it, for the same rule, inside bounds they read in words: the starter destructive-shell rule's built-in recipe (the same
// deleting program, every target inside one folder of one repository) and the rule packs' recipes (a folder or a file pattern
// in the project, a package in any version, a host, an MCP server's tool). A pattern never matches outside its bounds, never
// across rules, never for the always-on protections, and only where the workspace lets a person make one
// (`override.patterns`: person, needs_admin, off; anything else is off).
import { ENFORCE } from "./enforce-all.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scaffold, createHookRuntime, mapClaudeToolUse, compileManaged, digestRules, defaultRules, inspectManaged, HOOK_CAPABILITIES,
  createOverrideHandler, MANAGED_DOC_FILE, readAllowances, writeAllowances, makeAllowance, readBlocked, blockedQuestion, actOnBlocked,
  patternCovers, matchPatternAllowance, patternKey, similarFor, patternSetting, readActionText,
} from "../dist/index.js";
import { DELETE_RECIPE } from "@scopebond/policy-schema";

const INSTALLATION = "gw-pattern-1";
const terms = (extra = {}) => ({ reason_min: 10, minutes: 0, daily_limit: 5, harness_prompt: false, always: "at_once", requests: true, patterns: "person", ...extra });
const defaults = () => ({
  "force-push-protected": { mode: "block" }, "push-protected": { mode: "block" }, "destructive-shell": { mode: "block" },
  "secret-read": { mode: "block" }, "ci-config-write": { mode: "block" }, "network-egress": { mode: "monitor" },
});
function doc(revision, overrides = {}) {
  const rules = { ...defaults(), ...overrides };
  return { type: "scopebond:managed-rules", version: 1, revision, export_id: `rev-${revision}-${INSTALLATION}`, environment_id: "env-1",
    agent_id: "agent-1", installation_id: INSTALLATION, rules, rules_digest: digestRules(rules) };
}
const bash = (command) => ({ tool_name: "Bash", tool_input: { command } });

function setup(override) {
  const dir = mkdtempSync(join(tmpdir(), "scopebond-pattern-"));
  const { agentKid } = scaffold(dir, ENFORCE);
  const d = doc(2, { "destructive-shell": { mode: "override", override } });
  writeFileSync(join(dir, MANAGED_DOC_FILE), JSON.stringify(d));
  writeFileSync(join(dir, "policy.json"), JSON.stringify(compileManaged(defaultRules(), d, agentKid)));
  return dir;
}

// The repository every target under /work/app is in; nothing else is in one. Real paths are not read (nothing exists).
const REPO = "/work/app";
const repositoryTop = (path) => (path === REPO || path.startsWith(`${REPO}/`) ? REPO : null);

async function run(dir, command, { answers = [] } = {}) {
  const asked = [];
  const runtime = createHookRuntime({
    policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"), attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db"), cwd: "/repo",
    restorable: () => false,
    override: (agentKid) => {
      const made = createOverrideHandler({ dir, home: dir, agentKid, harness: "claude", permissionMode: "default", waitMs: 50, cwd: "/repo",
        repositoryTop, real: () => null,
        ask: async (_home, request) => { asked.push(request); return answers.shift() ?? { decision: "unavailable" }; } });
      return made ? { handler: made.handler, hint: () => null } : null;
    },
  });
  try {
    const d = await runtime.evaluate(mapClaudeToolUse({ cwd: "/repo", ...bash(command) }));
    return { ...d, asked, override: d.receipts?.map((r) => r.payload.override).find(Boolean) ?? null };
  } finally { runtime.close(); }
}

const REASON = "Removing an old worktree";
const deleteMatch = (bounds = {}) => ({ rule: "destructive-shell", action_type: "shell.exec", recipe: DELETE_RECIPE,
  bounds: { kind: "path_prefix", param: "delete_targets", program: "rm", value: "d:/src/app", project: "d:/src/app", ...bounds } });
const rm = (targets, extra = {}) => ({ action_type: "shell.exec", params: { command: "rm -rf x", program: "rm", program_scope: "rm", delete_targets: targets, ...extra } });
const covers = (match, action, extra = {}) => patternCovers(match, { rule: match.rule, action, project: "d:/src/other", home: "D:\\profiles\\me", ...extra });

test("the delete recipe's bounds: inside the folder, never outside it, never another project, never climbing out", () => {
  const m = deleteMatch();
  assert.equal(covers(m, rm(["d:/src/app/dist"])), true, "a folder inside");
  assert.equal(covers(m, rm(["d:/src/app/packages/web/build", "d:/src/app/tmp"])), true, "several inside");
  assert.equal(covers(m, rm(["d:/src/app"])), true, "the folder itself (the repository, at most)");
  assert.equal(covers(m, rm(["d:/SRC/APP/dist"])), true, "a drive path compares without case");
  for (const [targets, why] of [
    [["d:/src"], "the folder holding the project"],
    [["d:/src/other/dist"], "another project"],
    [["d:/src/app-old/dist"], "a folder whose name only starts the same"],
    [["d:/src/app/dist", "d:/src/other"], "one target outside"],
    [["d:/src/app/../other"], "a .. segment"],
    [["d:/src/app/./dist"], "a . segment"],
    [["d:/src/APP~1/dist"], "a short name standing for another folder"],
    [["d:/src/app/*"], "a wildcard"],
    [["d:/src/app/.git"], "the repository's history"],
    [["d:/src/app/.github/workflows"], "a protected place"],
    [["e:/src/app/dist"], "another drive"],
    [["~/GitHub/app/dist"], "another root"],
    [["app/dist"], "a relative path"],
    [[], "no target"],
  ]) assert.equal(covers(m, rm(targets)), false, why);
  assert.equal(covers(m, rm(["d:/src/app/dist"], { program: "shred", program_scope: "shred" })), false, "another program");
  assert.equal(covers(m, rm(["d:/src/app/dist"], { program_scope: "rm/remove-all" })), false, "a destructive form");
  assert.equal(covers(m, rm(["d:/src/app/dist"], { delete_targets: undefined })), false, "targets not read");
  assert.equal(covers(m, { action_type: "file.write", params: { path: "d:/src/app/dist" } }), false, "another action type");
});

test("a link to elsewhere, or a project holding the home folder, is never covered", () => {
  const m = deleteMatch();
  const real = (p) => (p === "d:/src/app/link" ? "c:/Windows/System32" : p);
  assert.equal(covers(m, rm(["d:/src/app/link"]), { real }), false, "the target really is elsewhere");
  assert.equal(covers(m, rm(["d:/src/app/dist"]), { real }), true, "a target where it says it is");
  const linkedFolder = (p) => (p.startsWith("d:/src/app/packages") ? p.replace("d:/src/app/packages", "c:/elsewhere") : p);
  assert.equal(covers(deleteMatch({ value: "d:/src/app/packages" }), rm(["d:/src/app/packages/web"]), { real: linkedFolder }), false, "the folder is a link out of its project");
  const users = deleteMatch({ value: "d:/profiles/x", project: "d:/profiles" });
  assert.equal(covers(users, rm(["d:/profiles/x/y"]), { home: "D:\\profiles\\me" }), false, "a project holding the home folder");
  const posixHome = deleteMatch({ value: "/srv/people/me/app", project: "/srv/people" });
  assert.equal(covers(posixHome, rm(["/srv/people/me/app/x"]), { home: "/srv/people/me" }), false);
  assert.equal(covers(deleteMatch({ value: "~/work/app", project: "~/work/app" }), rm(["~/work/app/dist"]), { home: "D:\\profiles\\me" }), true, "a repository in the home folder");
});

test("never across rules, never for an always-on protection", () => {
  const m = deleteMatch();
  assert.equal(patternCovers(m, { rule: "cloud-destructive", action: rm(["d:/src/app/dist"]), project: null }), false, "another rule");
  for (const rule of ["protect-scopebond-write", "protect-scopebond-read", "guardrail-config-write", "self-disable"]) {
    assert.equal(patternCovers({ ...m, rule }, { rule, action: rm(["d:/src/app/dist"]), project: null }), false, rule);
    assert.equal(similarFor(rule, rm(["d:/src/app/dist"]), { project: null, repositoryTop: () => "d:/src/app" }), null, rule);
  }
  // An allowance carrying a pattern for an always-on rule, or for another rule than its own, is not read at all.
  const dir = mkdtempSync(join(tmpdir(), "scopebond-pattern-valid-"));
  const ok = makeAllowance({ rule: "destructive-shell", actionKey: "0".repeat(64), reason: "", osUserDigest: null, lasts: "30d", match: m });
  const always = { ...ok, id: "alw_aaaaaaaaaaaaaaaaaaaaaa", rule: "protect-scopebond-write", match: { ...m, rule: "protect-scopebond-write" } };
  const crossed = { ...ok, id: "alw_bbbbbbbbbbbbbbbbbbbbbb", rule: "cloud-destructive" };
  const wide = { ...ok, id: "alw_cccccccccccccccccccccc", match: deleteMatch({ value: "d:/src", project: "d:/src/app" }) };
  writeAllowances(dir, [ok, always, crossed, wide]);
  assert.deepEqual(readAllowances(dir).map((a) => a.id), [ok.id]);
  assert.equal(ok.action_key, patternKey(m), "keyed on the pattern, which no action's key equals");
});

test("the pack recipes' bounds: in the project they were made in, the widened parameter only", () => {
  const at = (bounds, action, project = "d:/src/app") => patternCovers({ rule: "secret-write", action_type: action.action_type, recipe: "r", bounds: { project: "d:/src/app", ...bounds } },
    { rule: "secret-write", action, project });
  const file = (path) => ({ action_type: "file.write", params: { path } });
  assert.equal(at({ kind: "path_prefix", param: "path", value: "config/env" }, file("config/env/dev.json")), true);
  assert.equal(at({ kind: "path_prefix", param: "path", value: "config/env" }, file("config/env/deep/x.json")), true);
  assert.equal(at({ kind: "path_prefix", param: "path", value: "config/env" }, file("config/other.json")), false, "outside the folder");
  assert.equal(at({ kind: "path_prefix", param: "path", value: "config/env" }, file("config/env/../../x")), false, "..");
  assert.equal(at({ kind: "path_prefix", param: "path", value: "config/env" }, file("d:/src/app/config/env/x")), false, "an absolute path");
  assert.equal(at({ kind: "path_prefix", param: "path", value: "config/env" }, file("config/env/dev.json"), "d:/src/other"), false, "another project");
  assert.equal(at({ kind: "path_prefix", param: "path", value: "." }, file(".env")), false, "a protected file, even in the folder");
  assert.equal(at({ kind: "path_glob", param: "path", value: "config/*.json" }, file("config/prod.json")), true);
  assert.equal(at({ kind: "path_glob", param: "path", value: "config/*.json" }, file("config/deep/prod.json")), false, "a deeper folder");
  assert.equal(at({ kind: "path_glob", param: "path", value: "config/*.json" }, file("config/prod.yaml")), false, "another kind of file");
  const pkg = (name, ecosystem = "npm") => ({ action_type: "package.install", params: { package: name, ecosystem } });
  assert.equal(at({ kind: "package_name", param: "package", value: "left-pad", with: { ecosystem: "npm" } }, pkg("left-pad")), true);
  assert.equal(at({ kind: "package_name", param: "package", value: "left-pad", with: { ecosystem: "npm" } }, pkg("left-pad", "pypi")), false, "another registry");
  assert.equal(at({ kind: "package_name", param: "package", value: "left-pad", with: { ecosystem: "npm" } }, pkg("left-pad-x")), false);
  const fetch = (host) => ({ action_type: "net.fetch", params: { host, path: "/" } });
  assert.equal(at({ kind: "host", param: "host", value: "api.example.com" }, fetch("API.example.com")), true);
  assert.equal(at({ kind: "host", param: "host", value: "api.example.com" }, fetch("evil.api.example.com")), false);
  const tool = (server, name) => ({ action_type: "mcp.tool.call", params: { server, tool: name } });
  assert.equal(at({ kind: "mcp_tool", param: "tool", value: "create_issue", with: { server: "github" } }, tool("github", "create_issue")), true);
  assert.equal(at({ kind: "mcp_tool", param: "tool", value: "create_issue", with: { server: "github" } }, tool("gitlab", "create_issue")), false, "another server");
  assert.equal(at({ kind: "mcp_tool", param: "tool", value: "create_issue", with: { server: "github" } }, tool("github", "delete_repo")), false, "another tool");
});

test("what is offered: the built-in delete recipe in words, and a pack's recipe, only where one fits", () => {
  const top = (p) => (p.startsWith("d:/src/app") ? "d:/src/app" : null);
  const worktree = similarFor("destructive-shell", rm(["d:/src/app"]), { project: "d:/src/scopebond", repositoryTop: top });
  assert.deepEqual(worktree.offer, { recipe_id: DELETE_RECIPE, words: "Deleting folders inside d:/src/app with rm", covers: ["rm -r d:/src/app/dist"], not_covers: ["rm -rf d:/src"] });
  const inner = similarFor("destructive-shell", rm(["d:/src/app/packages/web/build"]), { project: null, repositoryTop: top });
  assert.equal(inner.offer.words, "Deleting folders inside d:/src/app/packages/web with rm");
  assert.deepEqual(inner.offer.covers, ["rm -r d:/src/app/packages/web/build"]);
  assert.equal(similarFor("destructive-shell", rm(["d:/src/app/a/x", "d:/src/app/b/y"]), { project: null, repositoryTop: top }).match.bounds.value, "d:/src/app", "the folder both are in");
  assert.equal(similarFor("destructive-shell", rm(["c:/elsewhere/x"]), { project: null, repositoryTop: top }), null, "in no repository");
  assert.equal(similarFor("destructive-shell", rm(["d:/src/app/x", "d:/src/zzz/y"]), { project: null, repositoryTop: (p) => p.split("/").slice(0, 3).join("/") }), null, "two repositories");
  assert.equal(similarFor("destructive-shell", rm(["~/x"]), { project: null, repositoryTop: () => "~" }), null, "the home folder as a repository");
  assert.equal(similarFor("destructive-shell", rm(["d:/src/app/x"], { program_scope: "rm/remove-all" }), { project: null, repositoryTop: top }), null, "a destructive form");
  // A pack's recipe, for that rule's action types only, in the call's project.
  const packRecipes = (rule) => (rule === "secret-write" ? { recipes: [{ id: "env-folder", title: "Writing secrets files in {value}", param: "path", kind: "path_prefix" }], action_types: ["file.write"] } : null);
  const env = similarFor("secret-write", { action_type: "file.write", params: { path: "config/env/dev.json" } }, { project: "d:/src/app", packRecipes });
  assert.equal(env.offer.words, "Writing secrets files in config/env");
  assert.deepEqual(env.match.bounds, { kind: "path_prefix", param: "path", value: "config/env", project: "d:/src/app" });
  assert.equal(similarFor("secret-write", { action_type: "net.fetch", params: { path: "x/y" } }, { project: "d:/src/app", packRecipes }), null, "another action type");
  assert.equal(similarFor("secret-write", { action_type: "file.write", params: { path: "config/env/dev.json" } }, { project: null, packRecipes }), null, "no project");
  assert.equal(similarFor("secret-write", { action_type: "file.write", params: { path: "../x/y" } }, { project: "d:/src/app", packRecipes }), null, "outside the project");
  assert.equal(similarFor("destructive-shell", { action_type: "file.write", params: { path: "a/b" } }, { project: "d:/src/app", packRecipes }), null, "never across rules");
});

test("the workspace decides who may make one: person, needs_admin, off; anything else is off", () => {
  assert.equal(patternSetting({ patterns: "person" }), "person");
  assert.equal(patternSetting({ patterns: "needs_admin" }), "needs_admin");
  for (const v of ["off", undefined, "everyone", 1, null]) assert.equal(patternSetting({ patterns: v }), "off", String(v));
  assert.ok(HOOK_CAPABILITIES.includes("pattern_allowances"));
  // An unknown value never refuses the document.
  const d = doc(3, { "destructive-shell": { mode: "override", override: terms({ patterns: "a newer word" }) } });
  assert.equal(inspectManaged(d, { installationId: INSTALLATION, currentRevision: 2 }).ok, true);
});

test("a person allows similar commands in the window: the pattern stands for the folder, nothing outside it", async () => {
  const dir = setup(terms());
  const first = await run(dir, `rm -rf ${REPO}/old-build`, { answers: [{ decision: "allow", reason: REASON, lasts: "always", scope: "similar" }] });
  assert.equal(first.decision, "allow");
  assert.deepEqual(first.asked[0].similar, { recipe_id: DELETE_RECIPE, words: `Deleting folders inside ${REPO} with rm`, covers: [`rm -r ${REPO}/old-build`], not_covers: ["rm -rf /work"] });
  const pattern = readAllowances(dir).find((a) => a.match);
  assert.equal(pattern.state, "active");
  assert.equal(pattern.match.bounds.value, REPO);
  assert.equal(readActionText(dir).get(pattern.action_key), `Deleting folders inside ${REPO} with rm`, "the Allowed list reads the words");
  const similar = await run(dir, `cd /tmp && rm -r ${REPO}/dist 2>&1`);
  assert.equal(similar.decision, "allow");
  assert.equal(similar.asked.length, 0, "not asked again");
  assert.equal(similar.override.method, "allowance");
  assert.equal(similar.override.repeat_of, pattern.id);
  for (const command of ["rm -rf /work", "rm -rf /work/other", `rm -rf ${REPO}-old/x`, `shred -u ${REPO}/x`]) {
    const outside = await run(dir, command);
    assert.equal(outside.decision, "deny", command);
  }
});

test("where the workspace says off, nothing similar is offered and a similar answer allows the action alone", async () => {
  const dir = setup(terms({ patterns: "off" }));
  const first = await run(dir, `rm -rf ${REPO}/a`, { answers: [{ decision: "allow", reason: REASON, lasts: "always", scope: "similar" }] });
  assert.equal(first.decision, "allow");
  assert.equal(first.asked[0].similar, undefined);
  assert.equal(readAllowances(dir).some((a) => a.match), false);
  assert.equal((await run(dir, `rm -rf ${REPO}/b`)).decision, "deny");
});

test("where an admin must approve, the pattern waits and only the action itself is allowed meanwhile", async () => {
  const dir = setup(terms({ patterns: "needs_admin" }));
  const first = await run(dir, `rm -rf ${REPO}/a`, { answers: [{ decision: "allow", reason: REASON, lasts: "always", scope: "similar" }] });
  assert.equal(first.decision, "allow");
  assert.equal(first.asked[0].similar.needs_admin, true, "the form says it needs an admin");
  const items = readAllowances(dir);
  assert.equal(items.find((a) => a.match).state, "proposed");
  assert.ok(items.some((a) => !a.match && a.state === "active"), "the action itself, for 15 minutes");
  assert.equal((await run(dir, `rm -rf ${REPO}/a`)).decision, "allow", "the same command passes meanwhile");
  assert.equal((await run(dir, `rm -rf ${REPO}/b`)).decision, "deny", "a similar one waits for the admin");
});

test("from the tray afterwards: the block keeps what similar would allow; the answer makes the pattern", async () => {
  const dir = setup(terms());
  const blocked = await run(dir, `rm -rf ${REPO}/cache`);
  assert.equal(blocked.decision, "deny");
  const item = readBlocked(dir).at(-1);
  const q = blockedQuestion(dir, item.id);
  assert.equal(q.similar.words, `Deleting folders inside ${REPO} with rm`);
  assert.equal(actOnBlocked(dir, item.id, { decision: "allow", reason: REASON, lasts: "always", scope: "similar" }).outcome, "allowed");
  assert.equal((await run(dir, `rm -rf ${REPO}/other-cache`)).decision, "allow");
  assert.equal((await run(dir, "rm -rf /work/elsewhere")).decision, "deny");
  // Not offered (the workspace turned it off since): a similar answer is declined, nothing is allowed.
  const later = await run(dir, `rmdir ${REPO}/zzz`);
  const offDoc = doc(3, { "destructive-shell": { mode: "override", override: terms({ patterns: "off" }) } });
  writeFileSync(join(dir, MANAGED_DOC_FILE), JSON.stringify(offDoc));
  const id = readBlocked(dir).at(-1).id;
  assert.equal(later.decision, "deny");
  assert.equal(blockedQuestion(dir, id).similar, null);
  assert.equal(actOnBlocked(dir, id, { decision: "allow", reason: REASON, lasts: "always", scope: "similar" }).outcome, "declined");
});

test("a pattern allowance matches only while in force, for its person", () => {
  const m = deleteMatch();
  const now = Date.parse("2026-10-21T12:00:00Z");
  const a = makeAllowance({ rule: "destructive-shell", actionKey: "x", reason: "", osUserDigest: "a".repeat(64), lasts: "1h", match: m, now });
  const q = (extra = {}) => ({ rule: "destructive-shell", action: rm(["d:/src/app/dist"]), project: null, osUserDigest: "a".repeat(64), now: now + 60_000, home: "D:\\profiles\\me", ...extra });
  assert.equal(matchPatternAllowance([a], q())?.id, a.id);
  assert.equal(matchPatternAllowance([a], q({ now: now + 2 * 60 * 60_000 })), null, "expired");
  assert.equal(matchPatternAllowance([a], q({ osUserDigest: "b".repeat(64) })), null, "another person");
  assert.equal(matchPatternAllowance([{ ...a, state: "revoked" }], q()), null, "revoked");
  assert.equal(matchPatternAllowance([{ ...a, ended_at: new Date(now).toISOString() }], q()), null, "stopped");
  assert.equal(matchPatternAllowance([{ ...a, state: "proposed" }], q()), null, "waiting for an admin");
});
