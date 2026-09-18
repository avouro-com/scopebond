// `scopebond-mcp init` — scaffold the local enrollment for the proxy: a signing
// key and a starter policy for one upstream server. Keys and receipts stay local.

import { writeFileSync, existsSync } from "node:fs";
import { loadOrCreateAttester } from "@scopebond/gateway/node";

/** A starter MCP policy: allow read-ish tools on the server, deny destructive
 *  ones by name. Every threshold is the operator's to edit. */
export function starterMcpPolicy(server: string): Record<string, unknown> {
  return {
    vocabulary_version: "1.0", policy_id: "mcp", version: 1,
    clauses: [{
      id: "tools", type: "action_allowlist", mode: "enforce", action_types: ["mcp.tool.call"],
      param_bounds: { server: { enum: [server] }, tool: { pattern: "^(?!delete_|write_|remove_|drop_|rm_).+" } },
      description: `Allow non-destructive tools on ${server}; deny delete/write/remove/drop/rm tools.`,
    }],
  };
}

export function scaffold(server: string, opts: { force?: boolean } = {}): { keyFile: string; policyFile: string } {
  const keyFile = "scopebond-agent.key";
  const policyFile = "scopebond.policy.json";
  loadOrCreateAttester({ file: keyFile }); // reused if present
  if (!existsSync(policyFile) || opts.force) {
    writeFileSync(policyFile, JSON.stringify(starterMcpPolicy(server), null, 2) + "\n");
  }
  return { keyFile, policyFile };
}
