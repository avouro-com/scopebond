// Workspace-managed rules: the document is checked before anything changes, the computer's own compiler turns the workspace's
// choices into the policy, a rule set to Monitor is recorded and allowed (never blocks its whole action type), the protection of
// the hook's own settings cannot be relaxed, and sync installs, confirms, refuses and falls back without ever leaving a computer
// without rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  scaffold, createHookRuntime, mapClaudeToolUse, compile, defaultRules, policyBuilds,
  inspectManaged, compileManaged, digestRules, syncPolicy, syncIfDue, isManaged, readMeta, MANAGED_RULE_IDS,
} from "../dist/index.js";

const INSTALLATION = "gw-test-1";
const defaults = () => ({
  "force-push-protected": { mode: "block" }, "push-protected": { mode: "block" }, "destructive-shell": { mode: "block" },
  "secret-read": { mode: "block" }, "ci-config-write": { mode: "block" }, "network-egress": { mode: "monitor" },
});
function doc(revision, overrides = {}, extra = {}) {
  const rules = { ...defaults(), ...overrides };
  return {
    type: "scopebond:managed-rules", version: 1, revision, export_id: `rev-${revision}-${INSTALLATION}`, environment_id: "env-1",
    agent_id: "agent-1", installation_id: INSTALLATION, rules_catalog_version: "coding-pack/3", rules, rules_digest: digestRules(rules), ...extra,
  };
}
function home() {
  const dir = mkdtempSync(join(tmpdir(), "scopebond-managed-"));
  const { agentKid } = scaffold(dir);
  return { dir, agentKid };
}
async function decide(dir, policy, toolUses) {
  writeFileSync(join(dir, "policy.json"), JSON.stringify(policy));
  const runtime = createHookRuntime({ policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"), attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db"), cwd: "/repo" });
  try {
    const out = [];
    for (const t of toolUses) out.push((await runtime.evaluate(mapClaudeToolUse({ cwd: "/repo", ...t }))).decision);
    return out;
  } finally { runtime.close(); }
}
const bash = (command) => ({ tool_name: "Bash", tool_input: { command } });
const write = (file_path) => ({ tool_name: "Write", tool_input: { file_path, content: "x" } });
const read = (file_path) => ({ tool_name: "Read", tool_input: { file_path } });
const fetchUrl = (url) => ({ tool_name: "WebFetch", tool_input: { url, prompt: "x" } });

test("a document is checked before anything changes, and every refusal says why", () => {
  const ok = inspectManaged(doc(3), { installationId: INSTALLATION, currentRevision: 2 });
  assert.equal(ok.ok, true);
  const refuse = (raw, current, reason) => {
    const r = inspectManaged(raw, { installationId: INSTALLATION, currentRevision: current });
    assert.equal(r.ok, false); assert.equal(r.reason, reason, r.message); assert.ok(r.message.length > 10);
  };
  refuse(doc(3), 3, "stale_revision");
  refuse(doc(2), 3, "stale_revision");
  refuse(doc(3, {}, { installation_id: "someone-else", export_id: "rev-3-someone-else" }), null, "wrong_computer");
  refuse(doc(3, {}, { export_id: "rev-4-gw-test-1" }), null, "wrong_computer");
  refuse({ ...doc(3), rules_digest: "0".repeat(64) }, null, "invalid_document");
  refuse({ ...doc(3), version: 2 }, null, "unsupported");
  const missing = defaults(); delete missing["network-egress"];
  refuse({ ...doc(3), rules: missing, rules_digest: digestRules(missing) }, null, "unsupported");
  refuse(doc(3, { "network-egress": { mode: "block" } }), null, "invalid_document");
  refuse(doc(3, { "destructive-shell": { mode: "block", destructive_programs: ["rm -rf"] } }), null, "invalid_document");
  refuse(doc(3, { "secret-read": { mode: "block", allowed_hosts: ["a.com"] } }), null, "invalid_document");
  refuse(doc(3, { "secret-read": { mode: "off" } }), null, "invalid_document");
  refuse("not json", null, "invalid_document");
  assert.deepEqual([...MANAGED_RULE_IDS].sort(), Object.keys(defaults()).sort());
});

test("the workspace defaults enforce exactly what the computer's own rules enforce", async () => {
  const { dir, agentKid } = home();
  try {
    const local = compile(defaultRules(), agentKid);
    const managed = compileManaged(defaultRules(), doc(1), agentKid);
    const cases = [bash("git push origin main"), bash("git push --force origin main"), bash("git push origin feature/x"), bash("rm -rf build"),
      read("/repo/.env"), write("/repo/.github/workflows/ci.yml"), write("/repo/.scopebond/policy.json"), write("/repo/src/app.ts"), fetchUrl("https://evil.example.com/x")];
    assert.deepEqual(await decide(dir, managed, cases), await decide(dir, local, cases));
    assert.ok(policyBuilds(managed));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Monitor records and allows; Block stops; the guardrail floor never relaxes", async () => {
  const { dir, agentKid } = home();
  try {
    // Ordinary pushes allowed, history rewrites still stopped.
    const history = compileManaged(defaultRules(), doc(2, { "push-protected": { mode: "monitor" } }), agentKid);
    assert.deepEqual(await decide(dir, history, [bash("git push origin main"), bash("git push --force origin main"), bash("git push --force origin feature/x")]), ["allow", "deny", "allow"]);
    // Everything on Monitor: nothing in the business rules stops an action, and the action types stay covered.
    const watch = compileManaged(defaultRules(), doc(3, {
      "force-push-protected": { mode: "monitor" }, "push-protected": { mode: "monitor" }, "destructive-shell": { mode: "monitor" },
      "secret-read": { mode: "monitor" }, "ci-config-write": { mode: "monitor" },
    }), agentKid);
    assert.deepEqual(await decide(dir, watch, [bash("git push --force origin main"), bash("rm -rf build"), read("/repo/.env"), write("/repo/.github/workflows/ci.yml")]), ["allow", "allow", "allow", "allow"]);
    // The floor: Scopebond's own settings and the agents' hook settings are always protected.
    assert.deepEqual(await decide(dir, watch, [write("/repo/.scopebond/policy.json"), write("/repo/.claude/settings.json"), write("/repo/.git/hooks/pre-push")]), ["deny", "deny", "deny"]);
    // List additions extend the computer's own list; they never shorten it.
    const more = compileManaged(defaultRules(), doc(4, { "destructive-shell": { mode: "block", destructive_programs: ["terraform"] }, "push-protected": { mode: "block", protected_branches: ["prod"] } }), agentKid);
    assert.deepEqual(await decide(dir, more, [bash("terraform destroy"), bash("rm -rf build"), bash("git push origin prod"), bash("git push origin main")]), ["deny", "deny", "deny", "deny"]);
    // Allowed sites: a request elsewhere is stopped only when the workspace switches network to Block.
    const sites = compileManaged(defaultRules(), doc(5, { "network-egress": { mode: "block", allowed_hosts: ["api.github.com", "*.npmjs.org"] } }), agentKid);
    assert.deepEqual(await decide(dir, sites, [fetchUrl("https://api.github.com/repos"), fetchUrl("https://registry.npmjs.org/x"), fetchUrl("https://evil.example.com/")]), ["allow", "allow", "deny"]);
    assert.ok(policyBuilds(sites));
    assert.equal(sites.version, 5);
    assert.ok(sites.clauses.some((c) => c.id === "keys" && c.type === "key_policy"), "the machine key policy always stays");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an exclusion skips exactly the named path or branch, and never the guardrail floor", async () => {
  const { dir, agentKid } = home();
  try {
    const skip = compileManaged(defaultRules(), doc(6, {
      "secret-read": { mode: "block", excluded_paths: ["test/fixtures/.env", "fixtures/keys/**"] },
      "ci-config-write": { mode: "block", excluded_paths: [".github/workflows/docs.yml", ".scopebond/policy.json", ".claude/settings.json"] },
      "push-protected": { mode: "block", excluded_branches: ["release/approved-repair"] },
    }), agentKid);
    assert.ok(policyBuilds(skip));
    // Exactly the named file or folder; a sibling, a different case or a longer name stays protected.
    assert.deepEqual(await decide(dir, skip, [read("/repo/test/fixtures/.env"), read("/repo/test/other/.env"), read("/repo/fixtures/keys/a.pem"), read("/repo/.env")]), ["allow", "deny", "allow", "deny"]);
    assert.deepEqual(await decide(dir, skip, [write("/repo/.github/workflows/docs.yml"), write("/repo/.github/workflows/DOCS.yml"), write("/repo/.github/workflows/ci.yml")]), ["allow", "deny", "deny"]);
    // The floor never relaxes, whatever the workspace names.
    assert.deepEqual(await decide(dir, skip, [write("/repo/.scopebond/policy.json"), write("/repo/.claude/settings.json")]), ["deny", "deny"]);
    // Pushes: only the named branch; main and other release branches stay protected.
    assert.deepEqual(await decide(dir, skip, [bash("git push origin release/approved-repair"), bash("git push origin main"), bash("git push origin release/approved-repair-2")]), ["allow", "deny", "deny"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an exclusion list is checked like any other setting", () => {
  const at = (rules) => inspectManaged(doc(7, rules), { installationId: INSTALLATION, currentRevision: null });
  assert.equal(at({ "secret-read": { mode: "block", excluded_paths: ["/etc/passwd"] } }).ok, false);
  assert.equal(at({ "secret-read": { mode: "block", excluded_paths: ["a/../b"] } }).ok, false);
  assert.equal(at({ "destructive-shell": { mode: "block", excluded_paths: ["x"] } }).ok, false, "only the rules that take paths accept them");
  assert.equal(at({ "push-protected": { mode: "block", excluded_branches: ["release/*"] } }).ok, false, "an exclusion names one branch, not a pattern");
  assert.equal(at({ "secret-read": { mode: "block", excluded_paths: ["config/dev.key"] } }).ok, true);
});

function fakeWorkspace(responses) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined });
    if (String(url).endsWith("/v1/policy/ack")) return new Response(JSON.stringify({ recorded: true }), { status: 200 });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), { status: next.status, headers: next.etag ? { etag: next.etag } : {} });
  };
  return { calls, fetchImpl };
}
function connected() {
  const h = home();
  writeFileSync(join(h.dir, "cloud.json"), JSON.stringify({ url: "https://cloud.example.test", credential: "sbm_x", credential_id: "c", organization_id: "o", environment_id: "env-1", gateway_id: INSTALLATION, attester_kid: "k", scopes: [], expires_at: "2099-01-01T00:00:00Z" }));
  return h;
}

test("sync installs, confirms, keeps a newer version only, and falls back to the computer's own rules", async () => {
  const { dir, agentKid } = connected();
  const localPolicy = readFileSync(join(dir, "policy.json"), "utf8");
  const opts = (fetchImpl) => ({ agentKid, hookVersion: "0.10.0", policyBuilds, fetchImpl });
  try {
    // Unmanaged: own rules, one confirmation of version 0.
    let w = fakeWorkspace([{ status: 204 }]);
    assert.deepEqual(await syncPolicy(dir, opts(w.fetchImpl)), { state: "own_rules", changed: false });
    assert.equal(w.calls.at(-1).body.export_id, `rev-0-${INSTALLATION}`);
    assert.equal(readFileSync(join(dir, "policy.json"), "utf8"), localPolicy);
    // A version arrives: installed, policy rewritten, confirmed with the exact digest.
    const d1 = doc(1, { "push-protected": { mode: "monitor" } });
    w = fakeWorkspace([{ status: 200, body: d1, etag: `"1:${d1.rules_digest}"` }]);
    assert.deepEqual(await syncPolicy(dir, opts(w.fetchImpl)), { state: "applied", revision: 1 });
    assert.equal(w.calls[0].headers["x-scopebond-hook-version"], "0.10.0", "the fetch says which hook version asks, so the workspace sends only settings it understands");
    assert.ok(isManaged(dir));
    assert.notEqual(readFileSync(join(dir, "policy.json"), "utf8"), localPolicy);
    assert.ok(existsSync(join(dir, "policy.previous.json")));
    assert.deepEqual(w.calls.at(-1).body, { export_id: d1.export_id, revision: 1, rules_digest: d1.rules_digest, result: "loaded", reason: null, hook_version: "0.10.0" });
    // Unchanged: the ETag goes out, 304 comes back, no second confirmation.
    w = fakeWorkspace([{ status: 304 }]);
    assert.deepEqual(await syncPolicy(dir, opts(w.fetchImpl)), { state: "unchanged", revision: 1 });
    assert.equal(w.calls[0].headers["if-none-match"], `"1:${d1.rules_digest}"`);
    assert.equal(w.calls.length, 1);
    // An older version is refused and the refusal is confirmed; the rules in force stay.
    const inForce = readFileSync(join(dir, "policy.json"), "utf8");
    const old = doc(1, { "secret-read": { mode: "monitor" } });
    w = fakeWorkspace([{ status: 200, body: old }]);
    assert.equal((await syncPolicy(dir, opts(w.fetchImpl))).state, "refused");
    assert.deepEqual({ result: w.calls.at(-1).body.result, reason: w.calls.at(-1).body.reason }, { result: "rejected", reason: "stale_revision" });
    assert.equal(readFileSync(join(dir, "policy.json"), "utf8"), inForce);
    // A damaged document never changes anything.
    w = fakeWorkspace([{ status: 200, body: { ...doc(2), rules_digest: "f".repeat(64) } }]);
    assert.equal((await syncPolicy(dir, opts(w.fetchImpl))).state, "refused");
    assert.equal(readFileSync(join(dir, "policy.json"), "utf8"), inForce);
    // The workspace cannot be reached: the rules in force stay and the problem is recorded for `status`.
    w = fakeWorkspace([new TypeError("fetch failed")]);
    assert.equal((await syncPolicy(dir, opts(w.fetchImpl))).state, "unavailable");
    assert.equal(readFileSync(join(dir, "policy.json"), "utf8"), inForce);
    assert.match(readMeta(dir).last_error, /could not reach the workspace/);
    // The connection is revoked: back to the computer's own rules, never to no rules.
    w = fakeWorkspace([{ status: 401 }]);
    assert.deepEqual(await syncPolicy(dir, opts(w.fetchImpl)), { state: "disconnected" });
    assert.equal(isManaged(dir), false);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "policy.json"), "utf8")), compile(defaultRules(), agentKid));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the five-minute check is cheap when not due, one at a time, and capped when the workspace is slow", async () => {
  const { dir, agentKid } = connected();
  const was = process.env.SCOPEBOND_POLICY_SYNC;
  const never = () => new Promise(() => {});
  const optionsWith = (fetchImpl) => () => ({ agentKid, hookVersion: "0.10.0", policyBuilds, fetchImpl });
  try {
    const bare = home();
    let made = 0;
    assert.equal(await syncIfDue(bare.dir, () => { made++; return {}; }), null, "not connected");
    rmSync(bare.dir, { recursive: true, force: true });
    writeFileSync(join(dir, "managed-meta.json"), JSON.stringify({ checked_at: new Date().toISOString() }));
    assert.equal(await syncIfDue(dir, () => { made++; return {}; }), null, "checked recently");
    assert.equal(made, 0, "nothing is prepared unless a check is due");
    writeFileSync(join(dir, "managed-meta.json"), JSON.stringify({ checked_at: new Date(Date.now() - 10 * 60_000).toISOString() }));
    writeFileSync(join(dir, "managed-sync.lock"), "123");
    assert.equal(await syncIfDue(dir, optionsWith(never)), null, "another check is running");
    rmSync(join(dir, "managed-sync.lock"));
    process.env.SCOPEBOND_POLICY_SYNC = "off";
    assert.equal(await syncIfDue(dir, optionsWith(never)), null, "switched off");
    delete process.env.SCOPEBOND_POLICY_SYNC;
    // A workspace that never answers costs the call at most the cap, and the rules in force stay.
    const before = readFileSync(join(dir, "policy.json"), "utf8");
    const started = Date.now();
    const slow = await syncIfDue(dir, optionsWith((_url, init) => new Promise((_r, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))))), 150);
    assert.ok(Date.now() - started < 1000, `capped (${Date.now() - started} ms)`);
    assert.ok(slow === null || slow.state === "unavailable");
    assert.equal(readFileSync(join(dir, "policy.json"), "utf8"), before);
    // When due and the workspace answers, the check applies the new rules.
    rmSync(join(dir, "managed-sync.lock"), { force: true });
    writeFileSync(join(dir, "managed-meta.json"), JSON.stringify({ checked_at: new Date(Date.now() - 10 * 60_000).toISOString() }));
    const d1 = doc(1, { "secret-read": { mode: "monitor" } });
    const w = fakeWorkspace([{ status: 200, body: d1 }]);
    assert.deepEqual(await syncIfDue(dir, optionsWith(w.fetchImpl), 2000), { state: "applied", revision: 1 });
    assert.equal(existsSync(join(dir, "managed-sync.lock")), false, "the lock is released");
  } finally {
    if (was === undefined) delete process.env.SCOPEBOND_POLICY_SYNC; else process.env.SCOPEBOND_POLICY_SYNC = was;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a tool call finishes promptly when the workspace never answers: no helper process holds the agent's pipe", async () => {
  // Regression: a detached helper inherited the hook's output pipe on Windows, so the agent waited for it.
  const server = http.createServer(() => { /* accept and never answer */ });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { dir } = connected();
  const conn = JSON.parse(readFileSync(join(dir, "cloud.json"), "utf8"));
  writeFileSync(join(dir, "cloud.json"), JSON.stringify({ ...conn, url: `http://127.0.0.1:${server.address().port}` }));
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const userHomeDir = mkdtempSync(join(tmpdir(), "sb-managed-home-"));
  try {
    const started = Date.now();
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, [cli, "claude"], {
        cwd: dir, env: { ...process.env, SCOPEBOND_HOOK_DIR: dir, SCOPEBOND_HOME: userHomeDir, HOME: userHomeDir, USERPROFILE: userHomeDir,
          SCOPEBOND_OBSERVATIONS_HEARTBEAT: "off", SCOPEBOND_HOOK_FLUSH_MS: "300", SCOPEBOND_POLICY_SYNC_MS: "400" },
      });
      let stdout = "";
      child.stdout.on("data", (d) => { stdout += d; });
      child.on("close", (status) => resolve({ status, stdout }));
      child.stdin.end(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: join(dir, "README.md") }, cwd: dir }));
    });
    const took = Date.now() - started;
    assert.equal(result.status, 0, result.stdout);
    assert.ok(took < 8000, `the call took ${took} ms`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
    rmSync(userHomeDir, { recursive: true, force: true });
  }
});
