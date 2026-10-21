// A delete git can restore is recorded instead of blocked: when every target it names outside the working folder is tracked
// and committed in a git repository (nothing modified, staged, untracked or ignored under it), safe-shell lets it run and the
// receipt records `program_scope: "rm/git_restorable"`. An untracked or modified target, a target outside any repository,
// the repository's own top folder, a missing path, and any git failure keep today's decision (blocked).
// Every row is a real signed decision under the starter policy with every rule blocking, against a real temporary repository.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  scaffold, createHookRuntime, mapClaudeToolUse, classifyIntent, defaultRules, gitRestorable, withRestorableScope, isRestorableDelete, RESTORABLE_SUFFIX,
} from "../dist/index.js";
import { ENFORCE } from "./enforce-all.mjs";

const dirs = [];
after(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 5 }); } catch { /* a handle still open on Windows */ } } });
// Not under /tmp, which safe-shell already treats as the temp folder, and by its long name (an 8.3 short name such as
// RUNNER~1 is never a known target): the runner's own temp folder when there is one.
const base = () => {
  if (process.env.RUNNER_TEMP) return process.env.RUNNER_TEMP;
  if (!tmpdir().startsWith("/tmp")) return tmpdir();
  const d = join(homedir(), ".cache", "sb-git-restorable");
  mkdirSync(d, { recursive: true });
  return d;
};
const temp = (prefix) => { const d = realpathSync.native(mkdtempSync(join(base(), prefix))); dirs.push(d); return d; };
const slash = (p) => p.replace(/\\/g, "/");

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args],
  { cwd, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" });

// The repository: committed folders, one with a change, one untracked, one with an ignored file in it.
const repo = temp("sb-git-repo-");
git(repo, "init", "-q");
for (const [file, text] of [["src/a.txt", "a"], ["src/deep/b.txt", "b"], ["changed/c.txt", "c"], ["mixed/d.txt", "d"], [".gitignore", "*.secret\n"], ["top.txt", "t"]]) {
  mkdirSync(join(repo, file, ".."), { recursive: true });
  writeFileSync(join(repo, file), text);
}
git(repo, "add", "-A");
git(repo, "commit", "-q", "-m", "first");
writeFileSync(join(repo, "changed/c.txt"), "changed");
mkdirSync(join(repo, "fresh"));
writeFileSync(join(repo, "fresh/new.txt"), "new");
writeFileSync(join(repo, "mixed/key.secret"), "ignored");
const staged = join(repo, "src/deep/staged.txt");
// A plain folder outside any repository.
const plain = temp("sb-git-plain-");
mkdirSync(join(plain, "x"));
writeFileSync(join(plain, "x/f.txt"), "f");
// The working folder the coding agent runs in: neither of them.
const project = temp("sb-git-project-");

const policyDir = temp("sb-git-policy-");
scaffold(policyDir, ENFORCE);
const runtime = createHookRuntime({ policyPath: join(policyDir, "policy.json"), keyPath: join(policyDir, "agent.key"), attesterPath: join(policyDir, "attester.key"), dbPath: join(policyDir, "receipts.db"), cwd: project });
after(() => runtime.close());

const decide = async (command) => {
  const d = await runtime.evaluate(mapClaudeToolUse({ tool_name: "Bash", tool_input: { command }, cwd: project }));
  const exec = d.receipts?.map((r) => r.payload?.intent ?? r.payload?.action).find((i) => i?.action_type === "shell.exec");
  return { decision: d.decision === "deny" ? "deny" : "allow", scope: exec?.params?.program_scope ?? null };
};
const at = (p) => `'${slash(join(repo, p))}'`;

// [what, command, expected]: the vectors.
const VECTORS = [
  ["a tracked and committed folder", `rm -rf ${at("src")}`, "allow"],
  ["a tracked and committed file", `rm -f ${at("src/a.txt")}`, "allow"],
  ["two committed targets", `rm -rf ${at("src/deep")} ${at("top.txt")}`, "allow"],
  ["a folder with an uncommitted change", `rm -rf ${at("changed")}`, "deny"],
  ["a folder holding an ignored file", `rm -rf ${at("mixed")}`, "deny"],
  ["an untracked folder", `rm -rf ${at("fresh")}`, "deny"],
  ["one committed and one untracked target", `rm -rf ${at("src")} ${at("fresh")}`, "deny"],
  ["the repository's own top folder", `rm -rf '${slash(repo)}'`, "deny"],
  ["the repository's history", `rm -rf ${at(".git")}`, "deny"],
  ["a path that does not exist", `rm -rf ${at("missing")}`, "deny"],
  ["a folder outside any repository", `rm -rf '${slash(join(plain, "x"))}'`, "deny"],
  ["a target only known at run time", "rm -rf $TARGET", "deny"],
  ["the root", "rm -rf /", "deny"],
];

test("a delete git can restore is recorded instead of blocked; anything else keeps its block", async () => {
  const wrong = [];
  for (const [what, command, expected] of VECTORS) {
    const { decision, scope } = await decide(command);
    if (decision !== expected) wrong.push(`${what}: ${command} -> ${decision} (expected ${expected})`);
    if (expected === "allow" && scope !== `rm${RESTORABLE_SUFFIX}`) wrong.push(`${what}: program_scope ${scope}`);
    if (expected === "deny" && scope === `rm${RESTORABLE_SUFFIX}`) wrong.push(`${what}: marked restorable`);
  }
  assert.deepEqual(wrong, []);
});

test("a staged change that is not committed keeps the block", async () => {
  writeFileSync(staged, "s");
  git(repo, "add", "src/deep/staged.txt");
  try {
    assert.equal((await decide(`rm -rf ${at("src/deep")}`)).decision, "deny");
  } finally {
    git(repo, "rm", "-q", "--cached", "src/deep/staged.txt");
    rmSync(staged, { force: true });
  }
  assert.equal((await decide(`rm -rf ${at("src/deep")}`)).decision, "allow", "committed again: restorable");
});

test("any git failure or a slow git keeps today's decision", () => {
  const targets = [slash(join(repo, "src"))];
  assert.equal(gitRestorable(targets, { run: () => null }), false, "git gave no answer");
  assert.equal(gitRestorable(targets, { run: () => { throw new Error("spawn failed"); } }), false, "git could not start");
  assert.equal(gitRestorable(targets, { timeoutMs: 0 }), false, "no time left");
  assert.equal(gitRestorable(targets), true, "the real git agrees it is restorable");
  assert.equal(gitRestorable([]), false, "no target");
  assert.equal(gitRestorable(Array.from({ length: 9 }, () => targets[0])), false, "too many targets to check in time");
});

test("only a plain delete with known targets outside the working folder is considered", () => {
  const exec = (params) => ({ intent: { action_type: "shell.exec", params }, evaluated: true, source: "test" });
  const yes = () => true;
  const scoped = withRestorableScope(exec({ program: "rm", program_scope: "rm", delete_targets: ["/r/x"] }), yes);
  assert.equal(scoped.intent.params.program_scope, "rm/git_restorable");
  assert.equal(isRestorableDelete(scoped.intent.params), true);
  // A destructive form, a contained delete, a program that is not a delete, no targets: unchanged.
  for (const params of [
    { program: "rm", program_scope: "rm/remove-all", delete_targets: ["/r/x"] },
    { program: "rm", program_scope: "rm/contained" },
    { program: "shred", program_scope: "shred", delete_targets: ["/r/x"] },
    { program: "rm", program_scope: "rm" },
    { program: "rm", program_scope: "rm", delete_targets: [] },
    { program: "rm", program_scope: "rm", delete_targets: [7] },
  ]) assert.equal(withRestorableScope(exec(params), yes).intent.params.program_scope, params.program_scope, JSON.stringify(params));
  // The check is never asked when nothing could pass.
  let asked = 0;
  withRestorableScope(exec({ program: "ls", program_scope: "ls" }), () => { asked++; return true; });
  assert.equal(asked, 0);
});

test("the catalog agrees with the policy: a restorable delete is not a destructive-shell match", () => {
  const params = { command: "rm -rf /r/x", program: "rm", program_scope: "rm/git_restorable", delete_targets: ["/r/x"] };
  assert.equal(classifyIntent({ action_type: "shell.exec", params }, defaultRules()).ids.includes("H04"), false);
  assert.equal(classifyIntent({ action_type: "shell.exec", params: { ...params, program_scope: "rm" } }, defaultRules()).ids.includes("H04"), true);
});
