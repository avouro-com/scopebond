// The MCP proxy core: sit in front of an upstream MCP server, check each
// `tools/call` against policy before forwarding it, and emit a signed
// PEP-authorized receipt. A denied call is never forwarded. Deterministic and
// transport-agnostic — the upstream is injected, so the decision path is
// conformance-tested directly; the `scopebond-mcp` CLI provides the real stdio
// transport. The proxy decides the caller's request (no agent signature), so its
// receipts are pep_authorized (§15) — the identity is the configured principal.

import { violates } from "@scopebond/verify";
import { buildPepReceipt, attesterFromPrivateKeyPem } from "@scopebond/gateway";
import { requestHash } from "@scopebond/gateway";
import type { SignedReceipt, Attester, DispatchGuard, DispatchDecision } from "@scopebond/gateway";
import { canonical } from "@scopebond/policy-schema/canonical";
import { createHash } from "node:crypto";
import { describeToolCall, intentDraft, manifestHash, outcomeDraft, type ExitCategory, type TypedAdapterConfig } from "./typed.js";

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

const digest = (value: unknown): string => "sha256:" + createHash("sha256").update(canonical(value as never)).digest("hex");

/** Map an MCP `tools/call` to a normalized `mcp.tool.call` action. Arguments are
 * digested, never stored. */
export function mapMcpToolCall(server: string, params: Record<string, unknown> | undefined): { action_type: string; params: Record<string, unknown> } {
  return {
    action_type: "mcp.tool.call",
    params: { server, tool: String(params?.name ?? ""), args_digest: digest(params?.arguments ?? {}) },
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
}

export interface McpProxyConfig {
  policy: unknown;
  /** The validated caller identity recorded on every receipt. */
  principal: { subject: string; issuer: string };
  /** The upstream server id, used as the action's `server` parameter. */
  server: string;
  /** PEM of the key that signs the PEP receipts (the enrolled proxy key). */
  attesterKeyPem: string;
  upstream: McpUpstream;
  now?: () => string;
  /** Sink for each emitted receipt (e.g. a local log / exporter). */
  onReceipt?: (receipt: SignedReceipt) => void | Promise<void>;
  /** Prior authorized calls to seed the window with (e.g. loaded from a durable log
   *  at startup). The proxy also accumulates in-session calls on top of these so
   *  rate_limit, spend_limit and sequence clauses see the real history rather than
   *  an empty one. */
  history?: CountableCall[];
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
  handle(message: JsonRpcMessage): Promise<JsonRpcMessage>;
}

/** Build a proxy handler. Every `tools/call` is decided against policy; anything
 * else is passed through to the upstream unchanged. */
export function createMcpProxy(config: McpProxyConfig): McpProxy {
  const attester: Attester = attesterFromPrivateKeyPem(config.attesterKeyPem);
  // Session history of authorized calls. A forwarded call actually runs, so it
  // counts as executed for windowed clauses (rate_limit, sequence, spend_limit).
  const history: CountableCall[] = [...(config.history ?? [])];
  const typed = config.typed;
  const nowMs = (): number => (config.now ? Date.parse(config.now()) : Date.now());

  // The live tool list is read from the upstream itself, and again after the recheck interval,
  // so a manifest pinned to one revision is not trusted for a server that has since changed.
  let verifiedAt = -Infinity;
  let verified = false;
  let liveHash: string | undefined;
  let probe = 0;
  const readToolList = async (): Promise<string | undefined> => {
    const tools: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const response = await config.upstream.call({ jsonrpc: "2.0", id: `scopebond-tools-${++probe}`, method: "tools/list", ...(cursor ? { params: { cursor } } : {}) });
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
    const recheck = typed.manifestRecheckMs ?? 60_000;
    if (nowMs() - verifiedAt < recheck) return verified;
    try { liveHash = await readToolList(); } catch { liveHash = undefined; }
    verified = liveHash !== undefined && liveHash === typed.manifest.hash;
    verifiedAt = nowMs();
    return verified;
  };

  return {
    async handle(message: JsonRpcMessage): Promise<JsonRpcMessage> {
      if (message?.method === "tools/list" && typed?.manifest) {
        // A client listing tools shows the live revision: learn it from the answer it gets.
        const response = await config.upstream.call(message);
        const result = response?.result as { tools?: unknown; nextCursor?: unknown } | undefined;
        if (!message.params?.cursor && result && Array.isArray(result.tools) && !result.nextCursor) {
          liveHash = manifestHash(result.tools);
          verified = liveHash === typed.manifest.hash;
          verifiedAt = nowMs();
        }
        return response;
      }
      if (message?.method !== "tools/call") return config.upstream.call(message);

      // Everything below is decided on, digested and forwarded from one private copy of the
      // request, so what the binding covers is exactly what reaches the upstream.
      const dispatched = JSON.parse(JSON.stringify(message)) as JsonRpcMessage;
      const intent = mapMcpToolCall(config.server, dispatched.params);
      const timestamp = config.now?.() ?? new Date().toISOString();
      const claimed = { intent, executed: true, timestamp, intent_hash: digest(intent).slice(7) };
      const verdict = violates(config.policy as never, history as never, claimed as never, { at: timestamp });

      // The adapter's own decision: unknown tools, revisions and unbound resources.
      const description = typed ? describeToolCall(typed, config.server, dispatched, await manifestVerified()) : undefined;
      const adapterDeny = typed?.mode === "enforce" && description !== undefined && !description.allow;
      let decision: "allow" | "deny" = verdict.violated || adapterDeny ? "deny" : "allow";

      // The boundary, for a call policy has allowed. The exact request forwarded below is what an approval is bound to.
      let boundary: DispatchDecision | undefined;
      const guardTarget = `${config.server}/${String(intent.params.tool)}`;
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
        ? config.dispatch.binder.bindDispatched(plainOperation as Record<string, unknown>, { action_type: "mcp.tool.call", target: guardTarget, request: guardRequest }) : plainOperation;
      if (typed?.sink && operation) { try { typed.sink.emit(intentDraft(operation, startedAt, receipt)); } catch { /* observations are best effort */ } }

      if (decision === "deny") {
        const why = verdict.violated ? (verdict.explanation || "out of policy")
          : boundary && !boundary.allow ? `dispatch boundary: ${boundary.reason}${boundary.detail ? ` (${boundary.detail})` : ""}`
          : `the typed adapter could not bind it (${description!.reasons.join("; ")})`;
        return {
          jsonrpc: "2.0",
          id: message.id ?? null,
          error: { code: -32000, message: `Scopebond policy denied ${intent.params.tool}: ${why}` },
        };
      }
      // Authorized and about to be forwarded: record it so it counts toward the window.
      history.push(claimed);
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
    },
  };
}
