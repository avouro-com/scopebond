// LangGraph's ToolNode runs a tool as `tool.invoke({ name, args, id, type: "tool_call" })`, and a
// LangChain tool unwraps `args` itself. The guard must check those arguments (the ones the tool
// runs with), not the ToolCall envelope, or a spend limit never sees the amount.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createToolGuard, wrapLangGraphTool, generateAgentKey } from "../dist/index.js";

const policy = {
  vocabulary_version: "1.0", assets: { USDC: { decimals: 2 } }, policy_id: "agent", version: 1,
  clauses: [
    { id: "tools", type: "action_allowlist", mode: "enforce", action_types: ["payout.create", "tool.lookup"] },
    { id: "cap", type: "spend_limit", mode: "enforce", asset: "USDC", max_per_action: 1000 },
  ],
};

const setup = () => {
  const receipts = [];
  const guard = createToolGuard({
    policy, agentKeyPem: generateAgentKey(), manifest: { transfer: "payout.create" },
    onReceipt: (r) => receipts.push(r),
  });
  return { guard, receipts };
};

const isToolCall = (x) => !!(x && typeof x === "object" && x.type === "tool_call");

// Mirrors @langchain/core's StructuredTool: invoke/call unwrap a ToolCall, parse the arguments
// with the tool's schema, and hand the parsed arguments to _call.
class StructuredTool {
  constructor(name, schema) { this.name = name; this.schema = schema; this.executed = []; }
  async invoke(input, config) { return this.call(isToolCall(input) ? input.args : input, config); }
  async call(arg) {
    const raw = isToolCall(arg) ? arg.args : arg;
    const parsed = this.schema ? await this.schema.parseAsync(raw) : raw;
    return this._call(parsed);
  }
  async _call(args) { this.executed.push(args); return `sent ${args.amount} ${args.asset}`; }
  async stream(input) { const out = await this.invoke(input); return (async function* () { yield out; })(); }
  async batch(inputs) { return Promise.all(inputs.map((i) => this.invoke(i))); }
}

const call = (args, name = "transfer") => ({ name, args, id: "call_1", type: "tool_call" });

test("a ToolCall input is checked on its args: over the cap is denied and never runs", async () => {
  const { guard, receipts } = setup();
  const tool = new StructuredTool("transfer");
  const wrapped = wrapLangGraphTool(tool, guard);
  assert.match(String(await wrapped.invoke(call({ asset: "USDC", amount: 5000 }))), /Denied.*max_per_action/);
  assert.match(String(await wrapped.call(call({ asset: "USDC", amount: 5000 }))), /Denied.*max_per_action/);
  const chunks = [];
  for await (const c of await wrapped.stream(call({ asset: "USDC", amount: 5000 }))) chunks.push(c);
  assert.match(String(chunks.join("")), /Denied/);
  assert.deepEqual(tool.executed, [], "the over-limit transfer never ran");
  for (const r of receipts) {
    assert.equal(r.payload.realtime_result, "deny");
    assert.equal(r.payload.intent.amount, 5000);
    assert.deepEqual(r.payload.intent.params, { asset: "USDC", amount: 5000 });
  }
});

test("a ToolCall within the cap runs once, and its receipt records the real arguments", async () => {
  const { guard, receipts } = setup();
  const tool = new StructuredTool("transfer");
  const wrapped = wrapLangGraphTool(tool, guard);
  assert.equal(await wrapped.invoke(call({ asset: "USDC", amount: 500 })), "sent 500 USDC");
  assert.deepEqual(tool.executed, [{ asset: "USDC", amount: 500 }]);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].payload.realtime_result, "allow");
  assert.equal(receipts[0].payload.intent.amount, 500);
});

test("a ToolCall naming a different tool is denied and never runs", async () => {
  const { guard } = setup();
  const tool = new StructuredTool("transfer");
  const wrapped = wrapLangGraphTool(tool, guard);
  assert.match(String(await wrapped.invoke(call({ asset: "USDC", amount: 1 }, "lookup"))), /Denied.*lookup/);
  assert.match(String(await wrapped.call(call({ asset: "USDC", amount: 1 }, "lookup"))), /Denied/);
  assert.deepEqual(tool.executed, []);
});

test("batch checks each ToolCall's args and runs only the allowed ones", async () => {
  const { guard } = setup();
  const tool = new StructuredTool("transfer");
  const wrapped = wrapLangGraphTool(tool, guard);
  const out = await wrapped.batch([call({ asset: "USDC", amount: 5000 }), call({ asset: "USDC", amount: 10 })]);
  assert.match(String(out[0]), /Denied/);
  assert.equal(out[1], "sent 10 USDC");
  assert.deepEqual(tool.executed, [{ asset: "USDC", amount: 10 }]);
});

test("the check sees the arguments after the tool's own schema parsing", async () => {
  const { guard } = setup();
  // A schema that turns a string amount into a number, as z.coerce.number() does.
  const schema = { parseAsync: async (v) => ({ ...v, amount: Number(v.amount) }) };
  const tool = new StructuredTool("transfer", schema);
  const wrapped = wrapLangGraphTool(tool, guard);
  assert.match(String(await wrapped.invoke(call({ asset: "USDC", amount: "5000" }))), /Denied.*max_per_action/);
  assert.match(String(await wrapped.invoke({ asset: "USDC", amount: "5000" })), /Denied.*max_per_action/);
  assert.deepEqual(tool.executed, []);
  assert.equal(await wrapped.invoke({ asset: "USDC", amount: "20" }), "sent 20 USDC");
});
