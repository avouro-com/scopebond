// Executors carry out an allowed action. The default is a no-op (record only);
// this HTTP executor forwards allowed `http.call` intents to the real endpoint and
// records a response digest as the execution reference.

import { createHash } from "node:crypto";
import type { Executor } from "./app.js";
import type { Intent } from "@scopebond/verify";

export interface HttpExecutorOptions {
  /** Injectable fetch (defaults to global fetch) — makes forwarding testable. */
  fetch?: typeof fetch;
  /** URL scheme for forwarded calls (default https). */
  scheme?: "http" | "https";
}

export function createHttpExecutor(opts: HttpExecutorOptions = {}): Executor {
  const f = opts.fetch ?? fetch;
  const scheme = opts.scheme ?? "https";
  return {
    async execute(intent: Intent) {
      const p = (intent.params ?? {}) as Record<string, any>;
      if (!p.host) return { ref: "noop:non-http-action" };
      const url = `${scheme}://${p.host}${p.path ?? "/"}`;
      const res = await f(url, { method: p.method ?? "GET", headers: p.headers, body: p.body });
      const text = await res.text();
      const digest = createHash("sha256").update(text).digest("hex");
      return { ref: `http:${res.status}:sha256:${digest.slice(0, 16)}` };
    },
  };
}
