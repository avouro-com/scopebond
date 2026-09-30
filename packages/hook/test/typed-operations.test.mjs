// Typed operations for git, github_resource and package: derived from the actual command or
// tool input, closed and schema-valid, keyed and free of raw values, honest when a fact
// cannot be read. Windows and POSIX shapes are both covered.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TYPED_ACTION_TYPES, bindingKeyFromHex, buildOperation, deriveTypedOperations, normalizeRemote, mapClaudeToolUse, redactCommand, useDigestKey, gitPushOperation } from "../dist/index.js";
import { validObservation } from "./observation-schema.mjs";

const KEY = bindingKeyFromHex("11".repeat(32));
useDigestKey("22".repeat(32));
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const MAIN = "c".repeat(40);
const TAG = "d".repeat(40);

/** A repository on a chosen remote, with the refs a real one would have. */
const fakeProbe = (over = {}) => ({
  head: () => HEAD,
  branch: () => "feature/x",
  remoteUrl: (_cwd, remote) => (remote === "origin" ? "https://user:secret-token@github.com/Acme/Widgets.git" : remote === "backup" ? "git@example.org:mirror/w.git" : null),
  defaultRemote: () => "origin",
  revParse: (_cwd, rev) => ({ "refs/heads/feature/x": HEAD, "refs/remotes/origin/HEAD": BASE, "refs/remotes/origin/develop": MAIN, "refs/tags/v1.0.0": TAG }[rev] ?? null),
  ...over,
});
const ctx = (over = {}) => ({ key: KEY, cwd: "/work/project", repositoryId: "sbr_repo", referenceSetVersion: "hook-1", probe: fakeProbe(), packageManagerVersion: () => undefined, ...over });

const payload = (operation) => ({
  type: "scopebond:observation", version: "1.0", observation_id: "11111111-1111-4111-8111-111111111111", installation_id: "i", installation_generation: 1,
  parent_action_id: "a", source_receipt_hash: "0".repeat(64), kind: "tool_intent", occurred_at: "2026-01-01T00:00:00Z", sequence: 1,
  data: { event: "requested", parent_action_id: "a", source_receipt_hash: "0".repeat(64), request_digest: operation.request_digest, operation },
});

/** The dispatched items the hook would have evaluated for a shell command, and the typed operations derived. */
function derive(command, { tool = "Bash", context = ctx() } = {}) {
  const mapped = mapClaudeToolUse({ tool_name: tool, tool_input: { command }, cwd: context.cwd });
  const dispatched = mapped.map((m) => ({ action: { action_type: m.intent.action_type, params: m.intent.params } }));
  const typed = deriveTypedOperations({ command, dialect: tool === "PowerShell" ? "powershell" : "posix", dispatched, redact: redactCommand }, context);
  return { dispatched, typed };
}
const only = (command, opts) => { const { typed } = derive(command, opts); assert.equal(typed.size, 1, command); return [...typed.values()][0]; };
const valid = (op) => { assert.equal(validObservation(payload(op)), true, JSON.stringify(op)); return op; };

test("normalizeRemote strips credentials and reduces every remote shape to host and path", () => {
  assert.deepEqual(normalizeRemote("https://user:tok@github.com/Acme/Widgets.git"), { host: "github.com", path: "Acme/Widgets" });
  assert.deepEqual(normalizeRemote("git@github.com:Acme/Widgets.git"), { host: "github.com", path: "Acme/Widgets" });
  assert.deepEqual(normalizeRemote("ssh://git@example.org:2222/team/repo"), { host: "example.org", path: "team/repo" });
  assert.deepEqual(normalizeRemote("C:\\repos\\Widgets.git"), { host: "local", path: "c:/repos/widgets" });
  assert.deepEqual(normalizeRemote("/srv/git/widgets.git"), { host: "local", path: "srv/git/widgets" });
  assert.equal(normalizeRemote("$REMOTE"), null);
  assert.equal(normalizeRemote(""), null);
});

test("git push: verbs, force, protected flag, resolved remote, and no credentials anywhere", () => {
  const push = (params, c = ctx()) => valid(gitPushOperation(params, c, undefined, { action_type: "git.push", params }));
  const plain = push({ ref: "feature/x", remote: "origin", force: false });
  assert.equal(plain.verb, "push");
  assert.equal(plain.resolution, "resolved");
  assert.equal(plain.refs[0].protected, false);
  assert.equal(plain.head_sha, HEAD);
  assert.ok(plain.remote_id.startsWith("sbr_"));
  const main = push({ ref: "main", remote: "origin", force: true });
  assert.equal(main.refs[0].protected, true);
  assert.equal(main.force, true);
  // The same remote reached by name and by URL (with a credential) has the same id.
  assert.equal(push({ ref: "main", remote: "https://other:pw@github.com/acme/widgets" }).remote_id, main.remote_id);
  assert.equal(push({ ref: "main" }).remote_id, main.remote_id, "a plain push uses the default remote");
  assert.notEqual(push({ ref: "main", remote: "backup" }).remote_id, main.remote_id);
  assert.equal(push({ ref: "old", remote: "origin", delete: true }).verb, "delete");
  const mirror = push({ ref: "--mirror", remote: "origin", force: true, delete: true, all: true });
  assert.equal(mirror.verb, "mirror");
  assert.equal(mirror.resolution, "unresolved");
  assert.deepEqual(mirror.refs, []);
  const all = push({ ref: "--all", remote: "origin", all: true });
  assert.equal(all.verb, "push");
  assert.equal(all.resolution, "unresolved");
  // A remote that cannot be resolved is recorded as unresolved, under a different id space.
  const unknown = push({ ref: "main", remote: "nowhere" });
  assert.equal(unknown.resolution, "unresolved");
  assert.notEqual(unknown.remote_id, main.remote_id);
  // A protected list from the loaded rules replaces the default.
  assert.equal(push({ ref: "trunk", remote: "origin" }, ctx({ isProtectedRef: (r) => r === "trunk" })).refs[0].protected, true);
  assert.equal(gitPushOperation({ ref: "main" }, ctx({ probe: fakeProbe({ head: () => null }) }), undefined), null, "no HEAD, no git operation");
  const text = JSON.stringify([plain, main, mirror, unknown]);
  assert.ok(!text.includes("secret-token") && !text.includes("Widgets") && !/github\.com/.test(text), "no raw remote, host or credential");
});

test("buildOperation routes a dispatched push through the git builder, with remote_id", () => {
  const op = buildOperation({ action_type: "git.push", params: { ref: "release/1.2", remote: "origin", force: true } }, { key: KEY, cwd: "/work/project", repositoryId: "sbr_repo", headSha: HEAD, probe: fakeProbe() });
  valid(op);
  assert.equal(op.refs[0].protected, true);
  assert.ok(op.remote_id);
});

test("git commit: the branch it lands on and the HEAD it starts from; not after a cd, not with -C", () => {
  const commit = valid(only('git commit -m "wip"'));
  assert.equal(commit.verb, "commit");
  assert.equal(commit.head_sha, HEAD);
  assert.equal("remote_id" in commit, false);
  assert.equal(commit.refs[0].ref_id, KEY.resourceId("ref", "feature/x"), "the same ref id a push uses");
  const detached = valid(only("git commit -m x", { context: ctx({ probe: fakeProbe({ branch: () => null }) }) }));
  assert.equal(detached.resolution, "unresolved");
  assert.equal(derive("git commit --dry-run").typed.size, 0);
  assert.equal(derive("git -C ../other commit -m x").typed.size, 0);
  assert.equal(derive("cd sub && git commit -m x").typed.size, 0, "after a cd the workspace probe would describe the wrong repository");
  assert.equal(derive("git status").typed.size, 0);
  // Windows: PowerShell and an exe spelling.
  assert.equal(valid(only("git.exe commit -m x", { context: ctx({ cwd: "C:\\w" }) })).verb, "commit");
  assert.equal(valid(only("git commit -m x", { tool: "PowerShell", context: ctx({ cwd: "C:\\w" }) })).verb, "commit");
});

test("the request digest covers the command actually sent, under the installation key", () => {
  const a = only("git commit -m one");
  const b = only("git commit -m two");
  assert.notEqual(a.request_digest, b.request_digest);
  assert.equal(a.request_digest, KEY.requestDigest({ action_type: "shell.exec", params: { command: "git commit -m one", cwd: "/work/project" } }));
  assert.equal(a.digest_key_generation, KEY.generation);
});

test("package operations: npm, pnpm, yarn, pip and uv, with unknown facts left unknown", () => {
  const npm = valid(only("npm install left-pad@1.3.0 lodash --ignore-scripts"));
  assert.equal(npm.manager, "npm");
  assert.equal(npm.verb, "install");
  assert.equal(npm.lifecycle_scripts, "blocked");
  assert.equal(npm.manager_version, "unknown");
  assert.deepEqual(npm.packages, [
    { name: "left-pad", integrity_status: "unknown", resolved_version: "1.3.0" },
    { name: "lodash", integrity_status: "unknown" },
  ]);
  const scoped = valid(only("pnpm add @types/node@^22 -D --registry https://registry.example.org/npm/"));
  assert.equal(scoped.manager, "pnpm");
  assert.equal(scoped.verb, "add");
  assert.equal(scoped.lifecycle_scripts, "unknown");
  assert.deepEqual(scoped.packages, [{ name: "@types/node", integrity_status: "unknown", registry_host: "registry.example.org" }], "a range is not a resolved version");
  assert.equal(valid(only("yarn upgrade react")).verb, "update");
  assert.equal(valid(only("npm update left-pad")).verb, "update");
  const pip = valid(only("pip install Requests[security]==2.31.0 --index-url https://pypi.example.org/simple"));
  assert.equal(pip.manager, "pip");
  assert.equal(pip.lifecycle_scripts, "not_supported");
  assert.deepEqual(pip.packages, [{ name: "requests", integrity_status: "unknown", resolved_version: "2.31.0", registry_host: "pypi.example.org" }]);
  assert.equal(valid(only("python3 -m pip install -U rich")).verb, "update");
  assert.equal(valid(only("uv add httpx")).verb, "add");
  assert.equal(valid(only("uv pip install httpx")).manager, "uv");
  // Non-registry sources are named as such, with credentials and queries dropped.
  const git = valid(only("npm i github:acme/tool https://user:tok@example.org/pkg.tgz?token=abc ./local-pkg"));
  assert.deepEqual(git.packages.map((p) => p.name), ["git:github.com/acme/tool", "url:example.org/pkg.tgz", "local:local-pkg"]);
  assert.ok(!JSON.stringify(git).includes("tok") && !JSON.stringify(git).includes("token=abc"));
});

test("package operations: a project's pinned manager version is used; an install with no named packages is not described", () => {
  const pinned = only("pnpm add zod", { context: ctx({ packageManagerVersion: (_cwd, manager) => (manager === "pnpm" ? "9.15.0" : undefined) }) });
  assert.equal(pinned.manager_version, "9.15.0");
  for (const command of ["npm ci", "npm install", "pnpm install", "yarn", "yarn install", "pip install -r requirements.txt", "pip install -e .", "uv sync", "uv pip install -r req.txt", "npm run build", "npx cowsay hi", "pnpm dlx create-app"]) {
    assert.equal(derive(command).typed.size, 0, command);
  }
});

test("package operations: Windows program spellings and PowerShell", () => {
  assert.equal(valid(only("npm.cmd install lodash", { context: ctx({ cwd: "C:\\w" }) })).manager, "npm");
  assert.equal(valid(only("C:\\Users\\dev\\AppData\\Roaming\\npm\\pnpm.CMD add zod", { tool: "PowerShell", context: ctx({ cwd: "C:\\w" }) })).manager, "pnpm");
  assert.equal(valid(only("npm install lodash", { tool: "PowerShell", context: ctx({ cwd: "C:\\w" }) })).packages[0].name, "lodash");
  assert.equal(valid(only("py -3 -m pip install flask==3.0.0", { context: ctx({ cwd: "C:\\w" }) })).packages[0].resolved_version, "3.0.0");
});

test("a compound command types each command that can be described and leaves the rest as shell actions", () => {
  const { dispatched, typed } = derive("git commit -m x && npm ci && pnpm add zod");
  assert.equal(dispatched.length, 3);
  assert.deepEqual([...typed.keys()], [0, 2]);
  assert.equal(typed.get(0).type, "git");
  assert.equal(typed.get(2).type, "package");
});

test("GitHub CLI: pr_create and release_create are typed from local state; pr_update and pr_merge need a platform read-back", () => {
  const create = valid(only("gh pr create --base develop --title x --body y"));
  assert.equal(create.verb, "pr_create");
  assert.equal(create.head_sha, HEAD);
  assert.equal(create.base_sha, MAIN);
  assert.equal(create.repository_id, KEY.resourceId("ghrepo", "github.com/acme/widgets"));
  assert.ok(!("pr_id" in create));
  assert.equal(valid(only("gh pr create -B develop -H feature/x")).head_sha, HEAD);
  assert.equal(only("gh pr create").base_sha, BASE, "no --base: the remote's default branch as the local clone sees it");
  const release = valid(only("gh release create v1.0.0 --notes done"));
  assert.equal(release.verb, "release_create");
  assert.equal(release.release_digest, TAG);
  assert.equal(release.required_check_policy_version, "unbound");
  assert.equal(only("gh release create v1.0.0", { context: ctx({ requiredCheckPolicyVersion: "rc-7" }) }).required_check_policy_version, "rc-7");
  // A release whose tag does not exist locally and names no target has no commit to bind.
  assert.equal(derive("gh release create v9.9.9").typed.size, 0);
  assert.equal(valid(only("gh release create v9.9.9 --target " + HEAD)).release_digest, HEAD);
  // Another repository than the workspace's cannot be described from local commits.
  assert.equal(derive("gh pr create --repo other/repo").typed.size, 0);
  assert.equal(derive("gh pr create --head fork-owner:feature").typed.size, 0);
  // A pull request named only by number has no head and base locally.
  for (const command of ["gh pr merge 12 --squash", "gh pr edit 12 --title y", "gh pr merge", "gh pr view 12", "gh api repos/acme/widgets/pulls/12/merge -X PUT"]) assert.equal(derive(command).typed.size, 0, command);
  const resolve = (repo, number) => (repo.repo.toLowerCase() === "widgets" && number === "12" ? { head_sha: HEAD, base_sha: BASE } : null);
  const merge = valid(only("gh pr merge 12 --squash --match-head-commit " + HEAD, { context: ctx({ resolvePullRequest: resolve }) }));
  assert.equal(merge.verb, "pr_merge");
  assert.equal(merge.pr_id, KEY.resourceId("pr", "github.com/acme/widgets#12"));
  assert.equal(merge.required_check_policy_version, "unbound");
  assert.equal(valid(only("gh pr edit https://github.com/Acme/Widgets/pull/12 --title z", { context: ctx({ resolvePullRequest: resolve }) })).verb, "pr_update");
  // The commit the caller expects to merge must be the one the platform reports.
  assert.equal(derive("gh pr merge 12 --match-head-commit " + "e".repeat(40), { context: ctx({ resolvePullRequest: resolve }) }).typed.size, 0);
  assert.ok(!JSON.stringify([create, release, merge]).match(/acme|widgets/i), "no raw repository name");
});

test("GitHub MCP tools: typed from the tool input the host sent; other servers keep the plain MCP operation", () => {
  const dispatchedFor = (name, input) => mapClaudeToolUse({ tool_name: name, tool_input: input, cwd: "/work/project" }).map((m) => ({ action: { action_type: m.intent.action_type, params: m.intent.params } }));
  const run = (server, tool, input, c = ctx()) => deriveTypedOperations({ mcp: { server, tool, input }, dispatched: dispatchedFor(`mcp__${server}__${tool}`, input), redact: redactCommand }, c);
  const create = run("github", "create_pull_request", { owner: "acme", repo: "widgets", head: "feature/x", base: "develop", title: "t", body: "b" });
  assert.equal(create.size, 1);
  const op = valid(create.get(0));
  assert.equal(op.verb, "pr_create");
  assert.equal(op.base_sha, MAIN);
  assert.equal(op.repository_id, KEY.resourceId("ghrepo", "github.com/acme/widgets"));
  assert.equal(run("github", "create_pull_request", { owner: "other", repo: "repo", head: "x", base: "y" }).size, 0, "not the workspace repository");
  assert.equal(run("github", "merge_pull_request", { owner: "acme", repo: "widgets", pullNumber: 12 }).size, 0, "no head/base without a read-back");
  const resolve = () => ({ head_sha: HEAD, base_sha: BASE });
  assert.equal(valid(run("github", "merge_pull_request", { owner: "acme", repo: "widgets", pullNumber: 12 }, ctx({ resolvePullRequest: resolve })).get(0)).verb, "pr_merge");
  assert.equal(run("gitlab", "create_pull_request", { owner: "acme", repo: "widgets", head: "x", base: "y" }).size, 0);
  assert.equal(run("github", "list_issues", { owner: "acme", repo: "widgets" }).size, 0);
});

test("against a real repository: HEAD, branch, protected ref and remote are read from git, with no network", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-typed-"));
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.org"); git("config", "user.name", "t"); git("config", "commit.gpgsign", "false");
  mkdirSync(join(dir, "src")); writeFileSync(join(dir, "src", "a.txt"), "x");
  git("add", "."); git("commit", "-q", "-m", "init");
  git("remote", "add", "origin", "https://ghp-user:pw@github.com/Acme/Widgets.git");
  const head = git("rev-parse", "HEAD");
  const context = { key: KEY, cwd: dir, repositoryId: "sbr_repo", referenceSetVersion: "hook-1" };
  const commit = valid(only('git commit -m "more"', { context }));
  assert.equal(commit.head_sha, head);
  assert.equal(commit.refs[0].protected, true, "main is protected by default");
  const push = valid(buildOperation({ action_type: "git.push", params: { ref: "main", remote: "origin" } }, { key: KEY, cwd: dir, repositoryId: "sbr_repo" }));
  assert.equal(push.head_sha, head);
  assert.equal(push.resolution, "resolved");
  assert.equal(push.remote_id, KEY.resourceId("remote", "github.com/acme/widgets"));
  // A pull request from a branch that exists locally, against a remote-tracking base.
  git("branch", "topic");
  git("update-ref", "refs/remotes/origin/main", head);
  git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  const pr = valid(only("gh pr create --head topic", { context }));
  assert.equal(pr.head_sha, head);
  assert.equal(pr.base_sha, head);
});

test("emitter: a typed operation replaces the plain shell one for the same receipt, and the outcome echoes it", async () => {
  const { makeHome, readPending } = await import("./observation-helpers.mjs");
  const { openObservations, createHookRuntime } = await import("../dist/index.js");
  const home = makeHome();
  const runtime = createHookRuntime({ policyPath: join(home.dir, "policy.json"), keyPath: join(home.dir, "agent.key"), attesterPath: join(home.dir, "attester.key"), dbPath: join(home.dir, "receipts.db") });
  try {
    const command = "git commit -m wip && pnpm add zod && ls";
    const decision = await runtime.evaluate(mapClaudeToolUse({ tool_name: "Bash", tool_input: { command }, cwd: home.dir }), { groupKey: "call-typed" });
    const { emitter } = openObservations(home.dir, { spawnHeartbeat: false });
    emitter.toolIntents({ harnessSessionId: "s", callId: "call-typed", cwd: home.dir, dispatched: decision.dispatched, request: { command }, probe: fakeProbe() });
    emitter.toolOutcomes("s", "call-typed", "ok");
    emitter.close();
    const rows = await readPending(home.dir);
    const intents = rows.filter((r) => r.payload.kind === "tool_intent");
    assert.deepEqual(intents.map((r) => r.payload.data.operation.type), ["git", "package", "shell"]);
    const receipts = decision.receipts.map((r) => r.payload.action_ref.action_id);
    assert.deepEqual(intents.map((r) => r.payload.parent_action_id), receipts, "each operation is linked to the receipt of the command it describes");
    for (const row of intents) assert.equal(validObservation(row.payload), true);
    const outcomes = rows.filter((r) => r.payload.kind === "tool_outcome");
    assert.deepEqual(outcomes.map((r) => r.payload.data.operation.request_digest), intents.map((r) => r.payload.data.operation.request_digest));
    assert.ok(!JSON.stringify(rows).includes("git commit") && !JSON.stringify(rows).includes("pnpm add"), "no command text is uploaded");
  } finally { runtime.close(); }
});

test("capability manifest: typed cells are observation-only, fixture-proven at most, and merge/deploy stay unsupported", async () => {
  const { computeManifest, runProofFixtures, VECTORS, cellState, TYPED_ACTION_TYPES } = await import("../dist/index.js");
  const configured = { claude: true, codex: true, cursor: true };
  const cells = computeManifest({ adapterVersion: "9.9.9", configured }).cells.filter((c) => TYPED_ACTION_TYPES.has(c.action_type));
  const hosts = new Set(cells.map((c) => c.host_variant));
  assert.deepEqual([...hosts].sort(), ["claude_desktop", "claude_terminal", "codex_cli", "codex_desktop", "cursor"]);
  for (const host of hosts) {
    const mine = cells.filter((c) => c.host_variant === host);
    assert.deepEqual(mine.map((c) => c.action_type).sort(), ["browser.action", "cloudflare.resource", "communication.send", "database.exec", "deploy.run", "git.commit", "github.pr_change", "github.resource", "network.request", "package.install", "visibility.change"]);
    for (const c of mine) {
      assert.equal(c.boundary, "none", "typed operations never gate anything");
      if (["deploy.run", "github.pr_change", "browser.action", "communication.send", "visibility.change"].includes(c.action_type)) {
        assert.equal(c.state, "unsupported");
        assert.equal(c.supported_operations.length, 0);
      } else {
        assert.equal(c.state, "configured_unverified");
        assert.equal(c.observation_only, true);
        assert.ok(c.test_vector_digest, "a supported typed cell has vectors");
        assert.ok(c.supported_operations.length > 0);
      }
    }
  }
  assert.equal(computeManifest({ adapterVersion: "9.9.9", configured: { claude: false, codex: false, cursor: false } }).cells.filter((c) => c.action_type === "git.commit").every((c) => c.state === "inactive"), true);
  // Every typed vector exists for POSIX and PowerShell (Claude) and for the other two harnesses.
  const typedVectors = VECTORS.filter((v) => v.typed);
  for (const cell of ["git.commit", "package.install", "github.resource"]) {
    const mine = typedVectors.filter((v) => v.cell.action_type === cell);
    for (const agent of ["claude", "codex", "cursor"]) assert.ok(mine.some((v) => v.agent === agent), `${cell} ${agent}`);
    assert.ok(mine.some((v) => v.dialect === "powershell") && mine.some((v) => v.dialect === "posix"), `${cell} both dialects`);
  }
  // The fixture run proves the derivation; it can never verify a cell.
  const proofs = await runProofFixtures("9.9.9");
  const after = computeManifest({ adapterVersion: "9.9.9", configured, proofs }).cells.filter((c) => TYPED_ACTION_TYPES.has(c.action_type) && c.state !== "unsupported");
  assert.ok(after.length > 0);
  for (const c of after) {
    assert.equal(c.last_proof?.typed_operation, true, c.key);
    assert.equal(c.last_proof?.origin, "fixture");
    assert.equal(c.state, "configured_unverified", c.key);
  }
  // A proof whose derivation failed degrades the cell.
  const failed = { ...after[0].last_proof, typed_operation: false };
  const degraded = cellState({ supported: true, configured: true, digest: after[0].test_vector_digest, adapterVersion: "9.9.9", proof: failed, observationOnly: true });
  assert.equal(degraded.state, "degraded");
  assert.match(degraded.reason, /typed operation/);
});

test("`observations id` prints the opaque ids the operations carry, without needing an enrollment", async () => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const { readFileSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "sb-id-"));
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const id = (...args) => {
    const r = spawnSync(process.execPath, [cli, "observations", "id", ...args], { encoding: "utf8", env: { ...process.env, SCOPEBOND_HOOK_DIR: dir, HOME: dir, USERPROFILE: dir }, cwd: dir, timeout: 30000 });
    return { status: r.status, out: r.stdout.trim() };
  };
  const a = id("remote", "git@github.com:Acme/Widgets.git");
  assert.equal(a.status, 0);
  const key = bindingKeyFromHex(readFileSync(join(dir, "observation-binding.key"), "utf8").trim());
  assert.equal(a.out, key.resourceId("remote", "github.com/acme/widgets"));
  assert.equal(id("remote", "https://user:pw@github.com/acme/widgets").out, a.out, "the same remote in another spelling");
  assert.equal(id("ref", "refs/heads/main").out, key.resourceId("ref", "main"));
  assert.equal(id("ghrepo", "Acme/Widgets").out, key.resourceId("ghrepo", "github.com/acme/widgets"));
  assert.equal(id("mcp", "github", "get_issue").out, key.resourceId("mcp", "github\0get_issue"));
  assert.equal(id("mcp-resource", "repository", "acme/widgets").out, key.resourceId("mcp:repository", "acme/widgets"));
  assert.equal(id("nonsense", "x").status, 1);
});

test("emitter: with approvals held in the workspace, a typed operation carries the hash the dispatch guard consumes with, and its resource id is the guard's target id", async () => {
  const { makeHome, readPending } = await import("./observation-helpers.mjs");
  const { openObservations, createHookRuntime } = await import("../dist/index.js");
  const { requestHash, dispatchIntentOf } = await import("@scopebond/gateway");
  const { targetIdFor } = await import("@scopebond/gateway/node");
  const { writeFileSync } = await import("node:fs");
  const run = async (settings) => {
    const home = makeHome();
    const runtime = createHookRuntime({ policyPath: join(home.dir, "policy.json"), keyPath: join(home.dir, "agent.key"), attesterPath: join(home.dir, "attester.key"), dbPath: join(home.dir, "receipts.db") });
    try {
      const command = "git commit -m wip && pnpm add zod";
      const decision = await runtime.evaluate(mapClaudeToolUse({ tool_name: "Bash", tool_input: { command }, cwd: home.dir }), { groupKey: "call-bind" });
      if (settings) writeFileSync(join(home.dir, "dispatch.json"), JSON.stringify(settings));
      const { emitter } = openObservations(home.dir, { spawnHeartbeat: false });
      emitter.toolIntents({ harnessSessionId: "s", callId: "call-bind", cwd: home.dir, dispatched: decision.dispatched, request: { command }, probe: fakeProbe() });
      emitter.close();
      const rows = (await readPending(home.dir)).filter((r) => r.payload.kind === "tool_intent");
      return { home, decision, ops: rows.map((r) => r.payload.data.operation), rows };
    } finally { runtime.close(); }
  };
  const { home, decision, ops, rows } = await run({ require_approval: ["shell.exec"] });
  assert.deepEqual(ops.map((o) => o.type), ["git", "package"]);
  const target = targetIdFor(home.dir);
  ops.forEach((op, i) => {
    const item = decision.dispatched[i].action;
    const d = dispatchIntentOf(item);
    assert.equal(op.approval_request_hash, requestHash(d.request), "the same hash the guard sends to consume");
    assert.match(op.approval_request_hash, /^[0-9a-f]{64}$/);
    assert.equal(op.resource_id, target(d.target), "resource_id equals the guard's target_id");
    assert.ok(!Object.hasOwn(d.request.params, "action_group"), "the group linkage is not part of what is hashed");
  });
  for (const row of rows) assert.equal(validObservation(row.payload), true, JSON.stringify(row.payload).slice(0, 1500));
  // Not required, workspace approvals switched off, or no dispatch settings: the operation is untouched.
  for (const settings of [{ require_approval: ["net.fetch"] }, { require_approval: ["shell.exec"], cloud: false }, null]) {
    const r = await run(settings);
    for (const op of r.ops) assert.equal(Object.hasOwn(op, "approval_request_hash"), false);
  }
});
