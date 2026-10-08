// The framework adapters must leave no unguarded path: a Vercel tool without execute is refused
// like guardedTool refuses it, and every way a LangChain-style tool can be run checks policy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createToolGuard, wrapVercelTools, wrapLangGraphTool, guardedTool, starterToolPolicy, generateAgentKey } from "../dist/index.js";

const guard = () => createToolGuard({ policy: starterToolPolicy(["allowed_tool"]), agentKeyPem: generateAgentKey() });

test("wrapVercelTools refuses a tool without execute, as guardedTool does", () => {
  assert.throws(() => wrapVercelTools({ client_side: { description: "runs in the app" } }, guard()), /no execute/);
  assert.throws(() => guardedTool({ name: "client_side" }, guard()), /no execute/);
  const ok = wrapVercelTools({ allowed_tool: { execute: async () => "ran" } }, guard());
  assert.equal(typeof ok.allowed_tool.execute, "function");
});

class Tool {
  constructor(name) { this.name = name; this.ran = 0; }
  async _call() { this.ran++; return "ran"; }
  async call(i) { return this._call(i); }
  async invoke(i) { return this.call(i); }
  async stream(i) { const out = await this._call(i); return (async function* () { yield out; })(); }
  async batch(inputs) { return Promise.all(inputs.map((i) => this.invoke(i))); }
}

test("wrapLangGraphTool checks policy on invoke, call, _call, stream and batch", async () => {
  const tool = new Tool("denied_tool");
  const wrapped = wrapLangGraphTool(tool, guard());
  assert.match(String(await wrapped.invoke({ a: 1 })), /Denied/);
  assert.match(String(await wrapped.call({ a: 1 })), /Denied/);
  assert.match(String(await wrapped._call({ a: 1 })), /Denied/);
  const chunks = [];
  for await (const c of await wrapped.stream({ a: 1 })) chunks.push(c);
  assert.match(String(chunks.join("")), /Denied/);
  const batch = await wrapped.batch([{ a: 1 }, { a: 2 }]);
  assert.equal(batch.length, 2);
  for (const r of batch) assert.match(String(r), /Denied/);
  assert.equal(tool.ran, 0, "the denied tool never ran");
});

test("wrapLangGraphTool guards a DynamicTool-style func, and lets an allowed tool run once per call", async () => {
  let ran = 0;
  const dyn = { name: "denied_tool", func: async () => { ran++; return "ran"; }, invoke: async function (i) { return this.func(i); } };
  const wrapped = wrapLangGraphTool(dyn, guard());
  assert.match(String(await wrapped.func({ a: 1 })), /Denied/);
  assert.match(String(await wrapped.invoke({ a: 1 })), /Denied/);
  assert.equal(ran, 0);
  const allowed = new Tool("allowed_tool");
  const ok = wrapLangGraphTool(allowed, guard());
  assert.equal(await ok.invoke({ a: 1 }), "ran");
  assert.equal(await ok.call({ a: 1 }), "ran");
  assert.equal(allowed.ran, 2);
  assert.equal(ok.name, "allowed_tool");
  assert.ok(ok instanceof Tool, "the wrapper still presents the tool instance");
});
