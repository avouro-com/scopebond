// The hook runtime: a check-only (M0) gateway built once from the enrolled
// machine key, policy and a durable local receipt log. Each mapped action is
// signed by the machine key, decided against policy and countersigned — locally,
// with no HTTP server and no Cloud dependency in 0.1.

import { readFileSync } from "node:fs";
import { createGateway, StaticPrincipalKeyRegistry } from "@scopebond/gateway";
import { loadOrCreateAttester, openReceiptStore } from "@scopebond/gateway/node";
import { createSigner } from "@scopebond/sdk";
import type { Mapped } from "./map.js";

export interface RuntimeConfig {
  policyPath: string;
  keyPath: string;
  attesterPath: string;
  dbPath: string;
  /** Strict mode: an unmapped tool is policy-checked (and denied by a closed
   *  allowlist) instead of observed. Fail-closed for tools with no taxonomy
   *  mapping; default false (observe, matching the connector conformance vector). */
  strict?: boolean;
}

export interface Decision {
  decision: "allow" | "deny" | "not_evaluated";
  reason: string;
  receipt?: unknown;
}

/** The default starter policy for a coding agent: protect release branches, deny
 *  destructive programs, allow workspace file access, and trust only the enrolled
 *  machine key. Every threshold is the operator's to edit. */
export function starterPolicy(agentKid: string): Record<string, unknown> {
  return {
    vocabulary_version: "1.0", policy_id: "coding-agent", version: 1,
    clauses: [
      {
        id: "protect-branches", type: "action_allowlist", mode: "enforce", action_types: ["git.push"],
        param_bounds: { ref: { pattern: "^(?!(?:main|master)$)(?!release/).+" } },
        description: "Deny pushes to main, master and release/*.",
      },
      {
        id: "safe-shell", type: "action_allowlist", mode: "enforce", action_types: ["shell.exec"],
        param_bounds: { program: { pattern: "^(?!(?:rm|sudo|shutdown|reboot|mkfs|dd)$).+" } },
        description: "Deny destructive programs (rm, sudo, …).",
      },
      { id: "workspace-files", type: "action_allowlist", mode: "enforce", action_types: ["file.write", "file.read"] },
      { id: "keys", type: "key_policy", active_keys: [agentKid], description: "Only the enrolled machine key may sign." },
    ],
  };
}

/** Build the runtime. Throws on any setup failure (unparseable policy, missing
 *  key, unavailable store) — the CLI turns that into a fail-closed deny. */
export function createHookRuntime(config: RuntimeConfig) {
  const policy = JSON.parse(readFileSync(config.policyPath, "utf8"));
  const agent = createSigner({ privateKeyPem: readFileSync(config.keyPath, "utf8") });
  const keys = new StaticPrincipalKeyRegistry([
    { kid: agent.kid, publicKeyPem: agent.publicKeyPem, purposes: ["agent"], status: "active" },
  ]);
  const { attester } = loadOrCreateAttester({ file: config.attesterPath });
  const { store } = openReceiptStore({ db: config.dbPath });
  const gateway = createGateway({ policy, authentication: { keys }, attester, store, mode: "check_only" });

  return {
    gateway,
    agentKid: agent.kid,
    async evaluate(mapped: Mapped): Promise<Decision> {
      const signed = agent.sign(mapped.intent);
      if (!mapped.evaluated && !config.strict) {
        // Unknown tool, non-strict: observe without evaluating — grants nothing (D30).
        const { receipt } = await gateway.observeAction({ intent: signed.intent, authorization: signed.authorization });
        return { decision: "not_evaluated", reason: `no policy applies to ${mapped.intent.action_type}`, receipt };
      }
      // Evaluated tools, and (in strict mode) unmapped tool.<name> actions, go
      // through policy — a closed allowlist denies an unlisted action.
      const result = await gateway.handleAction({ intent: signed.intent, authorization: signed.authorization });
      return { decision: result.allowed ? "allow" : "deny", reason: result.reason, receipt: result.receipt };
    },
  };
}
