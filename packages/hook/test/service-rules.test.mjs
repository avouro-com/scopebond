// Blocked services: a workspace blocks MCP servers, hosts, programs and packages by name in its rules document
// (`blocked_services`). The list is checked whole and digested with the rules; each kind compiles into a policy clause after
// the ordinary rules, so a blocked service is denied, recorded and explained like any other rule block.
import { ENFORCE } from "./enforce-all.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical } from "@scopebond/policy-schema/canonical";
import { validateEvidencePayload } from "@scopebond/gateway";
import {
  scaffold, createHookRuntime, mapClaudeToolUse, inspectManaged, compileManaged, digestRules, digestManaged, defaultRules, policyBuilds,
  syncPolicy, isManaged, readMeta, localActivity, MANAGED_DOC_FILE, createOverrideHandler, makeAllowance, writeAllowances, explainDeny,
  validBlockedServices, blockedServiceClauses, serviceMatches, BLOCKED_SERVICE_CLAUSES, HOOK_CAPABILITIES, SERVICE_RULES_CAPABILITY,
} from "../dist/index.js";
import { actionKey } from "../dist/override.js";

const INSTALLATION = "gw-services-1";
const terms = (extra = {}) => ({ reason_min: 10, minutes: 0, daily_limit: 5, harness_prompt: false, ...extra });
const defaults = () => ({
  "force-push-protected": { mode: "block" }, "push-protected": { mode: "block" }, "destructive-shell": { mode: "block" },
  "secret-read": { mode: "block" }, "ci-config-write": { mode: "block" }, "network-egress": { mode: "monitor" },
});
const SERVICES = [
  { kind: "cli", key: "ffmpeg" },
  { kind: "host", key: "api.example.com:8443" },
  { kind: "host", key: "tracker.example.net" },
  { kind: "mcp_server", key: "github" },
  { kind: "package", key: "npm:zod" },
  { kind: "package", key: "pip:requests" },
];
function doc(revision, { rules: overrides = {}, services, digest } = {}) {
  const rules = { ...defaults(), ...overrides };
  return {
    type: "scopebond:managed-rules", version: 1, revision, export_id: `rev-${revision}-${INSTALLATION}`, environment_id: "env-1",
    agent_id: "agent-1", installation_id: INSTALLATION, rules, ...(services !== undefined ? { blocked_services: services } : {}),
    rules_digest: digest ?? digestManaged(rules, services),
  };
}
const inspect = (raw) => inspectManaged(raw, { installationId: INSTALLATION, currentRevision: 2 });

function setup(services = SERVICES, rules = {}) {
  const dir = mkdtempSync(join(tmpdir(), "scopebond-services-"));
  const { agentKid } = scaffold(dir, ENFORCE);
  const d = doc(3, { rules, services: services ?? undefined });
  writeFileSync(join(dir, MANAGED_DOC_FILE), JSON.stringify(d));
  writeFileSync(join(dir, "policy.json"), JSON.stringify(compileManaged(defaultRules(), d, agentKid)));
  return { dir, agentKid };
}
async function run(dir, toolUse, { override } = {}) {
  const runtime = createHookRuntime({
    policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"), attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db"), cwd: "/repo",
    ...(override ? { override } : {}),
  });
  try { return await runtime.evaluate(mapClaudeToolUse({ cwd: "/repo", ...toolUse })); }
  finally { runtime.close(); }
}
const bash = (command) => ({ tool_name: "Bash", tool_input: { command } });
const mcp = (server, tool = "search_code") => ({ tool_name: `mcp__${server}__${tool}`, tool_input: { query: "x" } });
const fetchUrl = (url) => ({ tool_name: "WebFetch", tool_input: { url, prompt: "x" } });
const denied = (d) => d.receipts.find((r) => r.payload.realtime_result === "deny")?.payload;

test("the list is optional; a valid one is accepted; a malformed or oversized one refuses the document", () => {
  assert.equal(inspect(doc(3)).ok, true, "a document without the list (an older workspace) is unchanged");
  assert.equal(inspect(doc(3, { services: SERVICES })).ok, true);
  assert.equal(inspect(doc(3, { services: [] })).ok, true, "an empty list is a valid list");
  const scoped = [{ kind: "package", key: "npm:@acme/build-tools" }, { kind: "package", key: "uv:httpx" }, { kind: "host", key: "localhost:3000" }, { kind: "mcp_server", key: "plugin_github_github" }];
  assert.equal(validBlockedServices(scoped), true);
  const full = Array.from({ length: 500 }, (_, i) => ({ kind: "cli", key: `tool${String(i).padStart(3, "0")}` }));
  assert.equal(inspect(doc(3, { services: full })).ok, true, "500 entries is the limit");
  const malformed = {
    "501 entries": [...full, { kind: "cli", key: "tool999" }],
    "a key over 200 characters": [{ kind: "mcp_server", key: "a".repeat(201) }],
    "an unknown kind": [{ kind: "database", key: "postgres" }],
    "a repository": [{ kind: "repository", key: "github.com/acme/app" }],
    "an extra member": [{ kind: "cli", key: "ffmpeg", mode: "block" }],
    "a missing key": [{ kind: "cli" }],
    "a key that is not a string": [{ kind: "cli", key: 7 }],
    "an empty key": [{ kind: "host", key: "" }],
    "a host with a path": [{ kind: "host", key: "example.com/admin" }],
    "a host with a port out of range": [{ kind: "host", key: "example.com:70000" }],
    "a host with port 0": [{ kind: "host", key: "example.com:0" }],
    "a host with the https default port, which a request's host never shows": [{ kind: "host", key: "api.example.com:443" }],
    "a host with the http default port": [{ kind: "host", key: "api.example.com:80" }],
    "a program with a space": [{ kind: "cli", key: "rm -rf" }],
    "a package without a manager": [{ kind: "package", key: "zod" }],
    "a package with a URL": [{ kind: "package", key: "npm:https://example.com/x.tgz" }],
    "a server name with a space": [{ kind: "mcp_server", key: "git hub" }],
    "a dot-dot": [{ kind: "host", key: "a..b" }],
    "not a list": { kind: "cli", key: "ffmpeg" },
    "a list of strings": ["cli:ffmpeg"],
  };
  for (const [name, services] of Object.entries(malformed)) {
    assert.equal(validBlockedServices(services), false, name);
    const refused = inspect(doc(3, { services }));
    assert.equal(refused.ok, false, name);
    assert.equal(refused.reason, "invalid_document", name);
    assert.equal(refused.message, "the blocked services are malformed", name);
  }
});

test("the list is digested with the rules: a changed list, or a digest of the rules alone, is refused", () => {
  const good = doc(3, { services: SERVICES });
  // The contract: sha256 of the canonical JSON of { rules, blocked_services }; the rules alone when the list is absent.
  assert.equal(good.rules_digest, createHash("sha256").update(canonical({ rules: good.rules, blocked_services: SERVICES })).digest("hex"));
  assert.equal(digestManaged(good.rules), digestRules(good.rules));
  assert.notEqual(digestManaged(good.rules, SERVICES), digestManaged(good.rules, SERVICES.slice(1)), "a changed list changes the digest");
  const tampered = { ...good, blocked_services: SERVICES.slice(1) };
  const refused = inspect(tampered);
  assert.equal(refused.ok, false);
  assert.match(refused.message, /do not match their digest/);
  const added = { ...doc(3), blocked_services: SERVICES };
  assert.equal(inspect(added).ok, false, "a list added to a document digested without it is refused");
  const rulesOnly = doc(3, { services: SERVICES, digest: digestRules(defaults()) });
  assert.equal(inspect(rulesOnly).ok, false, "a list the digest does not cover is refused");
  const removed = { ...good };
  delete removed.blocked_services;
  assert.equal(inspect(removed).ok, false, "a list removed from a document digested with it is refused");
  // The same version with a changed list is a newer document (the digest changed).
  const sameVersion = inspectManaged(doc(3, { services: SERVICES.slice(1) }), { installationId: INSTALLATION, currentRevision: 3, currentDigest: good.rules_digest });
  assert.equal(sameVersion.ok, true);
});

test("an absent or empty list compiles to the policy it always was; a list adds one clause per kind before the key policy", () => {
  const { agentKid } = setup([]);
  const plain = compileManaged(defaultRules(), doc(3), agentKid);
  assert.deepEqual(compileManaged(defaultRules(), doc(3, { services: [] }), agentKid), plain);
  const policy = compileManaged(defaultRules(), doc(3, { services: SERVICES }), agentKid);
  const ids = policy.clauses.map((c) => c.id);
  assert.deepEqual(ids.slice(-5), ["blocked-mcp-servers", "blocked-hosts", "blocked-programs", "blocked-packages", "keys"]);
  assert.deepEqual(ids.slice(0, -5), plain.clauses.map((c) => c.id).slice(0, -1), "every ordinary rule comes first, unchanged");
  assert.equal(policyBuilds(policy), true);
  for (const clause of blockedServiceClauses(SERVICES)) assert.equal(clause.mode, "enforce");
  assert.deepEqual(blockedServiceClauses([{ kind: "cli", key: "ffmpeg" }]).map((c) => c.id), ["blocked-programs"]);
  // Each clause denies exactly the values one of its entries names.
  const list = [...SERVICES, { kind: "mcp_server", key: "acme-tools" }, { kind: "mcp_server", key: "__" }, { kind: "cli", key: "c++" }, { kind: "package", key: "npm:@acme/x.y" }];
  const values = ["github", "GITHUB_mcp", "githubx", "acme_tools", "acme", "__", "a__b", "", "api.example.com:8443", "api.example.com", "tracker.example.net:1",
    "tracker.example.netx", "ffmpeg", "C:/bin/ffmpeg.exe", "ffmpeg.sh", "c++", "C++.EXE", "cxx", "npm:zod", "npm:Zod", "pnpm:zod", "npm:@acme/x.y", "npm:@acme/xxy", "pip:requests"];
  for (const clause of blockedServiceClauses(list)) {
    const [param, bound] = Object.entries(clause.param_bounds)[0];
    const kind = Object.keys(BLOCKED_SERVICE_CLAUSES).find((k) => BLOCKED_SERVICE_CLAUSES[k].id === clause.id);
    assert.equal(param, BLOCKED_SERVICE_CLAUSES[kind].param);
    // eslint-disable-next-line security/detect-non-literal-regexp -- the clause under test
    const allows = new RegExp(bound.pattern);
    for (const value of values) {
      assert.equal(!allows.test(value), list.some((e) => e.kind === kind && serviceMatches(e, value)), `${clause.id} ${value}`);
    }
  }
});

test("an MCP server is blocked by the word rule that recognises it, in any case; a longer word is not", async () => {
  const { dir } = setup();
  for (const server of ["github", "GitHub", "github-mcp", "plugin_github_github", "my.github.tools"]) {
    const d = await run(dir, mcp(server));
    assert.equal(d.decision, "deny", server);
    assert.equal(d.code, "blocked_service", server);
    assert.equal(d.clauseId, BLOCKED_SERVICE_CLAUSES.mcp_server.id, server);
    assert.match(d.reason, /Your workspace blocks the MCP server github\./, server);
  }
  for (const server of ["githubx", "gh", "git-hub", "mygithub", "linear"]) assert.equal((await run(dir, mcp(server))).decision, "allow", server);
  // A key of several words matches them in order, as a run.
  const entry = { kind: "mcp_server", key: "acme-tools" };
  assert.equal(serviceMatches(entry, "plugin_acme_tools"), true);
  assert.equal(serviceMatches(entry, "ACME.TOOLS.v2"), true);
  assert.equal(serviceMatches(entry, "acme_other_tools"), false);
  assert.equal(serviceMatches(entry, "acmetools"), false);
  // A name with no letter or digit has no word: it blocks only itself, never every server.
  const bare = { kind: "mcp_server", key: "__" };
  assert.equal(validBlockedServices([bare]), true);
  assert.equal(serviceMatches(bare, "__"), true);
  assert.equal(serviceMatches(bare, "a__b"), false);
  assert.equal(serviceMatches(bare, "github"), false);
});

test("a host is blocked by name in any case; a key with a port blocks that port only, a key without one every port", async () => {
  const { dir } = setup();
  for (const url of ["https://api.example.com:8443/v1", "https://API.Example.COM:8443/v1"]) {
    const d = await run(dir, fetchUrl(url));
    assert.equal(d.decision, "deny", url);
    assert.equal(d.code, "blocked_service", url);
    assert.match(d.reason, /Your workspace blocks the host api\.example\.com:8443\./);
  }
  for (const url of ["https://api.example.com/v1", "https://api.example.com:9443/v1", "https://api.example.community:8443/", "https://xapi.example.com:8443/"]) {
    assert.equal((await run(dir, fetchUrl(url))).decision, "allow", url);
  }
  for (const url of ["https://tracker.example.net/", "http://tracker.example.net:8080/x", "https://TRACKER.example.net./"]) {
    const d = await run(dir, fetchUrl(url));
    assert.equal(d.decision, "deny", url);
    assert.equal(d.code, "blocked_service", url);
    assert.match(d.reason, /Your workspace blocks the host tracker\.example\.net\./);
  }
  assert.equal((await run(dir, fetchUrl("https://sub.tracker.example.net/"))).decision, "allow", "a subdomain is another host");
});

test("a program is blocked by the name the hook reports, with or without a path or an executable suffix", async () => {
  const { dir } = setup();
  for (const command of ["ffmpeg -i a.mov b.mp4", "/usr/local/bin/ffmpeg -version", "FFMPEG.EXE -version", "ls && ffmpeg -version"]) {
    const d = await run(dir, bash(command));
    assert.equal(d.decision, "deny", command);
    assert.equal(d.code, "blocked_service", command);
    assert.equal(d.clauseId, BLOCKED_SERVICE_CLAUSES.cli.id, command);
    assert.match(d.reason, /Your workspace blocks the program ffmpeg\./, command);
  }
  for (const command of ["ffmpeg-normalize in.wav", "ffprobe a.mov", "echo ffmpeg", "ls ./ffmpeg"]) assert.equal((await run(dir, bash(command))).decision, "allow", command);
});

test("a package is blocked on its manager and exact name; the denial is recorded as that package's install", async () => {
  const { dir } = setup();
  for (const [command, key] of [["npm install zod", "npm:zod"], ["npm i -D zod@3.23.8", "npm:zod"], ["pip install Requests==2.31.0", "pip:requests"], ["python3 -m pip install requests", "pip:requests"]]) {
    const d = await run(dir, bash(command));
    assert.equal(d.decision, "deny", command);
    assert.equal(d.code, "blocked_service", command);
    assert.equal(d.clauseId, BLOCKED_SERVICE_CLAUSES.package.id, command);
    assert.ok(d.reason.includes(`Your workspace blocks the package ${key}.`), `${command}: ${d.reason}`);
    const receipt = denied(d);
    assert.equal(receipt.intent.action_type, "package.install");
    const [manager, name] = key.split(":");
    assert.equal(receipt.intent.params.manager, manager);
    assert.equal(receipt.intent.params.name, name);
    assert.equal(receipt.intent.params.package_key, key);
    assert.equal(receipt.realtime_result, "deny");
    assert.equal(validateEvidencePayload(receipt), true);
  }
  // Shown in the computer's own activity like any other block.
  const recent = localActivity(dir, { limit: 20 }).recent_blocks.map((b) => b.summary);
  assert.ok(recent.includes("package.install npm:zod"), JSON.stringify(recent));
  assert.ok(recent.includes("package.install pip:requests"), JSON.stringify(recent));
  for (const command of ["npm install zod-to-json-schema", "pnpm add zod", "yarn add zod", "pip install zod", "npm install", "npm ci", "npm uninstall zod", "pip install requests-oauthlib"]) {
    const d = await run(dir, bash(command));
    assert.equal(d.decision, "allow", command);
    assert.equal(d.receipts.some((r) => r.payload.intent.action_type === "package.install"), false, `${command}: an install that names no blocked package is recorded as before`);
  }
  // Several packages in one install: the blocked one denies the call.
  assert.equal((await run(dir, bash("npm install react zod"))).decision, "deny");
});

test("every named package is checked: beside a requirements file or an editable path, past 100 specs, past an unreadable spec", async () => {
  const { dir } = setup();
  const many = (n) => Array.from({ length: n }, (_, i) => `p${i}`).join(" ");
  for (const command of ["pip install requests -r /dev/null", "pip install -r requirements.txt requests", "pip install requests -e .",
    `npm install ${many(99)} zod`, `npm install ${many(100)} zod`, `npm install ${many(300)} zod`, "npm install @@@ zod", "npm install 'bad spec!' zod"]) {
    const d = await run(dir, bash(command));
    assert.equal(d.decision, "deny", command.slice(0, 60));
    assert.equal(d.code, "blocked_service", command.slice(0, 60));
    assert.match(d.reason, /Your workspace blocks the package (npm:zod|pip:requests)\./, command.slice(0, 60));
  }
  for (const command of ["npm install @@@ react", "pip install -r requirements.txt", "pip install -e .", `npm install ${many(150)}`]) {
    assert.equal((await run(dir, bash(command))).decision, "allow", command.slice(0, 60));
  }
});

test("an install whose named packages none can be read is denied while the workspace blocks packages (fail closed)", async () => {
  const { dir } = setup();
  for (const command of ["npm install @@@", "npm install '$PKG'", "pip install '!!!'"]) {
    const d = await run(dir, bash(command));
    assert.equal(d.decision, "deny", command);
    assert.equal(d.clauseId, BLOCKED_SERVICE_CLAUSES.package.id, command);
    assert.equal(d.code, "blocked_service", command);
    assert.match(d.reason, /packages this install names could not be read/, command);
    assert.match(denied(d).intent.params.package_key, /^(npm|pip):$/);
  }
  // Without a package block, the same command is recorded as it always was.
  const { dir: other } = setup([{ kind: "cli", key: "ffmpeg" }]);
  assert.equal((await run(other, bash("npm install @@@"))).decision, "allow");
});

test("a blocked package decides before its command: the package is the denied action and the command is never evaluated", async () => {
  const { dir } = setup();
  const d = await run(dir, bash("npm install zod"));
  assert.equal(d.decision, "deny");
  assert.deepEqual(d.receipts.map((r) => r.payload.intent.action_type), ["package.install"]);
});

test("without blocked services nothing changes: an install is recorded as the same command, with its install action beside it", async () => {
  const { dir } = setup(null);
  const d = await run(dir, bash("npm install zod"));
  assert.equal(d.decision, "allow");
  assert.deepEqual(d.receipts.map((r) => r.payload.intent.action_type), ["shell.exec", "software.install"]);
});

test("ordinary rules decide first, and a blocked service is a block no allowance and no person can lift", async () => {
  // Network egress set to 'Block, person may allow', with an allowance for the exact fetch: the allowance lets an unlisted
  // site through, but not a blocked host.
  const rules = { "network-egress": { mode: "override", override: terms(), allowed_hosts: ["example.org"] } };
  const { dir } = setup(SERVICES, rules);
  const fetchKey = (url) => actionKey(mapClaudeToolUse({ cwd: "/repo", ...fetchUrl(url) })[0].intent);
  writeAllowances(dir, [
    makeAllowance({ rule: "network-egress", actionKey: fetchKey("https://docs.example.io/"), reason: "reading the vendor docs", osUserDigest: null, lasts: "always" }),
    makeAllowance({ rule: "network-egress", actionKey: fetchKey("https://tracker.example.net/"), reason: "reading the tracker page", osUserDigest: null, lasts: "always" }),
    makeAllowance({ rule: BLOCKED_SERVICE_CLAUSES.cli.id, actionKey: actionKey(mapClaudeToolUse({ cwd: "/repo", ...bash("ffmpeg -version") })[0].intent), reason: "converting the demo video", osUserDigest: null, lasts: "always" }),
  ]);
  const asked = [];
  const override = (agentKid) => {
    const made = createOverrideHandler({ dir, home: dir, agentKid, harness: "claude", permissionMode: "default", waitMs: 50,
      ask: async (_home, request) => { asked.push(request); return { decision: "allow", reason: "I need this one right now", lasts: "once" }; } });
    return made ? { handler: made.handler, hint: () => null } : null;
  };
  const allowed = await run(dir, fetchUrl("https://docs.example.io/"), { override });
  assert.equal(allowed.decision, "allow", "the allowance lets an unlisted site through");
  const blocked = await run(dir, fetchUrl("https://tracker.example.net/"), { override });
  assert.equal(blocked.decision, "deny", "the same kind of allowance does not carry a blocked host through");
  assert.equal(blocked.clauseId, "allowed-sites", "the ordinary rule is evaluated first and named");
  assert.equal(blocked.code, undefined);
  const program = await run(dir, bash("ffmpeg -version"), { override });
  assert.equal(program.decision, "deny", "an allowance never lifts a blocked service");
  assert.equal(program.clauseId, BLOCKED_SERVICE_CLAUSES.cli.id);
  assert.deepEqual(asked, [], "nobody is asked to allow a blocked service");
});

test("the explanation names the service even without the list at hand, and says it was only recorded when it already ran", () => {
  const intent = { action_type: "shell.exec", params: { program: "ffmpeg" } };
  assert.equal(explainDeny({ clauseId: "blocked-programs", detail: "param program fails pattern", intent }).split("\n")[0],
    "Scopebond blocked shell.exec ffmpeg: Your workspace blocks the program ffmpeg.");
  assert.match(explainDeny({ clauseId: "blocked-mcp-servers", detail: "x", intent: { action_type: "mcp.tool.call", params: { server: "plugin_github_github", tool: "t" } }, services: SERVICES }),
    /Your workspace blocks the MCP server github\./);
  assert.match(explainDeny({ clauseId: "blocked-programs", detail: "x", intent, postHoc: true }), /^Scopebond recorded an out-of-policy shell\.exec ffmpeg/);
});

test("the hook says it reads service rules, and a synced list is enforced; a tampered one is refused and the rules in force stay", async () => {
  assert.ok(HOOK_CAPABILITIES.includes(SERVICE_RULES_CAPABILITY));
  const dir = mkdtempSync(join(tmpdir(), "scopebond-services-sync-"));
  try {
    const { agentKid } = scaffold(dir, ENFORCE);
    writeFileSync(join(dir, "cloud.json"), JSON.stringify({ url: "https://cloud.example.test", credential: "sbm_x", credential_id: "c", organization_id: "o", environment_id: "env-1", gateway_id: INSTALLATION, attester_kid: "k", scopes: [], expires_at: "2099-01-01T00:00:00Z" }));
    const seen = [];
    const acks = [];
    let answer = doc(3, { services: SERVICES });
    const workspace = async (url, init) => {
      if (String(url).endsWith("/v1/policy/ack")) { acks.push({ capabilities: init.headers["x-scopebond-hook-capabilities"], body: JSON.parse(init.body) }); return new Response("{}", { status: 200 }); }
      seen.push(init.headers["x-scopebond-hook-capabilities"]);
      return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json", etag: `"${answer.revision}"` } });
    };
    const applied = await syncPolicy(dir, { agentKid, hookVersion: "0.24.0", policyBuilds, fetchImpl: workspace });
    assert.equal(applied.state, "applied", JSON.stringify(applied));
    assert.deepEqual(seen, ["allowances,session_budgets,service_rules,unblock_terms,unlimited_terms,packs"]);
    // The confirmation carries the same capabilities, so the workspace compares the digest of the document it sent this hook.
    assert.deepEqual(acks.map((a) => [a.capabilities, a.body.result, a.body.rules_digest]), [["allowances,session_budgets,service_rules,unblock_terms,unlimited_terms,packs", "loaded", answer.rules_digest]]);
    assert.ok(isManaged(dir));
    const installed = JSON.parse(readFileSync(join(dir, "policy.json"), "utf8"));
    assert.ok(installed.clauses.some((c) => c.id === "blocked-programs"));
    assert.equal((await run(dir, bash("ffmpeg -version"))).decision, "deny");

    answer = { ...doc(4, { services: SERVICES }), blocked_services: [] };
    const refused = await syncPolicy(dir, { agentKid, hookVersion: "0.24.0", policyBuilds, fetchImpl: workspace });
    assert.equal(refused.state, "refused");
    assert.equal(readMeta(dir).revision, 3, "the rules in force stay");
    assert.equal((await run(dir, bash("ffmpeg -version"))).decision, "deny", "and still block");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a shared test vector: a workspace document with blocked services and the digest both sides compute for it", () => {
  // The exact document a workspace sends, byte for byte, and its rules_digest: the hook must compute the same value.
  const DOCUMENT = '{"agent_id":"agent-1","blocked_services":[{"key":"curl","kind":"cli"},{"key":"evil.example","kind":"host"},{"key":"pastebin.com","kind":"host"},{"key":"github","kind":"mcp_server"},{"key":"npm:left-pad","kind":"package"}],"environment_id":"env-a","export_id":"rev-3-gw-1","installation_id":"gw-1","revision":3,"rules":{"ci-config-write":{"mode":"monitor"},"destructive-shell":{"mode":"monitor"},"force-push-protected":{"mode":"block"},"network-egress":{"mode":"monitor"},"push-protected":{"mode":"block","protected_branches":["prod"]},"secret-read":{"mode":"block"}},"rules_catalog_version":"coding-pack/3","rules_digest":"00e420f45bab21f46b5cb893f2cecb4ea82c1b0afea6ef6db32965c7f38b7fc6","type":"scopebond:managed-rules","version":1}';
  const RULES_DIGEST = "00e420f45bab21f46b5cb893f2cecb4ea82c1b0afea6ef6db32965c7f38b7fc6";
  const vector = JSON.parse(DOCUMENT);
  assert.equal(digestManaged(vector.rules, vector.blocked_services), RULES_DIGEST);
  assert.equal(vector.rules_digest, RULES_DIGEST);
  const inspected = inspectManaged(vector, { installationId: "gw-1", currentRevision: null });
  assert.equal(inspected.ok, true, inspected.message);
});
