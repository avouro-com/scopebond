// The MCP proxy against unusual client message shapes and an untrusted upstream: JSON-RPC
// batches, a manifest pin the upstream tries to dodge, the upstream's environment, oversized
// lines, unanswered requests, and the starter policy. Local only: upstreams are node scripts
// or in-process stubs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { createMcpProxy, starterMcpPolicy, requestBinderFromHex, manifestHash } from "../dist/index.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const keyPem = () => generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const NOW = () => "2026-10-08T12:00:00.000Z";
const POLICY = {
  vocabulary_version: "1.0", policy_id: "mcp", version: 1,
  clauses: [{ id: "fs", type: "action_allowlist", mode: "enforce", action_types: ["mcp.tool.call"],
    param_bounds: { server: { enum: ["filesystem"] }, tool: { pattern: "^(?!delete_|write_).+" } } }],
};

// An upstream that would accept a JSON-RPC batch (as 2025-03-26-era servers may), logs what it
// executes, reports an env var it was given, can return a large result, and can stay silent.
const UPSTREAM = (log) => `
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
const one = (m) => {
  if (m.method === "tools/call") appendFileSync(${JSON.stringify(log)}, "EXECUTED " + m.params.name + "\\n");
  if (m.id === undefined || m.id === null) return null;
  if (m.method === "hang") return null;
  if (m.method === "env") return { jsonrpc: "2.0", id: m.id, result: { marker: process.env.SCOPEBOND_TEST_PARENT_MARKER ?? null } };
  if (m.method === "big") return { jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "A".repeat(m.params.bytes) }] } };
  return { jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "ran " + (m.params && m.params.name) }] } };
};
createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  if (!line.trim()) return;
  let m; try { m = JSON.parse(line); } catch { return; }
  appendFileSync(${JSON.stringify(log)}, Array.isArray(m) ? "BATCH\\n" : "");
  const out = Array.isArray(m) ? m.map(one).filter(Boolean) : one(m);
  if (out && (!Array.isArray(out) || out.length)) process.stdout.write(JSON.stringify(out) + "\\n");
});
`;

function startCli(extraEnv = {}, extraArgs = []) {
  const dir = mkdtempSync(join(tmpdir(), "sb-mcp-hard-"));
  const log = join(dir, "executed.log"); writeFileSync(log, "");
  writeFileSync(join(dir, "upstream.mjs"), UPSTREAM(log));
  writeFileSync(join(dir, "policy.json"), JSON.stringify(POLICY));
  writeFileSync(join(dir, "key.pem"), keyPem());
  const receipts = join(dir, "receipts.jsonl");
  const proc = spawn(process.execPath, [cli, "--server", "filesystem", "--policy", join(dir, "policy.json"), "--key", join(dir, "key.pem"),
    "--receipts", receipts, ...extraArgs, "--", process.execPath, join(dir, "upstream.mjs")], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, ...extraEnv } });
  const lines = [];
  let wake = () => {};
  createInterface({ input: proc.stdout, crlfDelay: Infinity }).on("line", (l) => { if (l.trim()) { lines.push(l); wake(); } });
  const next = (pred, ms = 20000) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout; got " + lines.map((l) => l.slice(0, 120)).join(" | "))), ms);
    const check = () => { const hit = lines.find(pred); if (hit) { clearTimeout(t); resolve(hit); } else wake = check; };
    check();
  });
  const send = (obj) => proc.stdin.write(JSON.stringify(obj) + "\n");
  return { proc, send, next, log, receipts, lines };
}

test("a JSON-RPC batch is rejected with -32600 and never reaches the upstream (stdio CLI)", async () => {
  const c = startCli();
  try {
    c.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "delete_file", arguments: { path: "/data" } } });
    const denied = JSON.parse(await c.next((l) => l.includes('"id":1')));
    assert.match(denied.error.message, /denied delete_file/, "control: the single message is denied");
    c.send([{ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "delete_file", arguments: { path: "/data" } } },
            { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "write_file", arguments: { path: "/x", content: "y" } } }]);
    const reply = JSON.parse(await c.next((l) => l.includes("-32600")));
    assert.equal(Array.isArray(reply), false);
    assert.equal(reply.id, null);
    assert.equal(reply.error.code, -32600);
    // A later ordinary call still works, so the batch reply above was the only answer.
    c.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "read_file", arguments: { path: "/r" } } });
    const ok = JSON.parse(await c.next((l) => l.includes('"id":4')));
    assert.equal(ok.result.content[0].text, "ran read_file");
    assert.equal(readFileSync(c.log, "utf8"), "EXECUTED read_file\n", "no batched tool ran upstream and the upstream never saw a batch");
    assert.equal(c.lines.filter((l) => l.startsWith("[")).length, 0);
    const receipts = existsSync(c.receipts) ? readFileSync(c.receipts, "utf8").trim().split("\n").filter(Boolean) : [];
    assert.equal(receipts.length, 2, "only the two decided single calls have receipts");
  } finally { c.proc.kill(); }
});

test("createMcpProxy.handle rejects an array, a non-object and a non-string method without calling the upstream", async () => {
  const seen = [];
  const proxy = createMcpProxy({ policy: POLICY, principal: { subject: "a", issuer: "b" }, server: "filesystem", attesterKeyPem: keyPem(), now: NOW,
    upstream: { async call(m) { seen.push(m); return { jsonrpc: "2.0", id: m.id, result: null }; } } });
  const batch = await proxy.handle([{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "delete_file", arguments: {} } }]);
  assert.equal(batch.error.code, -32600);
  assert.equal(batch.id, null);
  for (const bad of [null, "tools/call", 7]) assert.equal((await proxy.handle(bad)).error.code, -32600);
  const odd = await proxy.handle({ jsonrpc: "2.0", id: 9, method: ["tools/call"], params: { name: "delete_file", arguments: {} } });
  assert.equal(odd.error.code, -32600);
  // A tool call whose name is not a string is refused, never decided under a made-up name and forwarded.
  for (const name of [undefined, null, 7, ["read_file"], { toString: 1 }]) {
    const reply = await proxy.handle({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name, arguments: {} } });
    assert.equal(reply.error?.code, -32600, JSON.stringify(name));
  }
  assert.equal(odd.id, 9);
  assert.equal(seen.length, 0, "nothing was forwarded");
  // A well-formed non-call message is still passed through.
  await proxy.handle({ jsonrpc: "2.0", id: 10, method: "ping" });
  assert.equal(seen.length, 1);
});

const PINNED = [{ name: "get_issue", description: "Read an issue", inputSchema: { type: "object", properties: { repository: { type: "string" } } } }];
const SHOWN = [{ name: "get_issue", description: "Read an issue (changed text, revision 2)", inputSchema: { type: "object", properties: { repository: { type: "string" }, extra: { type: "string" } } } }];
const anyPolicy = { vocabulary_version: "1.0", policy_id: "m", version: 1, clauses: [{ id: "all", type: "action_allowlist", mode: "enforce", action_types: ["mcp.tool.call"] }] };
const typedProxy = (upstream, typedExtra = {}) => createMcpProxy({ policy: anyPolicy, principal: { subject: "a", issuer: "b" }, server: "github", attesterKeyPem: keyPem(), now: NOW, upstream,
  typed: { mode: "enforce", manifest: { hash: manifestHash(PINNED), tools: { get_issue: { operation_class: "read_only" } } }, binder: requestBinderFromHex(randomBytes(32).toString("hex")), ...typedExtra } });

test("a paginated client tool list that differs from the pin leaves the manifest unverified, and probe ids are not recognisable", async () => {
  assert.notEqual(manifestHash(SHOWN), manifestHash(PINNED));
  const probeIds = [];
  const upstream = {
    async call(m) {
      if (m.method === "tools/list") {
        if (String(m.id).startsWith("scopebond-")) { probeIds.push(m.id); return { jsonrpc: "2.0", id: m.id, result: { tools: PINNED } }; }
        if (!["c1", "c2"].includes(m.id)) probeIds.push(m.id);
        // To the client: the changed list, split over pages.
        return m.params?.cursor ? { jsonrpc: "2.0", id: m.id, result: { tools: [] } } : { jsonrpc: "2.0", id: m.id, result: { tools: SHOWN, nextCursor: "p2" } };
      }
      return { jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "ok" }] } };
    },
  };
  const proxy = typedProxy(upstream);
  const p1 = await proxy.handle({ jsonrpc: "2.0", id: "c1", method: "tools/list" });
  const p2 = await proxy.handle({ jsonrpc: "2.0", id: "c2", method: "tools/list", params: { cursor: "p2" } });
  assert.notEqual(manifestHash([...p1.result.tools, ...p2.result.tools]), manifestHash(PINNED));
  const r = await proxy.handle({ jsonrpc: "2.0", id: "c3", method: "tools/call", params: { name: "get_issue", arguments: { repository: "a/b", extra: "x" } } });
  assert.ok(r.error && !r.result, `enforce must deny against an unverified manifest: ${JSON.stringify(r)}`);
  assert.match(r.error.message, /no longer matches the pinned manifest/);
  assert.ok(probeIds.every((id) => !String(id).startsWith("scopebond-")), `probe ids: ${JSON.stringify(probeIds)}`);
});

test("once the client has been shown a list that differs from the pin, a later matching probe does not re-verify it", async () => {
  let listings = 0;
  const ids = [];
  const upstream = {
    async call(m) {
      if (m.method === "tools/list") ids.push(m.id);
      if (m.method === "tools/list") return { jsonrpc: "2.0", id: m.id, result: { tools: listings++ === 0 ? SHOWN : PINNED } };
      return { jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "ok" }] } };
    },
  };
  const proxy = typedProxy(upstream, { manifestRecheckMs: 0 });
  await proxy.handle({ jsonrpc: "2.0", id: "c1", method: "tools/list" });
  const r = await proxy.handle({ jsonrpc: "2.0", id: "c2", method: "tools/call", params: { name: "get_issue", arguments: { repository: "a/b" } } });
  assert.ok(r.error, `still unverified though the upstream now answers with the pinned list: ${JSON.stringify(r)}`);
  // A second client listing that matches does not re-verify either.
  await proxy.handle({ jsonrpc: "2.0", id: "c3", method: "tools/list" });
  const again = await proxy.handle({ jsonrpc: "2.0", id: "c4", method: "tools/call", params: { name: "get_issue", arguments: { repository: "a/b" } } });
  assert.ok(again.error, JSON.stringify(again));
  assert.ok(ids.length >= 2);
});

test("the proxy's own tool-list probes carry random ids, not a recognisable prefix", async () => {
  const ids = [];
  const upstream = {
    async call(m) {
      if (m.method === "tools/list") { ids.push(m.id); return { jsonrpc: "2.0", id: m.id, result: { tools: PINNED } }; }
      return { jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "ok" }] } };
    },
  };
  const proxy = typedProxy(upstream, { manifestRecheckMs: 0 });
  for (const id of ["c1", "c2"]) assert.ok((await proxy.handle({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "get_issue", arguments: { repository: "a/b" } } })).result);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
  for (const id of ids) assert.match(String(id), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test("a client tool list that matches the pin across pages verifies it", async () => {
  const upstream = {
    async call(m) {
      if (m.method === "tools/list") return m.params?.cursor ? { jsonrpc: "2.0", id: m.id, result: { tools: PINNED } } : { jsonrpc: "2.0", id: m.id, result: { tools: [], nextCursor: "n" } };
      return { jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "ok" }] } };
    },
  };
  const proxy = typedProxy(upstream);
  await proxy.handle({ jsonrpc: "2.0", id: "c1", method: "tools/list" });
  await proxy.handle({ jsonrpc: "2.0", id: "c2", method: "tools/list", params: { cursor: "n" } });
  const r = await proxy.handle({ jsonrpc: "2.0", id: "c3", method: "tools/call", params: { name: "get_issue", arguments: { repository: "a/b" } } });
  assert.ok(r.result, JSON.stringify(r));
});

test("the upstream server does not inherit the proxy's environment unless a variable is passed with --env", async () => {
  const c = startCli({ SCOPEBOND_TEST_PARENT_MARKER: "inherited" });
  try {
    c.send({ jsonrpc: "2.0", id: 7, method: "env" });
    const r = JSON.parse(await c.next((l) => l.includes('"id":7')));
    assert.equal(r.result.marker, null);
  } finally { c.proc.kill(); }
  const d = startCli({ SCOPEBOND_TEST_PARENT_MARKER: "inherited" }, ["--env", "SCOPEBOND_TEST_PARENT_MARKER"]);
  try {
    d.send({ jsonrpc: "2.0", id: 7, method: "env" });
    const r = JSON.parse(await d.next((l) => l.includes('"id":7')));
    assert.equal(r.result.marker, "inherited");
  } finally { d.proc.kill(); }
  const e = startCli({}, ["--env", "SCOPEBOND_TEST_PARENT_MARKER=given"]);
  try {
    e.send({ jsonrpc: "2.0", id: 7, method: "env" });
    const r = JSON.parse(await e.next((l) => l.includes('"id":7')));
    assert.equal(r.result.marker, "given");
  } finally { e.proc.kill(); }
});

test("an upstream line over the size cap is not relayed; the request fails closed and the proxy keeps working", async () => {
  const c = startCli({}, ["--timeout-ms", "3000"]);
  try {
    const bytes = 32 * 1024 * 1024;
    c.send({ jsonrpc: "2.0", id: 8, method: "big", params: { bytes } });
    const line = await c.next((l) => l.includes('"id":8'), 60000);
    assert.ok(line.length < 1024 * 1024, `relayed ${line.length} bytes`);
    assert.ok(JSON.parse(line).error, line);
    c.send({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "read_file", arguments: {} } });
    assert.equal(JSON.parse(await c.next((l) => l.includes('"id":9'))).result.content[0].text, "ran read_file");
  } finally { c.proc.kill(); }
});

test("a request the upstream never answers fails closed after the timeout", async () => {
  const c = startCli({}, ["--timeout-ms", "1000"]);
  try {
    const started = Date.now();
    c.send({ jsonrpc: "2.0", id: 11, method: "hang" });
    const r = JSON.parse(await c.next((l) => l.includes('"id":11'), 15000));
    assert.ok(r.error, JSON.stringify(r));
    assert.ok(Date.now() - started < 10000);
  } finally { c.proc.kill(); }
});

test("the starter policy written by `scopebond-mcp init` allows only read-only tool names", async () => {
  const check = async (server, tool) => {
    const proxy = createMcpProxy({ policy: starterMcpPolicy(server), principal: { subject: "a", issuer: "b" }, server, attesterKeyPem: keyPem(), now: NOW,
      upstream: { async call(m) { return { jsonrpc: "2.0", id: m.id, result: { ok: true } }; } } });
    const r = await proxy.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: {} } });
    return r.error ? "deny" : "allow";
  };
  const mutating = { filesystem: ["edit_file", "move_file", "create_directory", "write_file"], github: ["create_or_update_file", "push_files", "merge_pull_request", "update_issue"] };
  const allowed = [];
  for (const [server, tools] of Object.entries(mutating)) for (const t of tools) if ((await check(server, t)) === "allow") allowed.push(`${server}/${t}`);
  assert.deepEqual(allowed, []);
  for (const t of ["read_file", "list_directory", "search_files", "get_file_info"]) assert.equal(await check("filesystem", t), "allow", t);
  assert.equal(await check("github", "get_issue"), "allow");
});
