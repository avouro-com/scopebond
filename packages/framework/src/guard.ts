// The in-process tool guard: before an agent runs a tool, check the call against
// policy (cooperative M0) and record a signed-intent receipt. The agent's key
// signs the intent, so the receipt is the strongest class. Framework-agnostic —
// the adapters wrap each framework's tool loop around `check`.

import { createGateway, StaticPrincipalKeyRegistry, MemoryReceiptStore, createAttester, attesterFromPrivateKeyPem, createCloudExporter, createMemoryCloudOutbox, withCloudExporter } from "@scopebond/gateway";
import type { SignedReceipt, ReceiptStore, CloudExporter, CloudOutbox } from "@scopebond/gateway";
import { createSigner } from "@scopebond/sdk";

export interface ToolGuardConfig {
  /** The policy the tool calls are checked against. */
  policy: unknown;
  /** PEM of the agent's Ed25519 signing key (the agent identity). */
  agentKeyPem: string;
  /** PEM of the countersigning (attester) key. If omitted, an ephemeral key is
   *  used — fine for tests, but persist one for verifiable receipts. */
  attesterKeyPem?: string;
  /** Map a framework tool name to a taxonomy action type (e.g. a payout tool →
   *  `payout.create`). Unmapped tools become `tool.<name>` and are governed by
   *  name under a closed allowlist. */
  manifest?: Record<string, string>;
  /** Called with every emitted receipt (persist / export locally). */
  onReceipt?: (receipt: SignedReceipt) => void | Promise<void>;
  /** Injectable store (defaults to in-memory). */
  store?: ReceiptStore;
  /** Connect to a Scopebond workspace so receipts are mirrored to the hosted portal.
   *  `connection` comes from `connectCloud`. `outbox` defaults to in-memory (fine for
   *  a long-running agent); pass a durable one to survive restarts. */
  cloud?: { connection: { url: string; credential: string }; outbox?: CloudOutbox; fetch?: typeof fetch };
}

export interface ToolDecision {
  allowed: boolean;
  reason: string;
  actionType: string;
  receipt: SignedReceipt;
}

export interface ToolGuard {
  /** Check a tool call. Returns the cooperative decision and its signed receipt;
   *  the caller runs the tool only when `allowed` is true. */
  check(toolName: string, args?: Record<string, unknown>): Promise<ToolDecision>;
  /** Deliver any queued receipts to Cloud now (a no-op when not connected). */
  flush(): Promise<void>;
  /** Stop the background exporter (a no-op when not connected). */
  stop(): void;
}

/** Build the guard once and reuse it across tool calls. */
export function createToolGuard(config: ToolGuardConfig): ToolGuard {
  const agent = createSigner({ privateKeyPem: config.agentKeyPem });
  const keys = new StaticPrincipalKeyRegistry([
    { kid: agent.kid, publicKeyPem: agent.publicKeyPem, purposes: ["agent"], status: "active" },
  ]);
  const attester = config.attesterKeyPem ? attesterFromPrivateKeyPem(config.attesterKeyPem) : createAttester();
  // When connected, mirror receipts to the workspace through a bounded outbox.
  const baseStore = config.store ?? new MemoryReceiptStore();
  let store = baseStore;
  let exporter: CloudExporter | undefined;
  if (config.cloud) {
    exporter = createCloudExporter({
      url: config.cloud.connection.url, credential: config.cloud.connection.credential,
      outbox: config.cloud.outbox ?? createMemoryCloudOutbox(), fetch: config.cloud.fetch,
    });
    store = withCloudExporter(baseStore, exporter);
  }
  const gateway = createGateway({
    policy: config.policy as never,
    authentication: { keys },
    attester,
    store,
    mode: "check_only",
  });

  return {
    flush: () => exporter ? exporter.flush() : Promise.resolve(),
    stop: () => exporter?.stop(),
    async check(toolName, args = {}) {
      const actionType = config.manifest?.[toolName] ?? `tool.${toolName}`;
      const intent: Record<string, unknown> = { action_type: actionType, params: args };
      // Lift money fields so spend_limit clauses (which read the top-level asset /
      // amount) apply to a mapped money tool.
      if (typeof args.asset === "string") intent.asset = args.asset;
      if (typeof args.amount === "number") intent.amount = args.amount;
      const signed = agent.sign(intent as never);
      const result = await gateway.handleAction({ intent: signed.intent, authorization: signed.authorization });
      await config.onReceipt?.(result.receipt);
      return { allowed: result.allowed, reason: result.reason, actionType, receipt: result.receipt };
    },
  };
}
