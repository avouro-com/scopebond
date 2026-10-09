// The MCP proxy core: sit in front of an upstream MCP server, check each
// `tools/call` against policy before forwarding it, and emit a signed
// PEP-authorized receipt. A denied call is never forwarded. Deterministic and
// transport-agnostic — the upstream is injected, so the decision path is
// conformance-tested directly; the `scopebond-mcp` CLI provides the real stdio
// transport. The proxy decides the caller's request (no agent signature), so its
// receipts are pep_authorized (§15) — the identity is the configured principal.

import { violates, historyNeed, boundPrior } from "@scopebond/verify";
import { buildPepReceipt, attesterFromPrivateKeyPem } from "@scopebond/gateway";
import { requestHash } from "@scopebond/gateway";
import type { SignedReceipt, Attester, DispatchGuard, DispatchDecision } from "@scopebond/gateway";
import { canonical } from "@scopebond/policy-schema/canonical";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { describeToolCall, intentDraft, jsonString, manifestHash, outcomeDraft, type ExitCategory, type TypedAdapterConfig } from "./typed.js";
import { historyBound, type HistoryLimit } from "./history-limit.js";

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

const digest = (value: unknown): string => "sha256:" + createHash("sha256").update(canonical(value)).digest("hex");

const ARGS_DIGEST_DOMAIN = "scopebond:mcp-args-digest/v1\n";

/** The keyed digest of a tool call's arguments: HMAC-SHA-256 under a local key (64 hex), labelled `hmac-sha256:`. A
 *  plain hash of a 6-digit code or a short password could be confirmed offline by anyone holding the receipt; keyed,
 *  it still tells identical calls under one key apart from different ones but cannot be tested against guesses. */
export function keyedArgsDigest(keyHex: string): (args: unknown) => string {
  if (!/^[0-9a-f]{64}$/i.test(keyHex)) throw new TypeError("the argument digest key must be 64 hex characters");
  const key = Buffer.from(keyHex, "hex");
  return (args) => "hmac-sha256:" + createHmac("sha256", key).update(ARGS_DIGEST_DOMAIN + canonical(args), "utf8").digest("hex");
}

// Without a configured key: a random key for this process (safe; digests then compare only within the process).
let processArgsDigest: ((args: unknown) => string) | undefined;
const defaultArgsDigest = (args: unknown): string =>
  (processArgsDigest ??= keyedArgsDigest(randomBytes(32).toString("hex")))(args);

/** Map an MCP `tools/call` to a normalized `mcp.tool.call` action. Arguments are
 * digested (keyed), never stored. */
export function mapMcpToolCall(
  server: string, params: Record<string, unknown> | undefined, argsDigest: (args: unknown) => string = defaultArgsDigest,
): { action_type: string; params: { server: string; tool: string; args_digest: string } } {
  return {
    action_type: "mcp.tool.call",
    // The same text String() gave, but a name like {"toString": 1} no longer throws out of the proxy.
    params: { server, tool: jsonString(params?.name ?? ""), args_digest: argsDigest(params?.arguments ?? {}) },
  };
}

/** A pre-authenticated forwarder to the upstream MCP server. Tests inject it; the
 * CLI implements it over stdio. */
export interface McpUpstream {
  call(message: JsonRpcMessage): Promise<JsonRpcMessage>;
}

/** The minimal receipt shape a windowed clause needs to count a prior authorized
 *  call. The proxy keeps these for the session so rate_limit/sequence clauses work. */
export interface CountableCall {
  intent: { action_type: string; params?: Record<string, unknown>; asset?: string; amount?: number };
  executed: boolean;
  timestamp: string;
  intent_hash: string;
  /** Tells two calls apart that have the same intent and timestamp (two identical calls in one millisecond are two calls). */
  action_id?: string;
}

export interface McpProxyConfig {
  policy: unknown;
  /** The validated caller identity recorded on every receipt. */
  principal: { subject: string; issuer: string };
  /** The upstream server id, used as the action's `server` parameter. */
  server: string;
  /** PEM of the key that signs the PEP receipts (the enrolled proxy key). */
  attesterKeyPem: string;
  /** The local key (64 hex, never uploaded) for the receipts' `args_digest`, an HMAC of the tool arguments. The CLI
   *  uses the proxy's binding key file. Without one, a random key for this process is used. */
  argsDigestKey?: string;
  upstream: McpUpstream;
  now?: () => string;
  /** Sink for each emitted receipt (e.g. a local log / exporter). */
  onReceipt?: (receipt: SignedReceipt) => void | Promise<void>;
  /** Prior authorized calls to seed the window with (e.g. loaded from a durable log
   *  at startup). The proxy also accumulates in-session calls on top of these so
   *  rate_limit, spend_limit and sequence clauses see the real history rather than
   *  an empty one. */
  history?: CountableCall[];
  /** The most calls and bytes the session history holds (default 10,000 calls and 8 MiB); past either the oldest are
   *  dropped. While a dropped call may still be inside a windowed clause's window, calls are refused, so the bound never
   *  lets through more than the policy allows. */
  historyLimit?: HistoryLimit;
  /** The typed adapter: binds the server, tool, pinned manifest revision, operation class and
   *  resources from the dispatched request, decides before dispatch under `enforce`, and emits
   *  tool_intent and tool_outcome observations to its sink. Absent, the proxy behaves as before. */
  typed?: TypedAdapterConfig;
  /** Recorded as the adapter version on tool_outcome observations. */
  adapterVersion?: string;
  /** The dispatch boundary: single-use approvals, the session's delegated scope and per-agent action
   *  budgets, decided once per `tools/call` after policy allows it and immediately before it is
   *  forwarded. A denial is never forwarded and spends nothing. Absent, the proxy behaves as before. */
  dispatch?: {
    guard: DispatchGuard; /** The delegation this session runs under, if it is a delegated child. */ delegationId?: string;
    /** Adds the approval hash and target id the guard uses to a typed operation, so a consumed approval can be correlated to its intent. */
    binder?: { bindDispatched<T extends Record<string, unknown>>(operation: T, intent: { action_type: string; target: string; request: unknown }): T };
  };
}

export interface McpProxy {
  /** Decide and forward one JSON-RPC message. Anything that is not a single JSON-RPC object
   *  (a batch array, null, a primitive) or whose `method` is not a string is answered with a
   *  -32600 Invalid Request error and never forwarded. */
  handle(message: unknown): Promise<JsonRpcMessage>;
}

/** A JSON-RPC -32600 reply for a message the proxy will not forward. */
function invalidRequest(id: unknown, why: string): JsonRpcMessage {
  const replyId = typeof id === "string" || typeof id === "number" ? id : null;
  return { jsonrpc: "2.0", id: replyId, error: { code: -32600, message: `Invalid Request: ${why}` } };
}

/** The methods the proxy decides (`tools/call`) or reads (`tools/list`, for the manifest pin). */
const GOVERNED_METHODS = ["tools/call", "tools/list"] as const;
// A method name with case, width, spacing, invisible characters and punctuation taken away: what an upstream that
// matches method names loosely could still read as the same method.
const methodSkeleton = (method: string): string => method.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/g, "");
const GOVERNED_SKELETONS = new Map<string, string>(GOVERNED_METHODS.map((m) => [methodSkeleton(m), m]));

/** Why a message is not a single JSON-RPC object the proxy can decide on, or undefined. Batches
 *  are rejected rather than split: a call inside one would otherwise skip the policy check. */
export function invalidMessageReason(message: unknown): string | undefined {
  if (Array.isArray(message)) return "JSON-RPC batches are not supported; send each message on its own";
  if (message === null || typeof message !== "object") return "a JSON-RPC message must be an object";
  if ("method" in message && typeof (message as { method?: unknown }).method !== "string") return "method must be a string";
  const { method, params } = message as { method?: unknown; params?: unknown };
  // Only the exact method is decided. Another spelling of it ("Tools/Call", "tools/call ") would be passed through
  // undecided, and an upstream that matches method names loosely would run it, so it is refused instead.
  if (typeof method === "string") {
    const governed = GOVERNED_SKELETONS.get(methodSkeleton(method));
    if (governed !== undefined && governed !== method) return `method is another spelling of "${governed}"; send the exact method name`;
  }
  // A tool call names its tool with a string. Anything else is refused here, never decided under a made-up name and forwarded.
  if (method === "tools/call" && typeof (params as { name?: unknown } | null | undefined)?.name !== "string") return "tools/call params.name must be a string";
  return undefined;
}

/** Build a proxy handler. A batch or malformed message is rejected (-32600). Every
 * `tools/call` is decided against policy; any other single message
 * is passed through to the upstream unchanged. */
export function createMcpProxy(config: McpProxyConfig): McpProxy {
  const attester: Attester = attesterFromPrivateKeyPem(config.attesterKeyPem);
  // Session history of authorized calls. A forwarded call actually runs, so it
  // counts as executed for windowed clauses (rate_limit, sequence, spend_limit); a call
  // still being decided after policy allowed it is held here too, until it is forwarded or refused.
  // Only what the policy can read is kept: nothing for a policy without windowed clauses, and the calls inside the longest
  // window for one with them (the policy is fixed for the proxy's life). Keeping every call made each decision re-read
  // and re-hash the whole session, so decisions slowed down and memory grew for as long as the proxy ran.
  const need = historyNeed(config.policy as never);
  const nowMs = (): number => (config.now ? Date.parse(config.now()) : Date.now());
  const history: CountableCall[] = boundPrior(need, [...(config.history ?? [])], new Date(nowMs()).toISOString());
  // Calls are dropped a while after they leave the window (another window, at least five minutes), so a clock that steps
  // back a little does not lose calls a decision still counts. Each decision is then trimmed exactly by boundPrior.
  const retention = need.kind === "window" ? { kind: "window" as const, ms: need.ms + Math.max(need.ms, 5 * 60_000) } : need;
  /** Drop the calls no clause can read any more at `at`, in place (in-flight calls are found again by identity). */
  const prune = (at: string): void => {
    if (retention.kind !== "window" || history.length === 0) return;
    const kept = boundPrior(retention, history, at);
    if (kept.length !== history.length) history.splice(0, history.length, ...kept);
  };
  const typed = config.typed;
  const argsDigest = config.argsDigestKey ? keyedArgsDigest(config.argsDigestKey) : defaultArgsDigest;
  // However long the policy's windows, the history stays within a number of calls and bytes (see history-limit.ts).
  const historyCap = historyBound(config.policy, config.historyLimit);
  historyCap.trim(history);

  // The live tool list is read from the upstream itself, and again after the recheck interval,
  // so a manifest pinned to one revision is not trusted for a server that has since changed.
  // A full tool list that differs from the pin is remembered until restart: an upstream that has
  // ever shown a different list cannot become verified again by answering a later read with the
  // pinned one. The client's own listing is hashed across every page it fetches, and the proxy's
  // probes carry random ids, so an upstream cannot tell them apart from client requests by id.
  let verifiedAt = -Infinity;
  let verified = false;
  let mismatchSeen = false;
  const learn = (hash: string): void => {
    // eslint-disable-next-line security/detect-possible-timing-attacks -- a tool-list hash compared with the pinned manifest hash, both public; not a secret
    if (hash !== typed?.manifest?.hash) mismatchSeen = true;
    verified = !mismatchSeen;
    verifiedAt = nowMs();
  };
  // The client's paginated listing in progress: the tools seen so far and the cursor it must ask for next.
  let clientListing: { tools: unknown[]; next: string; pages: number } | undefined;
  const readToolList = async (): Promise<string | undefined> => {
    const tools: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const response = await config.upstream.call({ jsonrpc: "2.0", id: globalThis.crypto.randomUUID(), method: "tools/list", ...(cursor ? { params: { cursor } } : {}) });
      const result = response?.result as { tools?: unknown; nextCursor?: unknown } | undefined;
      if (!result || !Array.isArray(result.tools)) return undefined;
      tools.push(...result.tools);
      if (typeof result.nextCursor !== "string" || result.nextCursor === "") return manifestHash(tools);
      cursor = result.nextCursor;
    }
    return undefined;
  };
  const manifestVerified = async (): Promise<boolean> => {
    if (!typed?.manifest) return false;
    if (mismatchSeen) return false;
    // A client listing that is still incomplete has shown pages nobody has checked yet.
    if (clientListing) return false;
    const recheck = typed.manifestRecheckMs ?? 60_000;
    if (nowMs() - verifiedAt < recheck) return verified;
    let hash: string | undefined;
    try { hash = await readToolList(); } catch { hash = undefined; }
    // eslint-disable-next-line security/detect-possible-timing-attacks -- checks whether a tool list was read at all; no secret is compared
    if (hash === undefined) { verified = false; verifiedAt = nowMs(); }
    else learn(hash);
    return verified;
  };

  return {
    async handle(raw: unknown): Promise<JsonRpcMessage> {
      const invalid = invalidMessageReason(raw);
      if (invalid) return invalidRequest((raw as { id?: unknown } | null)?.id, invalid);
      const message = raw as JsonRpcMessage;
      if (message.method === "tools/list" && typed?.manifest) {
        // A client listing tools shows the live revision: learn it from every page it gets.
        const response = await config.upstream.call(message);
        const result = response?.result as { tools?: unknown; nextCursor?: unknown } | undefined;
        const cursor = message.params?.cursor;
        const continues = typeof cursor === "string" && cursor !== "" && clientListing?.next === cursor;
        if (!result || !Array.isArray(result.tools)) { if (!cursor) clientListing = undefined; return response; }
        if (cursor && !continues) return response; // a page of a listing the proxy did not see start: no full list to hash
        const tools = [...(continues ? clientListing!.tools : []), ...result.tools];
        const pages = (continues ? clientListing!.pages : 0) + 1;
        if (typeof result.nextCursor === "string" && result.nextCursor !== "" && pages < 100) {
          clientListing = { tools, next: result.nextCursor, pages };
        } else {
          clientListing = undefined;
          if (typeof result.nextCursor === "string" && result.nextCursor !== "") { verified = false; verifiedAt = nowMs(); }
          else learn(manifestHash(tools));
        }
        return response;
      }
      if (message.method !== "tools/call") return config.upstream.call(message);

      // Everything below is decided on, digested and forwarded from one private copy of the
      // request, so what the binding covers is exactly what reaches the upstream.
      const dispatched = JSON.parse(JSON.stringify(message)) as JsonRpcMessage;
      const intent = mapMcpToolCall(config.server, dispatched.params, argsDigest);
      const timestamp = config.now?.() ?? new Date().toISOString();
      // Its own id, so two identical calls stamped in the same millisecond count as two.
      const claimed: CountableCall = { intent, executed: true, timestamp, intent_hash: digest(intent).slice(7), action_id: globalThis.crypto.randomUUID() };
      prune(timestamp);
      const verdict = violates(config.policy as never, boundPrior(need, history, timestamp) as never, claimed as never, { at: timestamp });
      // A call policy allows takes its place in the window in the same step as its verdict, before anything below awaits,
      // so calls decided while it is still in flight (concurrent or pipelined requests) count it. A call that is then not
      // forwarded gives its place back. A policy that reads no history keeps none.
      const held = !verdict.violated && need.kind !== "none";
      if (held) history.push(claimed);
      let forwarded = false;
      // A call is not decided on a history that dropped calls a windowed clause may still count; one that is goes into the
      // bound, dropping the oldest past it.
      const historyLost = historyCap.refusal(timestamp);
      if (held && historyLost === null) historyCap.trim(history);
      try {
        // The adapter's own decision: unknown tools, revisions and unbound resources.
        const description = typed ? describeToolCall(typed, config.server, dispatched, await manifestVerified()) : undefined;
        const adapterDeny = typed?.mode === "enforce" && description !== undefined && !description.allow;
        let decision: "allow" | "deny" = verdict.violated || adapterDeny || historyLost !== null ? "deny" : "allow";

        // The boundary, for a call policy has allowed. The exact request forwarded below is what an approval is bound to.
        let boundary: DispatchDecision | undefined;
        const guardTarget = `${config.server}/${intent.params.tool}`;
        const guardRequest = { server: config.server, method: "tools/call", params: dispatched.params ?? {} };
        if (decision === "allow" && config.dispatch) {
          const target = guardTarget;
          const request = guardRequest;
          // One transport request keeps one group, so a retry of it is not a second dispatch; a new invocation is.
          const group = `mcp:${requestHash({ id: dispatched.id ?? null, request, session: config.dispatch.delegationId ?? null })}`;
          try {
            boundary = await config.dispatch.guard.authorize({
              actor: config.principal.subject, action_group: dispatched.id === undefined || dispatched.id === null ? `mcp:${globalThis.crypto.randomUUID()}` : group,
              policy_digest: digest(config.policy).slice(7), intents: [{ action_type: "mcp.tool.call", target, request }],
              ...(config.dispatch.delegationId ? { delegation_id: config.dispatch.delegationId } : {}),
            });
          } catch (error) {
            boundary = { allow: false, reason: "counter_unavailable", detail: (error as Error).message, consumed_approvals: [], budgets: [] };
          }
          if (!boundary.allow) decision = "deny";
        }

        const receipt = await buildPepReceipt(
          { intent, policy: config.policy as never, principal: config.principal, realtimeResult: decision, now: config.now },
          attester,
        );
        await config.onReceipt?.(receipt);

        // The intent is recorded before dispatch, whatever the decision. Emission can never
        // change the decision or fail the call.
        const startedAt = nowMs();
        const plainOperation = description?.operation ?? null;
        const operation = plainOperation && config.dispatch?.binder
          ? config.dispatch.binder.bindDispatched(plainOperation, { action_type: "mcp.tool.call", target: guardTarget, request: guardRequest }) : plainOperation;
        if (typed?.sink && operation) { try { typed.sink.emit(intentDraft(operation, startedAt, receipt)); } catch { /* observations are best effort */ } }

        if (decision === "deny") {
          const why = verdict.violated ? (verdict.explanation || "out of policy")
            : historyLost !== null ? historyLost
            : boundary && !boundary.allow ? `dispatch boundary: ${boundary.reason}${boundary.detail ? ` (${boundary.detail})` : ""}`
            : `the typed adapter could not bind it (${description!.reasons.join("; ")})`;
          return {
            jsonrpc: "2.0",
            id: message.id ?? null,
            error: { code: -32000, message: `Scopebond policy denied ${intent.params.tool}: ${why}` },
          };
        }
        // Authorized and forwarded: it keeps its place in the window, whatever the upstream answers.
        forwarded = true;
        let exit: ExitCategory = "unknown";
        try {
          const response = await config.upstream.call(dispatched);
          const result = response?.result as { isError?: unknown } | undefined;
          exit = response?.error !== undefined || result?.isError === true ? "error" : "ok";
          return response;
        } catch (error) {
          exit = "error";
          throw error;
        } finally {
          if (typed?.sink && operation) { try { typed.sink.emit(outcomeDraft(operation, exit, config.adapterVersion ?? "unknown", nowMs(), startedAt, receipt)); } catch { /* best effort */ } }
        }
      } finally {
        if (held && !forwarded) {
          const at = history.lastIndexOf(claimed);
          if (at >= 0) history.splice(at, 1);
        }
      }
    },
  };
}
