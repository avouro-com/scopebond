import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const policy = {
  vocabulary_version: "1.0", policy_id: "gh", version: 1,
  clauses: [{
    id: "no-prod", type: "action_allowlist", mode: "enforce", action_types: ["pr.merge"],
    param_bounds: { paths: { items: { pattern: "^(?!infra/prod/).*" }, match: "all" } },
  }],
};

function run(over, paths) {
  const dir = mkdtempSync(join(tmpdir(), "sb-ghpr-"));
  const event = {
    repository: { full_name: "acme/app" },
    pull_request: { base: { ref: "main" }, head: { ref: "agent/x", sha: "abc123def456abc1" }, changed_files: paths.length, additions: 1, deletions: 0, user: { login: "copilot-swe-agent[bot]" } },
    ...over,
  };
  writeFileSync(join(dir, "event.json"), JSON.stringify(event));
  writeFileSync(join(dir, "policy.json"), JSON.stringify(policy));
  writeFileSync(join(dir, "paths.txt"), paths.join("\n"));
  try {
    const stdout = execFileSync(process.execPath, [cli, "--event", join(dir, "event.json"), "--policy", join(dir, "policy.json"), "--paths-file", join(dir, "paths.txt"), "--policy-source", "workspace"], {
      encoding: "utf8", env: { ...process.env, GITHUB_EVENT_NAME: "pull_request", GITHUB_OUTPUT: "", GITHUB_EVENT_PATH: "" },
    });
    return { status: 0, stdout };
  } catch (e) { return { status: e.status, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "") }; }
}

test("the check passes (exit 0) for an in-policy agent PR", () => {
  const r = run({}, ["src/app.ts", "docs/x.md"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /ALLOW/);
});

test("the check fails (exit 1) for a PR touching a production path", () => {
  const r = run({}, ["infra/prod/main.tf"]);
  assert.equal(r.status, 1, "a deny blocks the required check");
  assert.match(r.stdout, /DENY/);
});

test("the check fails closed when the file list is truncated (fewer paths than changed_files)", () => {
  // The pull-request files API stops at 3000 files; an out-of-policy path can hide past it.
  const listed = Array.from({ length: 3000 }, (_, i) => `src/f${i}.ts`);
  const r = run({
    pull_request: { base: { ref: "main" }, head: { ref: "agent/x", sha: "abc123def456abc1" }, changed_files: 3001, additions: 1, deletions: 0, user: { login: "copilot-swe-agent[bot]" } },
  }, listed);
  assert.equal(r.status, 1, "a truncated list must not pass the check");
  assert.match(r.stderr, /truncated/);
});

test("exports the boundary receipt to a workspace when configured (best-effort)", async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const http = await import("node:http");
  const run = promisify(execFile);
  const keyPem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const ingested = [];
  let auth = null;
  const server = http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => { body += c; });
    req.on("end", () => {
      if (req.url === "/v1/ingest") { auth = req.headers.authorization ?? null; for (const r of (JSON.parse(body).receipts ?? [])) ingested.push(r); res.writeHead(200); res.end('{"ok":true}'); }
      else { res.writeHead(404); res.end("{}"); }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const dir = mkdtempSync(join(tmpdir(), "sb-ghpr-cloud-"));
    const event = { repository: { full_name: "acme/app" }, pull_request: { base: { ref: "main" }, head: { ref: "agent/x", sha: "abc123def456abc1" }, changed_files: 1, additions: 1, deletions: 0, user: { login: "copilot-swe-agent[bot]" } } };
    writeFileSync(join(dir, "event.json"), JSON.stringify(event));
    writeFileSync(join(dir, "policy.json"), JSON.stringify(policy));
    writeFileSync(join(dir, "paths.txt"), "src/app.ts");
    const { stdout } = await run(process.execPath, [cli, "--event", join(dir, "event.json"), "--policy", join(dir, "policy.json"), "--paths-file", join(dir, "paths.txt"), "--policy-source", "workspace"], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_EVENT_NAME: "pull_request", GITHUB_OUTPUT: "", GITHUB_EVENT_PATH: "", SCOPEBOND_ATTESTER_KEY: keyPem, SCOPEBOND_CLOUD_URL: url, SCOPEBOND_CLOUD_CREDENTIAL: "sbm_test_credential" },
    });
    assert.match(stdout, /ALLOW/);
    assert.match(stdout, /exported to/);
    assert.equal(ingested.length, 1, "the boundary receipt was exported");
    assert.equal(ingested[0].payload.evidence_class, "boundary");
    assert.equal(auth, "Bearer sbm_test_credential");
  } finally {
    server.close();
  }
});

// Base-branch policy: build a real repository whose base commit carries a strict
// policy, then an agent head that rewrites the policy to allow everything.
function gitRepoWithRewrittenPolicy() {
  const repo = mkdtempSync(join(tmpdir(), "sb-ghpr-git-"));
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q");
  git("config", "user.email", "t@example.test"); git("config", "user.name", "t"); git("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "scopebond.policy.json"), JSON.stringify(policy));
  git("add", "."); git("commit", "-q", "-m", "base");
  const baseSha = git("rev-parse", "HEAD");
  const permissive = { ...policy, clauses: [{ id: "anything", type: "action_allowlist", mode: "enforce", action_types: ["pr.merge"] }] };
  writeFileSync(join(repo, "scopebond.policy.json"), JSON.stringify(permissive));
  git("commit", "-q", "-am", "agent loosens the policy");
  return { repo, baseSha };
}

function runIn(repo, event, paths, extraArgs = []) {
  writeFileSync(join(repo, "..", `${repo.split(/[\\/]/).pop()}-event.json`), JSON.stringify(event));
  const eventFile = join(repo, "..", `${repo.split(/[\\/]/).pop()}-event.json`);
  const pathsFile = join(repo, "..", `${repo.split(/[\\/]/).pop()}-paths.txt`);
  writeFileSync(pathsFile, paths.join("\n"));
  try {
    const stdout = execFileSync(process.execPath, [cli, "--event", eventFile, "--paths-file", pathsFile, ...extraArgs], {
      cwd: repo, encoding: "utf8", env: { ...process.env, GITHUB_EVENT_NAME: "pull_request", GITHUB_OUTPUT: "", GITHUB_EVENT_PATH: "", SCOPEBOND_POLICY_SOURCE: "" },
    });
    return { status: 0, stdout };
  } catch (e) { return { status: e.status, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "") }; }
}

test("the policy is read from the base commit, so a PR cannot loosen the policy it is checked against", () => {
  const { repo, baseSha } = gitRepoWithRewrittenPolicy();
  const event = { repository: { full_name: "acme/app" }, pull_request: { base: { ref: "main", sha: baseSha }, head: { ref: "agent/x", sha: "abc123def456abc1" }, changed_files: 2, user: { login: "copilot-swe-agent[bot]" } } };
  const r = runIn(repo, event, ["infra/prod/main.tf", "scopebond.policy.json"]);
  assert.equal(r.status, 1, "the base policy (no infra/prod) still applies");
  assert.match(r.stdout, /DENY/);
  // The same PR evaluated against the head's copy would pass — which is exactly the hole.
  const head = runIn(repo, event, ["infra/prod/main.tf", "scopebond.policy.json"], ["--policy-source", "workspace"]);
  assert.equal(head.status, 0);
});

test("without a base sha, or when the base has no policy, the check fails closed", () => {
  const { repo } = gitRepoWithRewrittenPolicy();
  const noSha = { repository: { full_name: "acme/app" }, pull_request: { base: { ref: "main" }, head: { ref: "x", sha: "s" }, changed_files: 1, user: { login: "copilot-swe-agent[bot]" } } };
  const r1 = runIn(repo, noSha, ["src/a.ts"]);
  assert.equal(r1.status, 1);
  assert.match(r1.stderr, /base\.sha/);
  const missing = { ...noSha, pull_request: { ...noSha.pull_request, base: { ref: "main", sha: "0123456789abcdef0123456789abcdef01234567" } } };
  const r2 = runIn(repo, missing, ["src/a.ts"]);
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /base/);
});

test("the check fails closed when the diff step yields no paths for a changed PR", () => {
  const r = run({}, []); // changed_files is 0 here (paths.length), so craft a mismatch:
  // rebuild with changed_files > 0 but empty paths
  const dir = mkdtempSync(join(tmpdir(), "sb-ghpr-"));
  const event = { repository: { full_name: "acme/app" }, pull_request: { base: { ref: "main" }, head: { ref: "x", sha: "s" }, changed_files: 3, user: { login: "copilot-swe-agent[bot]" } } };
  writeFileSync(join(dir, "event.json"), JSON.stringify(event));
  writeFileSync(join(dir, "policy.json"), JSON.stringify(policy));
  writeFileSync(join(dir, "paths.txt"), "");
  try {
    execFileSync(process.execPath, [cli, "--event", join(dir, "event.json"), "--policy", join(dir, "policy.json"), "--paths-file", join(dir, "paths.txt"), "--policy-source", "workspace"], { encoding: "utf8", env: { ...process.env, GITHUB_EVENT_NAME: "pull_request", GITHUB_OUTPUT: "", GITHUB_EVENT_PATH: "" } });
    assert.fail("expected a non-zero exit");
  } catch (e) { assert.equal(e.status, 1); }
});
