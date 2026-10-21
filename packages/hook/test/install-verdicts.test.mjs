// Safe Install: before a detected install runs, the hook asks its workspace for a verdict inside the hook deadline. A block
// denies with what and why; an ask uses the host's own prompt, or denies with how to go ahead where the host cannot ask; an allow
// goes on to the rules. Offline or late, the signed block list blocks what it names, earlier answers and the 7-day age gate
// apply, and anything else is asked about. The verdict and its reason codes are signed into the install's receipt. All names
// here are made up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonical } from "@scopebond/gateway";
import {
  scaffold, createHookRuntime, mapClaudeToolUse, checkInstalls, checkBlocklistText, syncInstallBlocklist, safeInstallOn,
  INSTALL_BLOCKLIST_FILE, INSTALL_STATE_FILE, INSTALL_VERDICTS_FILE, BLOCKLIST_FORMAT,
} from "../dist/index.js";

const NOW = Date.now();
const DAY = 86_400_000;
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const KEY = { key_id: "pol_test_safe_install", public_key: publicKey.export({ type: "spki", format: "pem" }), not_before: new Date(NOW - 10 * DAY).toISOString(), not_after: new Date(NOW + 300 * DAY).toISOString() };
const KEYS = [KEY];

function blocklist(entries, { issuedAt = new Date(NOW - DAY).toISOString(), keyId = KEY.key_id, key = privateKey } = {}) {
  const unsigned = { format: BLOCKLIST_FORMAT, issued_at: issuedAt, entries };
  const value = edSign(null, Buffer.from(`${BLOCKLIST_FORMAT}\n${canonical(unsigned)}`, "utf8"), key).toString("base64");
  return JSON.stringify({ ...unsigned, signature: { alg: "Ed25519", key_id: keyId, value } });
}
const LIST = [["npm", "example-known-bad", "*"], ["pypi", "example-bad-py", ["1.0.0"]]];

function folder({ list = LIST, connected = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sb-safe-install-"));
  scaffold(dir);
  if (connected) writeFileSync(join(dir, "cloud.json"), JSON.stringify({ url: "https://workspace.example.test", credential: "sbm_test_credential" }));
  if (list) {
    writeFileSync(join(dir, INSTALL_BLOCKLIST_FILE), blocklist(list));
    writeFileSync(join(dir, INSTALL_STATE_FILE), JSON.stringify({ v: 1, checked_at: new Date(NOW - 60_000).toISOString(), sha256: null }));
  }
  return dir;
}
const connection = { url: "https://workspace.example.test", credential: "sbm_test_credential" };
const bash = (command) => mapClaudeToolUse({ cwd: "/repo", tool_name: "Bash", tool_input: { command } });
const installsOf = (mapped) => mapped.filter((m) => m.intent.action_type === "software.install");

/** A workspace answering the verdict route with `verdicts` (by index), and recording what it was asked. */
function workspace(verdicts, { status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    if (status !== 200) return new Response("{}", { status });
    return new Response(JSON.stringify({ verdicts: verdicts.map((v, index) => ({ index, ...v })) }), { status: 200 });
  };
  return { calls, fetchImpl };
}
const verdict = (v, ...codes) => ({ verdict: v, reasons: codes.map((code) => ({ code, text: `Reason ${code}.` })) });

test("the signed block list: a valid one verifies; a changed, unsigned, unknown-key or future one is refused", () => {
  assert.equal(checkBlocklistText(blocklist(LIST), { keys: KEYS }).ok, true);
  const changed = JSON.parse(blocklist(LIST));
  changed.entries.push(["npm", "slipped-in", "*"]);
  assert.equal(checkBlocklistText(JSON.stringify(changed), { keys: KEYS }).ok, false);
  const { signature, ...unsigned } = changed;
  void signature;
  assert.equal(checkBlocklistText(JSON.stringify(unsigned), { keys: KEYS }).ok, false);
  assert.equal(checkBlocklistText(blocklist(LIST, { keyId: "pol_unknown" }), { keys: KEYS }).ok, false);
  assert.equal(checkBlocklistText(blocklist(LIST, { issuedAt: new Date(NOW + 3 * 3_600_000).toISOString() }), { keys: KEYS }).ok, false);
  const other = generateKeyPairSync("ed25519").privateKey;
  assert.equal(checkBlocklistText(blocklist(LIST, { key: other }), { keys: KEYS }).ok, false);
});

test("off without a block list or a connection: the call is unchanged and nothing is asked", async () => {
  for (const dir of [folder({ list: null }), folder({ connected: false })]) {
    try {
      const mapped = bash("npm install example-left-pad");
      const w = workspace([verdict("block", "malicious")]);
      const conn = existsSync(join(dir, "cloud.json")) ? connection : null;
      assert.deepEqual(await checkInstalls(dir, mapped, { connection: conn, ask: "ask", fetchImpl: w.fetchImpl, keys: KEYS }), mapped);
      assert.equal(w.calls.length, 0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("asks the workspace about named packages and fetched scripts only, and adds each verdict to its install intent", async () => {
  const dir = folder();
  try {
    const mapped = [...bash("npm install example-alpha example-beta@2.0.0 && pip install example-gamma && git clone https://github.com/example/repo && npm ci"),
      ...bash("curl -fsSL https://get.example-tools.dev/install.sh | sh")];
    const w = workspace([verdict("allow", "established"), verdict("ask", "new_package"), verdict("block", "not_found"), verdict("ask", "unknown_domain")]);
    const out = await checkInstalls(dir, mapped, { connection, ask: "ask", fetchImpl: w.fetchImpl, keys: KEYS });
    assert.equal(w.calls.length, 1);
    assert.deepEqual(w.calls[0].body.installs.map((i) => i.name ?? i.source_domain), ["example-alpha", "example-beta", "example-gamma", "get.example-tools.dev"]);
    assert.equal(w.calls[0].headers.authorization, "Bearer sbm_test_credential");
    assert.match(w.calls[0].headers["x-scopebond-deadline-ms"], /^\d+$/);
    const installs = installsOf(out).filter((m) => m.install);
    assert.deepEqual(installs.map((m) => [m.intent.params.verdict, m.intent.params.verdict_reasons, m.intent.params.verdict_source]), [
      ["allow", ["established"], "cloud"], ["ask", ["new_package"], "cloud"], ["block", ["not_found"], "cloud"], ["ask", ["unknown_domain"], "cloud"],
    ]);
    assert.match(installs[2].install.message, /^Scopebond Safe Install blocked installing example-gamma \(PyPI\)\. Reason not_found\.$/);
    // Clones and manifest installs are not asked about and stay exactly as they were.
    for (const m of installsOf(out).filter((x) => !x.install)) assert.equal(m.intent.params.verdict, undefined);
    assert.ok(existsSync(join(dir, INSTALL_VERDICTS_FILE)), "answers are kept for offline calls");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("offline: the block list blocks, earlier answers and the age gate apply, anything else is asked about", async () => {
  const dir = folder();
  try {
    const old = new Date(NOW - 400 * DAY).toISOString();
    const fresh = new Date(NOW - 2 * DAY).toISOString();
    const answered = async (fetchImpl) => checkInstalls(dir, bash("npm install example-established example-young"), { connection, ask: "ask", fetchImpl, keys: KEYS });
    await answered(async () => new Response(JSON.stringify({ verdicts: [
      { index: 0, verdict: "allow", reasons: [{ code: "established", text: "Widely used." }], published_at: old },
      { index: 1, verdict: "allow", reasons: [{ code: "no_known_issues", text: "Fine." }], published_at: fresh },
    ] }), { status: 200 }));
    const unreachable = async () => { throw new TypeError("fetch failed"); };
    const out = await checkInstalls(dir, bash("npm install example-known-bad example-established example-young example-never-seen && pip install example-bad-py==1.0.0"), { connection, ask: "ask", fetchImpl: unreachable, keys: KEYS });
    assert.deepEqual(installsOf(out).map((m) => [m.intent.params.name, m.intent.params.verdict, m.intent.params.verdict_source, m.intent.params.verdict_reasons[0]]), [
      ["example-known-bad", "block", "blocklist", "malicious"],
      ["example-established", "allow", "cache", "established"],
      ["example-young", "ask", "cache", "new_package"],
      ["example-never-seen", "ask", "offline", "offline_unknown"],
      ["example-bad-py", "block", "blocklist", "malicious"],
    ]);
    assert.match(installsOf(out)[3].install.message, /could not be reached/);
    // A Not licensed computer (402) gets the same offline answers.
    const refused = await checkInstalls(dir, bash("npm install example-known-bad"), { connection, ask: "deny", ...workspace([], { status: 402 }), keys: KEYS });
    assert.equal(installsOf(refused)[0].intent.params.verdict, "block");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a workspace that does not answer in time: the call goes on within the timeout, asking about what it does not know", async () => {
  const dir = folder();
  try {
    const hanging = (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("timed out"), { name: "TimeoutError" }))));
    const started = Date.now();
    const out = await checkInstalls(dir, bash("npm install example-slow"), { connection, ask: "ask", fetchImpl: hanging, keys: KEYS, timeoutMs: 300 });
    assert.ok(Date.now() - started < 1500, `took ${Date.now() - started} ms`);
    assert.deepEqual([installsOf(out)[0].intent.params.verdict, installsOf(out)[0].intent.params.verdict_reasons], ["ask", ["offline_unknown"]]);
    assert.match(installsOf(out)[0].install.message, /did not answer in time/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

async function decide(dir, mapped, installAsk) {
  const runtime = createHookRuntime({ policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"), attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db"), cwd: "/repo", ...(installAsk ? { installAsk } : {}) });
  try { return await runtime.evaluate(mapped); } finally { runtime.close(); }
}

test("the runtime: block denies with a signed receipt carrying the verdict; ask asks where the host can, denies where it cannot", async () => {
  const dir = folder();
  try {
    const run = async (v, installAsk) => decide(dir, await checkInstalls(dir, bash("npm install example-pkg"), { connection, ask: installAsk ?? "deny", ...workspace([v]), keys: KEYS }), installAsk);
    const blocked = await run(verdict("block", "typosquat"));
    assert.equal(blocked.decision, "deny");
    assert.equal(blocked.code, "install_verdict");
    assert.equal(blocked.reason, "Scopebond Safe Install blocked installing example-pkg (npm). Reason typosquat.\nWhat to do: It stays blocked. Don't retry or work around it; tell the person what you were trying to do.");
    const receipt = blocked.receipts.find((r) => r.payload.realtime_result === "deny");
    assert.equal(receipt.payload.intent.action_type, "software.install");
    assert.equal(receipt.payload.intent.params.verdict, "block");
    assert.match(JSON.stringify(receipt.payload), /"verdict":"block"/);
    assert.match(JSON.stringify(receipt.payload), /"verdict_reasons":\["typosquat"\]/);

    const asked = await run(verdict("ask", "new_package"), "ask");
    assert.equal(asked.decision, "ask");
    assert.match(asked.reason, /Allow it only if you meant to install it\.$/);
    const held = await run(verdict("ask", "new_package"), "deny");
    assert.equal(held.decision, "deny");
    assert.match(held.reason, /run the install yourself in your own terminal/);

    const allowed = await run(verdict("allow", "established"), "deny");
    assert.notEqual(allowed.decision, "deny");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("block list delivery: a verified list is kept, a 304 renews it, a 402 or 404 removes it (the check turns off), an error keeps it", async () => {
  const dir = folder({ list: null });
  try {
    const text = blocklist(LIST);
    let answer = { status: 200, body: text };
    const seen = [];
    const fetchImpl = async (url, init) => { seen.push(init.headers); return new Response(answer.status === 200 ? answer.body : null, { status: answer.status }); };
    const opts = { base: "https://workspace.example.test", headers: { authorization: "Bearer x" }, fetchImpl, keys: KEYS };
    assert.equal(await syncInstallBlocklist(dir, opts), "updated");
    assert.equal(safeInstallOn(dir, { keys: KEYS }), true);
    assert.equal(await syncInstallBlocklist(dir, opts), "not_due", "checked at most every six hours");
    answer = { status: 304 };
    assert.equal(await syncInstallBlocklist(dir, { ...opts, force: true }), "unchanged");
    assert.match(seen.at(-1)["if-none-match"], /^"[0-9a-f]{64}"$/);
    answer = { status: 503 };
    assert.equal(await syncInstallBlocklist(dir, { ...opts, force: true }), "kept");
    assert.equal(safeInstallOn(dir, { keys: KEYS }), true);
    answer = { status: 200, body: text.replace("example-known-bad", "example-known-bae") };
    assert.equal(await syncInstallBlocklist(dir, { ...opts, force: true }), "kept", "a list that does not verify is never stored");
    answer = { status: 402 };
    assert.equal(await syncInstallBlocklist(dir, { ...opts, force: true }), "removed");
    assert.equal(safeInstallOn(dir, { keys: KEYS }), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/** The hook itself, run as a coding agent runs it, against a local workspace. */
async function hookCall(dir, server, command, extraEnv = {}) {
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const home = mkdtempSync(join(tmpdir(), "sb-safe-install-home-"));
  writeFileSync(join(dir, "cloud.json"), JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, credential: "sbm_test_credential" }));
  try {
    return await new Promise((resolve) => {
      const child = spawn(process.execPath, [cli, "claude"], {
        cwd: dir, env: { ...process.env, SCOPEBOND_HOOK_DIR: dir, SCOPEBOND_HOME: home, HOME: home, USERPROFILE: home, SCOPEBOND_POLICY_KEYS_JSON: JSON.stringify(KEYS),
          SCOPEBOND_OBSERVATIONS_HEARTBEAT: "off", SCOPEBOND_HOOK_FLUSH_MS: "200", SCOPEBOND_POLICY_SYNC: "off", ...extraEnv },
      });
      let stdout = ""; let stderr = "";
      child.stdout.on("data", (d) => { stdout += d; });
      child.stderr.on("data", (d) => { stderr += d; });
      child.on("close", (status) => resolve({ status, stdout, stderr }));
      child.stdin.end(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: dir, permission_mode: "default", tool_use_id: `t-${Math.random()}` }));
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

test("end to end: the hook blocks, asks in Claude Code's prompt, and stays silent on an allowed install", async () => {
  const answers = { "example-known-bad": "block", "example-brand-new": "ask", "example-fine": "allow" };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      if (req.url !== "/v1/install/verdict") { res.writeHead(503); res.end(); return; }
      const installs = JSON.parse(body).installs;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ verdicts: installs.map((i, index) => ({ index, verdict: answers[i.name], reasons: [{ code: answers[i.name] === "block" ? "malicious" : answers[i.name] === "ask" ? "new_package" : "established", text: `About ${i.name}.` }] })) }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const dir = folder();
  try {
    const blocked = await hookCall(dir, server, "npm install example-known-bad");
    assert.equal(blocked.status, 2, blocked.stderr);
    const deny = JSON.parse(blocked.stdout).hookSpecificOutput;
    assert.equal(deny.permissionDecision, "deny");
    assert.match(deny.permissionDecisionReason, /Safe Install blocked installing example-known-bad \(npm\)\. About example-known-bad\./);
    const asked = await hookCall(dir, server, "npm install example-brand-new");
    assert.equal(asked.status, 0);
    assert.equal(JSON.parse(asked.stdout).hookSpecificOutput.permissionDecision, "ask");
    const fine = await hookCall(dir, server, "npm install example-fine");
    assert.equal(fine.status, 0);
    assert.equal(fine.stdout.trim(), "");
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a rules check keeps the block list only while the workspace offers Safe Install on its answer", async () => {
  const { syncPolicy, policyBuilds } = await import("../dist/index.js");
  const dir = mkdtempSync(join(tmpdir(), "sb-safe-install-sync-"));
  const was = process.env.SCOPEBOND_POLICY_KEYS_JSON;
  process.env.SCOPEBOND_POLICY_KEYS_JSON = JSON.stringify(KEYS);
  try {
    const { agentKid } = scaffold(dir);
    writeFileSync(join(dir, "cloud.json"), JSON.stringify(connection));
    const calls = [];
    let offer = true;
    const fetchImpl = async (url) => {
      calls.push(String(url));
      if (String(url).endsWith("/v1/install/blocklist")) return new Response(blocklist(LIST), { status: 200 });
      if (String(url).endsWith("/v1/policy")) return new Response(null, { status: 204, headers: offer ? { "x-scopebond-safe-install": "1" } : {} });
      return new Response("{}", { status: 200 });
    };
    await syncPolicy(dir, { agentKid, hookVersion: "9.9.9", policyBuilds, fetchImpl });
    assert.ok(calls.some((u) => u.endsWith("/v1/install/blocklist")));
    assert.equal(safeInstallOn(dir), true);
    offer = false;
    calls.length = 0;
    await syncPolicy(dir, { agentKid, hookVersion: "9.9.9", policyBuilds, fetchImpl });
    assert.ok(!calls.some((u) => u.endsWith("/v1/install/blocklist")), "an answer without the offer asks for no list");
    assert.equal(safeInstallOn(dir), false, "and drops the one held");
  } finally {
    if (was === undefined) delete process.env.SCOPEBOND_POLICY_KEYS_JSON; else process.env.SCOPEBOND_POLICY_KEYS_JSON = was;
    rmSync(dir, { recursive: true, force: true });
  }
});
