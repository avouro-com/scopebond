// Repository enrolment: `init --repo` writes the committed hook files for runs where no person signs in (cloud coding
// agents, agent steps in CI), and a hook with SCOPEBOND_REPO_TOKEN and no connection enrols as the repository and delivers.
// Runs the real dist/cli.js with HOME/USERPROFILE/SCOPEBOND_HOME in temp dirs, against the in-process fake workspace.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  scaffold, isScopebondHookCommand, COPILOT_EVENTS, REPO_HARNESSES, repositoryToken, repositoryWorkspaceUrl,
  repositoryEnrollmentProof, RepositoryEnrollmentError, DEFAULT_WORKSPACE_URL,
} from "../dist/index.js";
import { refreshIfDue } from "../dist/credential-refresh.js";
import { hookVersion } from "../dist/version.js";
import { startFakeCloud } from "./fake-cloud.mjs";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const TOKEN = "sbr_fake_us_0123456789abcdefABCDEF";
const REVOKED = "sbr_fake_revoked_0123456789abcdef";

function isolated(extra = {}) {
  const root = mkdtempSync(join(tmpdir(), "sb-repo-"));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(SCOPEBOND_|CLAUDE_|COPILOT_|CODEX_)/.test(k)) delete env[k];
  Object.assign(env, {
    HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"),
    SCOPEBOND_HOME: join(home, ".scopebond"), SCOPEBOND_HOOK_FLUSH_MS: "3000", ...extra,
  });
  const project = join(root, "proj");
  mkdirSync(project, { recursive: true });
  return { root, home, env, project, scopebond: join(home, ".scopebond") };
}

function run(env, args, { cwd, input } = {}) {
  const r = spawnSync(process.execPath, [cli, ...args], { env, cwd, input, encoding: "utf8", timeout: 120_000 });
  return { status: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
}

/** The hook as a child process, so the fake workspace in this process can answer it. */
function runAsync(env, args, { cwd, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { env, cwd });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (status) => resolve({ status, stdout: stdout.trim(), stderr: stderr.trim() }));
    child.stdin.end(input ?? "");
  });
}

const claudeCall = (cwd, command = "ls") => JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s-repo", cwd, tool_name: "Bash", tool_input: { command }, tool_use_id: `t-${Math.random()}` });

const filesUnder = (dir) => existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String) : [];

test("init --repo writes the three committed hook files, keeps other settings, and is idempotent", () => {
  const ctx = isolated();
  mkdirSync(join(ctx.project, ".claude"), { recursive: true });
  const other = { permissions: { allow: ["Bash(ls)"] }, hooks: { PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "echo other" }] }] } };
  writeFileSync(join(ctx.project, ".claude", "settings.json"), JSON.stringify(other, null, 2));
  mkdirSync(join(ctx.project, ".github", "hooks"), { recursive: true });
  writeFileSync(join(ctx.project, ".github", "hooks", "scopebond.json"), JSON.stringify({ version: 1, hooks: { PreToolUse: [{ type: "command", bash: "echo team-check" }] } }));

  const first = run(ctx.env, ["init", "--repo", "--yes"], { cwd: ctx.project });
  assert.equal(first.status, 0, first.stderr);
  const files = REPO_HARNESSES.map((h) => join(ctx.project, ...(h === "claude" ? [".claude", "settings.json"] : h === "codex" ? [".codex", "hooks.json"] : [".github", "hooks", "scopebond.json"])));
  const snapshot = files.map((f) => readFileSync(f, "utf8"));

  const claude = JSON.parse(snapshot[0]);
  assert.deepEqual(claude.permissions, other.permissions, "unrelated settings are kept");
  assert.deepEqual(claude.hooks.PostToolUse, other.hooks.PostToolUse, "other hooks are kept");
  assert.equal(claude.hooks.PreToolUse.length, 1);
  assert.equal(claude.hooks.PreToolUse[0].hooks[0].command, `npx -y @scopebond/hook@${hookVersion()} claude`, "the pinned portable command");

  const codex = JSON.parse(snapshot[1]);
  assert.equal(codex.hooks.PreToolUse[0].hooks[0].command, `npx -y @scopebond/hook@${hookVersion()} codex`);

  const copilot = JSON.parse(snapshot[2]);
  assert.equal(copilot.version, 1);
  for (const event of COPILOT_EVENTS) {
    const ours = copilot.hooks[event].filter((e) => isScopebondHookCommand(e.bash ?? ""));
    assert.equal(ours.length, 1, `one Scopebond entry for ${event}`);
    // The cloud agent honours only bash/command entries.
    assert.equal(ours[0].type, "command");
    assert.equal(ours[0].bash, `npx -y @scopebond/hook@${hookVersion()} copilot`);
  }
  assert.ok(copilot.hooks.PreToolUse.some((e) => e.bash === "echo team-check"), "the team's own Copilot hook is kept");

  const again = run(ctx.env, ["init", "--repo", "--yes"], { cwd: ctx.project });
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(files.map((f) => readFileSync(f, "utf8")), snapshot, "a second run changes nothing");
  assert.match(again.stdout, /already configured in/);

  // Nothing machine-specific: no keys, no .scopebond folder here or in the home, no backup files to commit by mistake.
  assert.ok(!existsSync(join(ctx.project, ".scopebond")));
  assert.ok(!existsSync(ctx.scopebond));
  assert.deepEqual(filesUnder(ctx.project).filter((f) => f.endsWith(".scopebond-backup")), []);
  // It says where the token goes, and that the files are not a boundary on their own.
  assert.match(first.stdout, /SCOPEBOND_REPO_TOKEN/);
  assert.match(first.stdout, /not a boundary on their own/);
  assert.match(first.stdout, /not verified yet/);
});

test("init --repo --dry-run writes nothing; a file that is not JSON stops it before any file is written", () => {
  const ctx = isolated();
  const dry = run(ctx.env, ["init", "--repo", "--dry-run"], { cwd: ctx.project });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /Would configure/);
  assert.deepEqual(filesUnder(ctx.project), []);

  mkdirSync(join(ctx.project, ".codex"), { recursive: true });
  writeFileSync(join(ctx.project, ".codex", "hooks.json"), "{ not json");
  const bad = run(ctx.env, ["init", "--repo", "--yes"], { cwd: ctx.project });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /not valid JSON/);
  assert.ok(!existsSync(join(ctx.project, ".claude", "settings.json")), "no file written");
  assert.equal(readFileSync(join(ctx.project, ".codex", "hooks.json"), "utf8"), "{ not json");
});

test("init --repo without a terminal or --yes is refused", () => {
  const ctx = isolated();
  const r = run(ctx.env, ["init", "--repo"], { cwd: ctx.project });
  assert.equal(r.status, 1);
  assert.deepEqual(filesUnder(ctx.project), []);
});

test("with SCOPEBOND_REPO_TOKEN and no connection, the first call enrols the repository in the user home and delivers", async () => {
  const cloud = await startFakeCloud();
  try {
    const ctx = isolated({ SCOPEBOND_REPO_TOKEN: TOKEN, SCOPEBOND_URL: cloud.url });
    const first = await runAsync(ctx.env, ["claude"], { cwd: ctx.project, input: claudeCall(ctx.project) });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(cloud.state().repository_enrollments.length, 1);
    assert.equal(cloud.state().repository_enrollments[0].proofs_verified, true, "both keys proved possession");

    const connection = JSON.parse(readFileSync(join(ctx.scopebond, "cloud.json"), "utf8"));
    assert.equal(connection.source, "repository");
    assert.equal(connection.gateway_id, "gw-repo");
    assert.match(connection.credential, /^sbm_/);
    // The token is never kept or printed.
    for (const f of filesUnder(ctx.root)) {
      const full = join(ctx.root, f);
      try { assert.ok(!readFileSync(full, "latin1").includes(TOKEN), `token written to ${f}`); } catch (error) { if (error.code !== "EISDIR") throw error; }
    }
    assert.ok(!first.stdout.includes(TOKEN) && !first.stderr.includes(TOKEN));
    // The checkout stays clean: the hook set itself up in the sandbox's home.
    assert.ok(!existsSync(join(ctx.project, ".scopebond")));

    // A notable record (a force push the starter rules monitor) is sent with the repository's credential; routine ones go
    // as summaries later.
    const second = await runAsync(ctx.env, ["claude"], { cwd: ctx.project, input: claudeCall(ctx.project, "git push --force origin main") });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(cloud.state().repository_enrollments.length, 1, "the connection is reused");
    await runAsync(ctx.env, ["flush"], { cwd: ctx.project });
    assert.ok(cloud.state().ingested >= 1, "records were delivered as the repository");
    assert.ok(cloud.state().ingested_results.includes("deny"), "the monitored force push arrived");
  } finally { await cloud.close(); }
});

test("a GitHub Copilot call with the token enrols and is decided (no 'not set up' deny)", async () => {
  const cloud = await startFakeCloud();
  try {
    const ctx = isolated({ SCOPEBOND_REPO_TOKEN: TOKEN, SCOPEBOND_URL: cloud.url });
    const payload = JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s-cp", cwd: ctx.project, tool_name: "bash", tool_input: { command: "ls" } });
    const r = await runAsync(ctx.env, ["copilot"], { cwd: ctx.project, input: payload });
    assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);
    assert.equal(cloud.state().repository_enrollments.length, 1);
  } finally { await cloud.close(); }
});

test("a revoked token fails closed, saying why, without the token", async () => {
  const cloud = await startFakeCloud();
  try {
    const ctx = isolated({ SCOPEBOND_REPO_TOKEN: REVOKED, SCOPEBOND_URL: cloud.url });
    const r = await runAsync(ctx.env, ["claude"], { cwd: ctx.project, input: claudeCall(ctx.project) });
    assert.equal(r.status, 2);
    const reason = JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason;
    assert.match(reason, /refused this repository's token/);
    assert.match(reason, /SCOPEBOND_REPO_TOKEN/);
    assert.ok(!r.stdout.includes(REVOKED) && !r.stderr.includes(REVOKED));
    assert.ok(!existsSync(join(ctx.scopebond, "cloud.json")));
  } finally { await cloud.close(); }
});

test("a malformed token or workspace address fails closed before anything is sent", () => {
  const ctx = isolated({ SCOPEBOND_REPO_TOKEN: "not-a-token", SCOPEBOND_URL: "http://127.0.0.1:9" });
  const r = run(ctx.env, ["claude"], { cwd: ctx.project, input: claudeCall(ctx.project) });
  assert.equal(r.status, 2);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason, /is not a Scopebond repository token/);
  assert.ok(!r.stdout.includes("not-a-token"));

  assert.equal(repositoryToken({}), null);
  assert.throws(() => repositoryToken({ SCOPEBOND_REPO_TOKEN: ["sbm", "wrongkind", "0123456789abcdef"].join("_") }), RepositoryEnrollmentError);
  assert.equal(repositoryWorkspaceUrl({}), DEFAULT_WORKSPACE_URL);
  assert.equal(repositoryWorkspaceUrl({ SCOPEBOND_URL: "https://ws.example.com/app" }), "https://ws.example.com");
  assert.throws(() => repositoryWorkspaceUrl({ SCOPEBOND_URL: "http://ws.example.com" }), RepositoryEnrollmentError);
  assert.throws(() => repositoryWorkspaceUrl({ SCOPEBOND_URL: "https://user:pw@ws.example.com" }), RepositoryEnrollmentError);
});

test("a person's own connection wins over the repository token", async () => {
  const cloud = await startFakeCloud();
  try {
    const ctx = isolated({ SCOPEBOND_REPO_TOKEN: TOKEN, SCOPEBOND_URL: cloud.url });
    scaffold(ctx.scopebond);
    writeFileSync(join(ctx.scopebond, "cloud.json"), JSON.stringify({ url: cloud.url, credential: "sbm_person", credential_id: "c1", gateway_id: "gw-person", expires_at: new Date(Date.now() + 86_400_000 * 60).toISOString() }));
    const r = await runAsync(ctx.env, ["claude"], { cwd: ctx.project, input: claudeCall(ctx.project) });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(cloud.state().repository_enrollments.length, 0);
    assert.equal(JSON.parse(readFileSync(join(ctx.scopebond, "cloud.json"), "utf8")).gateway_id, "gw-person");
  } finally { await cloud.close(); }
});

test("an expired repository connection is enrolled again; a repository credential is never 'renewed'", async () => {
  const cloud = await startFakeCloud();
  try {
    const ctx = isolated({ SCOPEBOND_REPO_TOKEN: TOKEN, SCOPEBOND_URL: cloud.url });
    scaffold(ctx.scopebond);
    const stale = { url: cloud.url, credential: "sbm_old", credential_id: "c-old", gateway_id: "gw-repo", source: "repository", expires_at: new Date(Date.now() - 1000).toISOString() };
    writeFileSync(join(ctx.scopebond, "cloud.json"), JSON.stringify(stale));
    const r = await runAsync(ctx.env, ["claude"], { cwd: ctx.project, input: claudeCall(ctx.project) });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(cloud.state().repository_enrollments.length, 1);
    assert.notEqual(JSON.parse(readFileSync(join(ctx.scopebond, "cloud.json"), "utf8")).credential, "sbm_old");
    assert.equal(await refreshIfDue(ctx.scopebond, { ...stale, expires_at: new Date(Date.now() + 3_600_000).toISOString() }, { fetchImpl: () => { throw new Error("must not be called"); } }), "not_due");
  } finally { await cloud.close(); }
});

test("the enrolment proof binds the token digest, the time and both keys", () => {
  const a = repositoryEnrollmentProof({ token: TOKEN, issuedAt: "2026-10-13T00:00:00.000Z", publicKeyPem: "A\n", agentPublicKeyPem: "B" });
  assert.ok(!a.includes(TOKEN), "the proof carries the token's digest, not the token");
  assert.match(a, /"type":"scopebond:repository-enrollment"/);
  assert.notEqual(a, repositoryEnrollmentProof({ token: REVOKED, issuedAt: "2026-10-13T00:00:00.000Z", publicKeyPem: "A", agentPublicKeyPem: "B" }));
  assert.equal(a, repositoryEnrollmentProof({ token: TOKEN, issuedAt: "2026-10-13T00:00:00.000Z", publicKeyPem: "A", agentPublicKeyPem: "B" }), "keys are trimmed");
});
