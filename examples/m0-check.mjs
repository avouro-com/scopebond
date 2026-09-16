// M0 (check-only) — the neutral core, in-process: no HTTP server, no agent
// framework, no vendor account. Any agent — in any language, on any model —
// that can import this library or call the gateway over HTTP/MCP gets the same
// policy decision and the same portable, signed receipt.
// Run: `pnpm -r build && node examples/m0-check.mjs`
import { createGateway, createAttester, verifyReceipt, ed25519JwkToSpkiPem } from "@scopebond/gateway";

// 1) Your policy is plain data. Here: enforce a $10,000-per-action USDC limit.
const policy = {
  vocabulary_version: "1.0", policy_id: "support-agent", version: 1,
  clauses: [{ id: "cap", type: "spend_limit", mode: "enforce", asset: "USDC", max_per_action: 10000 }],
};

// 2) Use the gateway as a library — no server is started. We pass our own
//    attester so we can verify the receipt against its public key below.
//    This demo skips agent-key authentication for brevity; a real deployment
//    authenticates signed agent intents (see examples/quickstart.mjs).
const attester = createAttester();
const { handleAction } = createGateway({ authentication: { mode: "insecure-development" }, policy, attester });
const attesterPem = ed25519JwkToSpkiPem(attester.publicKeyJwk.x);

// 3) Before your agent acts, ask: is this action in policy? You get a verdict
//    and a signed receipt. M0 does not perform the action — your agent does,
//    cooperatively, only if allowed.
async function check(intent) {
  const { allowed, reason, receipt } = await handleAction({ intent });
  const verified = verifyReceipt(receipt, attesterPem).valid;
  return { allowed, reason, receipt, verified };
}

const within = await check({ action_type: "payout.create", asset: "USDC", amount: 500 });
const over = await check({ action_type: "payout.create", asset: "USDC", amount: 18000 });

for (const [label, r] of [["$500 payout", within], ["$18,000 payout", over]]) {
  console.log(`\n${label}: ${r.allowed ? "ALLOW" : "DENY "}   (${r.reason})`);
  console.log(`  receipt.realtime_result = ${r.receipt.payload.realtime_result}`);
  console.log(`  receipt.executed        = ${r.receipt.payload.executed}    <- M0 never claims it executed the action`);
  console.log(`  receipt.external_effect = ${r.receipt.payload.execution.external_effect}`);
  console.log(`  signature verified      = ${r.verified}    <- Ed25519, against the published key, no server`);
}

console.log("\nOne policy in, a decision + a portable signed receipt out — no server, no framework, no vendor.");
