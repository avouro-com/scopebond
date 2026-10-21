// What this computer enforces, counted for the tray's "Protection" row: every rule that blocks (the four starter rules, the
// workspace's allowed sites and target rules, the rule packs' rules on Block, and each service the workspace blocks by
// name) and every rule that only records, with the packs in force. The older per-rule report (`ruleReport`, which the rules
// check sends the workspace) is unchanged. And "Rules updated" is the last successful rules check: a check that fails
// records when it was tried and why, and leaves `checked_at` alone.
import { ENFORCE } from "./enforce-all.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scaffold, compileManaged, defaultRules, digestManaged, MANAGED_DOC_FILE, ruleReport, ruleSummary, syncPolicy, syncIfDue, readMeta, policyBuilds, digestRules,
} from "../dist/index.js";
import { TARGET_PACK } from "./target-pack.mjs";

const INSTALLATION = "gw-summary-1";
const defaults = () => ({
  "force-push-protected": { mode: "block" }, "push-protected": { mode: "block" }, "destructive-shell": { mode: "block" },
  "secret-read": { mode: "monitor" }, "ci-config-write": { mode: "block" }, "network-egress": { mode: "block", allowed_hosts: ["example.com"] },
  "production-deploy": { mode: "block" }, "cloud-destructive": { mode: "monitor" },
});
const SERVICES = [{ kind: "mcp_server", key: "files" }, { kind: "host", key: "paste.example.org" }];

function managedComputer() {
  const dir = mkdtempSync(join(tmpdir(), "scopebond-summary-"));
  const { agentKid } = scaffold(dir, ENFORCE);
  const rules = defaults();
  const doc = { type: "scopebond:managed-rules", version: 1, revision: 2, export_id: `rev-2-${INSTALLATION}`, environment_id: "env-1", agent_id: "agent-1",
    installation_id: INSTALLATION, rules, blocked_services: SERVICES, rules_digest: digestManaged(rules, SERVICES) };
  writeFileSync(join(dir, MANAGED_DOC_FILE), JSON.stringify(doc));
  writeFileSync(join(dir, "policy.json"), JSON.stringify(compileManaged(defaultRules(), doc, agentKid)));
  return dir;
}

test("a computer on its own rules: the four starter rules, by mode", () => {
  const blocking = mkdtempSync(join(tmpdir(), "scopebond-summary-own-"));
  scaffold(blocking, ENFORCE);
  const s = ruleSummary(blocking, []);
  assert.equal(s.blocking, 4);
  assert.equal(s.monitoring, 0);
  assert.deepEqual(s.packs, []);
  assert.deepEqual(s.rules, ruleReport(blocking), "the per-rule report is the old one where nothing else applies");
  const recording = mkdtempSync(join(tmpdir(), "scopebond-summary-own-"));
  scaffold(recording);
  assert.deepEqual({ ...ruleSummary(recording, []), rules: undefined }, { rules: undefined, blocking: 0, monitoring: 4, packs: [] });
});

test("a workspace's computer: starter rules, allowed sites, target rules from the packs, and blocked services", () => {
  const dir = managedComputer();
  const s = ruleSummary(dir, [TARGET_PACK]);
  // Block: protect-branches, safe-shell, protect-write, allowed-sites, production-deploy, and the two blocked services.
  // Record: protect-read, and the pack's other target rules (cloud-destructive, secret-write, iam-change, database-migrate).
  assert.equal(s.blocking, 7);
  assert.equal(s.monitoring, 5);
  assert.deepEqual(s.packs, [{ id: "demo-targets", version: "1.0.0", title: "demo-targets" }]);
  assert.deepEqual(s.rules["production-deploy"], ["enforce", "workspace"]);
  assert.deepEqual(s.rules["cloud-destructive"], ["monitor", "workspace"]);
  assert.deepEqual(s.rules["allowed-sites"], ["enforce", "workspace"]);
  assert.deepEqual(s.rules["protect-read"], ["monitor", "workspace"]);
  assert.equal("observe-targets" in s.rules, false, "a pack's observation clause is not a rule a person turns on");
  // The older report keeps its shape: the four starter rules only.
  assert.deepEqual(Object.keys(ruleReport(dir)).sort(), ["protect-branches", "protect-read", "protect-write", "safe-shell"]);
  // Without the pack, its target rules are not in force.
  const bare = ruleSummary(dir, []);
  assert.equal(bare.blocking, 6);
  assert.equal(bare.monitoring, 1);
});

function connected() {
  const dir = mkdtempSync(join(tmpdir(), "scopebond-summary-sync-"));
  const { agentKid } = scaffold(dir, ENFORCE);
  writeFileSync(join(dir, "cloud.json"), JSON.stringify({ url: "https://cloud.example.test", credential: "sbm_x", credential_id: "c", organization_id: "o", environment_id: "env-1", gateway_id: INSTALLATION, attester_kid: "k", scopes: [], expires_at: "2099-01-01T00:00:00Z" }));
  return { dir, agentKid };
}
const managedDoc = (revision) => {
  const rules = { "force-push-protected": { mode: "block" }, "push-protected": { mode: "block" }, "destructive-shell": { mode: "block" },
    "secret-read": { mode: "block" }, "ci-config-write": { mode: "block" }, "network-egress": { mode: "monitor" } };
  return { type: "scopebond:managed-rules", version: 1, revision, export_id: `rev-${revision}-${INSTALLATION}`, environment_id: "env-1", agent_id: "agent-1",
    installation_id: INSTALLATION, rules, rules_digest: digestRules(rules) };
};
const answering = (responses) => async (url) => {
  if (String(url).endsWith("/v1/policy/ack")) return new Response("{}", { status: 200 });
  const next = responses.shift();
  if (next instanceof Error) throw next;
  return new Response(next.body === undefined ? null : JSON.stringify(next.body), { status: next.status });
};

test("rules updated means the last successful check: a failed check keeps checked_at and records the attempt and the error", async () => {
  const { dir, agentKid } = connected();
  const at = (iso) => () => new Date(iso);
  const opts = (fetchImpl, now) => ({ agentKid, hookVersion: "0.40.0", policyBuilds, fetchImpl, now });
  assert.equal((await syncPolicy(dir, opts(answering([{ status: 200, body: managedDoc(1) }]), at("2026-10-21T10:00:00Z")))).state, "applied");
  let meta = readMeta(dir);
  assert.equal(meta.checked_at, "2026-10-21T10:00:00.000Z");
  assert.equal(meta.last_attempt_at, "2026-10-21T10:00:00.000Z");
  assert.equal(meta.last_error, null);

  // Unreachable: checked_at stays; the attempt and the error are recorded.
  assert.equal((await syncPolicy(dir, opts(answering([new Error("offline")]), at("2026-10-21T10:10:00Z")))).state, "unavailable");
  meta = readMeta(dir);
  assert.equal(meta.checked_at, "2026-10-21T10:00:00.000Z");
  assert.equal(meta.last_attempt_at, "2026-10-21T10:10:00.000Z");
  assert.match(meta.last_error, /could not reach the workspace/);
  // An error answer, and a refused document, are failures too.
  assert.equal((await syncPolicy(dir, opts(answering([{ status: 503 }]), at("2026-10-21T10:20:00Z")))).state, "unavailable");
  assert.equal((await syncPolicy(dir, opts(answering([{ status: 200, body: { ...managedDoc(3), rules_digest: "0".repeat(64) } }]), at("2026-10-21T10:30:00Z")))).state, "refused");
  meta = readMeta(dir);
  assert.equal(meta.checked_at, "2026-10-21T10:00:00.000Z");
  assert.equal(meta.last_attempt_at, "2026-10-21T10:30:00.000Z");
  assert.ok(meta.last_error);

  // Unchanged (304) is a successful check.
  assert.equal((await syncPolicy(dir, opts(answering([{ status: 304 }]), at("2026-10-21T10:40:00Z")))).state, "unchanged");
  meta = readMeta(dir);
  assert.equal(meta.checked_at, "2026-10-21T10:40:00.000Z");
  assert.equal(meta.last_error, null);
});

test("a failed check is not tried again on every tool call: the five-minute wait counts from the last attempt", async () => {
  const { dir, agentKid } = connected();
  writeFileSync(join(dir, "managed-meta.json"), JSON.stringify({ checked_at: new Date(Date.now() - 60 * 60_000).toISOString(), last_attempt_at: new Date().toISOString() }));
  let made = 0;
  assert.equal(await syncIfDue(dir, () => { made++; return { agentKid, hookVersion: "0.40.0", policyBuilds }; }), null);
  assert.equal(made, 0, "tried a moment ago");
});
