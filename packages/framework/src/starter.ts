// Onboarding helpers: generate an agent signing key and a starter tool policy so
// a developer can scaffold a guard in code.

import { generateKeyPairSync } from "node:crypto";

/** Generate a fresh Ed25519 agent signing key as a PKCS#8 PEM string. Persist it
 *  (e.g. a file or secret) and pass it as `agentKeyPem`. */
export function generateAgentKey(): string {
  return generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

/** A starter policy that allows exactly the named tools (as `tool.<name>`), fail
 *  closed on anything else. Add spend_limit / param_bounds clauses as needed. */
export function starterToolPolicy(toolNames: string[]): Record<string, unknown> {
  return {
    vocabulary_version: "1.0", policy_id: "agent", version: 1,
    clauses: [{
      id: "tools", type: "action_allowlist", mode: "enforce",
      action_types: toolNames.map((name) => `tool.${name}`),
      description: "Allow exactly these tools; deny everything else.",
    }],
  };
}
