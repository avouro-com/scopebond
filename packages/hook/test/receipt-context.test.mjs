// Receipt context (payload.context): what a receipt says about where it was produced, how the
// repository is reduced to host/owner/name, and when a connected hook may send it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openReceiptStore, loadOrCreateAttester } from "@scopebond/gateway/node";
import { verifyReceipt } from "@scopebond/gateway";
import {
  scaffold, canonicalRepository, receiptContextFor, receiptContextAllowed, receiptContextFrom, clearRepositoryFacts,
  loadOrCreateBindingKey, syncPolicy, readMeta, createHookRuntime, mapClaudeToolUse, MANAGED_META_FILE, RECEIPT_CONTEXT_HEADER,
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
