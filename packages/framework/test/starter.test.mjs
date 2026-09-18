import { test } from "node:test";
import assert from "node:assert/strict";
import { createToolGuard, generateAgentKey, starterToolPolicy } from "../dist/index.js";

test("generateAgentKey + starterToolPolicy produce a working guard", async () => {
  const key = generateAgentKey();
  assert.match(key, /BEGIN PRIVATE KEY/);
  const policy = starterToolPolicy(["search", "read"]);
  const guard = createToolGuard({ policy, agentKeyPem: key });

  assert.equal((await guard.check("search", { q: "x" })).allowed, true);
  assert.equal((await guard.check("read", { path: "a" })).allowed, true);
  const denied = await guard.check("delete_all", {});
  assert.equal(denied.allowed, false);
  assert.match(denied.reason, /not allowlisted/);
});

test("starterToolPolicy maps tool names to tool.<name> action types", () => {
  const policy = starterToolPolicy(["send_email"]);
  assert.deepEqual(policy.clauses[0].action_types, ["tool.send_email"]);
});
