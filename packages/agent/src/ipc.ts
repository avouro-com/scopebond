// The agent's local control channel: an HTTP server bound to 127.0.0.1 on a random port, with a
// random token. Port, token and process id are written to agent.json in the Scopebond home (owner
// read/write only), which is how the CLI and, later, the tray find it. Nothing listens beyond this
// computer, and every request must carry the token.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const AGENT_FILE = "agent.json";
export const TOKEN_HEADER = "x-scopebond-agent-token";

export interface AgentEndpoint { port: number; token: string; pid: number; started_at: number; version: string }

export type Handler = (body: unknown) => Promise<unknown> | unknown;

export function readEndpoint(dir: string): AgentEndpoint | null {
  const file = join(dir, AGENT_FILE);
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, "utf8")) as AgentEndpoint; } catch { return null; }
}

/** Start the control server. `routes` maps "METHOD /path" to a handler. */
export async function startControl(dir: string, version: string, routes: Record<string, Handler>): Promise<{ server: Server; endpoint: AgentEndpoint; close(): Promise<void> }> {
  const token = randomBytes(24).toString("base64url");
  const expected = Buffer.from(token);
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
    const offered = Buffer.from(String(req.headers[TOKEN_HEADER] ?? ""));
    if (offered.length !== expected.length || !timingSafeEqual(offered, expected)) return send(401, { error: "unauthorized" });
    const handler = routes[`${req.method} ${(req.url ?? "/").split("?")[0]}`];
    if (!handler) return send(404, { error: "not found" });
    let raw = "";
    for await (const chunk of req) { raw += chunk; if (raw.length > 64 * 1024) return send(413, { error: "too large" }); }
    try { send(200, await handler(raw ? JSON.parse(raw) : null)); }
    catch (error) { send(500, { error: (error as Error).message.slice(0, 200) }); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const endpoint: AgentEndpoint = { port, token, pid: process.pid, started_at: Date.now(), version };
  const file = join(dir, AGENT_FILE);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(endpoint, null, 2) + "\n", { mode: 0o600 });
  renameSync(temp, file);
  return {
    server, endpoint,
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Only remove the file if it is still ours (a newer agent may have replaced it).
      try { if (readEndpoint(dir)?.pid === process.pid) rmSync(file, { force: true }); } catch { /* best effort */ }
    }),
  };
}

/** Call a running agent. Returns null when no agent answers. */
export async function callAgent(dir: string, method: "GET" | "POST", path: string, body?: unknown, timeoutMs = 5_000): Promise<unknown | null> {
  const endpoint = readEndpoint(dir);
  if (!endpoint) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${endpoint.port}${path}`, {
      method, headers: { [TOKEN_HEADER]: endpoint.token, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}
