// Minimal MCP (Model Context Protocol) ingress over JSON-RPC: an agent's tool
// calls are routed through the gateway's policy enforcement. Supports initialize,
// tools/list, and tools/call for the `scopebond.evaluate` tool. Deeper MCP
// surface (resources, prompts, streaming) is [PLANNED].

type ActionResultLike = { allowed: boolean; reason: string; receipt: unknown };
type HandleAction = (req: { intent: unknown; authorization?: unknown; approval?: unknown }) => Promise<ActionResultLike>;

const PROTOCOL_VERSION = "2024-11-05";
// Reported as MCP serverInfo.version. Bundled into Workers, so it cannot read
// package.json at runtime; keep this in sync with the package version on release.
const SERVER_VERSION = "0.4.1";

/** An object's fields, or none for anything else. */
const fields = (value: unknown): Record<string, unknown> => (value !== null && typeof value === "object" ? value as Record<string, unknown> : {});
/** A JSON-RPC value as it appears in an error message: a scalar as itself, anything else by its type. */
const shown = (value: unknown): string => (value === null || ["string", "number", "boolean", "undefined"].includes(typeof value) ? String(value) : typeof value);

export async function handleMcp(body: unknown, handleAction: HandleAction): Promise<unknown> {
  const request = fields(body);
  const id = request.id ?? null;
  const method = request.method;
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

  switch (method) {
    case "initialize":
      return ok({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "scopebond-gateway", version: SERVER_VERSION },
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
      const params = fields(request.params);
      const name = params.name;
      const args = fields(params.arguments);
      if (name !== "scopebond.evaluate") return fail(-32602, `unknown tool: ${shown(name)}`);
      if (!fields(args.intent).action_type) return fail(-32602, "intent.action_type required");
      let result: ActionResultLike;
      try { result = await handleAction({ intent: args.intent, authorization: args.authorization, approval: args.approval }); }
      // Only a refusal meant for the caller is passed on; anything else is reported generically (no internal detail).
      catch (error) { return fail(-32602, error instanceof Error && typeof (error as { status?: unknown }).status === "number" ? error.message : "the action could not be evaluated"); }
      return ok({
        content: [{ type: "text", text: JSON.stringify({ allowed: result.allowed, reason: result.reason, receipt: result.receipt }) }],
        isError: !result.allowed,
      });
    }
    default:
      return fail(-32601, `method not found: ${shown(method)}`);
  }
}
