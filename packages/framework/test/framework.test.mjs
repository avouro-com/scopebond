import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createPublicKey } from "node:crypto";
import { createToolGuard, wrapVercelTools, wrapLangGraphTool } from "../dist/index.js";
import { verifyReceipt } from "@scopebond/gateway";

const edPem = () => generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const policy = {
  vocabulary_version: "1.0", policy_id: "agent", version: 1,
  clauses: [
    { id: "tools", type: "action_allowlist", mode: "enforce", action_types: ["tool.search", "tool.read", "payout.create"] },
    { id: "cap", type: "spend_limit", mode: "enforce", asset: "USDC", max_per_action: 100000 },
  ],
};

function guardWith(onReceipt) {
  const attesterKeyPem = edPem();
  const guard = createToolGuard({ policy, agentKeyPem: edPem(), attesterKeyPem, manifest: { transfer: "payout.create" }, onReceipt });
  return { guard, attesterPub: createPublicKey(attesterKeyPem).export({ type: "spki", format: "pem" }).toString() };
}

test("an allowlisted tool is a cooperative allow with a signed-intent receipt", async () => {
  const { guard, attesterPub } = guardWith();
  const d = await guard.check("search", { q: "weather" });
  assert.equal(d.allowed, true, d.reason);
  assert.equal(d.actionType, "tool.search");
  const v = verifyReceipt(d.receipt, attesterPub);
  assert.equal(v.valid, true);
  assert.equal(v.evidence_class, "signed_intent");
  assert.equal(d.receipt.payload.execution.state, "cooperative_allow");
  assert.equal(d.receipt.payload.executed, false);
});

test("a mapped money tool over its cap is denied", async () => {
  const { guard } = guardWith();
  const d = await guard.check("transfer", { asset: "USDC", amount: 200000 });
  assert.equal(d.allowed, false);
  assert.equal(d.actionType, "payout.create");
  assert.equal(d.receipt.payload.realtime_result, "deny");
});

test("an unlisted tool is denied by the closed allowlist (fail closed)", async () => {
  const { guard } = guardWith();
  const d = await guard.check("delete_everything", {});
  assert.equal(d.allowed, false);
  assert.match(d.reason, /not allowlisted/);
});

test("wrapVercelTools runs allowed tools and returns a denial for denied ones", async () => {
  const { guard } = guardWith();
  const calls = [];
  const tools = {
    search: { description: "search", execute: async (args) => { calls.push(["search", args]); return "results"; } },
    transfer: { description: "transfer", execute: async (args) => { calls.push(["transfer", args]); return "sent"; } },
  };
  const wrapped = wrapVercelTools(tools, guard);
  assert.equal(await wrapped.search.execute({ q: "x" }), "results");
  const denied = await wrapped.transfer.execute({ asset: "USDC", amount: 200000 });
  assert.match(String(denied), /Denied by Scopebond policy/);
  assert.deepEqual(calls, [["search", { q: "x" }]], "the denied tool never executed");
  assert.equal(wrapped.search.description, "search", "other tool fields are preserved");
});

test("wrapLangGraphTool guards a LangChain-style tool and preserves it", async () => {
  const { guard } = guardWith();
  let invoked = 0;
  const readTool = { name: "read", description: "read a file", invoke: async (input) => { invoked += 1; return `content of ${input.path}`; } };
  const guarded = wrapLangGraphTool(readTool, guard);
  assert.equal(guarded.name, "read");
  assert.equal(guarded.description, "read a file");
  assert.equal(await guarded.invoke({ path: "a.txt" }), "content of a.txt");
  assert.equal(invoked, 1);

  const deleteTool = { name: "delete_everything", invoke: async () => { invoked += 1; return "gone"; } };
  const guardedDelete = wrapLangGraphTool(deleteTool, guard);
  assert.match(String(await guardedDelete.invoke({})), /Denied by Scopebond policy/);
  assert.equal(invoked, 1, "the denied tool never invoked");
});

test("onReceipt receives a receipt for every checked call", async () => {
  const receipts = [];
  const { guard } = guardWith((r) => receipts.push(r));
  await guard.check("search", { q: "x" });
  await guard.check("delete_everything", {});
  assert.equal(receipts.length, 2);
  assert.equal(receipts[0].payload.realtime_result, "allow");
  assert.equal(receipts[1].payload.realtime_result, "deny");
});
