// `scopebond-mcp init` — scaffold the local enrollment for the proxy: a signing
// key and a starter policy for one upstream server. Keys and receipts stay local.

import { writeFileSync } from "node:fs";
import { loadOrCreateAttester } from "@scopebond/gateway/node";

/** The tool-name pattern of the starter policy: an allowlist of names that conventionally mark
 *  a read-only tool. Every other tool, including any whose name does not say what it does, is
 *  denied. */
export const READ_ONLY_TOOL_PATTERN = "^(read|list|get|search|describe|view)_[A-Za-z0-9_]+$";

/** A starter MCP policy: allow only tools whose names mark them read-only on the server, deny
 *  everything else. A name is a convention, not a guarantee: review the server's tools/list and
 *  edit the pattern (every threshold is the operator's to edit). */
export function starterMcpPolicy(server: string): Record<string, unknown> {
  return {
    vocabulary_version: "1.0", policy_id: "mcp", version: 1,
    clauses: [{
      id: "tools", type: "action_allowlist", mode: "enforce", action_types: ["mcp.tool.call"],
      param_bounds: { server: { enum: [server] }, tool: { pattern: READ_ONLY_TOOL_PATTERN } },
      description: `Allow only read-only tools on ${server} (names starting read_, list_, get_, search_, describe_ or view_); deny every other tool. Review the server's tool list and edit the pattern.`,
    }],
  };
}

export function scaffold(server: string, opts: { force?: boolean } = {}): { keyFile: string; policyFile: string } {
  const keyFile = "scopebond-agent.key";
  const policyFile = "scopebond.policy.json";
  loadOrCreateAttester({ file: keyFile }); // reused if present
  const policy = JSON.stringify(starterMcpPolicy(server), null, 2) + "\n";
  if (opts.force) {
    writeFileSync(policyFile, policy);
  } else {
    // Create only when absent; the exclusive create is the existence check, so nothing can slip in between.
    try {
      writeFileSync(policyFile, policy, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  return { keyFile, policyFile };
}
