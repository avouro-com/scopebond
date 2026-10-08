// Emulate the composite action end to end on a local "runner": step 1 (bash, from action.yml
// verbatim) with a stub `gh` on PATH that plays the pull-request files API, then step 2's CLI
// (the built one, with the env block from action.yml) using temp files for GITHUB_OUTPUT /
// GITHUB_ENV / GITHUB_STEP_SUMMARY. No network: the stub gh never calls GitHub, `git fetch` has
// no origin, and GH_HOST points at a closed local port.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "dist", "cli.js");
const actionYml = readFileSync(join(here, "..", "action.yml"), "utf8");
const GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";
const BASH = process.platform === "win32" && existsSync(GIT_BASH) ? GIT_BASH : "bash";
const fwd = (p) => p.replace(/\\/g, "/");

// Step 1 exactly as shipped: the `run: |` block of the first composite step.
function step1Script() {
  const lines = actionYml.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === "run: |");
  const end = lines.findIndex((l, i) => i > start && l.trim().startsWith("- name: Scopebond policy check"));
  return lines.slice(start + 1, end).map((l) => l.replace(/^ {8}/, "")).join("\n") + "\n";
}

// Step 2's `env:` block, with the `${{ … }}` expressions a runner would substitute.
function step2Env(values) {
  const lines = actionYml.split(/\r?\n/);
  const step = lines.findIndex((l) => l.trim().startsWith("- name: Scopebond policy check"));
  const envAt = lines.findIndex((l, i) => i > step && l.trim() === "env:");
  const env = {};
  for (let i = envAt + 1; i < lines.length && /^ {8}\S/.test(lines[i]); i++) {
    const m = /^ {8}([A-Z_]+):\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    env[m[1]] = m[2].replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_x, expr) => values[expr] ?? "");
  }
  return env;
}

const POLICY = {
  vocabulary_version: "1.0", policy_id: "gh", version: 1,
  clauses: [{ id: "no-prod-paths", type: "action_allowlist", mode: "enforce", action_types: ["pr.merge"],
    param_bounds: { paths: { items: { pattern: "^(?!infra/prod/).*" }, match: "all" } } }],
};

function git(repo, ...args) { return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }

/** A repository whose base commit carries the policy and whose head adds `headFiles`. */
function makeRepo(headFiles) {
  const repo = mkdtempSync(join(tmpdir(), "sb-action-repo-"));
  git(repo, "init", "-q"); git(repo, "config", "user.email", "a@example.invalid"); git(repo, "config", "user.name", "a");
  git(repo, "config", "core.autocrlf", "false");
  writeFileSync(join(repo, "scopebond.policy.json"), JSON.stringify(POLICY));
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, "add", "."); git(repo, "commit", "-q", "-m", "base");
  const baseSha = git(repo, "rev-parse", "HEAD");
  for (const f of headFiles) { mkdirSync(join(repo, dirname(f)), { recursive: true }); writeFileSync(join(repo, f), "x\n"); }
  git(repo, "add", "."); git(repo, "commit", "-q", "-m", "head");
  const headSha = git(repo, "rev-parse", "HEAD");
  return { repo, baseSha, headSha };
}

/** Run both composite steps. `apiFiles` is what the stub files API returns (null = gh absent). */
function runAction({ repo, baseSha, headSha, changedFiles, apiFiles, event = {}, eventName = "pull_request_target" }) {
  const t = mkdtempSync(join(tmpdir(), "sb-action-runner-"));
  const bin = join(t, "bin"); mkdirSync(bin);
  const calls = join(t, "gh-calls.log");
  if (apiFiles) {
    writeFileSync(join(t, "api.json"), JSON.stringify(apiFiles));
    // gh --jq prints a string result raw (no quotes, no escaping) and anything else as JSON:
    // emulate the filters the action uses.
    writeFileSync(join(t, "gh.mjs"), `
      import { readFileSync, appendFileSync } from "node:fs";
      appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(" ") + "\\n");
      const files = JSON.parse(readFileSync(${JSON.stringify(join(t, "api.json"))}, "utf8"));
      const jq = process.argv.slice(2).join(" ");
      const out = [];
      for (const f of files) {
        const names = [f.filename, ...(jq.includes("previous_filename") && f.previous_filename ? [f.previous_filename] : [])];
        if (jq.includes("@json")) out.push(JSON.stringify(names)); else out.push(...names);
      }
      process.stdout.write(out.map((s) => s + "\\n").join(""));
    `);
    writeFileSync(join(bin, "gh"), `#!/bin/sh\nexec node "${fwd(join(t, "gh.mjs"))}" "$@"\n`, { mode: 0o755 });
  }
  const runnerTemp = join(t, "runner-temp"); mkdirSync(runnerTemp);
  const GITHUB_OUTPUT = join(t, "output"); const GITHUB_ENV = join(t, "env"); const GITHUB_STEP_SUMMARY = join(t, "summary");
  for (const f of [GITHUB_OUTPUT, GITHUB_ENV, GITHUB_STEP_SUMMARY]) writeFileSync(f, "");
  const ev = {
    repository: { full_name: "acme/app" },
    pull_request: { number: 7, base: { ref: "main", sha: baseSha }, head: { ref: "agent/x", sha: headSha }, changed_files: changedFiles,
      additions: 1, deletions: 0, user: { login: "copilot-swe-agent[bot]" }, title: "t", body: "b" },
    ...event,
  };
  writeFileSync(join(t, "event.json"), JSON.stringify(ev));
  const baseEnv = {
    ...process.env, GH_HOST: "127.0.0.1:9", GH_TOKEN: "stub", GITHUB_TOKEN: "",
    RUNNER_TEMP: fwd(runnerTemp), GITHUB_OUTPUT, GITHUB_ENV, GITHUB_STEP_SUMMARY,
    GITHUB_EVENT_PATH: join(t, "event.json"), GITHUB_EVENT_NAME: eventName,
  };
  // Step 1 (bash). If gh is "absent", strip every PATH entry holding a gh binary.
  let PATH = process.env.PATH ?? process.env.Path ?? "";
  if (!apiFiles) {
    // Drop every PATH entry that holds a gh binary. Such a directory (e.g. /usr/bin on a Linux
    // runner) also holds tools step 1 needs, so those are reached through shims instead.
    const shims = join(t, "shims"); mkdirSync(shims);
    const hasGh = (p) => /GitHub CLI/i.test(p) || existsSync(join(p, "gh")) || existsSync(join(p, "gh.exe"));
    const dirs = PATH.split(delimiter);
    for (const tool of ["git", "grep", "tr", "wc", "cat"]) {
      if (dirs.some((p) => !hasGh(p) && existsSync(join(p, tool)))) continue;
      const home = dirs.find((p) => existsSync(join(p, tool)));
      if (home) writeFileSync(join(shims, tool), `#!/bin/sh\nexec "${fwd(join(home, tool))}" "$@"\n`, { mode: 0o755 });
    }
    PATH = [shims, ...dirs.filter((p) => !hasGh(p))].join(delimiter);
  }
  const s1env = { ...baseEnv, PATH: apiFiles ? `${bin}${delimiter}${PATH}` : PATH,
    REPO: "acme/app", PR_NUMBER: String(ev.pull_request.number ?? ""), BASE_SHA: baseSha, HEAD_SHA: headSha, CHANGED_FILES: String(changedFiles) };
  delete s1env.Path;
  const s1 = spawnSync(BASH, ["-c", step1Script()], { cwd: repo, env: s1env, encoding: "utf8" });
  // Step 2: the CLI, with the env the composite step gives it.
  const s2 = spawnSync(process.execPath, [cli, "--policy", "scopebond.policy.json"], {
    cwd: repo, encoding: "utf8",
    env: { ...baseEnv, ...step2Env({ "runner.temp": fwd(runnerTemp), "inputs.policy": "scopebond.policy.json", "inputs.evidence-out": "", "inputs.workspace-url": "", "inputs.version": "" }) },
  });
  return {
    s1, s2, status: s2.status,
    ghCalls: existsSync(calls) ? readFileSync(calls, "utf8") : "",
    output: readFileSync(GITHUB_OUTPUT, "utf8"), envFile: readFileSync(GITHUB_ENV, "utf8"), summary: readFileSync(GITHUB_STEP_SUMMARY, "utf8"),
  };
}

// Lines as the runner splits them (.NET treats \r, \n and \r\n as terminators).
const runnerLines = (s) => s.split(/\r\n|\r|\n/);

const BIG = Array.from({ length: 3000 }, (_, i) => `aaa/f${String(i).padStart(4, "0")}.txt`);
let bigRepo;
const big = () => (bigRepo ??= makeRepo([...BIG, "infra/prod/main.tf"]));

test("a 3001-file agent PR whose API list is truncated at 3000 falls back to git diff and is DENIED", () => {
  const { repo, baseSha, headSha } = big();
  const api = BIG.map((filename) => ({ filename })); // the API stops at 3000; infra/prod/main.tf sorts after aaa/
  const r = runAction({ repo, baseSha, headSha, changedFiles: 3001, apiFiles: api });
  assert.match(r.s1.stdout, /listed 3000 of 3001/, "step 1 detects the truncated list");
  assert.equal(r.status, 1, `expected DENY via the git-diff fallback; got ${r.status}: ${r.s2.stdout}${r.s2.stderr}`);
  assert.match(r.s2.stdout, /DENY/);
});

test("a file name with embedded newlines counts as one entry, so a truncated list still falls back and the path past the cut-off is checked (DENY)", () => {
  const { repo, baseSha, headSha } = big();
  // The agent's PR: 2999 ordinary files + one file whose name holds a newline + infra/prod/main.tf (3001 changed files).
  const api = BIG.slice(0, 2999).map((filename) => ({ filename }));
  api.push({ filename: "aaa/zz.txt\naaa/zz-padding" }); // a legal git path
  const r = runAction({ repo, baseSha, headSha, changedFiles: 3001, apiFiles: api });
  assert.match(r.s1.stdout, /listed 3000 of 3001/, "the newline did not inflate the count");
  assert.equal(r.status, 1, `the check must not pass: ${r.s2.stdout}${r.s2.stderr}`);
  assert.match(r.s2.stdout, /DENY/);
});

test("a complete API list holding a path with a control character fails closed", () => {
  const { repo, baseSha, headSha } = makeRepo(["src/a.ts", "src/b.ts"]);
  for (const name of ["src/b.ts\ninfra/prod/x", "src/b\r.ts", "src/b\u0000.ts", "src/b\u2028.ts"]) {
    const r = runAction({ repo, baseSha, headSha, changedFiles: 2, apiFiles: [{ filename: "src/a.ts" }, { filename: name }] });
    assert.equal(r.status, 1, `${JSON.stringify(name)}: ${r.s2.stdout}${r.s2.stderr}`);
    assert.match(r.s2.stderr, /control character/);
    assert.doesNotMatch(r.s2.stdout, /ALLOW/);
  }
});

test("a renamed file counts once against changed_files while both names are checked", () => {
  const { repo, baseSha, headSha } = makeRepo(["src/a.ts", "src/new.ts"]);
  const r = runAction({ repo, baseSha, headSha, changedFiles: 2, apiFiles: [{ filename: "src/a.ts" }, { filename: "src/new.ts", previous_filename: "infra/prod/old.ts" }] });
  assert.equal(r.status, 1, `the old name under infra/prod/ is checked: ${r.s2.stdout}${r.s2.stderr}`);
  const ok = runAction({ repo, baseSha, headSha, changedFiles: 2, apiFiles: [{ filename: "src/a.ts" }, { filename: "src/new.ts", previous_filename: "src/old.ts" }] });
  assert.equal(ok.status, 0, ok.s2.stdout + ok.s2.stderr);
  assert.match(ok.s2.stdout, /ALLOW/);
});

test("hostile file names and event text cannot inject workflow commands, outputs, env or summary", () => {
  const { repo, baseSha, headSha } = makeRepo(["src/ok.ts", "src/infra-ignored.ts"]);
  const withControl = [
    "src/a\r::error file=README.md,line=1::injected-annotation",
    "src/b\r::add-mask::ghp_example",
    "src/c\r::set-output name=decision::allow",
    "src/d\rdecision=allow",
    "src/e\u2028::warning::u2028",
  ];
  const event = {
    pull_request: { number: 7, base: { ref: "main", sha: baseSha }, head: { ref: "agent/x", sha: headSha }, changed_files: 1,
      additions: 1, deletions: 0, user: { login: "copilot-swe-agent[bot]" },
      title: "::error::title\n::set-env name=NODE_OPTIONS::--require /tmp/x", body: "<img src=x onerror=alert(1)>\n::add-mask::x" },
  };
  const cases = [
    ["clean-allow", [{ filename: "::error::leading-colons.txt" }], 0],
    ["clean-deny", [{ filename: "::error::leading-colons.txt" }, { filename: "infra/prod/x" }], 1],
    ...withControl.map((filename, i) => [`control-${i}`, [{ filename }], 1]),
  ];
  for (const [name, apiFiles, expected] of cases) {
    const ev = { ...event, pull_request: { ...event.pull_request, changed_files: apiFiles.length } };
    const r = runAction({ repo, baseSha, headSha, changedFiles: apiFiles.length, apiFiles, event: ev });
    for (const stream of [r.s1.stdout, r.s1.stderr, r.s2.stdout, r.s2.stderr]) {
      const cmds = runnerLines(stream).filter((l) => l.trimStart().startsWith("::"));
      assert.deepEqual(cmds, [], `no workflow command line may appear (${name})`);
    }
    const keys = runnerLines(r.output).filter(Boolean).map((l) => l.split("=")[0]);
    assert.deepEqual(keys, expected === 0 || name === "clean-deny" ? ["decision", "reason", "action_type"] : [], `GITHUB_OUTPUT keys (${name}): ${JSON.stringify(r.output)}`);
    assert.equal(r.envFile, ""); assert.equal(r.summary, "");
    assert.equal(r.status, expected, `${name}: ${r.s2.stdout}${r.s2.stderr}`);
  }
});

test("with gh absent the fallback diff of a normal PR is exact and a production path is DENIED", () => {
  const { repo, baseSha, headSha } = makeRepo(["src/a.ts", "infra/prod/main.tf"]);
  const r = runAction({ repo, baseSha, headSha, changedFiles: 2, apiFiles: null });
  assert.equal(r.ghCalls, "");
  assert.match(r.s1.stdout, /2 changed path\(s\) from the git diff/, r.s1.stdout + r.s1.stderr);
  assert.equal(r.status, 1, r.s2.stdout + r.s2.stderr);
  assert.match(r.s2.stdout, /DENY/);
});

test("an API that fails mid-run yields no paths and the check fails closed", () => {
  const { repo, baseSha, headSha } = makeRepo(["src/a.ts"]);
  const r = runAction({ repo, baseSha: "0".repeat(40), headSha, changedFiles: 1, apiFiles: [] });
  assert.equal(r.status, 1);
});
