import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createToolGuard, guardExecute, guardedTool, wrapOpenAITools } from "../dist/index.js";

const edPem = () => generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const policy = {
  vocabulary_version: "1.0", policy_id: "agent", version: 1,
  clauses: [{ id: "tools", type: "action_allowlist", mode: "enforce", action_types: ["tool.search"] }],
};
const guard = () => createToolGuard({ policy, agentKeyPem: edPem() });

test("guardExecute runs an allowed function and blocks a denied one", async () => {
  const g = guard();
  const search = guardExecute("search", async (args) => `found ${args.q}`, g);
  const del = guardExecute("delete_all", async () => "gone", g);
  assert.equal(await search({ q: "x" }), "found x");
  assert.match(String(await del({})), /Denied by Scopebond policy/);
});

test("guardedTool wraps a { name, execute } tool and preserves other fields", async () => {
  const g = guard();
  let ran = 0;
  const tool = { name: "search", description: "search the web", execute: async (a) => { ran += 1; return a.q; } };
  const guarded = guardedTool(tool, g);
  assert.equal(guarded.description, "search the web");
  assert.equal(await guarded.execute({ q: "hi" }), "hi");
  assert.equal(ran, 1);
});

test("wrapOpenAITools guards each tool in an array", async () => {
  const g = guard();
  const ran = [];
  const tools = [
    { name: "search", execute: async (a) => { ran.push("search"); return a.q; } },
    { name: "delete_all", execute: async () => { ran.push("delete_all"); return "gone"; } },
  ];
  const wrapped = wrapOpenAITools(tools, g);
  assert.equal(await wrapped[0].execute({ q: "x" }), "x");
  assert.match(String(await wrapped[1].execute({})), /Denied by Scopebond policy/);
  assert.deepEqual(ran, ["search"], "the denied tool never ran");
});

test("onDenied customizes the denial value", async () => {
  const g = guard();
  const del = guardExecute("delete_all", async () => "gone", g, { onDenied: (name, reason) => ({ blocked: name, reason }) });
  const r = await del({});
  assert.equal(r.blocked, "delete_all");
  assert.match(r.reason, /not allowlisted/);
});
