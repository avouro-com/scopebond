// Talking to the Scopebond Agent over its local channel: a named pipe on Windows, a Unix socket elsewhere. The Unix socket
// sits in a folder only the user can open. The pipe's name is random and kept in the agent's file in the user's own
// Scopebond folder, but Windows lets other accounts list pipe names and open the pipe for reading, so what protects each
// request is the agent's token, which is always sent.

import { request } from "node:http";

/** One JSON request over a pipe or socket. Resolves with the status and parsed body, or null when nothing answers. */
export function requestOverSocket(socketPath: string, method: "GET" | "POST", path: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<{ status: number; body: unknown } | null> {
  return new Promise((resolve) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request({
      socketPath, method, path, timeout: timeoutMs,
      headers: { ...headers, ...(payload !== undefined ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}) },
    }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { raw += chunk; if (raw.length > 4 * 1024 * 1024) req.destroy(); });
      res.on("end", () => {
        let parsed: unknown;
        try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    const timer = setTimeout(() => req.destroy(new Error("timeout")), timeoutMs);
    req.on("close", () => clearTimeout(timer));
    req.on("error", () => resolve(null));
    req.on("timeout", () => req.destroy(new Error("timeout")));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}
