// On a Windows runner the check runs in the pull request's own checkout. A program started by a bare name ("git") is
// looked up in the current folder before PATH unless NoDefaultCurrentDirectoryInExePath is set, so a pull request that
// adds a git.exe must not have it run. The planted git.exe is a copy of Node that leaves a marker file when it starts
// (NODE_OPTIONS preloads the marker script; the real git ignores NODE_OPTIONS), and the guard variable is removed from
// the environment, as on a default Windows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const windows = process.platform === "win32";
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const policy = {
  vocabulary_version: "1.0", policy_id: "gh", version: 1,
  clauses: [{
    id: "no-prod", type: "action_allowlist", mode: "enforce", action_types: ["pr.merge"],
    param_bounds: { paths: { items: { pattern: "^(?!infra/prod/).*" }, match: "all" } },
  }],
};

test("Windows: the base policy is read with the real git, never a git.exe the pull request adds", { skip: !windows && "Windows-only program search" }, () => {
  const repo = mkdtempSync(join(tmpdir(), "sb-ghpr-hostile-"));
  const outside = mkdtempSync(join(tmpdir(), "sb-ghpr-hostile-run-"));
  try {
    const git = (...args) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
    git("init", "-q");
    writeFileSync(join(repo, "scopebond.policy.json"), JSON.stringify(policy));
    git("add", "."); git("commit", "-q", "-m", "base");
    const baseSha = git("rev-parse", "HEAD");
    copyFileSync(process.execPath, join(repo, "git.exe"));
    const preload = join(outside, "preload.cjs");
    writeFileSync(preload, [
      `const { basename, join } = require("node:path");`,
      `const name = basename(process.execPath).toLowerCase();`,
      `if (name !== ${JSON.stringify(basename(process.execPath).toLowerCase())}) require("node:fs").writeFileSync(join(${JSON.stringify(outside)}, name + ".ran"), "");`,
    ].join("\n"));
    const event = { repository: { full_name: "acme/app" }, pull_request: { base: { ref: "main", sha: baseSha }, head: { ref: "agent/x", sha: "abc123def456abc1" }, changed_files: 1, user: { login: "copilot-swe-agent[bot]" } } };
    writeFileSync(join(outside, "event.json"), JSON.stringify(event));
    writeFileSync(join(outside, "paths.txt"), "infra/prod/main.tf");
    const env = {};
    for (const [k, v] of Object.entries(process.env)) if (k.toLowerCase() !== "nodefaultcurrentdirectoryinexepath" && k.toUpperCase() !== "NODE_OPTIONS") env[k] = v;
    Object.assign(env, { NODE_OPTIONS: `--require ${JSON.stringify(preload)}`, GITHUB_EVENT_NAME: "pull_request", GITHUB_OUTPUT: "", GITHUB_EVENT_PATH: "", SCOPEBOND_POLICY_SOURCE: "" });
    const r = spawnSync(process.execPath, [cli, "--event", join(outside, "event.json"), "--paths-file", join(outside, "paths.txt")], { cwd: repo, env, encoding: "utf8" });
    assert.deepEqual(readdirSync(outside).filter((f) => f.endsWith(".ran")), [], "the planted git.exe did not run");
    assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /DENY/, "the base policy, read with the real git, denies the change");
  } finally {
    for (const d of [repo, outside]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* a planted copy still closing */ } }
  }
});
