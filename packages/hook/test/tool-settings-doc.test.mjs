// The managed document's `tool_settings` section: its shape and digest, its own signature (checked with the rules check
// itself), and how the rules check carries it: a changed section at the same rules version is installed, an answer without
// one changes nothing, and the Scopebond Agent's version and report ride on the request. Keys are made at run time.
import { ENFORCE } from "./enforce-all.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scaffold, policyBuilds, digestRules, syncPolicy, inspectToolSettings, digestToolSettings, checkToolSettingsSignature, checkPolicySignature,
  signedPolicyBytes, toolSettingsMark, inspectManaged, MANAGED_DOC_FILE,
} from "../dist/index.js";

const INSTALLATION = "gw-tsd-1";
const WORKSPACE = "org-tsd-1";
const NOW = new Date("2026-10-20T00:00:00Z");
const pair = generateKeyPairSync("ed25519");
const KEYS = [{ key_id: "ws-1", public_key: pair.publicKey.export({ type: "spki", format: "pem" }), not_before: "2026-10-01T00:00:00Z", not_after: "2027-10-01T00:00:00Z" }];

function section(harnesses, { revision = 1, mode = "enforce" } = {}) {
  const s = { type: "scopebond:tool-settings", version: 1, revision, mode, harnesses };
  return { ...s, settings_digest: digestToolSettings(s) };
}
const payloadFor = (revision, digest, issuedAt) => ({ v: 1, workspace: WORKSPACE, computer: INSTALLATION, revision, rules_digest: digest, local_changes: false, managed: true, issued_at: issuedAt });
function sign(s, issuedAt = "2026-10-15T00:00:00Z") {
  return { ...s, workspace_id: WORKSPACE, issued_at: issuedAt, key_id: "ws-1", signature: cryptoSign(null, signedPolicyBytes(payloadFor(s.revision, s.settings_digest, issuedAt)), pair.privateKey).toString("base64") };
}
const context = { workspace: WORKSPACE, computer: INSTALLATION, lastIssuedAt: null, keys: KEYS, now: NOW };

test("a well-formed section passes; a bad list, a bad server name or a changed list does not", () => {
  const s = section({ claude: { permissions_deny: ["Bash(rm:*)"], mcp_denied: ["evil"] }, future_tool: { some_list: ["x"] } });
  assert.equal(inspectToolSettings(s).ok, true);
  assert.equal(inspectToolSettings({ ...s, version: 2 }).reason, "unsupported");
  assert.equal(inspectToolSettings({ ...s, mode: "sometimes" }).ok, false);
  assert.equal(inspectToolSettings(section({ claude: { mcp_denied: ["evil server"] } })).ok, false);
  assert.equal(inspectToolSettings(section({ claude: { permissions_deny: ["a\nb"] } })).ok, false);
  assert.equal(inspectToolSettings(section({ claude: { permissions_deny: Array.from({ length: 101 }, (_, i) => `Bash(${i})`) } })).ok, false);
  assert.equal(inspectToolSettings({ ...s, harnesses: { claude: { permissions_deny: [] } } }).ok, false);
});

test("the section's signature is checked with the rules check: signed verifies, unsigned is unsigned, a rules signature does not pass", () => {
  const s = section({ claude: { permissions_deny: ["Bash(rm:*)"] } });
  assert.equal(checkToolSettingsSignature(sign(s), context).result, "verified");
  assert.equal(checkToolSettingsSignature(s, context).result, "unsigned");
  assert.equal(checkToolSettingsSignature(sign(s), { ...context, keys: [] }).reason, "unknown_key");
  assert.equal(checkToolSettingsSignature(sign(s), { ...context, computer: "gw-other" }).reason, "bad_signature");
  // A rules document signed under the same key: its signature, moved onto a section, does not verify (the digests differ).
  const rules = { "secret-read": { mode: "block" } };
  const rulesSig = cryptoSign(null, signedPolicyBytes(payloadFor(1, digestRules(rules), "2026-10-15T00:00:00Z")), pair.privateKey).toString("base64");
  assert.equal(checkToolSettingsSignature({ ...s, workspace_id: WORKSPACE, issued_at: "2026-10-15T00:00:00Z", key_id: "ws-1", signature: rulesSig }, context).reason, "bad_signature");
  // And the reverse: a section's signature carried onto a rules document verifies only with the section's digest as
  // `rules_digest`, and no rules object hashes to that digest (its `type` is part of it), so the document is refused.
  const signedSection = sign(s);
  const forged = doc({ revision: 1, export_id: `rev-1-${INSTALLATION}`, rules_digest: s.settings_digest, workspace_id: WORKSPACE, issued_at: signedSection.issued_at, key_id: "ws-1", signature: signedSection.signature });
  assert.equal(checkPolicySignature(forged, { ...context, managed: true }).result, "verified");
  assert.equal(inspectManaged(forged, { installationId: INSTALLATION, currentRevision: null }).ok, false);
});

const defaults = () => ({
  "force-push-protected": { mode: "block" }, "push-protected": { mode: "block" }, "destructive-shell": { mode: "block" },
  "secret-read": { mode: "block" }, "ci-config-write": { mode: "block" }, "network-egress": { mode: "monitor" },
});
function doc(extra = {}) {
  const rules = defaults();
  return { type: "scopebond:managed-rules", version: 1, revision: 4, export_id: `rev-4-${INSTALLATION}`, environment_id: "env-1", agent_id: "agent-1", installation_id: INSTALLATION, rules, rules_digest: digestRules(rules), ...extra };
}
function connected() {
  const dir = mkdtempSync(join(tmpdir(), "scopebond-tsd-"));
  const { agentKid } = scaffold(dir, ENFORCE);
  writeFileSync(join(dir, "cloud.json"), JSON.stringify({ url: "https://cloud.example.test", credential: "sbm_x", credential_id: "c", organization_id: WORKSPACE, environment_id: "env-1", gateway_id: INSTALLATION, attester_kid: "k", scopes: [], expires_at: "2099-01-01T00:00:00Z" }));
  return { dir, agentKid };
}
async function sync(h, body, extra = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers ?? {} });
    if (String(url).endsWith("/v1/policy/ack")) return new Response("{}", { status: 200 });
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const outcome = await syncPolicy(h.dir, { agentKid: h.agentKid, hookVersion: "0.23.0", policyBuilds, fetchImpl, now: () => NOW, ...extra });
  return { outcome, calls };
}
const installed = (h) => JSON.parse(readFileSync(join(h.dir, MANAGED_DOC_FILE), "utf8"));

test("a changed section at the same rules version is installed; an answer without one leaves the installed section", async () => {
  const h = connected();
  assert.equal((await sync(h, doc())).outcome.state, "applied");
  assert.equal(installed(h).tool_settings, undefined);
  const first = sign(section({ claude: { permissions_deny: ["Bash(rm:*)"] } }));
  assert.equal((await sync(h, doc({ tool_settings: first }))).outcome.state, "applied");
  assert.equal(toolSettingsMark(installed(h)), `${first.settings_digest}:ws-1`);
  // The same section signed again later: nothing to install.
  assert.equal((await sync(h, doc({ tool_settings: sign(section({ claude: { permissions_deny: ["Bash(rm:*)"] } }), "2026-10-16T00:00:00Z") }))).outcome.state, "unchanged");
  const second = sign(section({ claude: { permissions_deny: ["Bash(rm:*)", "Bash(curl:*)"] } }, { revision: 2 }));
  assert.equal((await sync(h, doc({ tool_settings: second }))).outcome.state, "applied");
  assert.equal(installed(h).tool_settings.revision, 2);
  // A hook call is not sent the section: its answer changes nothing here.
  assert.equal((await sync(h, doc())).outcome.state, "unchanged");
  assert.equal(installed(h).tool_settings.revision, 2);
});

test("the agent's version and its tool settings report ride on the rules check; a hook call sends neither", async () => {
  const h = connected();
  const report = JSON.stringify({ v: 1, result: "applied", harnesses: { claude: { state: "drifted", keys: ["permissions.deny"] } } });
  const agent = await sync(h, doc(), { agentVersion: "0.8.0", toolSettingsReport: () => report });
  assert.equal(agent.calls[0].headers["x-scopebond-agent-version"], "0.8.0");
  assert.equal(agent.calls[0].headers["x-scopebond-tool-settings"], report);
  const hook = await sync(h, doc());
  assert.equal(hook.calls[0].headers["x-scopebond-agent-version"], undefined);
  assert.equal(hook.calls[0].headers["x-scopebond-tool-settings"], undefined);
  // A report that is too long, not printable, or that throws is left out; a malformed version too.
  for (const toolSettingsReport of [() => "x".repeat(5000), () => "café", () => { throw new Error("no"); }]) {
    const r = await sync(h, doc(), { agentVersion: "eight", toolSettingsReport });
    assert.equal(r.calls[0].headers["x-scopebond-tool-settings"], undefined);
    assert.equal(r.calls[0].headers["x-scopebond-agent-version"], undefined);
  }
});
