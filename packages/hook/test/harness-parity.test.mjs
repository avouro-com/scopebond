// The same action gets the same treatment in every coding agent. Runs the real dist/cli.js with each harness's payloads in
// isolated homes (HOME/USERPROFILE/APPDATA/LOCALAPPDATA/SCOPEBOND_HOME in temp dirs), no network.
//
// - Cursor is answered "allow" only for a clean evaluated allow. A violation a monitored rule records gets no opinion
//   ("ask"), so Cursor's own approval still decides, as Claude Code's and Codex's do when the hook stays silent.
// - A Cursor edit reported after it was written (afterFileEdit) that breaks a rule is signed as recorded after the fact
//   (execution state `observed_after`, executed true): it is never signed or counted as blocked.
// - The hook program answers "deny" (Claude Code: exit 2) when it fails before it can decide.
// - A Codex or Cursor hook entry that cannot start is kept as a delivery gap, which the rules check reports.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import * as hook from "../dist/index.js";
const { scaffold, localActivity, queueStatus } = hook;
const noteUnresolvableHooks = (...a) => hook.noteUnresolvableHooks(...a);
import { SqliteCloudOutbox } from "@scopebond/gateway/node";
import { ENFORCE } from "./enforce-all.mjs";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function isolatedEnv(root, extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(SCOPEBOND_|CLAUDE_)/.test(k)) delete env[k];
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  Object.assign(env, {
    HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"),
    SCOPEBOND_HOME: join(home, ".scopebond"), SCOPEBOND_HOOK_FLUSH_MS: "300", ...extra,
  });
  return { env, home };
}

function receipts(dir) {
  const db = join(dir, "receipts.db");
  if (!existsSync(db)) return [];
  const d = new DatabaseSync(db, { readOnly: true });
  try { return d.prepare("SELECT id, realtime_result, executed, receipt_json FROM receipts ORDER BY id").all(); } finally { d.close(); }
}

function run(env, harness, payload, cwd, rawInput, cliPath = cli) {
  const r = spawnSync(process.execPath, [cliPath, harness], { env, cwd, input: rawInput ?? JSON.stringify(payload), encoding: "utf8", timeout: 60_000 });
  return { status: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
}

function exercise(env, dir, harness, payload, cwd) {
  const before = receipts(dir).length;
  const out = run(env, harness, payload, cwd);
  const fresh = receipts(dir).slice(before).map((row) => {
    const p = JSON.parse(row.receipt_json).payload;
    return { action: p.intent?.action_type, result: row.realtime_result, executed: row.executed, state: p.execution?.state };
  });
  let decision = "(silent)";
  let message = "";
  if (out.stdout) {
    const j = JSON.parse(out.stdout.split("\n").pop());
    decision = j.permission ?? j.hookSpecificOutput?.permissionDecision ?? "(other)";
    message = j.agentMessage ?? j.hookSpecificOutput?.permissionDecisionReason ?? "";
  }
  return { exit: out.status, decision, message, receipts: fresh };
}

const claude = (tool_name, tool_input, cwd) => ({ hook_event_name: "PreToolUse", session_id: "s1", tool_use_id: "t-" + tool_name, tool_name, tool_input, cwd, permission_mode: "default" });
const codex = (tool_name, tool_input, cwd) => ({ hook_event_name: "PreToolUse", session_id: "c1", tool_use_id: "c-" + tool_name, tool_name, tool_input, cwd });
const cursorShell = (command, cwd, id) => ({ hook_event_name: "beforeShellExecution", conversation_id: "k1", generation_id: id, command, cwd });

function home(mode) {
  const root = mkdtempSync(join(tmpdir(), `sb-parity-${mode}-`));
  const { env, home } = isolatedEnv(root);
  const dir = join(home, ".scopebond");
  scaffold(dir, mode === "enforce" ? ENFORCE : {});
  const cwd = join(root, "proj");
  mkdirSync(join(cwd, "src"), { recursive: true });
  return { root, env, home, dir, cwd };
}

test("default (monitored) rules: Cursor gets no opinion for an out-of-policy action, like Claude Code and Codex", () => {
  const { env, dir, cwd } = home("default");
  const violations = [
    cursorShell("rm -rf src", cwd, "g1"),
    cursorShell("git push origin main", cwd, "g2"),
    cursorShell("cat .env", cwd, "g3"),
    { hook_event_name: "beforeReadFile", conversation_id: "k1", generation_id: "g4", file_path: join(cwd, ".env"), content: "", cwd },
  ];
  for (const payload of violations) {
    const r = exercise(env, dir, "cursor", payload, cwd);
    assert.notEqual(r.decision, "allow", `Cursor must not be told to allow a monitored violation: ${payload.command ?? payload.file_path}`);
    assert.equal(r.decision, "ask");
    assert.ok(r.receipts.some((x) => x.result === "deny"), "the violation is still recorded");
  }
  for (const [harness, payload] of [["claude", claude("Bash", { command: "rm -rf src" }, cwd)], ["codex", codex("Bash", { command: "rm -rf src" }, cwd)]]) {
    const r = exercise(env, dir, harness, payload, cwd);
    assert.equal(r.exit, 0);
    assert.equal(r.decision, "(silent)", `${harness} stays silent so its own approval decides`);
  }
});

test("default rules: a clean evaluated allow still answers allow for Cursor", () => {
  const { env, dir, cwd } = home("default");
  const r = exercise(env, dir, "cursor", cursorShell("ls", cwd, "g9"), cwd);
  assert.ok(r.receipts.length > 0 && r.receipts.every((x) => x.result === "allow"), JSON.stringify(r.receipts));
  assert.equal(r.decision, "allow");
});

test("blocking rules: a Cursor afterFileEdit violation is signed as recorded after the fact, never as denied", () => {
  const { env, dir, cwd } = home("enforce");
  const r = exercise(env, dir, "cursor", { hook_event_name: "afterFileEdit", conversation_id: "k1", generation_id: "g5", file_path: join(cwd, ".github/workflows/ci.yml"), edits: [], cwd }, cwd);
  const write = r.receipts.find((x) => x.action === "file.write");
  assert.ok(write, JSON.stringify(r.receipts));
  for (const x of r.receipts) assert.notEqual(x.state, "denied", "an edit already on disk was not prevented");
  assert.equal(write.result, "deny", "the violation is recorded");
  assert.equal(write.state, "observed_after");
  assert.equal(write.executed, 1, "the edit happened");
  assert.match(r.message, /not prevented/);

  // The same edit through Claude Code is really stopped.
  const claudeRun = exercise(env, dir, "claude", claude("Write", { file_path: join(cwd, ".github/workflows/ci.yml"), content: "x" }, cwd), cwd);
  assert.equal(claudeRun.exit, 2);
  const blocked = claudeRun.receipts.find((x) => x.action === "file.write");
  assert.equal(blocked.state, "denied");
  assert.equal(blocked.executed, 0);

  // `log` shows the difference, and `log --deny` (what got blocked) leaves the recorded edit out.
  const log = spawnSync(process.execPath, [cli, "log"], { env, cwd, encoding: "utf8", timeout: 60_000 });
  assert.match(log.stdout, /recorded, not prevented/);
  const denied = spawnSync(process.execPath, [cli, "log", "--deny"], { env, cwd, encoding: "utf8", timeout: 60_000 });
  assert.doesNotMatch(denied.stdout, /recorded, not prevented/);

  // Today's counts: one block (Claude Code), one recorded after the fact (Cursor).
  const activity = localActivity(dir);
  assert.equal(activity.today.blocked, 1);
  assert.equal(activity.today.recorded_after, 1);
  assert.equal(activity.recent_blocks.length, 1, "only the prevented write is listed as a block");
});

test("the hook answers deny when it fails before it can decide (Claude Code: exit 2)", () => {
  const { env, cwd } = home("default");
  // A copy of the entry point with nothing beside it: the commands cannot load.
  const lone = mkdtempSync(join(tmpdir(), "sb-parity-lone-"));
  const broken = join(lone, "cli.js");
  copyFileSync(cli, broken);
  writeFileSync(join(lone, "package.json"), JSON.stringify({ type: "module" }));
  const c = run(env, "claude", claude("Bash", { command: "ls" }, cwd), cwd, undefined, broken);
  assert.equal(c.status, 2, `Claude Code treats only exit 2 as a block: ${c.stderr}`);
  assert.match(c.stderr, /Scopebond/);
  const cur = run(env, "cursor", cursorShell("ls", cwd, "g10"), cwd, undefined, broken);
  assert.equal(JSON.parse(cur.stdout).permission, "deny");
  const cod = run(env, "codex", codex("Bash", { command: "ls" }, cwd), cwd, undefined, broken);
  assert.equal(JSON.parse(cod.stdout).hookSpecificOutput.permissionDecision, "deny");
});

test("a Codex or Cursor hook entry that cannot start is kept as a delivery gap, once per outage", () => {
  const { home: userHome, dir } = home("default");
  const missing = join(userHome, "gone", "cli.js");
  const command = `"${process.execPath}" "${missing}" codex`;
  mkdirSync(join(userHome, ".codex"), { recursive: true });
  const hooksFile = join(userHome, ".codex", "hooks.json");
  writeFileSync(hooksFile, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command }] }] } }));
  new SqliteCloudOutbox(join(dir, "receipts.db.cloud-outbox.db")).close();
  const files = { codex: hooksFile, cursor: join(userHome, ".cursor", "hooks.json") };

  const first = noteUnresolvableHooks(dir, ["codex", "cursor"], { files });
  assert.deepEqual(first.unresolvable, ["codex"]);
  assert.deepEqual(first.recorded, ["codex"]);
  assert.equal(queueStatus(dir).gapsByReason.hook_unresolvable, 1);
  // Still broken on the next check: the same outage, not a new gap.
  assert.deepEqual(noteUnresolvableHooks(dir, ["codex", "cursor"], { files }).recorded, []);
  assert.equal(queueStatus(dir).gapsByReason.hook_unresolvable, 1);
  // Repaired, then broken again: a new outage.
  mkdirSync(join(userHome, "gone"), { recursive: true });
  writeFileSync(missing, "");
  assert.deepEqual(noteUnresolvableHooks(dir, ["codex", "cursor"], { files }).unresolvable, []);
  writeFileSync(hooksFile, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: command.replace("gone", "gone-again") }] }] } }));
  assert.deepEqual(noteUnresolvableHooks(dir, ["codex", "cursor"], { files }).recorded, ["codex"]);
  assert.equal(queueStatus(dir).gapsByReason.hook_unresolvable, 2);
});
