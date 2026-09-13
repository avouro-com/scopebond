// Executors carry out an allowed action. The default is a no-op (record only);
// this HTTP executor forwards allowed `http.call` intents to the real endpoint and
// records a response digest as the execution reference.

import { createHash } from "node:crypto";
import { ExecutorInputError } from "./app.js";
import type { Executor, ExecutionQueryResult } from "./app.js";
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
    id: "scopebond:http-call",
    mode: "dispatch",
    async execute(intent: Intent) {
      const p = (intent.params ?? {}) as Record<string, any>;
      if (!p.host) return { ref: "noop:non-http-action" };
      const url = `${scheme}://${p.host}${p.path ?? "/"}`;
      const res = await f(url, { method: p.method ?? "GET", headers: p.headers, body: p.body, redirect: "error" });
      const text = await res.text();
      const digest = createHash("sha256").update(text).digest("hex");
      return { ref: `http:${res.status}:sha256:${digest.slice(0, 16)}` };
    },
  };
}

export interface SupportRefundExecutorOptions {
  /** Operator-controlled API origin, for example https://support.example.com. */
  origin: string;
  /** Gateway-owned credential. It is never accepted from the agent intent. */
  apiToken: string;
  fetch?: typeof fetch;
  /** Permit an HTTP loopback origin only in a controlled local test. */
  allowHttpLoopbackForTesting?: boolean;
  maxResponseBytes?: number;
}

const REFUND_FIELDS = new Set(["ticket_id", "payment_id", "reason_code"]);
const RESOURCE_ID = /^[A-Za-z0-9_-]{1,100}$/;
const REASON_CODE = /^[a-z][a-z0-9_]{0,49}$/;

function normalizedRefund(intent: Intent): { ticket_id: string; payment_id: string; reason_code: string } {
  if (intent.action_type !== "support.refund") throw new ExecutorInputError("refund adapter accepts only support.refund");
  if (!Number.isSafeInteger(intent.amount) || (intent.amount ?? 0) <= 0 || intent.asset !== "USD") {
    throw new ExecutorInputError("support.refund requires a positive integer USD amount");
  }
  const params = intent.params ?? {};
  if (Object.keys(params).some((key) => !REFUND_FIELDS.has(key))) {
    throw new ExecutorInputError("support.refund contains an unsupported parameter");
  }
  const ticket_id = params.ticket_id;
  const payment_id = params.payment_id;
  const reason_code = params.reason_code;
  if (typeof ticket_id !== "string" || !RESOURCE_ID.test(ticket_id) ||
      typeof payment_id !== "string" || !RESOURCE_ID.test(payment_id)) {
    throw new ExecutorInputError("support.refund requires valid ticket_id and payment_id values");
  }
  if (typeof reason_code !== "string" || !REASON_CODE.test(reason_code)) {
    throw new ExecutorInputError("support.refund requires a normalized reason_code");
  }
  return { ticket_id, payment_id, reason_code };
}

function refundOrigin(value: string, allowHttpLoopback: boolean): URL {
  const url = new URL(value);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  const testLoopback = allowHttpLoopback && loopback && url.protocol === "http:";
  if (url.protocol !== "https:" && !testLoopback) {
    throw new TypeError("refund origin must use HTTPS");
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new TypeError("refund origin must contain only scheme, host, and optional test port");
  }
  if (!testLoopback && (url.port && url.port !== "443")) throw new TypeError("refund origin must use the default HTTPS port");
  if (!testLoopback && (loopback || /^\[.*\]$/.test(url.hostname) || /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) ||
      !url.hostname.includes(".") || url.hostname.endsWith(".local") || url.hostname.endsWith(".internal"))) {
    throw new TypeError("refund origin must be a public DNS hostname");
  }
  return url;
}

/** One constrained real integration: create a support refund at a fixed,
 * operator-controlled origin with gateway-owned credentials and action-id
 * idempotency. Agent input cannot select a host, path, method, headers, or body. */
export function createSupportRefundExecutor(opts: SupportRefundExecutorOptions): Executor {
  const origin = refundOrigin(opts.origin, opts.allowHttpLoopbackForTesting === true);
  if (opts.apiToken.length < 16) throw new TypeError("refund API token is too short");
  const maxResponseBytes = opts.maxResponseBytes ?? 64 * 1024;
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 1024 * 1024) {
    throw new TypeError("maxResponseBytes must be between 1 and 1048576");
  }
  const doFetch = opts.fetch ?? fetch;
  const adapterId = `scopebond:support-refund:${origin.host}`;

  async function boundedBody(response: Response): Promise<{ text: string; body: Record<string, unknown> }> {
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) throw new Error("refund response exceeds configured limit");
    const text = await response.text();
    if (Buffer.byteLength(text) > maxResponseBytes) throw new Error("refund response exceeds configured limit");
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    return { text, body: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {} };
  }

  function executionResult(response: Response, text: string, body: Record<string, unknown>) {
    const digest = createHash("sha256").update(text).digest("hex");
    const refundId = typeof body.refund_id === "string" && RESOURCE_ID.test(body.refund_id) ? body.refund_id : undefined;
    return {
      ref: `support-refund:${response.status}:sha256:${digest.slice(0, 16)}`,
      output: {
        status: response.status,
        ...(refundId ? { refund_id: refundId } : {}),
        ...(typeof body.duplicate === "boolean" ? { duplicate: body.duplicate } : {}),
      },
    };
  }
  return {
    id: adapterId,
    mode: "dispatch",
    validate(intent) { normalizedRefund(intent); },
    async execute(intent, context) {
      const request = normalizedRefund(intent);
      const response = await doFetch(new URL("/v1/refunds", origin), {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${opts.apiToken}`,
          "content-type": "application/json",
          "idempotency-key": context.actionId,
        },
        body: JSON.stringify({ ...request, amount: intent.amount, asset: intent.asset }),
      });
      const { text, body } = await boundedBody(response);
      if (!response.ok) throw new Error(`refund upstream returned HTTP ${response.status}`);
      return executionResult(response, text, body);
    },
    async query({ actionId }): Promise<ExecutionQueryResult> {
      const response = await doFetch(new URL(`/v1/refunds/by-idempotency-key/${encodeURIComponent(actionId)}`, origin), {
        method: "GET",
        redirect: "error",
        headers: { authorization: `Bearer ${opts.apiToken}` },
      });
      const { text, body } = await boundedBody(response);
      if (response.status === 404) return { state: "failed", ref: "support-refund:not-found" };
      if (!response.ok) return { state: "outcome_unknown", ref: `support-refund:query-http-${response.status}` };
      const result = executionResult(response, text, body);
      return { state: "executed", ...result };
    },
  };
}
