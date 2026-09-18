// The MCP proxy core: sit in front of an upstream MCP server, check each
// `tools/call` against policy before forwarding it, and emit a signed
// PEP-authorized receipt. A denied call is never forwarded. Deterministic and
// transport-agnostic — the upstream is injected, so the decision path is
// conformance-tested directly; the `scopebond-mcp` CLI provides the real stdio
// transport. The proxy decides the caller's request (no agent signature), so its
// receipts are pep_authorized (§15) — the identity is the configured principal.

import { violates } from "@scopebond/verify";
import { buildPepReceipt, attesterFromPrivateKeyPem } from "@scopebond/gateway";
import type { SignedReceipt, Attester } from "@scopebond/gateway";
import { canonical } from "@scopebond/policy-schema/canonical";
import { createHash } from "node:crypto";

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
}

export interface McpProxy {
  handle(message: JsonRpcMessage): Promise<JsonRpcMessage>;
}

/** Build a proxy handler. Every `tools/call` is decided against policy; anything
 * else is passed through to the upstream unchanged. */
export function createMcpProxy(config: McpProxyConfig): McpProxy {
  const attester: Attester = attesterFromPrivateKeyPem(config.attesterKeyPem);
  return {
    async handle(message: JsonRpcMessage): Promise<JsonRpcMessage> {
      if (message?.method !== "tools/call") return config.upstream.call(message);

      const intent = mapMcpToolCall(config.server, message.params);
      const claimed = {
        intent,
        executed: true,
        timestamp: config.now?.() ?? new Date().toISOString(),
        intent_hash: digest(intent).slice(7),
      };
      const verdict = violates(config.policy as never, [], claimed as never, {});
      const decision = verdict.violated ? "deny" : "allow";

      const receipt = await buildPepReceipt(
        { intent, policy: config.policy as never, principal: config.principal, realtimeResult: decision, now: config.now },
        attester,
      );
      await config.onReceipt?.(receipt);

      if (decision === "deny") {
        return {
          jsonrpc: "2.0",
          id: message.id ?? null,
          error: { code: -32000, message: `Scopebond policy denied ${intent.params.tool}: ${verdict.explanation || "out of policy"}` },
        };
      }
      return config.upstream.call(message);
    },
  };
}
