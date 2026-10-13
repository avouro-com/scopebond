// Receipt context (payload.context): what a receipt says about where it was produced, how the
// repository is reduced to host/owner/name, and when a connected hook may send it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { openReceiptStore, loadOrCreateAttester } from "@scopebond/gateway/node";
import { verifyReceipt } from "@scopebond/gateway";
import {
  scaffold, canonicalRepository, receiptContextFor, receiptContextAllowed, receiptContextFrom, clearRepositoryFacts,
  loadOrCreateBindingKey, syncPolicy, readMeta, createHookRuntime, mapClaudeToolUse, MANAGED_META_FILE, RECEIPT_CONTEXT_HEADER, connectCloud,
} from "../dist/index.js";
import { ENFORCE } from "./enforce-all.mjs";
import { makeHome, readPending } from "./observation-helpers.mjs";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function hookDir() {
  const dir = mkdtempSync(join(tmpdir(), "sb-ctx-"));
  scaffold(dir, ENFORCE);
  return dir;
}

/** A git work tree with an `origin` remote and a branch (no commit needed for either). */
function gitRepo(remote, branch = "feature/ctx") {
  const repo = mkdtempSync(join(tmpdir(), "sb-ctx-repo-"));
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  git("init", "-q");
  git("symbolic-ref", "HEAD", `refs/heads/${branch}`);
  if (remote) git("remote", "add", "origin", remote);
  return repo;
}

/** Run a hook command in an isolated home, never touching the real one. */
function run(dir, args, input, env = {}) {
  return new Promise((resolve) => {
    const home = mkdtempSync(join(tmpdir(), "sb-ctx-home-"));
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: dir,
      env: {
        ...process.env, SCOPEBOND_HOOK_DIR: dir, SCOPEBOND_HOME: home, HOME: home, USERPROFILE: home,
        SCOPEBOND_POLICY_SYNC: "off", SCOPEBOND_OBSERVATIONS_HEARTBEAT: "off", SCOPEBOND_HOOK_FLUSH_MS: "300", ...env,
      },
    });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; }); child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input === undefined ? "" : JSON.stringify(input));
  });
}

async function receiptsOf(dir) {
  const { store } = openReceiptStore({ db: join(dir, "receipts.db") });
  try { return await Promise.resolve(store.list()); } finally { await Promise.resolve(store.close?.()); }
}

const write = (cwd, extra = {}) => ({ hook_event_name: "PreToolUse", session_id: "harness-session-1", cwd, tool_name: "Write", tool_input: { file_path: "src/a.ts" }, tool_use_id: "call-1", ...extra });

test("repository: the origin remote as host/owner/name, never credentials, a scheme, .git or a local path", () => {
  const cases = [
    ["https://someone:secret-token@github.com/Example/App.git", "github.com/example/app"],
    ["https://x-access-token:ghs_abc@github.com/example/app", "github.com/example/app"],
    ["git@github.com:example/app.git", "github.com/example/app"],
    ["ssh://git@github.com/example/app.git", "github.com/example/app"],
    ["ssh://git@gitlab.example.test:2222/group/sub/app.git", "gitlab.example.test/group/sub/app"],
    ["https://GitHub.COM/example/app", "github.com/example/app"],
    ["https://GITLAB.Example.TEST/Group/App", "gitlab.example.test/Group/App"],
    ["https://github.com/example/app/", "github.com/example/app"],
    ["https://github.com/example/app.git/", "github.com/example/app"],
    ["https://github.com/example/app?ref=1#frag", "github.com/example/app"],
  ];
  for (const [url, expected] of cases) assert.equal(canonicalRepository(url), expected, url);
  for (const url of [null, undefined, "", "   ", "/work/app", "D:/work/app", "file:///srv/git/app.git", "../app", "https://github.com/app", "$ORIGIN", "https://github.com/" + "a".repeat(200) + "/b"]) {
    assert.equal(canonicalRepository(url), null, String(url));
  }
});

test("a local receipt carries the context: harness, model, keyed session id, repository and branch", async () => {
  clearRepositoryFacts();
  const dir = hookDir();
  const repo = gitRepo("https://someone:secret-token@GitHub.com/Example/App.git");
  const r = await run(dir, ["claude"], write(repo, { model: "example-model-1" }));
  assert.equal(r.status, 0, r.stderr);
  const [receipt] = await receiptsOf(dir);
  const sessionId = loadOrCreateBindingKey(dir).sessionId("harness-session-1");
  assert.deepEqual(receipt.payload.context, {
    harness: "claude", harness_version: null, model: "example-model-1", session_id: sessionId,
    repository: "github.com/example/app", branch: "feature/ctx",
  });
  const text = JSON.stringify(receipt);
  for (const secret of ["secret-token", "someone", "harness-session-1", repo, JSON.stringify(repo).slice(1, -1)]) assert.equal(text.includes(secret), false, `receipt contains ${secret}`);
  const { attester } = loadOrCreateAttester({ file: join(dir, "attester.key") });
  assert.equal(verifyReceipt(receipt, attester.publicKeyPem).valid, true, "the receipt with context verifies");

  const verified = await run(dir, ["verify"]);
  assert.equal(verified.status, 0, `verify: ${verified.stdout}${verified.stderr}`);
  const log = await run(dir, ["log"]);
  assert.equal(log.status, 0);
  assert.match(log.stdout, /\[claude · example-model-1 · github\.com\/example\/app@feature\/ctx\]/);
});

test("outside a git repository, and with no model or session from the harness, those members are null", async () => {
  const dir = hookDir();
  const cwd = mkdtempSync(join(tmpdir(), "sb-ctx-plain-"));
  const r = await run(dir, ["codex"], { hook_event_name: "PreToolUse", cwd, tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "c1" });
  assert.equal(r.status, 0, r.stderr);
  const receipts = await receiptsOf(dir);
  assert.ok(receipts.length > 0);
  for (const receipt of receipts) {
    assert.deepEqual(receipt.payload.context, { harness: "codex", harness_version: null, model: null, session_id: null, repository: null, branch: null });
  }
});

test("a repository without an origin remote has no repository but keeps its branch", () => {
  clearRepositoryFacts();
  const dir = hookDir();
  const repo = gitRepo(null, "main");
  const context = receiptContextFor({ harness: "claude", input: {}, dir, cwd: repo, connected: false });
  assert.equal(context.repository, null);
  assert.equal(context.branch, "main");
});

test("Cursor: its reported version is kept; nothing else from its input (no email, no roots) is read", () => {
  const dir = hookDir();
  const probe = { head: () => null, branch: () => null, remoteUrl: () => null, defaultRemote: () => "origin", revParse: () => null };
  clearRepositoryFacts();
  const context = receiptContextFor({
    harness: "cursor", dir, cwd: "/work/cursor-case", connected: false, probe,
    input: { cursor_version: "1.7.2", model: "example-model-2", user_email: "someone@example.test", workspace_roots: ["/work/app"], conversation_id: "conv-1" },
  });
  assert.deepEqual(context, { harness: "cursor", harness_version: "1.7.2", model: "example-model-2", session_id: null, repository: null, branch: null });
});

test("connected: no context until the workspace says it reads it, then context", async () => {
  const { dir } = makeHome({ scopes: ["receipts:write"] });
  const repo = gitRepo("git@github.com:example/app.git", "main");
  assert.equal(receiptContextAllowed(dir, true), false);
  assert.equal((await run(dir, ["claude"], write(repo))).status, 0);
  const before = await receiptsOf(dir);
  assert.ok(before.length > 0);
  assert.equal(before.every((r) => !("context" in r.payload)), true, "no context before the workspace announced it");

  writeFileSync(join(dir, MANAGED_META_FILE), JSON.stringify({ receipt_context: true }));
  assert.equal(receiptContextAllowed(dir, true), true);
  assert.equal((await run(dir, ["claude"], write(repo, { tool_use_id: "call-2" }))).status, 0);
  const after = (await receiptsOf(dir)).slice(before.length);
  assert.ok(after.length > 0);
  for (const receipt of after) {
    assert.equal(receipt.payload.context.repository, "github.com/example/app");
    assert.equal(receipt.payload.context.branch, "main");
  }
  // Not connected at all: always included (the receipts stay on this computer).
  assert.equal(receiptContextAllowed(hookDir(), false), true);
});

test("the rules check sets and clears the flag; a 304 leaves it as it was", async () => {
  const { dir } = makeHome({ scopes: ["receipts:write"], url: "http://127.0.0.1:9" });
  const answer = (status, headers = {}) => async (url) => (String(url).endsWith("/v1/policy")
    ? new Response(null, { status, headers }) : new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
  const options = (fetchImpl) => ({ agentKid: "kid", hookVersion: "0.0.0", policyBuilds: () => true, fetchImpl });
  assert.equal(readMeta(dir).receipt_context ?? null, null);
  await syncPolicy(dir, options(answer(204, { [RECEIPT_CONTEXT_HEADER]: "1" })));
  assert.equal(readMeta(dir).receipt_context, true);
  await syncPolicy(dir, options(answer(304)));
  assert.equal(readMeta(dir).receipt_context, true, "a 304 keeps it");
  await syncPolicy(dir, options(answer(204)));
  assert.equal(readMeta(dir).receipt_context, false, "a full answer without the header clears it");
  assert.equal(receiptContextFrom(new Headers({ [RECEIPT_CONTEXT_HEADER]: " 1 " })), true);
  assert.equal(receiptContextFrom(new Headers({ [RECEIPT_CONTEXT_HEADER]: "0" })), false);
  assert.equal(receiptContextFrom(undefined), false);
});

test("a delivery answer carrying the header turns it on for later calls", async () => {
  const { dir, connection } = makeHome({ scopes: ["receipts:write"] });
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(String(url));
    const body = JSON.parse(init.body);
    const count = Array.isArray(body.receipts) ? body.receipts.length : 0;
    return new Response(JSON.stringify({ accepted: count }), { status: 200, headers: { "content-type": "application/json", [RECEIPT_CONTEXT_HEADER]: "1" } });
  };
  const runtime = createHookRuntime({
    policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"), attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db"),
    cloud: { connection, fetch: fetchImpl, flushTimeoutMs: 3000 },
  });
  try {
    await runtime.evaluate(mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "git push origin main" } }));
    await runtime.flush();
  } finally { runtime.close(); }
  assert.ok(seen.some((u) => u.endsWith("/v1/ingest")), `delivered: ${seen.join(", ")}`);
  assert.equal(readMeta(dir).receipt_context, true);
});

test("observations and receipts carry the same keyed session id", async () => {
  const { dir } = makeHome();
  writeFileSync(join(dir, MANAGED_META_FILE), JSON.stringify({ receipt_context: true }));
  const cwd = mkdtempSync(join(tmpdir(), "sb-ctx-obs-"));
  assert.equal((await run(dir, ["claude"], write(cwd, { session_id: "sess-shared" }))).status, 0);
  const [receipt] = await receiptsOf(dir);
  const intents = (await readPending(dir)).filter((w) => w.payload.kind === "tool_intent");
  assert.ok(intents.length > 0, "a tool intent was recorded");
  assert.match(receipt.payload.context.session_id, /^sbs_[0-9a-f]{32}$/);
  for (const intent of intents) assert.equal(intent.payload.session_id, receipt.payload.context.session_id);
  assert.equal(JSON.stringify(receipt).includes("sess-shared"), false);
  assert.equal(readFileSync(join(dir, "receipts.db")).includes("sess-shared"), false);
});

// ---- review follow-ups: remotes that could name a person or machine, fetch URL, re-connect, accepted answers only ----

test("repository: machine names, IP addresses, server folders, ~user and dot segments are never recorded", () => {
  for (const url of [
    "git@dev-box:/" + "home/alice/work/repo.git",
    "ssh://host/~alice/repo.git",
    "ssh://git@git.example.test/~alice/repo.git",
    "johns-macbook:repos/foo",
    "ssh://192.168.1.10/alice/repo.git",
    "https://10.0.0.7/group/repo.git",
    "ssh://git@[fe80::1]/alice/repo.git",
    "https://[2001:db8::1]/alice/repo.git",
    "git@git.example.test:/" + "home/alice/repo.git",
    "ssh://git@git.example.test/" + "Users/alice/repo.git",
    "https://git.example.test/srv/git/repo.git",
    "https://git.example.test/var/repos/app",
    "https://git.example.test/ROOT/app",
    "https://git.example.test/opt/app/x",
    "https://git.example.test/mnt/data/app",
    "https://git.example.test/tmp/a/b",
    "https://github.com/%2e%2e/r",
    "https://github.com/example/%2Eapp",
    "https://github.com/example/./app",
  ]) assert.equal(canonicalRepository(url), null, url);
  // Hosted repositories keep working, a nested group included.
  assert.equal(canonicalRepository("git@gitlab.example.test:group/sub/app.git"), "gitlab.example.test/group/sub/app");
  assert.equal(canonicalRepository("https://dev.azure.example.test/org/project/_git/app"), "dev.azure.example.test/org/project/_git/app");
});

test("repository comes from the fetch URL, not a push URL pointing at a mirror", () => {
  clearRepositoryFacts();
  const repo = gitRepo("https://github.com/example/app.git", "main");
  execFileSync("git", ["-C", repo, "remote", "set-url", "--push", "origin", "/srv/mirror/app.git"], { stdio: "ignore" });
  const context = receiptContextFor({ harness: "claude", input: {}, dir: hookDir(), cwd: repo, connected: false });
  assert.equal(context.repository, "github.com/example/app");
});

test("a delivery answer that is not accepted does not turn receipt context on", async () => {
  for (const status of [401, 500, 503]) {
    const { dir, connection } = makeHome({ scopes: ["receipts:write"] });
    const fetchImpl = async () => new Response("<html>proxy</html>", { status, headers: { [RECEIPT_CONTEXT_HEADER]: "1" } });
    const runtime = createHookRuntime({
      policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"), attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db"),
      cloud: { connection, fetch: fetchImpl, flushTimeoutMs: 3000 },
    });
    try {
      await runtime.evaluate(mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "git push origin main" } }));
      await runtime.flush();
    } finally { runtime.close(); }
    assert.notEqual(readMeta(dir).receipt_context, true, `status ${status}`);
  }
});

const enrollProof = JSON.stringify({ challenge: "c1", enrollment_id: "e1", type: "scopebond:gateway-enrollment", version: 1 });
const enrollBundle = { enrollment_token: "sbe_ctx_test", proof_canonical: enrollProof, expires_at: "2099-01-01T00:00:00.000Z" };
function enrollAnswer(dir) {
  const { attester } = loadOrCreateAttester({ file: join(dir, "attester.key") });
  const { attester: agent } = loadOrCreateAttester({ file: join(dir, "agent.key") });
  return {
    credential_id: "cred-2", credential: "sbm_ctx_credential", organization_id: "org-2", environment_id: "env-2", gateway_id: "gw-2",
    attester_kid: attester.kid, agent_kid: agent.kid, scopes: ["receipt:ingest"], expires_at: "2099-01-01T00:00:00.000Z",
  };
}

test("connecting to a workspace forgets what the previous one said it reads", async () => {
  const dir = hookDir();
  writeFileSync(join(dir, MANAGED_META_FILE), JSON.stringify({ receipt_context: true, checked_at: new Date().toISOString(), evidence_detail: "full" }));
  const answer = enrollAnswer(dir);
  const fetchImpl = async (url) => (String(url).endsWith("/v1/enroll")
    ? new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } })
    : new Response("{}", { status: 404 }));
  await connectCloud(dir, "http://127.0.0.1:9", enrollBundle, fetchImpl);
  const meta = readMeta(dir);
  assert.equal(meta.receipt_context, null, "the new workspace has not said it reads receipt context");
  assert.equal(meta.checked_at, null, "the next tool call checks the rules at once");
  assert.equal(meta.evidence_detail, "full", "everything else is kept");
  assert.equal(receiptContextAllowed(dir, true), false);
});

test("connect runs one rules check right away, which can turn receipt context on", async () => {
  const dir = hookDir();
  writeFileSync(join(dir, MANAGED_META_FILE), JSON.stringify({ receipt_context: true }));
  const answer = enrollAnswer(dir);
  const seen = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      seen.push(`${req.method} ${req.url}`);
      if (req.url === "/v1/enroll") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(answer)); return; }
      if (req.url === "/v1/policy" && req.method === "GET") { res.writeHead(204, { [RECEIPT_CONTEXT_HEADER]: "1" }); res.end(); return; }
      res.writeHead(200, { "content-type": "application/json" }); res.end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const blob = Buffer.from(JSON.stringify(enrollBundle)).toString("base64");
    const r = await run(dir, ["connect", url, blob, "--no-install"], undefined, { SCOPEBOND_POLICY_SYNC: "" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  } finally { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); }
  assert.ok(seen.includes("GET /v1/policy"), `requests: ${seen.join(", ")}`);
  assert.equal(readMeta(dir).receipt_context, true);
});
