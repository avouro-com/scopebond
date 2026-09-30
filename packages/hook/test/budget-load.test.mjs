// `scopebond budget load`: an action budget exported from the workspace is verified, written as an
// acknowledged budget policy, and acknowledged back through the observation outbox.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonical } from "@scopebond/policy-schema/canonical";
import { budgetAcknowledged } from "@scopebond/gateway";
import { createHookRuntime, mapClaudeToolUse, inspectBudgetExport } from "../dist/index.js";
import { validObservation } from "./observation-schema.mjs";
import { makeHome, startServer } from "./observation-helpers.mjs";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const FAR = 4102444800000; // 2100-01-01

function run(dir, args) {
  return new Promise((resolve) => {
    const home = mkdtempSync(join(tmpdir(), "sb-budget-home-"));
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: dir, env: { ...process.env, SCOPEBOND_HOOK_DIR: dir, SCOPEBOND_HOME: home, HOME: home, USERPROFILE: home, SCOPEBOND_OBSERVATIONS_HEARTBEAT: "off" },
    });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; }); child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end();
  });
}

// The export exactly as the workspace makes it. The two digests below are the workspace's own values
// for these literal inputs, not computed here.
const GOLDEN = {
  policy: { actor: "agent-1", operation_set: ["file.write", "shell.exec"], authority_scope: "installation", max_dispatch: 5, window_seconds: 60, mode: "enforce", version: 2, acknowledged: { by: "user-9", at: "2026-09-30T10:00:00.000Z" } },
  policy_digest: "d0d5d4a4652979dc5c2d39ec205e0af50d681ae914704be3a55aa96056bd35d0",
  scope_digest: "d0862fc64082b2764adfd8927eee364c0fea4121178338b9238f0054cf72a03e",
};
const FAIL_CLOSED = {
  unlimited_dispatch_on_failure: false, expired_or_unacknowledged_policy: "keep_enforcing_the_last_acknowledged_limit_else_deny_new_dispatch",
  authoritative_counter_unavailable: "deny_new_dispatch", clock_rollback_detected: "deny_new_dispatch", window_clock: "monotonic_elapsed_seconds", counters_persist_across_restart: true,
  counted_unit: "one proven parent action per permitted dispatch", no_inferred_spend: true,
};

function goldenExport(over = {}) {
  return {
    type: "scopebond:action-budget-export", version: 1, export_id: "exp-1", budget_id: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", budget_version: 2, agent_id: "agent-1", environment_id: "env-1",
    created_at: 1_790_000_000_000, valid_until: FAR, policy: GOLDEN.policy, policy_digest: GOLDEN.policy_digest, scope_digest: GOLDEN.scope_digest,
    acknowledgement: { status: "pending", required: "a signed policy_ack.loaded observation", note: "pending" },
    enforcement: { eligible: true, reason: "acknowledged_installation_scope_enforce_budget", authority_scope: "installation", shared_gateway: { registered: false }, fail_closed: FAIL_CLOSED, enforced_by_cloud: false },
    ...over,
  };
}

/** An export whose digests are recomputed for a changed policy or ids, by the workspace's formulas. */
function remade({ policy = {}, exportId = "exp-1", agentId = "agent-1", environmentId = "env-1", top = {} } = {}) {
  const p = { ...GOLDEN.policy, ...policy };
  return goldenExport({
    export_id: exportId, agent_id: agentId, environment_id: environmentId, policy: p, budget_version: p.version,
    policy_digest: sha256(canonical({ ...p, acknowledged: null })),
    scope_digest: sha256("scopebond:policy-scope/v1\n" + canonical({ agent_id: agentId, environment_id: environmentId, export_id: exportId })),
    ...top,
  });
}

const writeExport = (dir, exp) => { const file = join(dir, "..", `budget-${Math.random().toString(16).slice(2)}.json`); writeFileSync(file, JSON.stringify(exp)); return file; };
const settings = (dir) => JSON.parse(readFileSync(join(dir, "dispatch.json"), "utf8"));
const acks = (server) => server.observations().filter((i) => i.payload.kind === "policy_ack");

test("the workspace's own digests for these literal inputs verify", () => {
  const ok = inspectBudgetExport(goldenExport(), { environmentId: "env-1", now: 1_790_000_000_000 });
  assert.equal(ok.ok, true, ok.message);
  assert.equal(ok.facts.policyDigest, GOLDEN.policy_digest);
});

test("budget load checks, writes an acknowledged budget only with --yes, and acknowledges the exact export", async () => {
  const server = await startServer();
  const home = makeHome({ url: server.url });
  const file = writeExport(home.dir, goldenExport());

  const dry = await run(home.dir, ["budget", "load", file]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /checks out/);
  assert.throws(() => readFileSync(join(home.dir, "dispatch.json"), "utf8"), "without --yes nothing is written");
  assert.equal(acks(server).length, 0, "and nothing is acknowledged");

  const loaded = await run(home.dir, ["budget", "load", file, "--yes"]);
  assert.equal(loaded.status, 0, loaded.stderr);
  const [b] = settings(home.dir).budgets;
  assert.equal(b.budget_id, "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d");
  assert.equal(b.actor, home.agent.kid);
  assert.deepEqual(b.operations, ["file.write", "shell.exec"]);
  assert.equal(b.max, 5);
  assert.equal(b.window_seconds, 60);
  assert.equal(b.mode, "enforce");
  assert.equal(b.version, 2);
  assert.equal(b.expires_at, new Date(FAR).toISOString());
  assert.equal(budgetAcknowledged(b), true, "written with an acknowledgement of its exact digest");

  const sent = acks(server);
  assert.equal(sent.length, 1);
  assert.equal(validObservation(sent[0].payload), true);
  const d = sent[0].payload.data;
  assert.deepEqual(
    { event: d.event, export_id: d.export_id, policy_id: d.policy_id, policy_version: d.policy_version, policy_digest: d.policy_digest, scope_digest: d.scope_digest, load_result: d.load_result },
    { event: "loaded", export_id: "exp-1", policy_id: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", policy_version: 2, policy_digest: GOLDEN.policy_digest, scope_digest: GOLDEN.scope_digest, load_result: "loaded" },
  );
  await server.close();
});

test("a loaded enforce budget is enforced by the hook: the sixth action in the window is refused before it runs", async () => {
  const server = await startServer();
  const home = makeHome({ url: server.url });
  const file = writeExport(home.dir, goldenExport());
  assert.equal((await run(home.dir, ["budget", "load", file, "--yes"])).status, 0);
  const outcomes = [];
  for (let i = 0; i < 6; i++) {
    const rt = createHookRuntime({ policyPath: join(home.dir, "policy.json"), keyPath: join(home.dir, "agent.key"), attesterPath: join(home.dir, "attester.key"), dbPath: join(home.dir, "receipts.db") });
    outcomes.push(await rt.evaluate(mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "git status" } }), { groupKey: `call-${i}` }));
    rt.close();
  }
  assert.deepEqual(outcomes.map((o) => o.decision), ["allow", "allow", "allow", "allow", "allow", "deny"]);
  assert.match(outcomes[5].reason, /budget_exceeded/);
  await server.close();
});

test("a changed policy, a wrong scope, another environment or a missing approval is refused and acknowledged as rejected", async () => {
  const cases = [
    ["changed limit", (e) => ({ ...e, policy: { ...e.policy, max_dispatch: 500 } }), "signature_invalid"],
    ["wrong scope digest", (e) => ({ ...e, scope_digest: "a".repeat(64) }), "scope_mismatch"],
    ["another environment", () => remade({ environmentId: "env-other" }), "scope_mismatch"],
    ["not approved", () => remade({ policy: { acknowledged: null } }), "schema_invalid"],
    ["shared gateway enforce", () => remade({ policy: { authority_scope: "shared_gateway" }, top: { enforcement: { eligible: false, fail_closed: FAIL_CLOSED } } }), "unsupported"],
    ["eligibility denied", () => remade({ top: { enforcement: { eligible: false, fail_closed: FAIL_CLOSED } } }), "unsupported"],
    ["no fail-closed contract", () => remade({ top: { enforcement: { eligible: true } } }), "unsupported"],
    ["unlimited on failure", () => remade({ top: { enforcement: { eligible: true, fail_closed: { ...FAIL_CLOSED, unlimited_dispatch_on_failure: true } } } }), "unsupported"],
  ];
  for (const [label, make, error] of cases) {
    const server = await startServer();
    const home = makeHome({ url: server.url });
    const exp = make(goldenExport());
    const result = await run(home.dir, ["budget", "load", writeExport(home.dir, exp), "--yes"]);
    assert.equal(result.status, 1, label);
    assert.throws(() => readFileSync(join(home.dir, "dispatch.json"), "utf8"), `${label}: nothing written`);
    const sent = acks(server);
    assert.equal(sent.length, 1, label);
    assert.equal(sent[0].payload.data.event, "rejected", label);
    assert.equal(sent[0].payload.data.error, error, label);
    assert.equal(sent[0].payload.data.policy_id, exp.budget_id, label);
    await server.close();
  }
});

test("an expired export, a non-export and a monitor-only export: expired and foreign files are not acknowledged; monitor loads as monitor", async () => {
  const server = await startServer();
  const home = makeHome({ url: server.url });
  const expired = await run(home.dir, ["budget", "load", writeExport(home.dir, goldenExport({ valid_until: 1_000 })), "--yes"]);
  assert.equal(expired.status, 1);
  assert.match(expired.stderr, /validity window/);
  const foreign = await run(home.dir, ["budget", "load", writeExport(home.dir, { type: "scopebond:reviewed-policy-export", version: 1 }), "--yes"]);
  assert.equal(foreign.status, 1);
  assert.equal(acks(server).length, 0);
  const monitor = remade({ policy: { mode: "monitor" }, top: { enforcement: { eligible: false, reason: "monitor_only_mode", fail_closed: FAIL_CLOSED } } });
  assert.equal((await run(home.dir, ["budget", "load", writeExport(home.dir, monitor), "--yes"])).status, 0);
  assert.equal(settings(home.dir).budgets[0].mode, "monitor");
  await server.close();
});

test("the workspace's { version, export } answer loads; a newer version replaces an older workspace budget, never the reverse, and a hand-written budget is kept", async () => {
  const server = await startServer();
  const home = makeHome({ url: server.url });
  writeFileSync(join(home.dir, "dispatch.json"), JSON.stringify({ budgets: [{ budget_id: "manual-budget-1", actor: home.agent.kid, operations: ["net.fetch"], authority_scope: "installation", max: 9, window_seconds: 60, mode: "monitor", version: 1, expires_at: "2099-01-01T00:00:00.000Z", acknowledgement: null }] }));
  const v2 = remade({ exportId: "exp-v2", policy: { version: 2 }, top: { budget_id: "budget-v2-aaaa" } });
  assert.equal((await run(home.dir, ["budget", "load", writeExport(home.dir, { version: 2, export: v2 }), "--yes"])).status, 0);
  const v3 = remade({ exportId: "exp-v3", policy: { version: 3, max_dispatch: 7 }, top: { budget_id: "budget-v3-bbbb" } });
  assert.equal((await run(home.dir, ["budget", "load", writeExport(home.dir, v3), "--yes"])).status, 0);
  let ids = settings(home.dir).budgets.map((b) => b.budget_id);
  assert.deepEqual(ids, ["manual-budget-1", "budget-v3-bbbb"]);
  const older = await run(home.dir, ["budget", "load", writeExport(home.dir, v2), "--yes"]);
  assert.equal(older.status, 1);
  assert.match(older.stderr, /same or newer/);
  ids = settings(home.dir).budgets.map((b) => b.budget_id);
  assert.deepEqual(ids, ["manual-budget-1", "budget-v3-bbbb"]);
  await server.close();
});
