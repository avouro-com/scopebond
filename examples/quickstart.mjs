// Quickstart: an agent (SDK) submits actions through the gateway and gets a
// countersigned receipt — all in-process. Run: `pnpm -r build && node examples/quickstart.mjs`
import { readFileSync } from "node:fs";
import { createGateway } from "@scopebond/gateway";
import { createSigner } from "@scopebond/sdk";

const policy = JSON.parse(readFileSync(new URL("./policy.json", import.meta.url), "utf8"));
const gateway = createGateway({ policy });
const agent = createSigner({ kid: "key:agent-demo" });

async function run(label, intent) {
  const signed = agent.sign(intent);
  const res = await gateway.handleAction({ intent: signed.intent });
  console.log(`\n${label}`);
  console.log(`  allowed = ${res.allowed}  ·  ${res.reason}`);
  console.log(`  receipt: executed=${res.receipt.payload.executed} realtime=${res.receipt.payload.realtime_result} sig=${res.receipt.signature.alg}`);
}

await run("in-policy $5,000 payout", { action_type: "payout.create", asset: "USDC", amount: 500000 });
await run("over-limit $20,000 payout (enforce → denied)", { action_type: "payout.create", asset: "USDC", amount: 2000000 });

console.log(`\ntotal receipts stored: ${(await gateway.store.list()).length}`);
