#!/usr/bin/env node
// scopebond-mcp — a stdio Model Context Protocol proxy. It sits between an MCP
// client and an upstream server: the client speaks MCP to this process, and this
// process speaks MCP to the upstream command (everything after `--`). Every
// tools/call is checked against policy before it is forwarded; a denial returns a
// JSON-RPC error and is never sent upstream.
//
//   scopebond-mcp init --server <id>          scaffold a key + starter policy
//   scopebond-mcp --server <id> [--policy p.json] [--key k.pem] [--principal sub] \
//       [--receipts log.jsonl] [--typed typed.json] [--dispatch-dir dir] [--delegation id] \
//       [--env NAME[=value]]... [--timeout-ms 120000] -- <upstream-command...>
//
// The upstream is started with a minimal environment (PATH, HOME/USERPROFILE, the temp and system
// directories, locale), not the proxy's whole environment. Pass anything else it needs with
// --env NAME (copied from the proxy's environment) or --env NAME=value, repeatable, or list names
// in SCOPEBOND_MCP_UPSTREAM_ENV (comma-separated). The upstream still runs as the same OS user, so
// it can read any file the proxy can, including the signing key and a stored Cloud credential.
//
// Limits: a JSON-RPC line over 8 MiB from either side is dropped (never relayed), and a request
// the upstream has not answered within --timeout-ms (default 120000, SCOPEBOND_MCP_TIMEOUT_MS)
// fails closed with a JSON-RPC error. A JSON-RPC batch from the client is rejected (-32600).
//
// --dispatch-dir turns on the dispatch boundary (off by default): the directory holds dispatch.json
// (require_approval, approver_keys, budgets), an approvals/ inbox and the shared dispatch.db. Each
// tools/call that policy allows then needs its single-use approval, its delegated scope and its
// action-budget slot before it is forwarded; without them it is denied and never sent upstream.
// --delegation (or SCOPEBOND_DELEGATION) runs the proxy under a delegated child scope.
//
// --typed turns on the typed adapter (off by default): a JSON file with
//   { "mode": "monitor" | "enforce", "manifest": { "hash": "sha256:…", "tools": { "<tool>":
//     { "operation_class": "read_only" | "mutation", "resources": [{ "arg": "repository", "kind": "repository" }] } } },
//     "requireResourceBinding": true, "approvedResources": { "repository": ["owner/name"] } }
// Under "enforce" a tool the pinned manifest does not list, a server whose tool list no longer
// matches its hash, and (with requireResourceBinding) a call whose resources cannot be bound
// from the dispatched arguments or are not approved, are denied before dispatch. When the
// hook is installed and enrolled for observations (SCOPEBOND_HOOK_DIR or --observations-dir),
// tool_intent and tool_outcome observations are queued in its outbox.
//
// Env: SCOPEBOND_MCP_POLICY, SCOPEBOND_MCP_KEY, SCOPEBOND_MCP_SERVER,
//      SCOPEBOND_MCP_PRINCIPAL, SCOPEBOND_MCP_RECEIPTS.
// MCP stdio is newline-delimited JSON-RPC. Fail closed: any setup error exits 1.

import { readFileSync, appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import type { SignedReceipt, CloudExporter } from "@scopebond/gateway";
import { createMcpProxy, invalidMessageReason } from "./proxy.js";
import { readLines, upstreamEnv, MAX_LINE_BYTES } from "./stdio.js";
import { requestBinderFromHex, typedConfigProblem, type ObservationSink, type RequestBinder, type TypedAdapterConfig } from "./typed.js";
import { loadOrCreateHexKey } from "./key-file.js";
import { join, resolve } from "node:path";
import type { JsonRpcMessage, McpUpstream } from "./proxy.js";
import { scaffold } from "./init.js";
import { openApprovalBinder, openDispatchGuard, isBareProgramName, programPath } from "@scopebond/gateway/node";
import { connectCloud, loadMcpConnection, connectionFileFor, openExporter } from "./cloud.js";

// Options are read only before `--`: everything after it belongs to the upstream command.
const optionEnd = process.argv.indexOf("--") < 0 ? process.argv.length : process.argv.indexOf("--");
const options = process.argv.slice(0, optionEnd);
function arg(name: string, fallback?: string): string | undefined {
  const i = options.indexOf(name);
  return i >= 0 ? options[i + 1] : fallback;
}
function args(name: string): string[] {
  const out: string[] = [];
  options.forEach((a, i) => { if (a === name && options[i + 1] !== undefined) out.push(options[i + 1]); });
  return out;
}
interface RequestBinderHolder { binding: RequestBinder }
function die(message: string): never { process.stderr.write(`scopebond-mcp: ${message}\n`); process.exit(1); }

// `init`: scaffold a key + a starter policy for one server, then exit.
if (process.argv[2] === "init") {
  const server = arg("--server", process.env.SCOPEBOND_MCP_SERVER);
  if (!server) die("usage: scopebond-mcp init --server <upstream-server-id>");
  const { keyFile, policyFile } = scaffold(server, { force: process.argv.includes("--force") });
  console.log(`Scopebond MCP proxy enrolled for server "${server}":`);
  console.log(`  key      ${keyFile}`);
  console.log(`  policy   ${policyFile} (starter — edit the tool bounds)`);
  console.log("");
  console.log("Point your MCP client at the proxy:");
  console.log(`  scopebond-mcp --server ${server} -- <your real MCP server command>`);
  process.exit(0);
}

// `connect`: enroll the proxy's key with a workspace and store a scoped credential.
if (process.argv[2] === "connect") {
  const url = process.argv[3];
  const bundleFile = process.argv[4];
  const keyPath = arg("--key", process.env.SCOPEBOND_MCP_KEY ?? "scopebond-agent.key")!;
  if (!url || !bundleFile) die("usage: scopebond-mcp connect <workspace-url> <enrollment-bundle.json> [--key k.pem]");
  let bundle;
  try { bundle = JSON.parse(readFileSync(bundleFile, "utf8")); }
  catch (e) { die(`could not read the enrollment bundle ${bundleFile}: ${(e as Error).message}`); }
  connectCloud(keyPath, url, bundle).then((c) => {
    console.log(`Connected to ${c.url} (org ${c.organization_id} · env ${c.environment_id})`);
    console.log(`  credential stored in ${connectionFileFor(keyPath)} — a secret, do not commit`);
    console.log("Run the proxy as usual; every governed tool call is now mirrored to your workspace.");
    process.exit(0);
  }).catch((e) => die(`connect failed: ${(e as Error).message}`));
} else {

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

// The typed adapter's config is checked before the upstream starts: a value of the wrong shape (an approved-resources entry
// written as one string, say) is refused, never read loosely.
const typedPath = arg("--typed", process.env.SCOPEBOND_MCP_TYPED);
let typedRaw: Record<string, unknown> | undefined;
if (typedPath) {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(typedPath, "utf8")); } catch (e) { die(`could not read the typed config ${typedPath}: ${(e as Error).message}`); }
  const problem = typedConfigProblem(raw);
  if (problem) die(`the typed config ${typedPath} is not valid: ${problem}`);
  typedRaw = raw as Record<string, unknown>;
}

// When connected to a workspace, mirror the PEP-authorized receipts to the portal
// through a durable outbox. The proxy is long-running, so the exporter's own timer
// delivers; a final flush runs on shutdown.
const connection = loadMcpConnection(keyPath as string);
let exporter: CloudExporter | undefined;
if (connection) {
  try { exporter = openExporter(keyPath as string, connection); }
  catch (e) { die(`durable Cloud outbox could not open: ${(e as Error).message}`); }
}

const timeoutRaw = arg("--timeout-ms", process.env.SCOPEBOND_MCP_TIMEOUT_MS ?? "120000") as string;
const timeoutMs = Number(timeoutRaw);
if (!/^\d+$/.test(timeoutRaw) || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) die(`--timeout-ms must be a positive whole number of milliseconds, not "${timeoutRaw}"`);

let childEnv: Record<string, string> = {};
try {
  const listed = (process.env.SCOPEBOND_MCP_UPSTREAM_ENV ?? "").split(",").map((n) => n.trim()).filter(Boolean);
  childEnv = upstreamEnv(process.env, [...listed, ...args("--env")]);
} catch (e) { die((e as Error).message); }

// A bare program name is looked up in the absolute folders on the upstream's PATH, never in the current folder (a
// spawn by bare name on Windows looks in the project folder first); a name with a folder in it is started as given.
let upstreamProgram = upstreamCmd[0];
if (isBareProgramName(upstreamProgram)) {
  try { upstreamProgram = programPath(upstreamProgram, { env: childEnv }); }
  catch (e) { die(`could not start the upstream server: ${(e as Error).message}`); }
}

// Spawn the upstream server with an allow-listed environment and correlate its responses by id.
const child = spawn(upstreamProgram, upstreamCmd.slice(1), { stdio: ["pipe", "pipe", "inherit"], env: childEnv });
child.on("error", (e) => die(`could not start the upstream server: ${e.message}`));
const shutdown = (code: number) => {
  const done = (): never => process.exit(code);
  void Promise.allSettled([exporter?.flush(), observations?.flush()]).finally(() => { exporter?.stop(); try { observations?.close(); } catch { /* closing is best effort */ } done(); });
};
child.on("exit", (code) => shutdown(code ?? 0));
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

const pending = new Map<string, (m: JsonRpcMessage) => void>();
const timedOut = new Set<string>();
const key = (id: unknown) => JSON.stringify(id ?? null);
const isObject = (m: unknown): m is JsonRpcMessage => m !== null && typeof m === "object" && !Array.isArray(m);

readLines(child.stdout, MAX_LINE_BYTES, (line) => {
  if (!line.trim()) return;
  let msg: unknown;
  try { msg = JSON.parse(line); } catch { return; }
  // A response (no method) settles the request it answers; a late answer to a timed-out request is dropped.
  if (isObject(msg) && msg.method === undefined && msg.id !== undefined && msg.id !== null) {
    const k = key(msg.id);
    const waiter = pending.get(k);
    if (waiter) { pending.delete(k); waiter(msg); return; }
    if (timedOut.delete(k)) return;
  }
  process.stdout.write(line + "\n"); // upstream-initiated request or notification → pass to the client
}, () => process.stderr.write(`scopebond-mcp: dropped an upstream message over ${MAX_LINE_BYTES} bytes\n`));

const upstream: McpUpstream = {
  call(message) {
    return new Promise((resolve) => {
      if (!isObject(message)) throw new Error("only single JSON-RPC objects are forwarded");
      // A notification, or the client's response to an upstream request: nothing comes back.
      if (message.id === undefined || message.id === null || typeof message.method !== "string") {
        child.stdin.write(JSON.stringify(message) + "\n");
        resolve({ jsonrpc: "2.0", result: null });
        return;
      }
      const k = key(message.id);
      const timer = setTimeout(() => {
        if (pending.get(k) !== settle) return;
        pending.delete(k);
        timedOut.add(k);
        if (timedOut.size > 10_000) timedOut.delete(timedOut.values().next().value as string);
        resolve({ jsonrpc: "2.0", id: message.id, error: { code: -32001, message: `scopebond-mcp: the upstream did not answer within ${timeoutMs} ms (failed closed)` } });
      }, timeoutMs);
      const settle = (m: JsonRpcMessage): void => { clearTimeout(timer); resolve(m); };
      pending.set(k, settle);
      child.stdin.write(JSON.stringify(message) + "\n");
    });
  },
};

// The typed adapter is off unless a typed config is given. Its binding key and observation
// outbox come from the hook when it is installed and enrolled; otherwise the key is a local
// file beside the signing key (never uploaded) and nothing is queued.
// The proxy's local key: a file beside the signing key, made on first use and never uploaded. It keys the typed
// adapter's request binding (when the hook does not supply one) and every receipt's args_digest.
function localBindingKey(): string {
  return loadOrCreateHexKey(`${keyPath}.binding`);
}
let typed: TypedAdapterConfig | undefined;
let observations: { flush(): Promise<unknown>; close(): void } | undefined;
if (typedRaw) {
  const raw = typedRaw;
  let binder: RequestBinder | undefined;
  let sink: ObservationSink | undefined;
  const hookDir = arg("--observations-dir", process.env.SCOPEBOND_HOOK_DIR);
  if (hookDir) {
    try {
      const hook = await import("@scopebond/hook") as unknown as { openObservations(dir: string, o?: object): { status: { state: string; reason?: string }; emitter?: ObservationSink & RequestBinderHolder & { flush(): Promise<unknown>; close(): void } } };
      const opened = hook.openObservations(resolve(hookDir), { adapterVersion: "scopebond-mcp" });
      if (opened.emitter) { sink = opened.emitter; binder = opened.emitter.binding; observations = opened.emitter; }
      else process.stderr.write(`scopebond-mcp: observations are not on (${opened.status.reason ?? opened.status.state}); the typed adapter runs without them\n`);
    } catch (e) { process.stderr.write(`scopebond-mcp: the hook package is not available for observations (${(e as Error).message})\n`); }
  }
  if (!binder) binder = requestBinderFromHex(localBindingKey());
  // Only the checked fields, never the rest of the file.
  typed = {
    mode: raw.mode as TypedAdapterConfig["mode"], binder, ...(sink ? { sink } : {}),
    ...(raw.manifest !== undefined ? { manifest: raw.manifest as TypedAdapterConfig["manifest"] } : {}),
    ...(raw.requireResourceBinding !== undefined ? { requireResourceBinding: raw.requireResourceBinding as boolean } : {}),
    ...(raw.approvedResources !== undefined ? { approvedResources: raw.approvedResources as Record<string, string[]> } : {}),
    ...(raw.manifestRecheckMs !== undefined ? { manifestRecheckMs: raw.manifestRecheckMs as number } : {}),
    ...(raw.referenceSetVersion !== undefined ? { referenceSetVersion: raw.referenceSetVersion as string } : {}),
  };
}

// The dispatch boundary is opt-in. A directory that is named but cannot be read is a setup error: it says what may be spent.
const dispatchDir = arg("--dispatch-dir", process.env.SCOPEBOND_DISPATCH_DIR);
const delegationId = arg("--delegation", process.env.SCOPEBOND_DELEGATION);
let dispatch: { guard: NonNullable<ReturnType<typeof openDispatchGuard>>; delegationId?: string; binder?: ReturnType<typeof openApprovalBinder> & object } | undefined;
if (delegationId && !dispatchDir) die("--delegation needs --dispatch-dir (a delegation is checked against its shared store)");
if (dispatchDir) {
  try {
    const guard = openDispatchGuard(dispatchDir ?? ".", { delegated: !!delegationId });
    if (guard) { const binder = openApprovalBinder(dispatchDir ?? "."); dispatch = { guard, ...(delegationId ? { delegationId } : {}), ...(binder ? { binder } : {}) }; }
  } catch (e) { die(`could not read the dispatch settings in ${dispatchDir ?? "."}: ${(e as Error).message}`); }

}

// args_digest is keyed: with the hook's per-machine digest key when the hook's folder is given and has one, else with
// the proxy's local key.
function argsDigestKeyHex(): string {
  const hookDir = arg("--observations-dir", process.env.SCOPEBOND_HOOK_DIR);
  if (hookDir) {
    try {
      const hex = readFileSync(join(resolve(hookDir), "digest.key"), "utf8").trim();
      if (/^[0-9a-f]{64}$/.test(hex)) return hex;
    } catch { /* fall back to the proxy's own key */ }
  }
  return localBindingKey();
}
let argsDigestKey: string;
try { argsDigestKey = argsDigestKeyHex(); } catch (e) { die(`could not read or create the local key ${keyPath}.binding: ${(e as Error).message}`); }

const proxy = createMcpProxy({
  policy, principal: { subject: `client:${principal}`, issuer: "scopebond:mcp-proxy" }, server: server,
  attesterKeyPem, argsDigestKey, upstream, ...(dispatch ? { dispatch } : {}), ...(typed ? { typed, adapterVersion: "scopebond-mcp" } : {}),
  onReceipt: (r: SignedReceipt) => {
    if (receiptsPath) { try { appendFileSync(receiptsPath, JSON.stringify(r) + "\n"); } catch { /* best effort */ } }
    exporter?.enqueue(r); // mirror to the workspace when connected
  },
});

const reply = (m: unknown): void => { process.stdout.write(JSON.stringify(m) + "\n"); };
// Lines are decided concurrently, as they arrive. Every failure while deciding one is answered inside
// `handleLine`; the `.catch` only keeps anything left over (a failed reply write) from becoming an
// unhandled rejection, which would end the proxy.
readLines(process.stdin, MAX_LINE_BYTES, (line) => {
  handleLine(line).catch((e: unknown) => { process.stderr.write(`scopebond-mcp: ${e instanceof Error ? e.message : String(e)}\n`); });
}, () => reply({ jsonrpc: "2.0", id: null, error: { code: -32600, message: `Invalid Request: message over ${MAX_LINE_BYTES} bytes` } }));

async function handleLine(line: string): Promise<void> {
  if (!line.trim()) return;
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { return; }
  // A batch or other non-message is answered here and never forwarded.
  const invalid = invalidMessageReason(parsed);
  if (invalid) { reply(await proxy.handle(parsed)); return; }
  const msg = parsed as JsonRpcMessage;
  const expectsReply = typeof msg.method === "string" && msg.id !== undefined && msg.id !== null;
  try {
    const response = await proxy.handle(msg);
    if (expectsReply) reply(response);
  } catch (e) {
    // Fail closed: a proxy error becomes a JSON-RPC error, never a silent forward.
    if (expectsReply) reply({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: `scopebond-mcp failed closed: ${(e as Error).message}` } });
  }
}
}
