// MCP connector (in-path proxy): one policy in front of every Model Context
// Protocol `tools/call`. An allowed call is forwarded to the upstream server and
// gets a PEP-authorized receipt; a denied call is answered with a JSON-RPC error
// and is *never forwarded*. Here the upstream is a stub that records whether it
// was reached, so you can see the denied call never gets there.
// Run: `pnpm -r build && node examples/mcp-proxy.mjs`
import { generateKeyPairSync } from "node:crypto";
import { createMcpProxy, starterMcpPolicy } from "@scopebond/mcp";

const attesterKeyPem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();

// starterMcpPolicy allows non-destructive tools on the named server and denies
// delete_/write_/remove_/drop_/rm_ tools.
const policy = starterMcpPolicy("filesystem");

// A stub upstream that records the last tool it was asked to run.
let lastForwardedTool = null;
const upstream = {
  async call(message) {
    lastForwardedTool = message?.params?.name ?? message?.method;
    return { jsonrpc: "2.0", id: message.id ?? null, result: { content: [{ type: "text", text: `ran ${lastForwardedTool}` }] } };
  },
};

const proxy = createMcpProxy({
  policy,
  principal: { subject: "agent://support-bot", issuer: "scopebond-mcp" },
  server: "filesystem",
  attesterKeyPem,
  upstream,
});

async function call(label, name, args) {
  lastForwardedTool = null;
  const response = await proxy.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  console.log(`\n${label}`);
  if (response.error) console.log(`  JSON-RPC error: ${response.error.message}`);
  else console.log(`  result: ${response.result.content[0].text}`);
  console.log(`  forwarded to upstream: ${lastForwardedTool === null ? "no (blocked before forwarding)" : `yes (${lastForwardedTool})`}`);
}

await call("read_file (non-destructive → allowed, forwarded)", "read_file", { path: "notes.txt" });
await call("delete_file (destructive → denied, never forwarded)", "delete_file", { path: "notes.txt" });
