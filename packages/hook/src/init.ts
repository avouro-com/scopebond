// `scopebond-hook init` — scaffold the local enrollment: a machine signing key, a
// gateway countersigning key and a starter policy. Keys and receipts stay on the
// machine; no credentials are handled.

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadOrCreateAttester } from "@scopebond/gateway/node";
import { createSigner } from "@scopebond/sdk";
import { starterPolicy } from "./runtime.js";

export function scaffold(dir: string, opts: { force?: boolean } = {}): { agentKid: string; policyPath: string } {
  mkdirSync(dir, { recursive: true });
  const keyPath = join(dir, "agent.key");
  const attesterPath = join(dir, "attester.key");
  const policyPath = join(dir, "policy.json");
  // Machine signing key (agent) + gateway countersigning key (attester). Reused if present.
  loadOrCreateAttester({ file: keyPath });
  loadOrCreateAttester({ file: attesterPath });
  const agent = createSigner({ privateKeyPem: readFileSync(keyPath, "utf8") });
  if (!existsSync(policyPath) || opts.force) {
    writeFileSync(policyPath, JSON.stringify(starterPolicy(agent.kid), null, 2) + "\n");
  }
  return { agentKid: agent.kid, policyPath };
}

/** The harness configuration snippet to install the hook. */
export function harnessSnippet(harness: "claude" | "cursor"): string {
  if (harness === "cursor") {
    return JSON.stringify({
      version: 1,
      hooks: {
        beforeShellExecution: [{ command: "scopebond-hook cursor" }],
        beforeMCPExecution: [{ command: "scopebond-hook cursor" }],
        beforeReadFile: [{ command: "scopebond-hook cursor" }],
        afterFileEdit: [{ command: "scopebond-hook cursor" }],
      },
    }, null, 2);
  }
  return JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "scopebond-hook claude" }] }],
    },
  }, null, 2);
}
