// The agent's local control channel: HTTP with a random token, over a named pipe on Windows (a random name) or a Unix
// socket in a folder only this user can open. npm installs also listen on 127.0.0.1 at a random port, because the
// PowerShell tray and hooks before the pipe use it (SCOPEBOND_AGENT_LOOPBACK=0 turns it off); the signed install with the
// native tray does not (its tray and its hook use the pipe). The pipe or socket, the port, the token and the process id
// are written to agent.json in the Scopebond home, which is how the CLI, the hook's override window and the tray find it.
// Who can reach what: a loopback port can be reached by any program on the computer. The Unix socket sits in a folder only
// this user can open. The Windows pipe keeps Windows' default security for a pipe: other accounts can list its name and
// open it for reading (not enough to send a request), and only this user, administrators and the system can write to it.
// So the token is what protects every route: each request must carry it, whatever the channel. On loopback a request must
// also name 127.0.0.1 or localhost at this port as its Host, and no request may carry an Origin header: a web page's
// request does (or names its own host after rebinding a name to 127.0.0.1); the CLI, the hook and the trays send neither.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestOverSocket } from "@scopebond/hook";

export const AGENT_FILE = "agent.json";
export const TOKEN_HEADER = "x-scopebond-agent-token";

/** `socket`: the named pipe or Unix socket (absent from agents before it); `port`: 0 when loopback is off. */
export interface AgentEndpoint { port: number; socket?: string | null; token: string; pid: number; started_at: number; version: string }

/** Where this start's pipe or socket goes. Windows: a pipe whose name is random, so no other program can create it first
 *  (its name can still be listed once it exists). Elsewhere: `run/agent.sock` in the Scopebond home (folder 0700), or a
 *  private folder under the temporary folder when that path is longer than a Unix socket path may be. */
export function localSocketPath(dir: string, platform: NodeJS.Platform = process.platform, random = randomBytes(16).toString("hex")): string {
  if (platform === "win32") return `\\\\.\\pipe\\scopebond-agent-${random}`;
  const inHome = join(dir, "run", "agent.sock");
  if (Buffer.byteLength(inHome) <= 100) return inHome;
  return join(mkdtempSync(join(tmpdir(), "scopebond-")), "agent.sock");
}

/** Returns the answer, or a promise of it. */
export type Handler = (body: unknown) => unknown;

/** Whether a loopback request's Host names this computer at the agent's port: `127.0.0.1` or `localhost`, with that port or
 *  none. A page that rebinds its own name to 127.0.0.1 sends that name, and is refused. */
function localHost(host: string | undefined, port: number): boolean {
  if (!host || port <= 0) return false;
  const named = host.toLowerCase();
  return ["127.0.0.1", "localhost"].some((name) => named === name || named === `${name}:${port}`);
}

export function readEndpoint(dir: string): AgentEndpoint | null {
  const file = join(dir, AGENT_FILE);
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, "utf8")) as AgentEndpoint; } catch { return null; }
}

/** Start the control server. `routes` maps "METHOD /path" to a handler. `loopback`: also listen on 127.0.0.1 (default:
 *  unless SCOPEBOND_AGENT_LOOPBACK=0); it is used anyway when the pipe or socket could not be made, or nothing could reach
 *  the agent. */
export async function startControl(dir: string, version: string, routes: Record<string, Handler>, options: { loopback?: boolean } = {}): Promise<{ server: Server; endpoint: AgentEndpoint; close(): Promise<void> }> {
  const token = randomBytes(24).toString("base64url");
  const expected = Buffer.from(token);
  // The loopback port, once listening: a loopback request must name it in its Host.
  let loopbackPort = 0;
  const handle = async (req: IncomingMessage, res: ServerResponse, overLoopback: boolean) => {
    const send = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
    // Only local programs: no web page's Origin, and on loopback only this computer's own name for the port.
    if (req.headers.origin !== undefined || (overLoopback && !localHost(req.headers.host, loopbackPort))) return send(403, { error: "forbidden" });
    const offered = Buffer.from(String(req.headers[TOKEN_HEADER] ?? ""));
    if (offered.length !== expected.length || !timingSafeEqual(offered, expected)) return send(401, { error: "unauthorized" });
    const handler = routes[`${req.method} ${(req.url ?? "/").split("?")[0]}`];
    if (!handler) return send(404, { error: "not found" });
    let raw = "";
    for await (const chunk of req) { raw += chunk; if (raw.length > 64 * 1024) return send(413, { error: "too large" }); }
    try { send(200, await handler(raw ? JSON.parse(raw) : null)); }
    catch (error) { send(500, { error: (error as Error).message.slice(0, 200) }); }
  };
  // A caller that drops the connection mid-body rejects the read; that ends the request, never the agent.
  const listenerFor = (overLoopback: boolean) => (req: IncomingMessage, res: ServerResponse) => { handle(req, res, overLoopback).catch(() => { res.destroy(); }); };
  // The pipe or socket first. A Unix socket's folder is created for this user only, and the socket itself is too.
  const socketPath = localSocketPath(dir);
  const local = createServer(listenerFor(false));
  let socket: string | null = socketPath;
  try {
    if (process.platform !== "win32") {
      mkdirSync(join(socketPath, ".."), { recursive: true, mode: 0o700 });
      chmodSync(join(socketPath, ".."), 0o700);
      rmSync(socketPath, { force: true });
    }
    await new Promise<void>((resolve, reject) => { local.once("error", reject); local.listen(socketPath, () => resolve()); });
    if (process.platform !== "win32") chmodSync(socketPath, 0o600);
  } catch { socket = null; }
  // Loopback where something still needs it (the PowerShell tray, older hooks), unless turned off; always when the pipe
  // could not be made.
  const loopback = (options.loopback ?? process.env.SCOPEBOND_AGENT_LOOPBACK !== "0") || socket === null;
  const server = createServer(listenerFor(true));
  if (loopback) await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
  const address = loopback ? server.address() : null;
  const port = typeof address === "object" && address ? address.port : 0;
  loopbackPort = port;
  const endpoint: AgentEndpoint = { port, socket, token, pid: process.pid, started_at: Date.now(), version };
  const file = join(dir, AGENT_FILE);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(endpoint, null, 2) + "\n", { mode: 0o600 });
  renameSync(temp, file);
  return {
    server, endpoint,
    close: () => new Promise<void>((resolve) => {
      let open = (loopback ? 1 : 0) + (socket ? 1 : 0);
      const done = () => { if (--open <= 0) resolve(); };
      if (open === 0) resolve();
      if (loopback) server.close(done);
      if (socket) local.close(() => { if (process.platform !== "win32") rmSync(socketPath, { force: true }); done(); });
      // Only remove the file if it is still ours (a newer agent may have replaced it).
      try { if (readEndpoint(dir)?.pid === process.pid) rmSync(file, { force: true }); } catch { /* best effort */ }
    }),
  };
}

/** Call a running agent, over its pipe or socket when it has one. Returns null when no agent answers. */
export async function callAgent(dir: string, method: "GET" | "POST", path: string, body?: unknown, timeoutMs = 5_000): Promise<unknown> {
  const endpoint = readEndpoint(dir);
  if (!endpoint) return null;
  if (typeof endpoint.socket === "string" && endpoint.socket) {
    const answer = await requestOverSocket(endpoint.socket, method, path, { [TOKEN_HEADER]: endpoint.token }, body, timeoutMs);
    if (answer) return answer.status >= 200 && answer.status < 300 ? answer.body : null;
    if (!endpoint.port) return null;
  }
  try {
    const res = await fetch(`http://127.0.0.1:${endpoint.port}${path}`, {
      method, headers: { [TOKEN_HEADER]: endpoint.token, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}
