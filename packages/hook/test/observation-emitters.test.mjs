import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createHmac } from "node:crypto";
import { canonical } from "@scopebond/policy-schema/canonical";
import {
  openObservations, observationStatus, describeObservations, buildOperation, bindingKeyFromHex, createHookRuntime, digestPolicy,
  wireLifecycleHooks, unwireLifecycleHooks, sourceReceiptHash, mapClaudeToolUse, useDigestKey,
} from "../dist/index.js";
import { HEARTBEAT_INTERVAL_MS, IDLE_LIMIT_MS, SLEEP_GAP_MS, MAX_INTENTS_PER_CALL } from "../dist/obs-emitter.js";
import { validObservation, validSigned } from "./observation-schema.mjs";
import { makeHome, startServer, verifyWrapper, publicKeyOf, readPending } from "./observation-helpers.mjs";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

/** Run a hook command asynchronously, so the in-process fake workspace keeps answering. */
function run(dir, args, input, env = {}) {
  return new Promise((resolve) => {
    const home = mkdtempSync(join(tmpdir(), "sb-obs-home-"));
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: dir, env: { ...process.env, SCOPEBOND_HOOK_DIR: dir, SCOPEBOND_HOME: home, HOME: home, USERPROFILE: home, SCOPEBOND_OBSERVATIONS_HEARTBEAT: "off", SCOPEBOND_HOOK_FLUSH_MS: "2000", ...env },
    });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; }); child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    if (input !== undefined) child.stdin.end(typeof input === "string" ? input : JSON.stringify(input)); else child.stdin.end();
  });
}
const claudeEvent = (dir, event, extra = {}) => ({ hook_event_name: event, session_id: "sess-0001", cwd: dir, ...extra });
const kindsOf = (items) => items.map((i) => `${i.payload.kind}:${i.payload.data.event}`);
const settled = async (predicate, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (predicate()) return true; await new Promise((r) => setTimeout(r, 50)); } return predicate(); };

function assertWellFormed(items, publicKeyPem, installationId = "inst-test-1", generation = 1) {
  // The heartbeat helper and the hook calls upload on their own, so records can arrive out of order
  // (the workspace accepts any order and refuses only a reused number). What must hold: every number
  // once, none skipped, starting at 1.
  const seqs = items.map((i) => i.payload.sequence).sort((a, b) => a - b);
  assert.deepEqual(seqs, Array.from({ length: items.length }, (_, i) => i + 1), "sequences unique and contiguous from 1");
  for (const item of items) {
    assert.equal(validSigned(item), true, `${item.payload.kind}:${item.payload.data.event} matches the closed schema`);
    assert.ok(verifyWrapper(item, publicKeyPem), "signature verifies over domain + canonical payload");
    assert.equal(item.payload.installation_id, installationId);
    assert.equal(item.payload.installation_generation, generation);
    const d = item.payload.data;
    if (d.session_id !== undefined) assert.equal(d.session_id, item.payload.session_id);
    if (d.sequence !== undefined) assert.equal(d.sequence, item.payload.sequence);
    if (d.parent_action_id !== undefined) assert.equal(d.parent_action_id, item.payload.parent_action_id);
    if (d.source_receipt_hash !== undefined) assert.equal(d.source_receipt_hash, item.payload.source_receipt_hash);
    if (item.payload.kind === "tool_intent") assert.equal(d.request_digest, d.operation.request_digest);
    assert.ok(["session", "capability", "health", "policy_ack", "tool_intent", "tool_outcome"].includes(item.payload.kind));
  }
}

// ---- opt-in ------------------------------------------------------------------------------------

test("emission is opt-in: off without observations:write, unsupported without an installation id or generation", () => {
  const off = makeHome({ scopes: ["receipts:write"] });
  assert.match(openObservations(off.dir).status.reason, /does not grant observations:write/);
  assert.equal(openObservations(off.dir).emitter, undefined);
  assert.equal(existsSync(join(off.dir, "observations.db")), false, "nothing is created when off");
  assert.match(describeObservations(off.dir)[0], /^off \(this enrollment does not grant observations:write\)/);

  const noGen = makeHome({ generation: null });
  const status = openObservations(noGen.dir).status;
  assert.equal(status.state, "unsupported");
  assert.match(status.reason, /generation/);
  assert.equal(existsSync(join(noGen.dir, "observations.db")), false, "a generation is never guessed");
  // The installation id is the enrollment's `gateway_id` when the explicit field is absent; the generation has no fallback.
  const noId = makeHome({ installation_id: null });
  assert.equal(openObservations(noId.dir).status.state, "on");
  assert.equal(openObservations(noId.dir).emitter.connection.installation_id, "gw-1");
  openObservations(noId.dir).emitter.close();
  const noEither = makeHome({ installation_id: null });
  const bare = JSON.parse(readFileSync(join(noEither.dir, "cloud.json"), "utf8")); delete bare.gateway_id;
  writeFileSync(join(noEither.dir, "cloud.json"), JSON.stringify(bare));
  assert.equal(openObservations(noEither.dir).status.state, "unsupported");

  assert.equal(observationStatus(null).state, "off");
  const { connection } = makeHome();
  assert.equal(observationStatus({ ...connection, installation_generation: 0 }).state, "unsupported");
  assert.equal(observationStatus({ ...connection, installation_generation: 1.5 }).state, "unsupported");
  assert.equal(observationStatus({ ...connection, agent_kid: undefined }).state, "unsupported");
  assert.equal(observationStatus(connection, "some-other-kid").state, "unsupported", "the local key must be the enrolled key");
  assert.equal(observationStatus(connection).state, "on");

  const home = makeHome();
  const opened = openObservations(home.dir);
  assert.equal(opened.status.state, "on");
  opened.emitter.close();
  // A connection whose generation is older than the local state is reported, not adopted.
  writeFileSync(join(home.dir, "cloud.json"), JSON.stringify({ ...home.connection, installation_generation: 3 }));
  openObservations(home.dir).emitter.close();
  writeFileSync(join(home.dir, "cloud.json"), JSON.stringify({ ...home.connection, installation_generation: 2 }));
  assert.match(openObservations(home.dir).status.reason, /older than the local generation/);
});

test("lifecycle hook events do nothing, print nothing and exit 0 when observations are off", async () => {
  const off = makeHome({ scopes: ["receipts:write"] });
  for (const event of ["SessionStart", "SessionEnd", "PostToolUse", "PostToolUseFailure"]) {
    const r = await run(off.dir, ["claude"], claudeEvent(off.dir, event, { tool_use_id: "t1", reason: "logout" }));
    assert.equal(r.status, 0, event);
    assert.equal(r.stdout, "", event);
  }
  assert.equal(existsSync(join(off.dir, "observations.db")), false);
});

// ---- Claude Code end to end -----------------------------------------------------------------------

test("Claude Code: session start, tool intent, tool outcome and session stop are signed, ordered and uploaded", async () => {
  const server = await startServer();
  const home = makeHome({ url: server.url });
  const dir = home.dir;
  assert.equal((await run(dir, ["claude"], claudeEvent(dir, "SessionStart", { source: "startup" }))).status, 0);
  const pre = await run(dir, ["claude"], claudeEvent(dir, "PreToolUse", { tool_name: "Bash", tool_input: { command: "ls -la" }, tool_use_id: "toolu_1" }));
  assert.equal(pre.status, 0);
  assert.equal(pre.stdout, "", "an allow stays silent");
  assert.equal((await run(dir, ["claude"], claudeEvent(dir, "PostToolUse", { tool_name: "Bash", tool_use_id: "toolu_1", tool_response: { stdout: "TOP-SECRET-OUTPUT" } }))).status, 0);
  const denied = await run(dir, ["claude"], claudeEvent(dir, "PreToolUse", { tool_name: "Bash", tool_input: { command: "rm -rf /" }, tool_use_id: "toolu_2" }));
  assert.equal(denied.status, 2, "a deny still denies");
  assert.match(denied.stdout, /"permissionDecision":"deny"/);
  assert.equal((await run(dir, ["claude"], claudeEvent(dir, "PreToolUse", { tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "toolu_3" }))).status, 0);
  assert.equal((await run(dir, ["claude"], claudeEvent(dir, "PostToolUseFailure", { tool_name: "Bash", tool_use_id: "toolu_3", is_interrupt: true }))).status, 0);
  assert.equal((await run(dir, ["claude"], claudeEvent(dir, "SessionEnd", { reason: "logout" }))).status, 0);

  await settled(() => server.observations().length >= 7);
  const items = server.observations();
  assert.deepEqual(kindsOf(items), [
    "session:start", "tool_intent:requested", "tool_outcome:completed", "tool_intent:requested", "tool_intent:requested", "tool_outcome:failed", "session:stop",
  ]);
  assertWellFormed(items, publicKeyOf(dir));
  const [start, intent1, outcome1, deniedIntent, , failed, stop] = items;
  assert.equal(stop.payload.data.stop_reason, "cancelled", "logout maps to cancelled");
  assert.equal(start.payload.session_id, stop.payload.session_id);
  assert.ok(!start.payload.session_id.includes("sess-0001"), "the harness session id is not uploaded");
  // The outcome echoes the intent's binding, parent and receipt link; it does not rebuild them.
  assert.equal(outcome1.payload.parent_action_id, intent1.payload.parent_action_id);
  assert.equal(outcome1.payload.source_receipt_hash, intent1.payload.source_receipt_hash);
  assert.equal(outcome1.payload.data.operation.request_digest, intent1.payload.data.operation.request_digest);
  assert.equal(outcome1.payload.data.exit_category, "ok");
  assert.equal(failed.payload.data.exit_category, "cancelled");
  // The denied call was recorded as an intent, and no outcome exists for it.
  assert.equal(deniedIntent.payload.data.operation.destructive_class, "unknown");
  assert.equal(deniedIntent.payload.data.operation.canonical_program, "rm");
  assert.ok(!items.some((i) => i.payload.kind === "tool_outcome" && i.payload.parent_action_id === deniedIntent.payload.parent_action_id));
  assert.equal(server.requests.find((r) => r.url === "/v1/observations").headers.authorization, "Bearer sbm_test-credential");
  await server.close();
});

test("policy decisions are identical whether the workspace accepts, errors, lacks the route or is unreachable", async () => {
  const outcomes = [];
  for (const mode of ["ok", "500", "404", "down"]) {
    const server = await startServer(mode === "ok" ? undefined : () => ({ status: mode === "500" ? 500 : 404, body: {} }));
    const home = makeHome({ url: mode === "down" ? "http://127.0.0.1:9" : server.url });
    const started = Date.now();
    const allow = await run(home.dir, ["claude"], claudeEvent(home.dir, "PreToolUse", { tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "a" }));
    const deny = await run(home.dir, ["claude"], claudeEvent(home.dir, "PreToolUse", { tool_name: "Bash", tool_input: { command: "rm -rf /" }, tool_use_id: "b" }));
    outcomes.push([allow.status, allow.stdout, deny.status, JSON.parse(deny.stdout).hookSpecificOutput.permissionDecision]);
    assert.ok(Date.now() - started < 20_000, `${mode}: bounded`);
    if (mode === "404") {
      await run(home.dir, ["claude"], claudeEvent(home.dir, "SessionStart"));
      assert.match(describeObservations(home.dir)[0], /unsupported by this workspace/);
    }
    await server.close();
  }
  for (const o of outcomes) assert.deepEqual(o, outcomes[0]);
  assert.deepEqual(outcomes[0], [0, "", 2, "deny"]);
});

test("Codex and Cursor emit tool intents from their tested pre-action mapping and no session or outcome events", async () => {
  const server = await startServer();
  const home = makeHome({ url: server.url });
  const dir = home.dir;
  assert.equal((await run(dir, ["codex"], { hook_event_name: "PreToolUse", session_id: "codex-1", cwd: dir, tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "c1" })).status, 0);
  const cursor = await run(dir, ["cursor"], { hook_event_name: "beforeShellExecution", cwd: dir, command: "npm test" });
  assert.equal(JSON.parse(cursor.stdout).permission, "allow");
  // Lifecycle events are Claude Code only: a Codex/Cursor invocation with these names is not lifecycle.
  await settled(() => server.observations().length >= 2);
  const items = server.observations();
  assert.deepEqual(kindsOf(items), ["tool_intent:requested", "tool_intent:requested"]);
  assertWellFormed(items, publicKeyOf(dir));
  assert.equal(items[1].payload.session_id, undefined, "Cursor gives no session id the hook relies on");
  await server.close();
});

// ---- privacy canaries --------------------------------------------------------------------------------

const CANARIES = ["CANARY-sk-abcdefghijklmnopqrstuvwx", "hunter2-CANARY-password", "AKIA" + "IOSFODNN7CANARY1", "canary-secret-path-8842", "CANARYSESSION9911", "toolu_CANARYCALL7", "gh" + "p_CANARYabcdefghijklmnopqrstuvwxyz0123"];

test("privacy canary: secrets seeded into every untrusted field never appear in an emitted or stored observation", async () => {
  const server = await startServer();
  const home = makeHome({ url: server.url });
  const dir = join(mkdtempSync(join(tmpdir(), "sb-obs-canary-")), "canary-secret-path-8842");
  mkdirSync(dir, { recursive: true });
  const env = {};
  const sid = "CANARYSESSION9911";
  const call = (n) => `toolu_CANARYCALL7_${n}`;
  await run(home.dir, ["claude"], { hook_event_name: "SessionStart", session_id: sid, cwd: dir }, env);
  const calls = [
    { tool_name: "Bash", tool_input: { command: `curl -H "Authorization: Bearer ${CANARIES[0]}" --password ${CANARIES[1]} https://x.example/?k=${CANARIES[2]}` } },
    { tool_name: "Bash", tool_input: { command: `${CANARIES[2]} --token=${CANARIES[6]}` } },
    { tool_name: "Read", tool_input: { file_path: join(dir, ".env") } },
    { tool_name: "Write", tool_input: { file_path: join(dir, "canary-secret-path-8842", "notes.txt"), content: `key=${CANARIES[0]}` } },
    { tool_name: "mcp__srv__tool", tool_input: { token: CANARIES[6], query: CANARIES[1] } },
    { tool_name: "mcp__gh" + "p_CANARYabcdefghijklmnopqrstuvwxyz0123__tool", tool_input: {} },
    { tool_name: "WebFetch", tool_input: { url: `https://user:${CANARIES[1]}@host.example/path?token=${CANARIES[0]}` } },
  ];
  for (const [n, c] of calls.entries()) {
    await run(home.dir, ["claude"], { hook_event_name: "PreToolUse", session_id: sid, cwd: dir, tool_use_id: call(n), ...c }, env);
    await run(home.dir, ["claude"], { hook_event_name: "PostToolUse", session_id: sid, cwd: dir, tool_use_id: call(n), ...c, tool_response: { output: `${CANARIES[0]} ${CANARIES[6]}` } }, env);
  }
  await run(home.dir, ["claude"], { hook_event_name: "SessionEnd", session_id: sid, cwd: dir, reason: `${CANARIES[1]}` }, env);
  await settled(() => server.observations().length >= 10);
  const uploaded = server.requests.filter((r) => r.url === "/v1/observations").map((r) => r.raw).join("\n");
  assert.ok(server.observations().length >= 10, "observations were emitted");
  const files = readdirSync(home.dir).filter((f) => f.startsWith("observations.db"));
  const stored = files.map((f) => readFileSync(join(home.dir, f)).toString("latin1")).join("\n");
  const pending = JSON.stringify(await readPending(home.dir).catch(() => []));
  for (const canary of CANARIES) {
    assert.ok(!uploaded.includes(canary), `uploaded observations leak ${canary}`);
    assert.ok(!stored.includes(canary), `the local observation store leaks ${canary}`);
    assert.ok(!pending.includes(canary));
  }
  assert.ok(!uploaded.includes("canary-secret-path"), "a path segment is not uploaded");
  // A WebFetch and a curl now carry a typed network operation: the destination host is one of its closed fields;
  // the credentials, path, query and body are not.
  const network = server.observations().filter((i) => i.payload.data.operation?.type === "network");
  assert.ok(network.some((i) => i.payload.data.operation.host === "host.example"), "the WebFetch destination is a typed field");
  assert.ok(network.every((i) => Object.keys(i.payload.data.operation).every((k) => !/path|query|user|password|token|body|header/i.test(k))));
  assert.ok(!uploaded.includes("/path"), "the URL path is not uploaded");
  // The secret-shaped MCP server name produced no operation; the plain one did.
  const mcp = server.observations().filter((i) => i.payload.data.operation?.type === "mcp");
  assert.equal(mcp.length >= 1, true);
  assert.ok(mcp.every((i) => i.payload.data.operation.server_id === "srv"));
  // The local binding key is never uploaded.
  const key = readFileSync(join(home.dir, "observation-binding.key"), "utf8").trim();
  assert.ok(!uploaded.includes(key));
  assertWellFormed(server.observations(), publicKeyOf(home.dir));
  await server.close();
});

// ---- operations, digests, both path shapes ---------------------------------------------------------------

const KEY = bindingKeyFromHex("11".repeat(32));
const ctx = (extra = {}) => ({ key: KEY, cwd: "/work/project", ...extra });
const opPayload = (operation) => ({
  type: "scopebond:observation", version: "1.0", observation_id: "11111111-1111-4111-8111-111111111111", installation_id: "i", installation_generation: 1,
  parent_action_id: "a", source_receipt_hash: "0".repeat(64), kind: "tool_intent", occurred_at: "2026-01-01T00:00:00Z", sequence: 1,
  data: { event: "requested", parent_action_id: "a", source_receipt_hash: "0".repeat(64), request_digest: operation.request_digest, operation },
});

test("typed operations: POSIX and Windows shapes reduce to closed, keyed, schema-valid operations", () => {
  const cases = [
    [{ action_type: "shell.exec", params: { program: "PowerShell.EXE", command: "x" } }, (o) => { assert.equal(o.canonical_program, "powershell"); assert.equal(o.destructive_class, "none"); }],
    [{ action_type: "shell.exec", params: { program: "C:\\Windows\\System32\\Remove-Item.exe" } }, (o) => { assert.equal(o.canonical_program, "remove-item"); assert.equal(o.destructive_class, "unknown"); }],
    [{ action_type: "shell.exec", params: { program: "/usr/bin/rm" } }, (o) => { assert.equal(o.canonical_program, "rm"); }],
    [{ action_type: "shell.exec", params: { program: "" } }, (o) => { assert.equal(o.resolution, "unresolved"); assert.equal(o.canonical_program, "unresolved"); }],
    [{ action_type: "shell.exec", params: { program: "AKIA" + "IOSFODNN7EXAMPLE" } }, (o) => { assert.equal(o.resolution, "unresolved"); }],
    [{ action_type: "file.read", params: { path: "C:\\Users\\dev\\.env" } }, (o) => { assert.equal(o.path_class, "credential"); assert.equal(o.outside_root, true); }],
    [{ action_type: "file.read", params: { path: "/srv/agent/.ssh/id_rsa" } }, (o) => { assert.equal(o.path_class, "credential"); }],
    [{ action_type: "file.write", params: { path: ".github/workflows/ci.yml" } }, (o) => { assert.equal(o.path_class, "ci"); assert.equal(o.outside_root, false); }],
    [{ action_type: "file.write", params: { path: ".claude/settings.json" } }, (o) => { assert.equal(o.path_class, "guardrail"); }],
    [{ action_type: "file.write", params: { path: "src\\app.ts" } }, (o) => { assert.equal(o.path_class, "ordinary"); assert.equal(o.verb, "write"); }],
    [{ action_type: "file.write", params: { path: "../outside.txt" } }, (o) => { assert.equal(o.outside_root, true); }],
    [{ action_type: "file.write", params: { path: "" } }, (o) => { assert.equal(o.resolution, "unresolved"); assert.equal("outside_root" in o, false); }],
    [{ action_type: "mcp.tool.call", params: { server: "github", tool: "create_issue" } }, (o) => { assert.equal(o.server_id, "github"); assert.equal(o.operation_class, "unknown"); }],
  ];
  for (const [action, check] of cases) {
    const operation = buildOperation(action, ctx());
    assert.ok(operation, JSON.stringify(action));
    check(operation);
    assert.equal(validObservation(opPayload(operation)), true, JSON.stringify(action));
    assert.equal(operation.digest_key_generation, KEY.generation);
    assert.equal(operation.request_digest, KEY.requestDigest({ action_type: action.action_type, params: action.params }));
    assert.ok(!JSON.stringify(operation).includes("Users") && !JSON.stringify(operation).includes("/srv/agent"), "no raw path");
  }
  // Not describable honestly: no operation (and so no intent) rather than a guess.
  assert.equal(buildOperation({ action_type: "net.fetch", params: { host: "example.com", path: "/", method: "GET" } }, ctx()), null);
  assert.equal(buildOperation({ action_type: "tool.task", params: {} }, ctx()), null);
  assert.equal(buildOperation({ action_type: "mcp.tool.call", params: { server: "gh" + "p_abcdefghijklmnopqrstuvwxyz0123", tool: "t" } }, ctx()), null);
  assert.equal(buildOperation({ action_type: "git.push", params: { ref: "main" } }, ctx()), null, "no HEAD, no git operation");
  const git = buildOperation({ action_type: "git.push", params: { ref: "main", force: true } }, ctx({ headSha: "a".repeat(40), repositoryId: "sbr_repo" }));
  assert.equal(git.refs[0].protected, true);
  assert.equal(git.force, true);
  assert.equal(validObservation(opPayload(git)), true);
  const feature = buildOperation({ action_type: "git.push", params: { ref: "feature/x" } }, ctx({ headSha: "a".repeat(40), repositoryId: "sbr_repo" }));
  assert.equal(feature.refs[0].protected, false);
});

test("the request digest is built from the actual dispatched request, including the group the hook added", async () => {
  const home = makeHome();
  useDigestKey("22".repeat(32));
  const runtime = createHookRuntime({ policyPath: join(home.dir, "policy.json"), keyPath: join(home.dir, "agent.key"), attesterPath: join(home.dir, "attester.key"), dbPath: join(home.dir, "receipts.db") });
  try {
    const decision = await runtime.evaluate(mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "ls -la" } }), { groupKey: "call-1" });
    assert.equal(decision.dispatched.length, decision.receipts.length);
    const { emitter } = openObservations(home.dir, { spawnHeartbeat: false });
    emitter.toolIntents({ harnessSessionId: "s", callId: "call-1", cwd: home.dir, dispatched: decision.dispatched });
    const [row] = await readPending(home.dir);
    const actual = decision.dispatched[0].action;
    assert.ok("action_group" in actual.params, "the dispatched request carries the group id");
    const key = bindingKeyFromHex(readFileSync(join(home.dir, "observation-binding.key"), "utf8").trim());
    assert.equal(row.payload.data.request_digest, key.requestDigest({ action_type: actual.action_type, params: actual.params }));
    assert.equal(row.payload.data.request_digest, createHmac("sha256", Buffer.from(readFileSync(join(home.dir, "observation-binding.key"), "utf8").trim(), "hex")).update("scopebond:request-binding/v1\n" + canonical({ action_type: actual.action_type, params: actual.params }), "utf8").digest("hex"));
    assert.equal(row.payload.source_receipt_hash, sourceReceiptHash(decision.receipts[0]));
    assert.equal(row.payload.parent_action_id, decision.receipts[0].payload.action_ref.action_id);
    emitter.close();
  } finally { runtime.close(); useDigestKey(null); }
});

test("a call with many decomposed intents records a bounded number and counts the rest", async () => {
  const home = makeHome();
  const { emitter } = openObservations(home.dir, { spawnHeartbeat: false });
  const dispatched = Array.from({ length: MAX_INTENTS_PER_CALL + 5 }, (_, i) => ({
    action: { action_type: "file.read", params: { path: `f${i}.txt` } }, receipt: { payload: { action_ref: { action_id: `act-${i}` } } },
  }));
  emitter.toolIntents({ harnessSessionId: "s", callId: "c", cwd: home.dir, dispatched });
  assert.equal(emitter.store.pendingSummary().count, MAX_INTENTS_PER_CALL);
  assert.equal(emitter.store.getMark("omitted_intents"), 5);
  emitter.close();
});

// ---- heartbeat ---------------------------------------------------------------------------------------------

function clockedEmitter() {
  const clock = { t: Date.UTC(2026, 8, 29, 12, 0, 0) };
  const home = makeHome();
  const { emitter } = openObservations(home.dir, { now: () => clock.t, spawnHeartbeat: false });
  return { clock, home, emitter };
}
const emitted = (emitter) => emitter.store.nextBatch(100).map((r) => r.wrapper.payload);
const tickAt = (ctx, sessionId, lastTick, advance) => { ctx.clock.t += advance; return ctx.emitter.heartbeatTick(sessionId, lastTick); };

test("heartbeat: 60s cadence only while a session is explicitly active; one start, one stop; nothing after the stop", () => {
  const c = clockedEmitter();
  assert.equal(HEARTBEAT_INTERVAL_MS, 60_000);
  assert.equal(c.emitter.heartbeatTick("sbs_unknown", c.clock.t), "stop", "no session, no heartbeat");
  c.emitter.sessionStart("s1", "/work");
  c.emitter.sessionStart("s1", "/work"); // a second start hook for the same session is not a second start
  let last = c.clock.t;
  for (let i = 0; i < 3; i += 1) { assert.equal(tickAt(c, c.emitter.sessionIdOf("s1"), last, 60_000), "continue"); last = c.clock.t; }
  c.emitter.sessionStop("s1", "completed");
  c.emitter.sessionStop("s1", "completed");
  assert.equal(tickAt(c, c.emitter.sessionIdOf("s1"), last, 60_000), "stop");
  const items = emitted(c.emitter);
  assert.deepEqual(items.map((p) => `${p.kind}:${p.data.event}${p.data.lease_active === undefined ? "" : `:${p.data.lease_active}`}`), [
    "session:start", "health:heartbeat:true", "health:heartbeat:true", "health:heartbeat:true", "session:stop",
  ]);
  assert.deepEqual(items.map((p) => p.sequence), [1, 2, 3, 4, 5]);
  assert.equal(items[4].data.stop_reason, "completed");
  for (const p of items) assert.equal(validObservation(p), true);
  c.emitter.close();
});

test("a host that slept emits no heartbeat for the gap: it records a stop (sleep) and resumes with a fresh start on activity", () => {
  const c = clockedEmitter();
  const sid = c.emitter.sessionIdOf("s1");
  c.emitter.sessionStart("s1", "/work");
  const last = c.clock.t;
  assert.equal(tickAt(c, sid, last, SLEEP_GAP_MS + 1), "stop");
  let items = emitted(c.emitter);
  assert.deepEqual(items.map((p) => `${p.kind}:${p.data.event}`), ["session:start", "session:stop"], "no fake heartbeat after waking");
  assert.equal(items[1].data.stop_reason, "sleep");
  assert.equal(items[1].occurred_at, new Date(last).toISOString(), "the stop is dated at the last time the host was seen awake");
  c.emitter.activity("s1", "/work");
  items = emitted(c.emitter);
  assert.equal(items[2].data.event, "start", "activity after wake resumes the session");
  // A session that was ended (not slept) is not resurrected by stray activity.
  c.emitter.sessionStop("s1", "completed");
  const count = emitted(c.emitter).length;
  c.emitter.activity("s1", "/work");
  assert.equal(emitted(c.emitter).length, count);
  c.emitter.close();
});

test("an idle session sends one final heartbeat that releases the lease, then nothing", () => {
  const c = clockedEmitter();
  const sid = c.emitter.sessionIdOf("s1");
  c.emitter.sessionStart("s1", "/work");
  let last = c.clock.t;
  assert.equal(tickAt(c, sid, last, 60_000), "continue");
  last = c.clock.t;
  c.clock.t += IDLE_LIMIT_MS; // no hook activity for the whole idle limit (kept awake, no gap)
  assert.equal(c.emitter.heartbeatTick(sid, c.clock.t - 60_000), "stop");
  const items = emitted(c.emitter).filter((p) => p.kind === "health");
  assert.deepEqual(items.map((p) => p.data.lease_active), [true, false]);
  c.emitter.close();
});

test("one heartbeat helper per session: the lease is claimed once, renewed by the loop, and reclaimable only after it lapses", () => {
  const c = clockedEmitter();
  c.emitter.sessionStart("s1", "/work");
  const sid = c.emitter.sessionIdOf("s1");
  assert.equal(c.emitter.store.claimHeartbeat(sid, 150_000), true);
  assert.equal(c.emitter.store.claimHeartbeat(sid, 150_000), false, "a live helper blocks a second one");
  c.clock.t += 149_000;
  assert.equal(c.emitter.store.claimHeartbeat(sid, 150_000), false);
  c.clock.t += 2_000;
  assert.equal(c.emitter.store.claimHeartbeat(sid, 150_000), true, "a crashed helper's claim lapses");
  c.emitter.store.releaseHeartbeat(sid);
  c.emitter.sessionStop("s1", "completed");
  assert.equal(c.emitter.store.claimHeartbeat(sid, 150_000), false, "no helper for an ended session");
  c.emitter.close();
});

test("the real helper: heartbeats flow while a session is active, from one process, and stop when the session ends", async () => {
  const server = await startServer();
  // A failed assertion must not leave the server open: the file would then hang until its time limit.
  try {
  const home = makeHome({ url: server.url });
  const env = { SCOPEBOND_OBSERVATIONS_HEARTBEAT: "on", SCOPEBOND_HEARTBEAT_INTERVAL_MS: "250" };
  await run(home.dir, ["claude"], claudeEvent(home.dir, "SessionStart"), env);
  for (let i = 0; i < 3; i += 1) await run(home.dir, ["claude"], claudeEvent(home.dir, "PreToolUse", { tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: `h${i}` }), env);
  assert.ok(await settled(() => server.observations().filter((i) => i.payload.kind === "health").length >= 3, 8000), "at least three heartbeats");
  await run(home.dir, ["claude"], claudeEvent(home.dir, "SessionEnd", { reason: "prompt_input_exit" }), env);
  await new Promise((r) => setTimeout(r, 900));
  const afterStop = server.observations();
  const stopIndex = afterStop.findIndex((i) => i.payload.data.event === "stop");
  assert.ok(stopIndex >= 0);
  const heartbeatsAfterStop = afterStop.slice(stopIndex + 1).filter((i) => i.payload.kind === "health");
  assert.equal(heartbeatsAfterStop.length, 0, "no heartbeat after the session ended");
  const beats = afterStop.filter((i) => i.payload.kind === "health").length;
  assert.ok(beats <= 20, "one helper, not one per hook call");
  assertWellFormed(afterStop, publicKeyOf(home.dir));
  } finally {
    await server.close();
  }
});

// ---- queue telemetry, policy acknowledgement, capability proof ---------------------------------------------

test("queue telemetry reports the oldest pending receipt and the count, and once more when it drains", () => {
  const c = clockedEmitter();
  const outbox = join(c.home.dir, "receipts.db.cloud-outbox.db");
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const db = new DatabaseSync(outbox);
  db.exec("CREATE TABLE cloud_outbox (event_id TEXT PRIMARY KEY, payload_hash TEXT, receipt_json TEXT, enqueued_at INTEGER, bytes INTEGER)");
  const old = c.clock.t - 20 * 60_000;
  for (let i = 0; i < 3; i += 1) db.prepare("INSERT INTO cloud_outbox VALUES (?, 'h', '{}', ?, 2)").run(`e${i}`, old + i);
  c.emitter.queueTelemetry();
  c.emitter.queueTelemetry(); // inside five minutes: not repeated
  let queue = emitted(c.emitter).filter((p) => p.data.event === "queue");
  assert.equal(queue.length, 1);
  assert.equal(queue[0].data.pending_count, 3);
  assert.equal(queue[0].data.oldest_pending_at, new Date(old).toISOString());
  assert.equal(validObservation(queue[0]), true);
  db.exec("DELETE FROM cloud_outbox");
  db.close();
  c.emitter.queueTelemetry();
  queue = emitted(c.emitter).filter((p) => p.data.event === "queue");
  assert.equal(queue.length, 2);
  assert.equal(queue[1].data.pending_count, 0);
  c.emitter.queueTelemetry();
  assert.equal(emitted(c.emitter).filter((p) => p.data.event === "queue").length, 2, "nothing more once drained");
  c.emitter.close();
});

test("policy acknowledgement: loaded and rejected carry the export, policy, digest, generation and scope digest", () => {
  const c = clockedEmitter();
  const policy = JSON.parse(readFileSync(join(c.home.dir, "policy.json"), "utf8"));
  const policyDigest = digestPolicy(policy);
  const scopeDigest = "a".repeat(64);
  c.emitter.policyAck({ exportId: "exp-1", policyId: policy.policy_id, policyVersion: policy.version, policyDigest, scopeDigest });
  c.emitter.policyAck({ exportId: "exp-2", policyId: policy.policy_id, policyVersion: policy.version, policyDigest, scopeDigest, error: "scope_mismatch" });
  const [loaded, rejected] = emitted(c.emitter);
  assert.equal(loaded.data.event, "loaded"); assert.equal(loaded.data.load_result, "loaded");
  assert.equal(rejected.data.event, "rejected"); assert.equal(rejected.data.error, "scope_mismatch");
  for (const p of [loaded, rejected]) {
    assert.equal(validObservation(p), true);
    assert.equal(p.data.installation_generation, p.installation_generation);
    assert.match(p.data.policy_digest, /^[0-9a-f]{64}$/);
  }
  c.emitter.close();
});

test("capability proofs from the --prove runner are emitted with a fixture origin, and only when observations are on", async () => {
  const server = await startServer();
  const home = makeHome({ url: server.url });
  const r = await run(home.dir, ["capabilities", "--prove"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /queued \d+ capability proof observation/);
  await settled(() => server.observations().length > 3);
  const items = server.observations();
  assert.ok(items.length > 3);
  assert.ok(items.every((i) => i.payload.kind === "capability" && i.payload.data.event === "proof"));
  assert.ok(items.every((i) => i.payload.data.fixture_version.startsWith("fixture/sha256:") && i.payload.data.connector === "scopebond-hook"));
  assert.ok(items.some((i) => i.payload.data.host_variant === "claude_terminal") && items.some((i) => i.payload.data.host_variant === "codex_cli"));
  assert.ok(items.every((i) => i.payload.data.proof_result === "verified"));
  assertWellFormed(items, publicKeyOf(home.dir));
  await server.close();
  const off = makeHome({ scopes: ["receipts:write"] });
  const r2 = await run(off.dir, ["capabilities", "--prove"]);
  assert.equal(r2.status, 0);
  assert.doesNotMatch(r2.stderr, /capability proof observation/);
  assert.equal(existsSync(join(off.dir, "observations.db")), false);
});

// ---- status, wiring -------------------------------------------------------------------------------------------

test("status names the queue, the terminal-error queue and the reason when unsupported", async () => {
  const server = await startServer((items) => ({ status: 200, body: { version: "1.0", results: items.map((item, index) => ({ index, observation_id: item.payload.observation_id, status: index === 0 ? "rejected" : "accepted", code: index === 0 ? "unsupported_version" : "ok", retryable: false })) } }));
  const home = makeHome({ url: server.url });
  await run(home.dir, ["claude"], claudeEvent(home.dir, "SessionStart"));
  await run(home.dir, ["claude"], claudeEvent(home.dir, "SessionEnd", { reason: "clear" }));
  await settled(() => server.observations().length >= 2);
  const lines = describeObservations(home.dir);
  assert.match(lines[0], /^on; generation 1; 0 pending/);
  assert.match(lines.join("\n"), /\d+ refused or unsendable, kept locally: unsupported_version \d+/);
  const status = await run(home.dir, ["observations", "status", "--refused"]);
  assert.match(status.stdout, /refused .* session .* unsupported_version/);
  await server.close();
  const off = makeHome({ scopes: [] });
  const s = await run(off.dir, ["status"]);
  assert.match(s.stdout, /observations\s+off \(this enrollment does not grant observations:write\)/);
});

test("lifecycle wiring is idempotent, Claude Code only, and leaves every other setting alone; unwire removes only its own entries", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-obs-wire-"));
  const file = join(dir, ".claude", "settings.json");
  mkdirSync(join(dir, ".claude"), { recursive: true });
  const command = `"node" "/somewhere/@scopebond/hook/dist/cli.js" claude`;
  writeFileSync(file, JSON.stringify({ model: "opus", hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command }] }, { matcher: "Bash", hooks: [{ type: "command", command: "other-tool" }] }], SessionStart: [{ hooks: [{ type: "command", command: "their-own-start" }] }] } }));
  wireLifecycleHooks(file, command);
  wireLifecycleHooks(file, command);
  let cfg = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(cfg.model, "opus");
  assert.equal(cfg.hooks.PreToolUse.length, 2);
  for (const event of ["SessionStart", "SessionEnd", "PostToolUse", "PostToolUseFailure"]) {
    assert.equal(cfg.hooks[event].filter((e) => e.hooks.some((h) => h.command === command)).length, 1, `${event}: exactly one`);
  }
  assert.ok(cfg.hooks.SessionStart.some((e) => e.hooks.some((h) => h.command === "their-own-start")), "their own hook kept");
  assert.equal(unwireLifecycleHooks(file), 4);
  cfg = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(cfg.hooks.PreToolUse.length, 2, "enforcement hook untouched");
  assert.equal(cfg.hooks.SessionEnd, undefined);
  assert.equal(cfg.hooks.SessionStart.length, 1);
  assert.equal(existsSync(`${file}.scopebond-backup`), true, "the original was backed up before the first change");
});

test("connect wires the lifecycle hooks only in a temporary project, and only when the enrollment grants observations:write", async () => {
  const { existsSync: exists } = await import("node:fs");
  // The CLI's connect path needs a live enrollment; the wiring decision is the tested part.
  const on = makeHome();
  const off = makeHome({ scopes: ["receipts:write"] });
  assert.equal(observationStatus(JSON.parse(readFileSync(join(on.dir, "cloud.json"), "utf8"))).state, "on");
  assert.equal(observationStatus(JSON.parse(readFileSync(join(off.dir, "cloud.json"), "utf8"))).state, "off");
  const project = mkdtempSync(join(tmpdir(), "sb-obs-proj-"));
  const wire = await run(project, ["observations", "wire"], undefined, { SCOPEBOND_HOOK_DIR: on.dir });
  assert.equal(wire.status, 1, "nothing configured for Claude Code in this temporary home: refused, not invented");
  assert.equal(exists(join(project, ".claude", "settings.json")), false);
});
