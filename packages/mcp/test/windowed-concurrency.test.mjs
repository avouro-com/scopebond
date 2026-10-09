// Windowed policy clauses (rate_limit, sequence) hold however tools/call requests arrive: one at a time, all at once
// from the library, or pipelined on the CLI's stdin. Each allowed call takes its place in the window in the same
// step as its verdict, so a burst is decided call by call against the calls before it, and two identical calls in
// the same millisecond are two calls. Method names that spell a decided method another way are refused, never
// forwarded. Local only: in-process stub upstreams and a node-script upstream for the CLI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync } from "node:crypto";
import { createInterface } from "node:readline";
import { createMcpProxy } from "../dist/index.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const keyPem = () => generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();

// Every tool on the server is allowed, at most 2 calls per hour.
const RATE = {
  vocabulary_version: "1.0", policy_id: "mcp-rate", version: 1,
  clauses: [
    { id: "tools", type: "action_allowlist", mode: "enforce", action_types: ["mcp.tool.call"], param_bounds: { server: { enum: ["filesystem"] } } },
    { id: "rate", type: "rate_limit", mode: "enforce", action_types: ["mcp.tool.call"], max_count: 2, window: "PT1H", scope: "principal" },
  ],
};
// At least a minute between tool calls.
const GAP = {
  vocabulary_version: "1.0", policy_id: "mcp-gap", version: 1,
  clauses: [
    { id: "tools", type: "action_allowlist", mode: "enforce", action_types: ["mcp.tool.call"] },
    { id: "gap", type: "sequence", mode: "enforce", first_action_types: ["mcp.tool.call"], then_action_types: ["mcp.tool.call"], min_gap: "PT1M" },
  ],
};

function proxyWith(policy, extra = {}) {
  const forwarded = [];
  const upstream = { async call(m) { forwarded.push(m); await new Promise((r) => setTimeout(r, 5)); return { jsonrpc: "2.0", id: m.id, result: { content: [] } }; } };
  const proxy = createMcpProxy({
    policy, principal: { subject: "client:t", issuer: "scopebond:mcp-proxy" }, server: "filesystem",
    attesterKeyPem: keyPem(), argsDigestKey: "ab".repeat(32), upstream, ...extra,
  });
  return { proxy, forwarded };
}
const call = (id, name, args = { n: id }) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

test("sequential tools/call requests are stopped at the rate_limit", async () => {
  const { proxy, forwarded } = proxyWith(RATE);
  const results = [];
  for (let i = 1; i <= 6; i++) results.push(await proxy.handle(call(i, "read_file")));
  assert.equal(forwarded.length, 2);
  assert.equal(results.filter((r) => r.error).length, 4);
});

test("concurrent tools/call requests are stopped at the rate_limit: exactly max_count are forwarded", async () => {
  const { proxy, forwarded } = proxyWith(RATE);
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => proxy.handle(call(i + 1, "write_file"))));
  assert.equal(forwarded.length, 2, `forwarded ${forwarded.length} of 10 under a limit of 2`);
  const denied = results.filter((r) => r.error);
  assert.equal(denied.length, 8);
  assert.ok(denied.every((r) => /exceeds max_count 2/.test(r.error.message)), JSON.stringify(denied[0]));
});

test("identical calls stamped in the same millisecond are counted as separate calls", async () => {
  const { proxy, forwarded } = proxyWith(RATE, { now: () => "2026-10-09T12:00:00.000Z" });
  for (let i = 1; i <= 6; i++) await proxy.handle(call(i, "write_file", { path: "/x" }));
  assert.equal(forwarded.length, 2);
});

test("a sequence gap holds for concurrent calls", async () => {
  const { proxy, forwarded } = proxyWith(GAP);
  await Promise.all(Array.from({ length: 5 }, (_, i) => proxy.handle(call(i + 1, "write_file"))));
  assert.equal(forwarded.length, 1);
});

test("a call refused after policy allowed it (dispatch boundary) does not use up the window", async () => {
  let n = 0;
  const guard = { async authorize() { n++; return n === 1 ? { allow: false, reason: "budget_exhausted", consumed_approvals: [], budgets: [] } : { allow: true, reason: "allowed", consumed_approvals: [], budgets: [] }; } };
  const { proxy, forwarded } = proxyWith(RATE, { dispatch: { guard } });
  const first = await proxy.handle(call(1, "write_file"));
  assert.match(first.error.message, /dispatch boundary/);
  for (let i = 2; i <= 4; i++) await proxy.handle(call(i, "write_file"));
  assert.equal(forwarded.length, 2, "the refused call left its place in the window");
});

test("a method that spells tools/call or tools/list another way is refused and never forwarded", async () => {
  const { proxy, forwarded } = proxyWith(RATE);
  for (const method of ["Tools/Call", "tools/call ", " tools/call", "TOOLS/CALL", "tools/call​", "tools.call", "tools_call", "ｔｏｏｌｓ/ｃａｌｌ", "Tools/List"]) {
    const r = await proxy.handle({ jsonrpc: "2.0", id: 7, method, params: { name: "delete_file", arguments: {} } });
    assert.equal(r.error?.code, -32600, `${JSON.stringify(method)}: ${JSON.stringify(r)}`);
    assert.equal(r.id, 7);
  }
  assert.equal(forwarded.length, 0, JSON.stringify(forwarded.map((m) => m.method)));
  // The exact methods, and methods that merely contain the words, are unaffected.
  await proxy.handle({ jsonrpc: "2.0", id: 8, method: "tools/callers", params: {} });
  await proxy.handle(call(9, "read_file"));
  assert.deepEqual(forwarded.map((m) => m.method), ["tools/callers", "tools/call"]);
});

const UPSTREAM = (log) => `
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  if (!line.trim()) return;
  let m; try { m = JSON.parse(line); } catch { return; }
  appendFileSync(${JSON.stringify(log)}, "RECEIVED " + JSON.stringify(m.method) + " " + JSON.stringify(m.params && m.params.name) + "\\n");
  if (m.id === undefined || m.id === null) return;
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "ran " + (m.params && m.params.name) }] } }) + "\\n");
});
`;

test("CLI (scopebond-mcp): pipelined tools/call lines are stopped at the rate_limit, and look-alike methods never reach the upstream", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-mcp-window-"));
  const log = join(dir, "upstream.log"); writeFileSync(log, "");
  writeFileSync(join(dir, "upstream.mjs"), UPSTREAM(log));
  writeFileSync(join(dir, "policy.json"), JSON.stringify(RATE));
  writeFileSync(join(dir, "key.pem"), keyPem());
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, APPDATA: dir, LOCALAPPDATA: dir, SCOPEBOND_HOME: dir };
  delete env.SCOPEBOND_HOOK_DIR;
  const proc = spawn(process.execPath, [cli, "--server", "filesystem", "--policy", join(dir, "policy.json"), "--key", join(dir, "key.pem"),
    "--", process.execPath, join(dir, "upstream.mjs")], { stdio: ["pipe", "pipe", "inherit"], env, cwd: dir });
  const lines = [];
  createInterface({ input: proc.stdout, crlfDelay: Infinity }).on("line", (l) => { if (l.trim()) lines.push(JSON.parse(l)); });
  const waitFor = async (pred, ms = 15000) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error("timeout: " + JSON.stringify(lines)); await new Promise((r) => setTimeout(r, 25)); } };
  try {
    // One write, ten requests: what a client issuing parallel tool calls sends.
    proc.stdin.write(Array.from({ length: 10 }, (_, i) => JSON.stringify(call(i + 1, "write_file"))).join("\n") + "\n");
    await waitFor(() => lines.length >= 10);
    const executed = readFileSync(log, "utf8").split("\n").filter((l) => l.includes('"tools/call"')).length;
    assert.equal(executed, 2, `the upstream ran ${executed} of 10 under a limit of 2`);
    assert.equal(lines.filter((m) => m.error).length, 8);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 100, method: "Tools/Call", params: { name: "delete_file", arguments: {} } }) + "\n");
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 101, method: "tools/call ", params: { name: "delete_file", arguments: {} } }) + "\n");
    await waitFor(() => lines.some((m) => m.id === 100) && lines.some((m) => m.id === 101));
    assert.equal(lines.find((m) => m.id === 100).error.code, -32600);
    assert.equal(lines.find((m) => m.id === 101).error.code, -32600);
    assert.doesNotMatch(readFileSync(log, "utf8"), /delete_file/);
  } finally {
    proc.kill();
    await new Promise((r) => setTimeout(r, 200));
    rmSync(dir, { recursive: true, force: true });
  }
});
