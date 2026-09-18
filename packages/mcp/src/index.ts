// @scopebond/mcp — the Model Context Protocol proxy connector. The library
// surface is the deterministic mapper and the transport-agnostic proxy core; the
// `scopebond-mcp` binary provides the stdio transport to a real upstream server.

export { createMcpProxy, mapMcpToolCall } from "./proxy.js";
export type { McpProxy, McpProxyConfig, McpUpstream, JsonRpcMessage } from "./proxy.js";
export { starterMcpPolicy } from "./init.js";
export { connectCloud, loadMcpConnection, openExporter, connectionFileFor } from "./cloud.js";
export type { McpConnection } from "./cloud.js";
