// The hook runtime: a check-only (M0) gateway built once from the enrolled
// machine key, policy and a durable local receipt log. Each mapped action is
// signed by the machine key, decided against policy and countersigned — locally,
// with no HTTP server and no Cloud dependency in 0.1.

import { readFileSync } from "node:fs";
import { createGateway, StaticPrincipalKeyRegistry, type CloudExporter } from "@scopebond/gateway";
import { loadOrCreateAttester, openReceiptStore } from "@scopebond/gateway/node";
import { createSigner } from "@scopebond/sdk";
import type { Mapped } from "./map.js";
import { attachExporter, flushBounded, type HookConnection } from "./cloud.js";

export interface RuntimeConfig {
  policyPath: string;
  keyPath: string;
  attesterPath: string;
  dbPath: string;
  /** Strict mode: an unmapped tool is policy-checked (and denied by a closed
   *  allowlist) instead of observed. Fail-closed for tools with no taxonomy
   *  mapping; default false (observe, matching the connector conformance vector). */
  strict?: boolean;
  /** When connected to a Cloud workspace, receipts are auto-exported to the portal.
   *  Export is best-effort and never changes the local decision. */
  cloud?: { connection: HookConnection; fetch?: typeof fetch; flushTimeoutMs?: number };
}

export interface Decision {
  decision: "allow" | "deny" | "not_evaluated";
  reason: string;
  /** The deciding receipt (the denied one, or the first allow). */
  receipt?: unknown;
  /** Every receipt produced — one per simple command in a decomposed shell call. */
  receipts?: unknown[];
}

// The hook's own config and keys must be off-limits to the agent it governs:
// otherwise the agent could rewrite its policy or read the signing keys and the
// receipts stop meaning anything. These patterns are "allow if the path does NOT
// match a protected location"; they run against the cwd-relative path the mapper
// produces (and equally against an absolute one).
const PROTECTED_WRITE = "^(?!(?:.*/)?\\.scopebond/)(?!(?:.*/)?\\.claude/settings)(?!(?:.*/)?\\.cursor/hooks)(?!(?:.*/)?\\.git/hooks/)(?!(?:.*/)?\\.github/workflows/)(?!(?:.*/)?\\.github/actions/)(?!(?:.*/)?\\.gitlab-ci\\.yml$)(?!(?:.*/)?\\.circleci/)(?!(?:.*/)?azure-pipelines\\.yml$)(?!(?:.*/)?Jenkinsfile$).+";
const PROTECTED_READ = "^(?!(?:.*/)?\\.scopebond/)(?!.*\\.key$)(?!(?:.*/)?\\.env(?:\\.(?!example$|sample$|template$)[^/]*)?$).+";

/** The default starter policy for a coding agent: protect release branches, deny
 *  destructive programs, allow workspace file access except the hook's own config
 *  and keys, and trust only the enrolled machine key. Every threshold is the
 *  operator's to edit. */
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
        param_bounds: { program: { pattern: "^(?!(?:rm|sudo|shutdown|reboot|mkfs|dd|del|rd|rmdir|erase|deltree|format|Remove-Item|ri)$).+" } },
        description: "Deny destructive programs — POSIX (rm, sudo, shutdown, reboot, mkfs, dd) and Windows/PowerShell (del, rd, rmdir, erase, deltree, format, Remove-Item). An empty program (an unparseable command) is denied.",
      },
      {
        id: "protect-write", type: "action_allowlist", mode: "enforce", action_types: ["file.write"],
        param_bounds: { path: { pattern: PROTECTED_WRITE } },
        description: "Allow workspace writes, but never to the hook's policy/keys, .claude/settings, .cursor/hooks, git hooks, or CI config (.github/workflows, .github/actions, .gitlab-ci.yml, .circleci, azure-pipelines.yml, Jenkinsfile).",
      },
      {
        id: "protect-read", type: "action_allowlist", mode: "enforce", action_types: ["file.read"],
        param_bounds: { path: { pattern: PROTECTED_READ } },
        description: "Allow workspace reads, but never the signing keys (*.key), environment secret files (.env, .env.*, except .env.example/.sample/.template) or the hook's own .scopebond directory.",
      },
      {
        id: "observe-net-mcp", type: "action_allowlist", mode: "monitor",
        action_types: ["net.fetch", "mcp.tool.call"],
        description: "Observe network fetches and MCP tool calls (recorded, not blocked) — add bounds to enforce.",
      },
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
  const { store: baseStore } = openReceiptStore({ db: config.dbPath });
  // When connected, mirror every stored receipt to the hosted portal through a
  // durable outbox. The wrapped store's decision is unchanged; export is best-effort.
  let store = baseStore;
  let exporter: CloudExporter | undefined;
  if (config.cloud) {
    const attached = attachExporter(config.dbPath + ".cloud-outbox.db", config.cloud.connection, baseStore, config.cloud.fetch);
    store = attached.store;
    exporter = attached.exporter;
  }
  const gateway = createGateway({ policy, authentication: { keys }, attester, store, mode: "check_only" });

  return {
    gateway,
    agentKid: agent.kid,
    exporter,
    /** Deliver queued receipts to Cloud with a bounded timeout, then it is safe to
     *  exit. Undelivered receipts persist in the durable outbox for the next run. */
    async flush(): Promise<void> {
      if (exporter) await flushBounded(exporter, config.cloud?.flushTimeoutMs);
    },
    /** Decide one mapped action, recording a receipt either way. */
    async evaluateOne(mapped: Mapped): Promise<Decision> {
      const signed = agent.sign(mapped.intent);
      if (!mapped.evaluated && !config.strict) {
        // Unknown tool or unparseable command, non-strict: observe without
        // evaluating — grants nothing (D30).
        const { receipt } = await gateway.observeAction({ intent: signed.intent, authorization: signed.authorization });
        return { decision: "not_evaluated", reason: `no policy applies to ${mapped.intent.action_type}`, receipt };
      }
      // Evaluated actions, and (in strict mode) unmapped tool.<name>/opaque commands,
      // go through policy — a closed allowlist denies an unlisted action.
      const result = await gateway.handleAction({ intent: signed.intent, authorization: signed.authorization });
      return { decision: result.allowed ? "allow" : "deny", reason: result.reason, receipt: result.receipt };
    },
    /** Decide a whole tool call. A shell call decomposes into several simple
     *  commands; every one is recorded, and a single deny denies the call. */
    async evaluate(mapped: Mapped | Mapped[]): Promise<Decision> {
      const list = Array.isArray(mapped) ? mapped : [mapped];
      if (list.length === 0) return { decision: "not_evaluated", reason: "no action", receipts: [] };
      const receipts: unknown[] = [];
      let allow: Decision | null = null;
      let notEvaluated: Decision | null = null;
      for (const m of list) {
        const d = await this.evaluateOne(m);
        if (d.receipt !== undefined) receipts.push(d.receipt);
        if (d.decision === "deny") return { ...d, receipts };            // any deny denies the call
        if (d.decision === "allow" && !allow) allow = d;
        if (d.decision === "not_evaluated" && !notEvaluated) notEvaluated = d;
      }
      // No deny: allow if any command was evaluated-and-allowed, else not_evaluated.
      const chosen = allow ?? notEvaluated!;
      return { ...chosen, receipts };
    },
  };
}
