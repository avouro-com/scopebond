import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { createInterface } from "node:readline";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

// A minimal upstream MCP server: echo a result for any request that has an id.
const UPSTREAM = `
import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id !== undefined && m.id !== null) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { upstream: m.method, name: m.params && m.params.name } }) + "\\n");
  }
});
`;

const policy = {
  vocabulary_version: "1.0", policy_id: "mcp-cli", version: 1,
  clauses: [{
    id: "fs", type: "action_allowlist", mode: "enforce", action_types: ["mcp.tool.call"],
    param_bounds: { server: { enum: ["filesystem"] }, tool: { pattern: "^(?!delete_).+" } },
  }],
};

test("the stdio proxy forwards allowed calls, blocks denied ones, and passes non-tool methods through", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-mcp-cli-"));
  writeFileSync(join(dir, "upstream.mjs"), UPSTREAM);
  writeFileSync(join(dir, "policy.json"), JSON.stringify(policy));
  writeFileSync(join(dir, "key.pem"), generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString());

  const proc = spawn(process.execPath, [
    cli, "--server", "filesystem", "--policy", join(dir, "policy.json"), "--key", join(dir, "key.pem"),
    "--", process.execPath, join(dir, "upstream.mjs"),
  ], { stdio: ["pipe", "pipe", "inherit"] });

  const responses = new Map();
  const waiters = new Map();
  createInterface({ input: proc.stdout }).on("line", (line) => {
    if (!line.trim()) return;
    const m = JSON.parse(line);
    responses.set(m.id, m);
    waiters.get(m.id)?.(m);
  });
  const send = (msg) => new Promise((resolve) => {
    if (responses.has(msg.id)) return resolve(responses.get(msg.id));
    waiters.set(msg.id, resolve);
    proc.stdin.write(JSON.stringify(msg) + "\n");
  });

  try {
    const allowed = await send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_file", arguments: { path: "a" } } });
    assert.deepEqual(allowed.result, { upstream: "tools/call", name: "read_file" }, "allowed call reached the upstream");

    const denied = await send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "delete_all", arguments: {} } });
    assert.ok(denied.error, "denied call returns a JSON-RPC error");
    assert.match(denied.error.message, /Scopebond policy denied delete_all/);

    const passthrough = await send({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
    assert.equal(passthrough.result.upstream, "tools/list", "non-tool method passed through");
  } finally {
    proc.kill();
    await once(proc, "exit").catch(() => {});
  }
});

// ---- typed adapter over stdio ----------------------------------------------------------------------

const TYPED_UPSTREAM = `
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
const TOOLS = [{ name: "get_issue", description: "read", inputSchema: { type: "object" } }, { name: "delete_branch", description: "delete", inputSchema: { type: "object" } }];
createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === "tools/call") appendFileSync(process.env.CALL_LOG, JSON.stringify(m.params) + "\\n");
  if (m.id === undefined || m.id === null) return;
  const result = m.method === "tools/list" ? { tools: TOOLS } : { content: [{ type: "text", text: "ok" }] };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
});
`;

test("the typed adapter over stdio: an unlisted tool and an unapproved resource are denied before the upstream sees them; observations reach the hook outbox", async () => {
  const { manifestHash } = await import("../dist/index.js");
  const { scaffold, bindingKeyFromHex } = await import("@scopebond/hook");
  const { loadOrCreateAttester } = await import("@scopebond/gateway/node");
  const { readFileSync, existsSync } = await import("node:fs");
  const { createRequire } = await import("node:module");
  const dir = mkdtempSync(join(tmpdir(), "sb-mcp-typed-"));
  const home = join(dir, "hook");
  scaffold(home, {});
  const { attester } = loadOrCreateAttester({ file: join(home, "agent.key") });
  writeFileSync(join(home, "cloud.json"), JSON.stringify({
    url: "http://127.0.0.1:9", credential_id: "c", credential: "sbm_test", organization_id: "o", environment_id: "e", gateway_id: "gw", attester_kid: "k",
    agent_kid: attester.kid, scopes: ["receipts:write", "observations:write"], expires_at: "2099-01-01T00:00:00Z", installation_id: "inst-1", installation_generation: 1,
  }));
  const tools = [{ name: "get_issue", description: "read", inputSchema: { type: "object" } }, { name: "delete_branch", description: "delete", inputSchema: { type: "object" } }];
  writeFileSync(join(dir, "typed.json"), JSON.stringify({
    mode: "enforce", requireResourceBinding: true, approvedResources: { repository: ["acme/widgets"] },
    manifest: { hash: manifestHash(tools), tools: {
      get_issue: { operation_class: "read_only", resources: [{ arg: "repository", kind: "repository" }] },
      delete_branch: { operation_class: "mutation", resources: [{ arg: "repository", kind: "repository" }] },
    } },
  }));
  writeFileSync(join(dir, "upstream.mjs"), TYPED_UPSTREAM);
  writeFileSync(join(dir, "policy.json"), JSON.stringify({ ...policy, clauses: [{ id: "any", type: "action_allowlist", mode: "enforce", action_types: ["mcp.tool.call"] }] }));
  writeFileSync(join(dir, "key.pem"), generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString());
  const callLog = join(dir, "calls.log");
  writeFileSync(callLog, "");

  const proc = spawn(process.execPath, [
    cli, "--server", "github", "--policy", join(dir, "policy.json"), "--key", join(dir, "key.pem"), "--typed", join(dir, "typed.json"),
    "--observations-dir", home, "--", process.execPath, join(dir, "upstream.mjs"),
  ], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, CALL_LOG: callLog, SCOPEBOND_OBSERVATIONS_HEARTBEAT: "off" } });
  const responses = new Map(); const waiters = new Map();
  createInterface({ input: proc.stdout }).on("line", (line) => {
    if (!line.trim()) return;
    const m = JSON.parse(line); responses.set(m.id, m); waiters.get(m.id)?.(m);
  });
  const send = (msg) => new Promise((resolve) => {
    if (responses.has(msg.id)) return resolve(responses.get(msg.id));
    waiters.set(msg.id, resolve); proc.stdin.write(JSON.stringify(msg) + "\n");
  });
  const call = (id, name, args) => send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  try {
    await send({ jsonrpc: "2.0", id: "l", method: "tools/list", params: {} });
    assert.ok((await call(1, "get_issue", { repository: "acme/widgets" })).result, "an approved read is forwarded");
    assert.match((await call(2, "delete_branch", { repository: "evil/repo" })).error.message, /not in the approved set/);
    assert.match((await call(3, "drop_database", {})).error.message, /not in the pinned manifest/);
  } finally {
    proc.kill();
    await once(proc, "exit");
  }
  const forwarded = readFileSync(callLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).name);
  assert.deepEqual(forwarded, ["get_issue"], "the denied calls never reached the upstream");
  // Intent and outcome of the forwarded call, and the intents of the two denied ones, are in the outbox, keyed and closed.
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const db = new DatabaseSync(join(home, "observations.db"));
  const rows = db.prepare("SELECT wrapper FROM pending ORDER BY generation, sequence").all().map((r) => JSON.parse(r.wrapper));
  db.close();
  assert.deepEqual(rows.map((r) => `${r.payload.kind}:${r.payload.data.operation.tool_name}`), ["tool_intent:get_issue", "tool_outcome:get_issue", "tool_intent:delete_branch", "tool_intent:drop_database"]);
  const key = bindingKeyFromHex(readFileSync(join(home, "observation-binding.key"), "utf8").trim());
  assert.deepEqual(rows[0].payload.data.operation.resource_ids, [key.resourceId("mcp:repository", "acme/widgets")], "the hook's own binding key produced the ids");
  assert.equal(rows[3].payload.data.operation.operation_class, "unknown");
  assert.ok(!JSON.stringify(rows).includes("acme/widgets") && !JSON.stringify(rows).includes("evil/repo"));
  assert.ok(!existsSync(join(dir, "key.pem.binding")), "the hook's key was used; no separate key was made");
});
