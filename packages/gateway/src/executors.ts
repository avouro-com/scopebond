// Executors carry out an allowed action. The default is a no-op (record only);
// this HTTP executor forwards allowed `http.call` intents to the real endpoint and
// records a response digest as the execution reference.

import { createHash } from "node:crypto";
import { ExecutorInputError } from "./app.js";
import type { Executor, ExecutionQueryResult } from "./app.js";
import type { Intent, Policy, EndpointDestination } from "@scopebond/verify";
import { endpointDestination, endpointDenylistClauses } from "@scopebond/verify";

/** The addresses a host name resolves to, as `dns.promises.lookup(name, { all: true })` returns them. */
export type HostLookup = (hostname: string) => Promise<ReadonlyArray<{ address: string; family: number }>>;

export interface HttpExecutorOptions {
  /** Injectable fetch (defaults to global fetch) — makes forwarding testable. */
  fetch?: typeof fetch;
  /** URL scheme for forwarded calls (default https). */
  scheme?: "http" | "https";
  /** Resolves a host name before the request is sent (default: the system resolver, every address). Used when the policy's
   *  endpoint_denylist lists an address, so that a name resolving to a denied address is refused. */
  lookup?: HostLookup;
  /** The most response bytes read (default 1 MiB). The response is only digested, so the rest is not read: the call is
   *  recorded as executed with a reference that says the body was over the limit. */
  maxResponseBytes?: number;
  /** How long one call may take, from sending it to reading its response (default 30 s). A call that runs out of time
   *  may have been sent, so its outcome is unknown. */
  timeoutMs?: number;
}

const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

function positiveLimit(value: number | undefined, fallback: number, name: string, max: number): number {
  const v = value ?? fallback;
  if (!Number.isSafeInteger(v) || v < 1 || v > max) throw new TypeError(`${name} must be a whole number between 1 and ${max}`);
  return v;
}

/** Thrown when a dispatch ran out of time. The request may have been sent, so the gateway records the outcome as unknown. */
class DispatchTimeoutError extends Error {
  constructor(ms: number) { super(`upstream did not answer within ${ms} ms`); this.name = "DispatchTimeoutError"; }
}

/** Settle with `promise`, or reject when `signal` aborts first (an injected fetch may ignore the signal). */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal, error: () => Error): Promise<T> {
  if (signal.aborted) return Promise.reject(error());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(error());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (reason: unknown) => { signal.removeEventListener("abort", onAbort); reject(signal.aborted ? error() : reason as Error); },
    );
  });
}

/** Read a response body up to `limit` bytes, hashing it as it arrives. At the limit the stream is cancelled, so an
 *  upstream cannot make the gateway hold more than `limit` bytes; `keep` also returns the text read. */
async function readBounded(
  response: Response, limit: number, signal: AbortSignal, timeout: () => Error, keep: boolean,
): Promise<{ digest: string; over: boolean; text: string }> {
  const hash = createHash("sha256");
  const kept: Uint8Array[] = [];
  const body = (response as { body?: ReadableStream<Uint8Array> | null }).body;
  if (!body || typeof body.getReader !== "function") {
    // A minimal injected fetch answer without a stream: its text is all there is.
    const text = typeof response.text === "function" ? await untilAborted(response.text(), signal, timeout) : "";
    const bytes = Buffer.from(text, "utf8");
    const over = bytes.length > limit;
    const read = over ? bytes.subarray(0, limit) : bytes;
    hash.update(read);
    return { digest: hash.digest("hex"), over, text: keep ? read.toString("utf8") : "" };
  }
  const reader = body.getReader();
  const cancel = () => { reader.cancel().catch(() => { /* already closed */ }); };
  signal.addEventListener("abort", cancel, { once: true });
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await untilAborted(reader.read(), signal, timeout);
      if (signal.aborted) throw timeout();
      if (done) break;
      if (size + value.byteLength > limit) {
        const head = value.subarray(0, limit - size);
        hash.update(head);
        if (keep) kept.push(head);
        cancel();
        return { digest: hash.digest("hex"), over: true, text: keep ? Buffer.concat(kept).toString("utf8") : "" };
      }
      size += value.byteLength;
      hash.update(value);
      if (keep) kept.push(value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
  }
  return { digest: hash.digest("hex"), over: false, text: keep ? Buffer.concat(kept).toString("utf8") : "" };
}

// Request headers that describe the connection or the message framing rather than the request: fetch sets them itself,
// and refuses or mis-frames a request that carries its own.
const CONNECTION_HEADERS = new Set([
  "connection", "keep-alive", "proxy-connection", "transfer-encoding", "te", "trailer", "upgrade", "expect", "content-length",
]);

/** The request an `http.call` describes, checked as far as it can be without sending it. Throws `ExecutorInputError`
 *  for one that cannot be sent as given, so it is refused before anything is reserved or sent. */
function httpRequestOf(p: Record<string, unknown>, scheme: "http" | "https"): { url: URL; dest: EndpointDestination; init: RequestInit } {
  const defaultPort = scheme === "https" ? 443 : 80;
  // The request goes only to the destination the policy checked: a bare host, a path from the root, parsed as a URL and
  // compared again. Concatenating strings let a path such as "@other.example/x" or ".other.example/x" reach another host.
  const dest = endpointDestination(p.host);
  const path = p.path ?? "/";
  if (dest === null) throw new ExecutorInputError("http.call host must be a bare host name or address");
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || path.includes("\\")) {
    throw new ExecutorInputError("http.call path must start with a single / and contain no backslash");
  }
  const url = new URL(path, `${scheme}://${dest.port === null ? dest.host : `${dest.host}:${dest.port}`}`);
  if (url.hostname !== dest.host || (url.port === "" ? defaultPort : Number(url.port)) !== (dest.port ?? defaultPort) || url.username || url.password) {
    throw new ExecutorInputError("http.call would reach another host than the one checked");
  }
  const method = p.method ?? "GET";
  if (typeof method !== "string") throw new ExecutorInputError("http.call method must be a string");
  if (p.body !== undefined && p.body !== null && typeof p.body !== "string") throw new ExecutorInputError("http.call body must be a string");
  if (p.headers !== undefined && p.headers !== null && (typeof p.headers !== "object" || Array.isArray(p.headers))) {
    throw new ExecutorInputError("http.call headers must be an object of header names and values");
  }
  const init: RequestInit = { method, headers: (p.headers ?? undefined) as HeadersInit | undefined, body: p.body ?? undefined };
  // fetch refuses some requests only once it starts to send them; build the request here so they are refused first.
  let request: Request;
  try { request = new Request(url.href, init); }
  catch (error) { throw new ExecutorInputError(`http.call cannot be sent: ${(error as Error).message}`); }
  for (const name of request.headers.keys()) {
    if (CONNECTION_HEADERS.has(name)) throw new ExecutorInputError(`http.call may not set the ${name} header`);
  }
  return { url, dest, init };
}

const systemLookup: HostLookup = async (hostname) => (await import("node:dns")).promises.lookup(hostname, { all: true });

// Whether a denylist clause lists an address (or a loopback name), which a resolved address can match.
const listsAddress = (clause: Record<string, unknown>): boolean => Array.isArray(clause.hosts) && clause.hosts.some((h) => {
  const entry = endpointDestination(h);
  return entry !== null && (entry.address || entry.loopback);
});

/** Refuse a call whose host name resolves to an address an enforced endpoint_denylist clause denies. The policy decided the
 *  name as written; a clause it already applied (and a person may have overridden) is not applied again. */
async function refuseDeniedAddresses(policy: Policy, params: Record<string, unknown>, dest: EndpointDestination, lookup: HostLookup): Promise<void> {
  if (dest.address) return; // an address was decided as itself
  const decided = new Set(endpointDenylistClauses(policy, params).map((c) => c.id));
  const enforced = (c: { id: string; mode?: string }): boolean => c.mode !== "monitor" && !decided.has(c.id);
  if (!(policy.clauses ?? []).some((c) => c.type === "endpoint_denylist" && enforced(c) && listsAddress(c))) return;
  const addresses = await lookup(dest.host);
  if (addresses.length === 0) throw new Error(`http.call host ${dest.host} did not resolve`);
  for (const { address } of addresses) {
    const literal = address.includes(":") ? `[${address}]` : address;
    const host = dest.port === null ? literal : `${literal}:${dest.port}`;
    const denied = endpointDenylistClauses(policy, { ...params, host }).find(enforced);
    if (denied) throw new ExecutorInputError(`http.call host ${dest.host} resolves to ${address}, which endpoint_denylist clause ${denied.id} denies`);
  }
}

export function createHttpExecutor(opts: HttpExecutorOptions = {}): Executor {
  const f = opts.fetch ?? fetch;
  const scheme = opts.scheme ?? "https";
  const lookup = opts.lookup ?? systemLookup;
  const maxResponseBytes = positiveLimit(opts.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, "maxResponseBytes", Number.MAX_SAFE_INTEGER);
  const timeoutMs = positiveLimit(opts.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs", 2_147_483_647);
  return {
    id: "scopebond:http-call",
    mode: "dispatch",
    // Checked before the action is reserved: a call that cannot be sent is refused as bad input and charges nothing.
    validate(intent: Intent) {
      const p: Record<string, unknown> = intent.params ?? {};
      if (p.host) httpRequestOf(p, scheme);
    },
    async execute(intent: Intent, context?: { actionId: string; policy?: Policy }) {
      const p: Record<string, unknown> = intent.params ?? {};
      if (!p.host) return { ref: "noop:non-http-action" };
      const { url, dest, init } = httpRequestOf(p, scheme);
      // The policy decided the host as written; a name is also checked by the addresses it resolves to now.
      if (context?.policy) await refuseDeniedAddresses(context.policy, p, dest, lookup);
      const signal = AbortSignal.timeout(timeoutMs);
      const timeout = () => new DispatchTimeoutError(timeoutMs);
      const res = await untilAborted(f(url.href, { ...init, redirect: "error", signal }), signal, timeout);
      const body = await readBounded(res, maxResponseBytes, signal, timeout, false);
      return { ref: `http:${res.status}:${body.over ? "over-limit:" : ""}sha256:${body.digest.slice(0, 16)}` };
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
  /** The most response bytes read (default 64 KiB, at most 1 MiB). A longer response is not read past the limit. */
  maxResponseBytes?: number;
  /** How long one call may take, from sending it to reading its response (default 30 s). */
  timeoutMs?: number;
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
  const timeoutMs = positiveLimit(opts.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs", 2_147_483_647);
  const doFetch = opts.fetch ?? fetch;
  const adapterId = `scopebond:support-refund:${origin.host}`;

  /** One request to the refund API, bounded in time (from sending it to reading its response) and in response size. */
  async function call(url: URL, init: RequestInit): Promise<{ response: Response; text: string; body: Record<string, unknown> }> {
    const signal = AbortSignal.timeout(timeoutMs);
    const timeout = () => new DispatchTimeoutError(timeoutMs);
    const response = await untilAborted(doFetch(url, { ...init, signal }), signal, timeout);
    const declaredLength = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
      response.body?.cancel().catch(() => { /* already closed */ });
      throw new Error("refund response exceeds configured limit");
    }
    const read = await readBounded(response, maxResponseBytes, signal, timeout, true);
    if (read.over) throw new Error("refund response exceeds configured limit");
    const text = read.text;
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    return { response, text, body: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {} };
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
      const { response, text, body } = await call(new URL("/v1/refunds", origin), {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${opts.apiToken}`,
          "content-type": "application/json",
          "idempotency-key": context.actionId,
        },
        body: JSON.stringify({ ...request, amount: intent.amount, asset: intent.asset }),
      });
      if (!response.ok) throw new Error(`refund upstream returned HTTP ${response.status}`);
      return executionResult(response, text, body);
    },
    async query({ actionId }): Promise<ExecutionQueryResult> {
      const { response, text, body } = await call(new URL(`/v1/refunds/by-idempotency-key/${encodeURIComponent(actionId)}`, origin), {
        method: "GET",
        redirect: "error",
        headers: { authorization: `Bearer ${opts.apiToken}` },
      });
      if (response.status === 404) return { state: "failed", ref: "support-refund:not-found" };
      if (!response.ok) return { state: "outcome_unknown", ref: `support-refund:query-http-${response.status}` };
      const result = executionResult(response, text, body);
      return { state: "executed", ...result };
    },
  };
}
