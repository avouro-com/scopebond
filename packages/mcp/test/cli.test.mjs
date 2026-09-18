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
