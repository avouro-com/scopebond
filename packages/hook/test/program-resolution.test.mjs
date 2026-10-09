// On Windows a program started by a bare name ("git") is looked up in the current folder before PATH unless
// NoDefaultCurrentDirectoryInExePath is set, and Windows does not set it by default. The hook's current folder is the
// project the coding agent works in, and the hook holds this computer's signing keys and workspace credential, so a
// git.exe or icacls.exe committed to a repository must never be what the hook starts.
//
// Each planted program here is a copy of Node that leaves a marker file when it starts (NODE_OPTIONS preloads the marker
// script; the real git and icacls ignore NODE_OPTIONS). The guard variable is removed from the environment, as on a
// default Windows, so the test does not depend on the harness that runs it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, linkSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { scaffold } from "../dist/index.js";
import { ENFORCE } from "./enforce-all.mjs";

const windows = process.platform === "win32";
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

/** A git repository on `branch` with one commit, its root holding `planted` (copies of Node that mark when they start). */
function hostileRepo(branch, planted) {
  const repo = mkdtempSync(join(tmpdir(), "sb-hostile-repo-"));
  const git = (...args) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", ...args], { stdio: "ignore" });
  git("init", "-q", "-b", branch);
  git("commit", "-q", "--allow-empty", "-m", "init");
  const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const markers = mkdtempSync(join(tmpdir(), "sb-planted-ran-"));
  const preload = join(markers, "preload.cjs");
  writeFileSync(preload, [
    `const { basename, join } = require("node:path");`,
    `const name = basename(process.execPath).toLowerCase();`,
    `if (name !== ${JSON.stringify(basename(process.execPath).toLowerCase())}) require("node:fs").writeFileSync(join(${JSON.stringify(markers)}, name + ".ran"), "");`,
  ].join("\n"));
  const first = join(repo, planted[0]);
  copyFileSync(process.execPath, first);
  for (const name of planted.slice(1)) { try { linkSync(first, join(repo, name)); } catch { copyFileSync(process.execPath, join(repo, name)); } }
  const sandbox = mkdtempSync(join(tmpdir(), "sb-hostile-home-"));
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (k.toLowerCase() !== "nodefaultcurrentdirectoryinexepath" && k.toUpperCase() !== "NODE_OPTIONS") env[k] = v;
  Object.assign(env, {
    NODE_OPTIONS: `--require ${JSON.stringify(preload)}`,
    HOME: sandbox, USERPROFILE: sandbox, SCOPEBOND_HOME: sandbox, CLAUDE_CONFIG_DIR: sandbox, CODEX_HOME: sandbox,
    SCOPEBOND_OBSERVATIONS_HEARTBEAT: "off",
  });
  const ran = () => readdirSync(markers).filter((f) => f.endsWith(".ran")).map((f) => f.slice(0, -4));
  const cleanup = () => { for (const d of [repo, markers, sandbox]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* a planted copy still closing */ } } };
  return { repo, head, env, ran, sandbox, cleanup };
}

test("Windows: the hook's git probes and key-file protection never start a git.exe or icacls.exe planted in the project", { skip: !windows && "Windows-only program search" }, () => {
  const h = hostileRepo("main", ["git.exe", "icacls.exe"]);
  try {
    const child = join(h.sandbox, "probe.mjs");
    const url = (rel) => JSON.stringify(new URL(rel, import.meta.url).href);
    writeFileSync(child, `
      import { join } from "node:path";
      const hook = await import(${url("../dist/index.js")});
      const { gitHead } = await import(${url("../dist/obs-emitter.js")});
      const { loadOrCreateAttester } = await import(${JSON.stringify(import.meta.resolve("@scopebond/gateway/node"))});
      const repo = process.cwd();
      const local = join(repo, "local-settings.json");
      const out = {
        head: hook.systemGit.head(repo), branch: hook.systemGit.branch(repo), gitHead: gitHead(repo),
        share: hook.gitShareState(local), excluded: hook.excludeFromGit(local),
      };
      out.shareAfter = hook.gitShareState(local);
      try { loadOrCreateAttester({ file: join(${JSON.stringify(h.sandbox)}, "keys", "attester.key") }); out.key = "created"; } catch (e) { out.key = String(e); }
      process.stdout.write(JSON.stringify(out));
    `);
    const r = spawnSync(process.execPath, [child], { cwd: h.repo, env: h.env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(h.ran(), [], "no program planted in the project folder ran");
    assert.equal(out.head, h.head, "systemGit.head read HEAD with the real git");
    assert.equal(out.gitHead, h.head, "gitHead read HEAD with the real git");
    assert.equal(out.branch, "main", "systemGit.branch read the branch with the real git");
    assert.equal(out.excluded, true, "excludeFromGit used the real git");
    assert.equal(out.share, "untracked", "gitShareState used the real git");
    assert.equal(out.shareAfter, "ignored");
    assert.equal(out.key, "created");
  } finally { h.cleanup(); }
});

test("Windows: a bare `git push` from a project holding git.exe reads the branch with the real git", { skip: !windows && "Windows-only program search" }, () => {
  const h = hostileRepo("feature/work", ["git.exe"]);
  try {
    const dir = mkdtempSync(join(tmpdir(), "sb-hostile-config-"));
    scaffold(dir, ENFORCE);
    writeFileSync(join(dir, "policy.json"), JSON.stringify({
      vocabulary_version: "1.0", policy_id: "branch", version: 1,
      clauses: [{ id: "branch", type: "action_allowlist", mode: "enforce", action_types: ["git.push"], param_bounds: { ref: { pattern: "^(?!(?:main|master)$).+" } } }],
    }));
    const event = { tool_name: "Bash", tool_input: { command: "git push" }, cwd: h.repo };
    const r = spawnSync(process.execPath, [cli, "claude"], { cwd: h.repo, env: { ...h.env, SCOPEBOND_HOOK_DIR: dir }, input: JSON.stringify(event), encoding: "utf8" });
    assert.deepEqual(h.ran(), [], "the planted git.exe did not run");
    // The branch came from the real git, so the push of feature/work is in policy (an unreadable branch fails closed).
    assert.equal(r.status, 0, `the push of feature/work is allowed: ${r.stdout}${r.stderr}`);
    rmSync(dir, { recursive: true, force: true });
  } finally { h.cleanup(); }
});
