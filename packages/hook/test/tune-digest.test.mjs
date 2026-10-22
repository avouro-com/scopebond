// The block digest of a blocked record and the workspace's quiet list. The digest is computed on this computer from the signed
// record's own intent and the clause that denied it, exactly as the workspace computes it (fixtures/tune-digest-vectors.json is
// shared with the workspace's own tests). A block whose digest is on the quiet list stays blocked, but nobody is asked about it
// and the tray lists it without a notification; Scopebond's own protection is never quiet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonical } from "@scopebond/gateway";
import {
  tuneDigest, tuneDigestParts, tuneDigestOfReceipt, targetClassOf, canonicalProgram, canonicalHost, quietPatternsOf, quietByWorkspace,
  quietBlock, noteBlock, readBlockNotes, localActivity, digestGrants, digestRules, carriesGrants, HOOK_CAPABILITIES, MANAGED_DOC_FILE, MAX_QUIET_PATTERNS,
} from "../dist/index.js";

const vectors = JSON.parse(readFileSync(new URL("./fixtures/tune-digest-vectors.json", import.meta.url), "utf8"));
const hex = (seed) => seed.repeat(64).slice(0, 64);

test("every shared vector's digest is the one the workspace computes", () => {
  assert.ok(vectors.digest.length >= 20);
  for (const v of vectors.digest) assert.equal(tuneDigestOfReceipt(v.receipt), v.digest, v.name);
  for (const v of vectors.computer_none) assert.equal(tuneDigestOfReceipt(v.receipt), null, v.name);
});

test("the digest is sha256 of the six parts in their fixed order, and each part is read the documented way", () => {
  const parts = tuneDigestParts({ action_type: "shell.exec", params: { program: "C:\\Tools\\RM.EXE", path: "dist/app.js" } }, "destructive-shell");
  assert.deepEqual(parts, { action_type: "shell.exec", rule: "destructive-shell", program: "rm", target_class: "build_output", environment: null, host: null });
  const expected = createHash("sha256").update(JSON.stringify(["shell.exec", "destructive-shell", "rm", "build_output", null, null])).digest("hex");
  assert.equal(tuneDigest(parts), expected);
  assert.equal(canonicalProgram("/usr/bin/Git"), "git");
  assert.equal(canonicalProgram("tool.ps1"), "tool");
  assert.equal(canonicalProgram("$(which rm)"), undefined);
  assert.equal(canonicalHost("Example.COM.:8443"), "example.com");
  assert.equal(canonicalHost("example.com/path"), undefined);
  assert.equal(canonicalHost("example.com:http"), undefined);
  assert.equal(targetClassOf("src/index.ts"), "repository");
  assert.equal(targetClassOf(undefined, "inside"), "repository");
  assert.equal(targetClassOf(undefined), "unknown");
  assert.equal(targetClassOf("/var/tmp/x"), "temp");
  assert.equal(targetClassOf("/HOME/dev/.ssh/id_ed25519"), "home");
  assert.equal(targetClassOf("/opt/app/config"), "system");
  assert.equal(targetClassOf("x".repeat(5000)), "unknown");
  // A long input is classified in one pass, never by backtracking.
  const started = performance.now();
  targetClassOf(`${"a@".repeat(2000)}`);
  targetClassOf(`a${":".repeat(4000)}`);
  assert.ok(performance.now() - started < 200);
});

test("the quiet list keeps only digests, at most MAX_QUIET_PATTERNS of them", () => {
  assert.equal(quietPatternsOf(null).size, 0);
  assert.equal(quietPatternsOf({ quiet_patterns: "nope" }).size, 0);
  const listed = quietPatternsOf({ quiet_patterns: [hex("a1"), hex("A1"), "short", 7, null, hex("b2"), hex("a1")] });
  assert.deepEqual([...listed].sort(), [hex("a1"), hex("b2")]);
  const many = Array.from({ length: MAX_QUIET_PATTERNS + 10 }, (_, i) => createHash("sha256").update(String(i)).digest("hex"));
  assert.equal(quietPatternsOf({ quiet_patterns: many }).size, MAX_QUIET_PATTERNS);
});

test("a block is quiet only when its digest is listed, and never Scopebond's own protection", () => {
  const { A, D } = vectors.workspace.patterns;
  const quiet = new Set([tuneDigestOfReceipt(A), tuneDigestOfReceipt(D)]);
  assert.equal(quietByWorkspace(quiet, A.payload.intent, A.payload.clause_id), true);
  assert.equal(quietByWorkspace(new Set(), A.payload.intent, A.payload.clause_id), false, "no list, nothing quiet");
  assert.equal(quietByWorkspace(quiet, D.payload.intent, D.payload.clause_id), false, "always-on protection is never quiet, even when listed");
  assert.equal(quietByWorkspace(quiet, A.payload.intent, "some-pack-rule"), false, "a clause that carries no workspace rule");
  assert.equal(quietByWorkspace(quiet, A.payload.intent, null), false);
  assert.equal(quietByWorkspace(quiet, { params: A.payload.intent.params }, "safe-shell"), false, "no action type");
});

test("the quiet list is signed with the grants, and a document without one keeps the grants digest it had", () => {
  assert.ok(HOOK_CAPABILITIES.includes("quiet_patterns"));
  const before = createHash("sha256").update(canonical({ allowances: [], revoked_allowances: [], session_budgets: [], request_answers: [] })).digest("hex");
  assert.equal(digestGrants({ rules: {} }), before);
  const withList = { quiet_patterns: [hex("a1")] };
  assert.notEqual(digestGrants(withList), before);
  assert.equal(digestGrants(withList), createHash("sha256").update(canonical({ allowances: [], revoked_allowances: [], session_budgets: [], request_answers: [], quiet_patterns: [hex("a1")] })).digest("hex"));
  assert.notEqual(digestGrants({ quiet_patterns: [] }), before, "an emptied list is a change the computer takes");
  assert.equal(carriesGrants(withList), true);
  // The workspace signs the same digest (shared vectors).
  for (const g of vectors.grants) assert.equal(digestGrants(g.doc), g.digest, g.name);
});

test("a block note says the workspace keeps it quiet, and only for a rule's block", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-quiet-note-"));
  try {
    const receipt = (id) => ({ payload: { action_ref: { action_id: id } } });
    noteBlock(dir, { decision: "deny", clauseId: "safe-shell", receipt: receipt("act-1") }, { harness: "claude", project: "app", quiet: true });
    noteBlock(dir, { decision: "deny", clauseId: "safe-shell", receipt: receipt("act-2") }, { harness: "claude", project: "app" });
    noteBlock(dir, { decision: "deny", code: "session_budget", receipt: receipt("act-3") }, { harness: "claude", project: "app", quiet: true });
    const notes = new Map(readBlockNotes(dir).map((n) => [n.id, n]));
    assert.equal(notes.get("act-1").quiet, true);
    assert.equal(notes.get("act-2").quiet, undefined);
    assert.equal(notes.get("act-3").quiet, undefined, "a session budget's block is never quiet");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a blocked call whose digest the workspace lists is noted quiet and listed so; others are not", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-quiet-cli-"));
  const config = join(dir, "sb-config");
  const env = { ...process.env, SCOPEBOND_HOOK_DIR: config, HOME: dir, USERPROFILE: dir };
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  try {
    execFileSync(process.execPath, [cli, "init", "--no-install", "--yes"], { cwd: dir, encoding: "utf8", env });
    execFileSync(process.execPath, [cli, "rules", "enforce", "safe-shell", "--yes"], { cwd: dir, encoding: "utf8", env });
    const call = (command) => {
      try {
        execFileSync(process.execPath, [cli, "claude"], { cwd: dir, env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], input: JSON.stringify({ cwd: dir, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }) });
        return "allow";
      } catch { return "deny"; }
    };
    const rm = tuneDigest(tuneDigestParts({ action_type: "shell.exec", params: { program: "rm" } }, "destructive-shell"));
    // A workspace's rules document (destructive-shell on Block, as this computer's own rules have it) with its quiet list.
    const rules = { "force-push-protected": { mode: "block" }, "push-protected": { mode: "block" }, "destructive-shell": { mode: "block" }, "secret-read": { mode: "block" }, "ci-config-write": { mode: "block" }, "network-egress": { mode: "monitor" } };
    writeFileSync(join(config, MANAGED_DOC_FILE), JSON.stringify({ type: "scopebond:managed-rules", version: 1, revision: 2, export_id: "rev-2-gw-1", environment_id: "env-1", agent_id: "agent-1",
      installation_id: "gw-1", rules, rules_digest: digestRules(rules), quiet_patterns: [rm] }));
    assert.equal(call("rm -rf ../build"), "deny", "still blocked");
    assert.equal(call("dd if=/dev/zero of=/tmp/x"), "deny");
    const blocks = localActivity(config, { limit: 10 }).recent_blocks;
    assert.equal(blocks.find((b) => b.summary === "shell.exec rm")?.quiet, true);
    assert.equal(blocks.find((b) => b.summary === "shell.exec dd")?.quiet, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/** The median of a list of numbers. */
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

test("the synthetic workspace: questions and notifications per developer per day before and after the quiet list arrives", () => {
  const w = vectors.workspace;
  const dir = mkdtempSync(join(tmpdir(), "sb-quiet-measure-"));
  try {
    const count = () => {
      const perDay = new Map();
      for (let d = 0; d < w.developers; d++) for (let day = 1; day <= w.days; day++) perDay.set(`${d}|${day}`, 0);
      for (const [developer, day, kind, n] of w.stream) {
        // A block the workspace keeps quiet asks no one and shows no notification; every other block does one or the other.
        if (!quietBlock(dir, w.patterns[kind])) perDay.set(`${developer}|${day}`, perDay.get(`${developer}|${day}`) + n);
      }
      const values = [...perDay.values()];
      return { total: values.reduce((a, b) => a + b, 0), median: median(values) };
    };
    const before = count();
    writeFileSync(join(dir, MANAGED_DOC_FILE), JSON.stringify({ quiet_patterns: w.quiet_patterns }));
    const after = count();
    console.log(JSON.stringify({ synthetic_workspace: { developer_days: w.developers * w.days, before, after } }));
    assert.deepEqual(before, w.expect.before);
    assert.deepEqual(after, w.expect.after);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
