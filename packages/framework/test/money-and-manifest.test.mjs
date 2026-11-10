// The guard maps a tool to its action type through the manifest's own entries only, and lifts money fields so a
// spend limit reads them. Under a policy with spend limits a money field the policy cannot read (an amount sent as
// text, an asset that is not a string) is refused rather than dropped, and an asset in another case is the same asset.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createToolGuard } from "../dist/index.js";

const edPem = () => generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const policy = {
  vocabulary_version: "1.0", policy_id: "agent-money", version: 1,
  clauses: [
    { id: "tools", type: "action_allowlist", mode: "enforce", action_types: ["tool.search", "payout.create"] },
    { id: "cap", type: "spend_limit", mode: "enforce", asset: "USDC", max_per_action: 100000 },
  ],
};
const guard = () => createToolGuard({ policy, agentKeyPem: edPem(), attesterKeyPem: edPem(), manifest: { transfer: "payout.create" } });

test("control: a payout within the cap is allowed and one over it is denied", async () => {
  const g = guard();
  assert.equal((await g.check("transfer", { asset: "USDC", amount: 500 })).allowed, true);
  assert.equal((await g.check("transfer", { asset: "USDC", amount: 200000 })).allowed, false);
});

test("a payout over the cap is denied when its asset is spelled in another case", async () => {
  const d = await guard().check("transfer", { asset: "usdc", amount: 200000 });
  assert.equal(d.allowed, false, d.reason);
  assert.match(d.reason, /max_per_action/);
});

test("a payout whose amount is text or whose asset is not a string is denied, never read as spending nothing", async () => {
  const g = guard();
  for (const args of [
    { asset: "usdc", amount: "200000" },
    { asset: "USDC", amount: "200000" },
    { asset: ["USDC"], amount: 200000 },
    { amount: 200000 },
    { asset: "USDC", amount: 1.5 },
    { asset: "USDC", amount: -5 },
  ]) {
    const d = await g.check("transfer", args);
    assert.equal(d.allowed, false, `${JSON.stringify(args)}: ${d.reason}`);
    assert.equal(d.receipt.payload.realtime_result, "deny");
  }
});

test("a spend limit naming its money actions by type denies one of them with no readable asset or amount, or an asset it does not limit", async () => {
  const byType = {
    vocabulary_version: "1.0", policy_id: "agent-money-typed", version: 1,
    clauses: [
      { id: "tools", type: "action_allowlist", mode: "enforce", action_types: ["payout.create"] },
      { id: "cap", type: "spend_limit", mode: "enforce", asset: "USDC", action_types: ["payout.create"], max_per_action: 100000 },
    ],
  };
  const g = createToolGuard({ policy: byType, agentKeyPem: edPem(), attesterKeyPem: edPem(), manifest: { transfer: "payout.create" } });
  for (const args of [{}, { asset: { code: "USDC" }, amount: "200000" }, { asset: "USDC" }, { asset: "USD-C", amount: 1 }, { asset: "usdc", amount: 200000 }]) {
    const d = await g.check("transfer", args);
    assert.equal(d.allowed, false, `${JSON.stringify(args)}: ${d.reason}`);
  }
  assert.equal((await g.check("transfer", { asset: "usdc", amount: 5 })).allowed, true, "an asset in another case is the limited asset");
});

test("a tool named like an Object prototype member is not mapped by the prototype", async () => {
  const g = guard();
  for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
    const d = await g.check(name, {});
    assert.equal(d.actionType, `tool.${name}`, name);
    assert.equal(d.allowed, false, `${name} is not allowlisted: ${d.reason}`);
  }
  // The manifest's own entries still map.
  assert.equal((await g.check("transfer", { asset: "USDC", amount: 1 })).actionType, "payout.create");
});
