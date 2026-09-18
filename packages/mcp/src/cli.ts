#!/usr/bin/env node
// scopebond-mcp — a stdio Model Context Protocol proxy. It sits between an MCP
// client and an upstream server: the client speaks MCP to this process, and this
// process speaks MCP to the upstream command (everything after `--`). Every
// tools/call is checked against policy before it is forwarded; a denial returns a
// JSON-RPC error and is never sent upstream.
//
//   scopebond-mcp init --server <id>          scaffold a key + starter policy
//   scopebond-mcp --server <id> [--policy p.json] [--key k.pem] [--principal sub] \
//       [--receipts log.jsonl] -- <upstream-command...>
//
// Env: SCOPEBOND_MCP_POLICY, SCOPEBOND_MCP_KEY, SCOPEBOND_MCP_SERVER,
//      SCOPEBOND_MCP_PRINCIPAL, SCOPEBOND_MCP_RECEIPTS.
// MCP stdio is newline-delimited JSON-RPC. Fail closed: any setup error exits 1.

import { readFileSync, appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createMcpProxy } from "./proxy.js";
import type { JsonRpcMessage, McpUpstream } from "./proxy.js";
import { scaffold } from "./init.js";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
function die(message: string): never { process.stderr.write(`scopebond-mcp: ${message}\n`); process.exit(1); }

// `init`: scaffold a key + a starter policy for one server, then exit.
if (process.argv[2] === "init") {
  const server = arg("--server", process.env.SCOPEBOND_MCP_SERVER);
  if (!server) die("usage: scopebond-mcp init --server <upstream-server-id>");
  const { keyFile, policyFile } = scaffold(server as string, { force: process.argv.includes("--force") });
  console.log(`Scopebond MCP proxy enrolled for server "${server}":`);
  console.log(`  key      ${keyFile}`);
  console.log(`  policy   ${policyFile} (starter — edit the tool bounds)`);
  console.log("");
  console.log("Point your MCP client at the proxy:");
  console.log(`  scopebond-mcp --server ${server} -- <your real MCP server command>`);
  process.exit(0);
}

const dashDash = process.argv.indexOf("--");
if (dashDash < 0 || dashDash === process.argv.length - 1) die("provide the upstream command after `--`");
const upstreamCmd = process.argv.slice(dashDash + 1);

const server = arg("--server", process.env.SCOPEBOND_MCP_SERVER);
const policyPath = arg("--policy", process.env.SCOPEBOND_MCP_POLICY ?? "scopebond.policy.json");
const keyPath = arg("--key", process.env.SCOPEBOND_MCP_KEY ?? "scopebond-agent.key");
const principal = arg("--principal", process.env.SCOPEBOND_MCP_PRINCIPAL ?? "mcp-client");
const receiptsPath = arg("--receipts", process.env.SCOPEBOND_MCP_RECEIPTS);
if (!server) die("--server (the upstream server id) is required");

let policy: unknown;
let attesterKeyPem: string;
try { policy = JSON.parse(readFileSync(policyPath as string, "utf8")); } catch (e) { die(`could not read policy ${policyPath}: ${(e as Error).message}`); }
try { attesterKeyPem = readFileSync(keyPath as string, "utf8"); } catch (e) { die(`could not read signing key ${keyPath}: ${(e as Error).message}`); }

// Spawn the upstream server and correlate its responses by id.
const child = spawn(upstreamCmd[0], upstreamCmd.slice(1), { stdio: ["pipe", "pipe", "inherit"] });
child.on("error", (e) => die(`could not start the upstream server: ${e.message}`));
child.on("exit", (code) => process.exit(code ?? 0));

const pending = new Map<string, (m: JsonRpcMessage) => void>();
const key = (id: unknown) => JSON.stringify(id ?? null);

createInterface({ input: child.stdout }).on("line", (line) => {
  if (!line.trim()) return;
  let msg: JsonRpcMessage;
  try { msg = JSON.parse(line); } catch { return; }
  const waiter = msg.id !== undefined ? pending.get(key(msg.id)) : undefined;
  if (waiter) { pending.delete(key(msg.id)); waiter(msg); return; }
  process.stdout.write(line + "\n"); // upstream-initiated notification → pass to the client
});

const upstream: McpUpstream = {
  call(message) {
    return new Promise((resolve) => {
      if (message.id === undefined || message.id === null) { // notification: fire and forget
        child.stdin.write(JSON.stringify(message) + "\n");
        resolve({ jsonrpc: "2.0", result: null });
        return;
      }
      pending.set(key(message.id), resolve);
      child.stdin.write(JSON.stringify(message) + "\n");
    });
  },
};

const proxy = createMcpProxy({
  policy, principal: { subject: `client:${principal}`, issuer: "scopebond:mcp-proxy" }, server: server as string,
  attesterKeyPem, upstream,
  onReceipt: receiptsPath ? (r) => { try { appendFileSync(receiptsPath, JSON.stringify(r) + "\n"); } catch { /* best effort */ } } : undefined,
});

createInterface({ input: process.stdin }).on("line", async (line) => {
  if (!line.trim()) return;
  let msg: JsonRpcMessage;
  try { msg = JSON.parse(line); } catch { return; }
  try {
    const response = await proxy.handle(msg);
    if (msg.id !== undefined && msg.id !== null) process.stdout.write(JSON.stringify(response) + "\n");
  } catch (e) {
    // Fail closed: a proxy error becomes a JSON-RPC error, never a silent forward.
    if (msg.id !== undefined && msg.id !== null) {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: `scopebond-mcp failed closed: ${(e as Error).message}` } }) + "\n");
    }
  }
});
