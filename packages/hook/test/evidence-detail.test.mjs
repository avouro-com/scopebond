// Evidence detail (D144): the workspace names it on every rules check; until it does, every receipt is sent. An action one
// of this computer's Monitor rules matches is always sent in full.
import { ENFORCE } from "./enforce-all.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scaffold, createHookRuntime, mapClaudeToolUse, compileManaged, defaultRules, digestRules, policyBuilds, syncPolicy,
  evidenceDetail, evidenceDetailFrom, summaryOptions,
} from "../dist/index.js";
import { isNotable } from "@scopebond/gateway";

const INSTALLATION = "gw-detail-1";
const headers = (value) => ({ get: (name) => (name === "x-scopebond-evidence-detail" ? value : null) });

function connected() {
  const dir = mkdtempSync(join(tmpdir(), "scopebond-detail-"));
  const { agentKid } = scaffold(dir, ENFORCE);
  writeFileSync(join(dir, "cloud.json"), JSON.stringify({ url: "https://cloud.example.test", credential: "sbm_x", credential_id: "c", organization_id: "o", environment_id: "env-1", gateway_id: INSTALLATION, attester_kid: "k", scopes: [], expires_at: "2099-01-01T00:00:00Z" }));
  return { dir, agentKid };
}
const workspace = (detail) => async (url) => {
  if (String(url).endsWith("/v1/policy/ack")) return new Response("{}", { status: 200 });
  return new Response(null, { status: 204, headers: detail ? { "x-scopebond-evidence-detail": detail } : {} });
};

test("the header names the level; minimal is standard here; anything else is ignored", () => {
  assert.equal(evidenceDetailFrom(headers("standard")), "standard");
  assert.equal(evidenceDetailFrom(headers(" FULL ")), "full");
  assert.equal(evidenceDetailFrom(headers("minimal")), "standard");
  assert.equal(evidenceDetailFrom(headers("everything")), null);
  assert.equal(evidenceDetailFrom(headers(null)), null);
});

test("the rules check keeps the workspace's level; until it says, every receipt is sent", async () => {
  const { dir, agentKid } = connected();
  try {
    assert.equal(evidenceDetail(dir), "full");
    await syncPolicy(dir, { agentKid, hookVersion: "0.22.0", policyBuilds, fetchImpl: workspace("standard") });
    assert.equal(evidenceDetail(dir), "standard");
    await syncPolicy(dir, { agentKid, hookVersion: "0.22.0", policyBuilds, fetchImpl: workspace(null) });
    assert.equal(evidenceDetail(dir), "standard", "a check without the header keeps the last level");
    await syncPolicy(dir, { agentKid, hookVersion: "0.22.0", policyBuilds, fetchImpl: workspace("full") });
    assert.equal(evidenceDetail(dir), "full");
    const options = summaryOptions(dir);
    assert.equal(options.detail(), "full");
    assert.ok(options.attester.kid.startsWith("key:"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("summaries key their folder digests with this computer's digest key", () => {
  const { dir } = connected();
  try {
    const key = readFileSync(join(dir, "digest.key"), "utf8").trim();
    assert.match(key, /^[0-9a-f]{64}$/);
    assert.equal(summaryOptions(dir).digestKey, key);
    assert.equal(summaryOptions(dir).digestKey, key, "the same key on every call, so one folder has one digest");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("no receipt key: no summaries (a key is never made for them)", () => {
  const dir = mkdtempSync(join(tmpdir(), "scopebond-detail-nokey-"));
  try { assert.equal(summaryOptions(dir), undefined); } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an action a Monitor rule matches is recorded as out of policy, so it is always sent in full", async () => {
  const { dir, agentKid } = connected();
  try {
    const rules = { "force-push-protected": { mode: "block" }, "push-protected": { mode: "block" }, "destructive-shell": { mode: "block" },
      "secret-read": { mode: "monitor" }, "ci-config-write": { mode: "block" }, "network-egress": { mode: "monitor" } };
    const doc = { type: "scopebond:managed-rules", version: 1, revision: 1, export_id: `rev-1-${INSTALLATION}`, environment_id: "env-1", agent_id: "agent-1",
      installation_id: INSTALLATION, rules_catalog_version: "coding-pack/3", rules, rules_digest: digestRules(rules) };
    writeFileSync(join(dir, "policy.json"), JSON.stringify(compileManaged(defaultRules(), doc, agentKid)));
    const runtime = createHookRuntime({ policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"), attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db"), cwd: "/repo" });
    const receiptOf = async (toolUse, type) => {
      const d = await runtime.evaluate(mapClaudeToolUse({ cwd: "/repo", ...toolUse }));
      return (d.receipts ?? [d.receipt]).find((r) => r.payload.intent.action_type === type);
    };
    try {
      // secret-read is on Monitor: reading .env is recorded and allowed, and it matches.
      const rm = await receiptOf({ tool_name: "Read", tool_input: { file_path: "/repo/.env" } }, "file.read");
      const ls = await receiptOf({ tool_name: "Bash", tool_input: { command: "ls" } }, "shell.exec");
      assert.equal(rm.payload.realtime_result, "deny", "a Monitor match is recorded as out of policy");
      assert.notEqual(rm.payload.execution.state, "denied", "and allowed");
      assert.equal(isNotable(rm.payload), true);
      assert.equal(isNotable(ls.payload), false);
    } finally { runtime.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
