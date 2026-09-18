// Framework connector: guard a framework's tool loop with policy, in-process.
// An agent's own tools are wrapped so each call is checked against policy
// (cooperative M0) and records a signed-intent receipt before it runs; a denied
// call returns a synthetic denial to the model instead of executing.
// Run: `pnpm -r build && node examples/framework-guard.mjs`
import { createToolGuard, wrapVercelTools, generateAgentKey } from "@scopebond/framework";

// The policy: allow a read-only `search` tool and a `refund` tool mapped to the
// `payout.create` money action, capped at $1,000. Everything else fails closed.
const policy = {
  vocabulary_version: "1.0", policy_id: "support-agent", version: 1,
  assets: { USD: { decimals: 2 } },
  clauses: [
    {
      id: "tools", type: "action_allowlist", mode: "enforce",
      action_types: ["tool.search", "payout.create"],
      description: "Allow exactly the search and refund tools; deny everything else.",
    },
    {
      id: "refund-cap", type: "spend_limit", mode: "enforce",
      asset: "USD", max_per_action: 100000,
      description: "A single money action may not exceed $1,000.",
    },
  ],
};

// `refund` is a money tool, so map it to the taxonomy's `payout.create` type; the
// guard lifts `asset`/`amount` so `spend_limit` applies. `search` and `deleteAll`
// stay `tool.<name>` and are governed by name under the allowlist.
const guard = createToolGuard({
  policy,
  agentKeyPem: generateAgentKey(),
  manifest: { refund: "payout.create" },
});

// A Vercel AI SDK-shaped `tools` record. Each `execute` is the real work; the
// wrapper checks policy first and only calls it when allowed.
const tools = wrapVercelTools({
  search: { description: "Look up an order", execute: async ({ q }) => `results for ${q}` },
  refund: { description: "Issue a refund", execute: async ({ amount }) => `refunded ${amount} cents` },
  deleteAll: { description: "Delete all orders", execute: async () => "everything deleted" },
}, guard, {
  onDenied: (name, reason) => `Blocked by policy: ${name} — ${reason}`,
});

async function call(label, name, args) {
  const result = await tools[name].execute(args);
  console.log(`\n${label}`);
  console.log(`  tool "${name}" returned: ${result}`);
}

await call("read-only search (allowlisted → runs)", "search", { q: "order-4821" });
await call("$500 refund (within the $1,000 cap → runs)", "refund", { asset: "USD", amount: 50000 });
await call("$5,000 refund (over the cap → denied, real refund never runs)", "refund", { asset: "USD", amount: 500000 });
await call("deleteAll (not on the allowlist → denied, fail-closed)", "deleteAll", {});

// Every checked call — allowed or denied — leaves a signed-intent receipt. Inspect
// one directly to see the evidence class and that nothing was executed (M0).
const decision = await guard.check("refund", { asset: "USD", amount: 500000 });
console.log("\nreceipt for the over-limit refund:");
console.log(`  action_type      = ${decision.receipt.payload.intent.action_type}`);
console.log(`  evidence_class   = ${decision.receipt.payload.evidence_class ?? "signed_intent (agent-signed)"}`);
console.log(`  realtime_result  = ${decision.receipt.payload.realtime_result}`);
console.log(`  executed         = ${decision.receipt.payload.executed}  (cooperative check; the guard never runs the tool)`);
console.log(`  signature.alg    = ${decision.receipt.signature.alg}`);
