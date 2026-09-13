// Minimal MCP (Model Context Protocol) ingress over JSON-RPC: an agent's tool
// calls are routed through the gateway's policy enforcement. Supports initialize,
// tools/list, and tools/call for the `scopebond.evaluate` tool. Deeper MCP
// surface (resources, prompts, streaming) is [PLANNED].

type ActionResultLike = { allowed: boolean; reason: string; receipt: unknown };
type HandleAction = (req: { intent: unknown; authorization?: unknown; approval?: unknown }) => Promise<ActionResultLike>;

const PROTOCOL_VERSION = "2024-11-05";

export async function handleMcp(body: any, handleAction: HandleAction): Promise<unknown> {
  const id = body?.id ?? null;
  const method = body?.method;
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

  switch (method) {
    case "initialize":
      return ok({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "scopebond-gateway", version: "0.0.0" },
      });
    case "notifications/initialized":
      return ok({});
    case "tools/list":
      return ok({
        tools: [{
          name: "scopebond.evaluate",
          description: "Submit an agent action intent to be policy-checked, countersigned, and (if allowed) executed through the Scopebond gateway.",
          inputSchema: {
            type: "object",
            properties: { intent: { type: "object" }, authorization: { type: "object" }, approval: { type: "object" } },
            required: ["intent", "authorization"],
          },
        }],
      });
    case "tools/call": {
      const name = body?.params?.name;
      const args = body?.params?.arguments ?? {};
      if (name !== "scopebond.evaluate") return fail(-32602, `unknown tool: ${name}`);
      if (!args?.intent?.action_type) return fail(-32602, "intent.action_type required");
      let result: ActionResultLike;
      try { result = await handleAction({ intent: args.intent, authorization: args.authorization, approval: args.approval }); }
      catch (error) { return fail(-32602, error instanceof Error ? error.message : "invalid action"); }
      return ok({
        content: [{ type: "text", text: JSON.stringify({ allowed: result.allowed, reason: result.reason, receipt: result.receipt }) }],
        isError: !result.allowed,
      });
    }
    default:
      return fail(-32601, `method not found: ${method}`);
  }
}
