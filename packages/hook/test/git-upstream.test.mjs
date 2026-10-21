// A bare push whose branch cannot be read: before it is denied as a push whose destination is unknown, git is asked for the
// upstream, and that branch is judged. When git cannot tell, the deny stands.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENFORCE } from "./enforce-all.mjs";
import { upstreamBranch, fillPushBranch, mapClaudeToolUse, scaffold, createHookRuntime } from "../dist/index.js";

const temps = [];
after(() => { for (const d of temps) { try { rmSync(d, { recursive: true, force: true, maxRetries: 5 }); } catch { /* a handle still open on Windows */ } } });
const temp = () => { const d = mkdtempSync(join(tmpdir(), "sb-upstream-")); temps.push(d); return d; };
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args],
  { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });

/** A repository on `feature/login` that tracks `origin/<tracks>`. */
function repoTracking(tracks) {
  const remote = temp();
  git(remote, "init", "--bare", "-q");
  const repo = temp();
  git(repo, "init", "-q");
  writeFileSync(join(repo, "a.txt"), "a");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-q", "-m", "a");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "origin", `HEAD:refs/heads/${tracks}`);
  git(repo, "checkout", "-q", "-b", "feature/login");
  git(repo, "branch", "-q", `--set-upstream-to=origin/${tracks}`);
  return repo;
}
const push = (command) => mapClaudeToolUse({ tool_name: "Bash", tool_input: { command }, cwd: "/repo" });

test("git names the upstream branch, without the remote", () => {
  assert.equal(upstreamBranch(repoTracking("feature/login")), "feature/login");
  assert.equal(upstreamBranch(repoTracking("main")), "main");
});

test("git cannot tell: no repository, no upstream, a detached head", () => {
  assert.equal(upstreamBranch(temp()), null);
  const repo = repoTracking("feature/login");
  git(repo, "checkout", "-q", "-b", "untracked");
  assert.equal(upstreamBranch(repo), null);
  git(repo, "checkout", "-q", "--detach");
  assert.equal(upstreamBranch(repo), null);
});

test("the upstream fills a bare push only when the current branch cannot be read, and is asked only then", () => {
  let asked = 0;
  const ask = (answer) => () => { asked++; return answer; };
  for (const command of ["git push", "git push --force-with-lease"]) {
    assert.equal(fillPushBranch(push(command), null, ask("feature/login"))[0].intent.params.ref, "feature/login", command);
    assert.equal(fillPushBranch(push(command), null, ask(null))[0].intent.params.ref, undefined, `${command}: git cannot tell`);
  }
  asked = 0;
  assert.equal(fillPushBranch(push("git push"), "feature/x", ask("main"))[0].intent.params.ref, "feature/x", "the current branch wins");
  assert.equal(fillPushBranch(push("git push origin feature/y"), null, ask("main"))[0].intent.params.ref, "feature/y", "a named destination is kept");
  assert.equal(asked, 0, "git is not asked when nothing needs it");
});

test("judged: a bare push to a feature branch's upstream is allowed, to main's is denied, and unknown stays denied", async () => {
  const dir = temp();
  scaffold(dir, ENFORCE);
  const runtime = createHookRuntime({ policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"), attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db"), cwd: "/repo" });
  try {
    const feature = repoTracking("feature/login");
    const main = repoTracking("main");
    const decide = async (command, cwd) => (await runtime.evaluate(fillPushBranch(push(command), null, () => upstreamBranch(cwd)))).decision;
    assert.equal(await decide("git push --force-with-lease", feature), "allow");
    assert.equal(await decide("git push", feature), "allow");
    assert.equal(await decide("git push", main), "deny");
    assert.equal(await decide("git push --force-with-lease", temp()), "deny", "git cannot tell: the push stays denied");
  } finally { runtime.close(); }
});
