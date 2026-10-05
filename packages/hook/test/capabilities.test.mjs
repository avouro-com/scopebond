// Capability manifest, safe proof fixtures and canonical action groups.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeManifest, cellState, cellKey, vectorsForCell, vectorDigest, runProofFixtures, saveProofs, loadProofs, renderManifest,
  mapClaudeToolUse, mapCodexToolUse, mapCursorEvent, createHookRuntime, scaffold, actionGroupId, withActionGroup, distinctTargets,
  VECTORS, mapVector, TYPED_ACTION_TYPES,
} from "../dist/index.js";
import { verifyReceipt } from "@scopebond/gateway";
import { loadOrCreateAttester } from "@scopebond/gateway/node";
import { ENFORCE } from "./enforce-all.mjs";

const temps = [];
after(() => { for (const dir of temps) { try { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* handle still open on Windows */ } } });
const temp = (prefix) => { const dir = mkdtempSync(join(tmpdir(), prefix)); temps.push(dir); return dir; };

const ALL = { claude: true, codex: true, cursor: true };
const NONE = { claude: false, codex: false, cursor: false };
const VERSION = "9.9.9";

test("the manifest has separate cells for Claude terminal/desktop, Codex CLI/desktop and Cursor", () => {
  const { cells } = computeManifest({ adapterVersion: VERSION, configured: ALL });
  for (const host of ["claude_terminal", "claude_desktop", "codex_cli", "codex_desktop", "cursor"]) {
    assert.ok(cells.some((c) => c.host_variant === host), `${host} has cells`);
  }
  const keys = cells.map((c) => c.key);
  assert.equal(new Set(keys).size, keys.length, "cell keys are unique (connector + version + host + action + phase)");
  assert.ok(keys.includes(cellKey(VERSION, "codex_desktop", "shell.exec", "pre_action")));
  for (const c of cells) {
    assert.equal(c.connector, "scopebond-hook");
    assert.equal(c.adapter_version, VERSION);
    assert.ok(Array.isArray(c.emitted_required_fields) && Array.isArray(c.supported_operations));
    assert.deepEqual(c.min_runtime, { node: ">=22.13" });
  }
});

test("unsupported cells stay unsupported however they are configured or proven", () => {
  const configured = computeManifest({ adapterVersion: VERSION, configured: ALL });
  const find = (host, action, phase = "pre_action") => configured.cells.find((c) => c.host_variant === host && c.action_type === action && c.event_phase === phase);
  assert.equal(find("cursor", "file.write").state, "unsupported", "Cursor has no before-edit hook");
  assert.equal(find("codex_cli", "file.read").state, "unsupported", "Codex has no native read event");
  assert.equal(find("codex_cli", "net.fetch").state, "unsupported");
  // Even a passing, live, acknowledged record cannot upgrade an unsupported cell.
  const state = cellState({ supported: false, unsupportedReason: "x", configured: true, digest: "sha256:a", adapterVersion: VERSION, observationOnly: false,
    proof: { adapter_version: VERSION, test_vector_digest: "sha256:a", origin: "live_harness", safe_allow: true, safe_deny: true, signature: true, grouping: true, cloud_ack: "acknowledged", observation_only: false } });
  assert.equal(state.state, "unsupported");
});

test("nested tool orchestration that escapes interception stays unsupported in every host", () => {
  const { cells } = computeManifest({ adapterVersion: VERSION, configured: ALL });
  const nested = cells.filter((c) => c.action_type === "nested_orchestration");
  assert.equal(nested.length, 5, "one per host variant");
  assert.ok(nested.every((c) => c.state === "unsupported" && !c.pre_action && c.boundary === "none"));
  // The mapper shows why: a sub-agent tool is one unevaluated action; what runs inside it
  // is never shown to the hook, so no shell.exec or file.write appears to be checked.
  const claude = mapClaudeToolUse({ tool_name: "Task", tool_input: { prompt: "run rm -rf / then push to main" }, cwd: "/w" });
  assert.equal(claude.length, 1);
  assert.equal(claude[0].evaluated, false);
  assert.equal(claude[0].intent.action_type, "tool.task");
  const codex = mapCodexToolUse({ tool_name: "spawn_agent", tool_input: { task: "rm -rf /" }, cwd: "/w" });
  assert.equal(codex.length, 1);
  assert.equal(codex[0].evaluated, false);
  // An MCP tool that shells out internally is one mcp.tool.call, not a shell.exec.
  const mcp = mapClaudeToolUse({ tool_name: "mcp__runner__exec", tool_input: { command: "rm -rf /" } });
  assert.deepEqual(mcp.map((m) => m.intent.action_type), ["mcp.tool.call"]);
  const cursor = mapCursorEvent("beforeSubagentStart", { cwd: "/w" });
  assert.equal(cursor[0].evaluated, false);
});

test("an unconfigured harness is inactive, not unverified", () => {
  const { cells } = computeManifest({ adapterVersion: VERSION, configured: NONE });
  assert.ok(cells.filter((c) => c.state !== "unsupported").every((c) => c.state === "inactive"));
});

const passing = (origin, ack, extra = {}) => ({
  adapter_version: VERSION, test_vector_digest: "sha256:d", origin, safe_allow: true, safe_deny: true, signature: true, grouping: true,
  cloud_ack: ack, observation_only: false, ...extra,
});
const base = { supported: true, configured: true, digest: "sha256:d", adapterVersion: VERSION, observationOnly: false };

test("only a current, live-harness, Cloud-acknowledged proof makes a cell verified", () => {
  assert.equal(cellState({ ...base, proof: null }).state, "configured_unverified");
  assert.equal(cellState({ ...base, proof: passing("fixture", "not_checked") }).state, "configured_unverified", "a local fixture is never verified");
  assert.equal(cellState({ ...base, proof: passing("fixture", "acknowledged") }).state, "configured_unverified", "an acknowledgement does not turn a fixture into a host proof");
  assert.equal(cellState({ ...base, proof: passing("live_harness", "not_checked") }).state, "configured_unverified");
  assert.equal(cellState({ ...base, proof: passing("live_harness", "failed") }).state, "configured_unverified");
  assert.equal(cellState({ ...base, proof: passing("live_harness", "acknowledged") }).state, "verified_reporting");
});

test("a stale, failed or missing-vector proof is not trusted", () => {
  assert.equal(cellState({ ...base, proof: passing("live_harness", "acknowledged", { test_vector_digest: "sha256:old" }) }).state, "configured_unverified", "vector set changed");
  assert.equal(cellState({ ...base, proof: passing("live_harness", "acknowledged", { adapter_version: "0.0.1" }) }).state, "configured_unverified", "adapter changed");
  for (const broken of [{ safe_allow: false }, { safe_deny: false }, { signature: false }, { grouping: false }]) {
    assert.equal(cellState({ ...base, proof: passing("live_harness", "acknowledged", broken) }).state, "degraded", JSON.stringify(broken));
  }
  assert.equal(cellState({ ...base, digest: null, proof: passing("live_harness", "acknowledged") }).state, "configured_unverified", "no vectors, nothing to prove");
  assert.equal(cellState({ ...base, retired: true, proof: null }).state, "retired");
});

test("observation-only cells need a known successful fixture and never a deny fixture", () => {
  const obs = { ...base, observationOnly: true };
  assert.equal(cellState({ ...obs, proof: passing("live_harness", "acknowledged", { safe_deny: "not_applicable", observation_only: true }) }).state, "verified_reporting");
  assert.equal(cellState({ ...obs, proof: passing("live_harness", "acknowledged", { safe_deny: true, observation_only: true }) }).state, "degraded", "a claimed deny on an observation cell is not accepted");
  const { cells } = computeManifest({ adapterVersion: VERSION, configured: ALL });
  const afterEdit = cells.find((c) => c.host_variant === "cursor" && c.action_type === "file.write" && c.event_phase === "after_action");
  assert.ok(afterEdit.observation_only && afterEdit.after_action && !afterEdit.pre_action && afterEdit.boundary === "none");
});

test("every supported cell has vectors, and a vector change changes the digest", () => {
  const { cells } = computeManifest({ adapterVersion: VERSION, configured: ALL });
  for (const c of cells.filter((x) => x.state !== "unsupported")) assert.ok(c.test_vector_digest?.startsWith("sha256:"), `${c.key} has vectors`);
  const vs = vectorsForCell("claude", "shell.exec", "pre_action");
  assert.ok(vs.some((v) => v.cell.role === "allow") && vs.some((v) => v.cell.role === "deny"));
  const changed = vs.map((v, i) => (i === 0 ? { ...v, expect: v.expect === "allow" ? "deny" : "allow" } : v));
  assert.notEqual(vectorDigest(vs), vectorDigest(changed));
  assert.equal(vectorDigest([]), null);
});

test("proof fixtures pass for every supported cell, run only in temp state and never claim verified", async () => {
  // Point every home-ish location at an empty directory and confirm nothing lands there.
  const fakeHome = temp("sb-fakehome-");
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, SCOPEBOND_HOOK_DIR: process.env.SCOPEBOND_HOOK_DIR };
  process.env.HOME = fakeHome; process.env.USERPROFILE = fakeHome; delete process.env.SCOPEBOND_HOOK_DIR;
  const cwdBefore = readdirSync(process.cwd());
  let proofs;
  try { proofs = await runProofFixtures(VERSION); }
  finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  assert.deepEqual(readdirSync(fakeHome), [], "no home directory was written");
  assert.deepEqual(readdirSync(process.cwd()), cwdBefore, "nothing was written to the working directory");

  const manifest = computeManifest({ adapterVersion: VERSION, configured: ALL, proofs });
  const supported = manifest.cells.filter((c) => c.state !== "unsupported");
  assert.ok(supported.length >= 20);
  for (const cell of supported) {
    const proof = proofs[cell.key];
    assert.ok(proof, `${cell.key} was proven`);
    assert.equal(proof.origin, "fixture");
    assert.equal(proof.cloud_ack, "not_checked", "a local run cannot claim a Cloud acknowledgement");
    assert.equal(proof.safe_allow, true, `${cell.key} safe allow`);
    assert.equal(proof.signature, true, `${cell.key} receipts verify`);
    assert.equal(proof.grouping, true, `${cell.key} one group per call`);
    assert.equal(proof.safe_deny, cell.observation_only ? "not_applicable" : true, `${cell.key} safe deny`);
    assert.equal(proof.observation_only, cell.observation_only);
    assert.equal(cell.state, "configured_unverified", `${cell.key} is not verified by a fixture`);
  }
  assert.ok(!manifest.cells.some((c) => c.state === "verified_reporting" || c.state === "degraded"));
  assert.ok(manifest.cells.filter((c) => c.observation_only).length >= 4);
  assert.ok(renderManifest(manifest).includes("unsupported"), "the text form says unsupported plainly");
});

test("recorded proofs round-trip and are only trusted for the same adapter and vectors", () => {
  const dir = temp("sb-proofs-");
  assert.deepEqual(loadProofs(dir), {});
  const key = cellKey(VERSION, "cursor", "shell.exec", "pre_action");
  const vs = vectorsForCell("cursor", "shell.exec", "pre_action");
  const proof = { cell: key, ran_at: new Date().toISOString(), adapter_version: VERSION, test_vector_digest: vectorDigest(vs), origin: "fixture", safe_allow: true, safe_deny: true, signature: true, grouping: true, cloud_ack: "not_checked", observation_only: false };
  saveProofs(dir, { [key]: proof });
  const loaded = loadProofs(dir);
  assert.deepEqual(loaded[key], proof);
  const current = computeManifest({ adapterVersion: VERSION, configured: ALL, proofs: loaded }).cells.find((c) => c.key === key);
  assert.equal(current.last_proof.origin, "fixture");
  assert.match(current.reason, /fixture passed/);
  const newer = computeManifest({ adapterVersion: "10.0.0", configured: ALL, proofs: loaded }).cells.find((c) => c.host_variant === "cursor" && c.action_type === "shell.exec");
  assert.equal(newer.last_proof, null, "a proof for another adapter version is not attached");
});

test("the capabilities command prints an honest manifest and exits zero", () => {
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const dir = temp("sb-cli-caps-");
  const run = (...args) => spawnSync(process.execPath, [cli, "capabilities", ...args], { encoding: "utf8", env: { ...process.env, SCOPEBOND_HOOK_DIR: dir, HOME: dir, USERPROFILE: dir }, timeout: 120000 });
  const text = run();
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /nested_orchestration\s+before action unsupported/);
  assert.doesNotMatch(text.stdout, /verified_reporting\s/);
  const json = JSON.parse(run("--json").stdout);
  assert.ok(json.cells.length > 20 && json.cells.every((c) => c.state !== "verified_reporting"));
  assert.ok(json.cells.filter((c) => c.host_variant === "cursor").every((c) => c.state === "unsupported" || c.state === "inactive"), "an unconfigured Cursor is inactive");
  const proved = run("--prove");
  assert.equal(proved.status, 0, proved.stderr);
  assert.match(proved.stdout, /Fixture run passed/);
  assert.ok(!existsSync(join(dir, "capability-proof.json")), "--prove alone records nothing");
});

// Canonical action groups -------------------------------------------------------------

function runtimeIn(dir) {
  scaffold(dir, ENFORCE);
  return createHookRuntime({ policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"), attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db") });
}
const params = (receipt) => receipt.payload.intent.params;

test("every receipt of one tool call shares one authenticated parent action group", async () => {
  const dir = temp("sb-group-");
  const rt = runtimeIn(dir);
  const { attester } = loadOrCreateAttester({ file: join(dir, "attester.key") });
  try {
    // One call, several intents: the command, a read and a write it performs.
    const mapped = mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "cp src/a.ts src/b.ts" }, cwd: "/w" });
    assert.ok(mapped.length >= 3, "a decomposed call");
    const decision = await rt.evaluate(mapped, { groupKey: "toolu_01" });
    assert.equal(decision.decision, "allow");
    const groups = new Set(decision.receipts.map((r) => params(r).action_group));
    assert.equal(groups.size, 1);
    const [group] = [...groups];
    assert.equal(group, actionGroupId("toolu_01"), "stable from the harness call id");
    assert.deepEqual(decision.receipts.map((r) => params(r).action_group_seq), mapped.map((_, i) => i));
    assert.ok(decision.receipts.every((r) => params(r).action_group_size === mapped.length));
    // The group is inside the signed intent: the receipt verifies, and altering it does not.
    for (const r of decision.receipts) assert.equal(verifyReceipt(r, attester.publicKeyPem).valid, true);
    const forged = structuredClone(decision.receipts[0]);
    forged.payload.intent.params.action_group = "sbg_forged";
    assert.equal(verifyReceipt(forged, attester.publicKeyPem).valid, false, "the group is authenticated by the signature");
    // A different call never shares the group, with or without a harness id.
    const other = await rt.evaluate(mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "ls" }, cwd: "/w" }), { groupKey: "toolu_02" });
    assert.notEqual(params(other.receipts[0]).action_group, group);
    const a = await rt.evaluate(mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "ls" }, cwd: "/w" }));
    const b = await rt.evaluate(mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "ls" }, cwd: "/w" }));
    assert.notEqual(params(a.receipts[0]).action_group, params(b.receipts[0]).action_group, "no key, no shared group");
    assert.match(params(a.receipts[0]).action_group, /^sbg_[0-9a-f]{32}$/);
  } finally { rt.close(); }
});

test("a denied call's receipts share the group too, and the group is only additive params", async () => {
  const dir = temp("sb-group-deny-");
  const rt = runtimeIn(dir);
  try {
    const mapped = mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "ls && git push origin main" }, cwd: "/w" });
    const decision = await rt.evaluate(mapped, { groupKey: "toolu_03" });
    assert.equal(decision.decision, "deny");
    const denied = decision.receipts.at(-1);
    assert.equal(params(denied).action_group, actionGroupId("toolu_03"));
    // Receipt top-level keys are unchanged: the group lives in intent.params only.
    assert.deepEqual(Object.keys(denied).sort(), Object.keys(decision.receipts[0]).sort());
    assert.ok(!("action_group" in denied.payload), "no new top-level payload key");
    assert.ok(!("action_group" in denied.payload.intent), "no new intent key");
  } finally { rt.close(); }
});

test("distinct physical targets are counted once per group", () => {
  const mapped = withActionGroup(mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "cp a.ts b.ts && cat a.ts" }, cwd: "/w" }), "sbg_x");
  const targets = distinctTargets(mapped);
  assert.equal(new Set(targets).size, targets.length);
  assert.ok(targets.includes("file:a.ts") && targets.includes("file:b.ts"));
  assert.equal(targets.filter((t) => t === "file:a.ts").length, 1, "read and write of a.ts are one target");
});

test("vector table and manifest agree on which agents each action type is proven for", () => {
  for (const v of VECTORS.filter((x) => x.cell)) {
    const mapped = mapVector(v);
    // Typed-operation cells are proven on the command the mapper already evaluates as shell or push.
    const types = TYPED_ACTION_TYPES.has(v.cell.action_type) ? ["shell.exec", "git.push", "net.fetch"] : [v.cell.action_type];
    assert.ok(mapped.some((m) => types.includes(m.intent.action_type)), `${v.id} maps to ${v.cell.action_type}`);
  }
});
