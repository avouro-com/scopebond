// The HTTP executor resolves a host name before it sends anything when an enforced endpoint_denylist lists an address. A
// lookup that fails or finds nothing happens before any connection: the action is recorded as failed (no external effect),
// never as an unknown outcome. A resolver may answer with a scoped IPv6 address (`fe80::1%eth0`, as getaddrinfo can for a
// LAN name): the zone index does not make the address unreadable, so it is compared like any other address and refused
// only when the denylist covers it, with that clause as the reason.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGateway, createHttpExecutor, StaticPrincipalKeyRegistry } from "../dist/index.js";
import { createSigner } from "@scopebond/sdk";

const policyWith = (hosts) => ({ vocabulary_version: "1.0", policy_id: "deny", version: 1, clauses: [
  { id: "no-internal", type: "endpoint_denylist", mode: "enforce", hosts },
] });

function gatewayWith(lookup, hosts = ["localhost", "169.254.169.254"]) {
  const calls = [];
  const fetch = async (url) => { calls.push(String(url)); return { status: 200, text: async () => "ok" }; };
  const agent = createSigner();
  const keys = new StaticPrincipalKeyRegistry([{ kid: agent.kid, publicKeyPem: agent.publicKeyPem, purposes: ["agent"], status: "active" }]);
  const gw = createGateway({ policy: policyWith(hosts), authentication: { keys }, executor: createHttpExecutor({ fetch, lookup }) });
  return { agent, gw, calls };
}

const call = (host) => ({ action_type: "http.call", params: { host, path: "/status", method: "GET" } });

/** What the executor itself throws for a call to `host` under `hosts` (null when it sends the call). */
async function executorRefusal(lookup, host, hosts) {
  const executor = createHttpExecutor({ fetch: async () => ({ status: 200, text: async () => "ok" }), lookup });
  try { await executor.execute(call(host), { actionId: "action:resolution", policy: policyWith(hosts) }); return null; }
  catch (error) { return error; }
}

test("a name that does not resolve is recorded as failed: nothing was sent", async () => {
  const notFound = gatewayWith(async (name) => { throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${name}`), { code: "ENOTFOUND" }); });
  const r = await notFound.gw.handleAction(notFound.agent.sign(call("api.example.test")));
  assert.equal(notFound.calls.length, 0);
  assert.equal(r.allowed, true);
  assert.equal(r.receipt.payload.execution.state, "failed", "a lookup that failed before any connection had no external effect");

  const empty = gatewayWith(async () => []);
  const r2 = await empty.gw.handleAction(empty.agent.sign(call("api.example.test")));
  assert.equal(empty.calls.length, 0);
  assert.equal(r2.receipt.payload.execution.state, "failed", "an empty answer is a failed lookup, not an unknown outcome");

  const refusal = await executorRefusal(async () => { throw Object.assign(new Error("queryA ETIMEOUT"), { code: "ETIMEOUT" }); }, "api.example.test", ["localhost"]);
  assert.equal(refusal?.name, "ExecutorInputError");
  assert.match(refusal.message, /api\.example\.test did not resolve \(ETIMEOUT\); nothing was sent/);
});

test("a LAN name with a scoped link-local IPv6 address is sent when the denylist does not cover that address", async () => {
  for (const zoned of ["fe80::1%11", "fe80::1%eth0", "FE80::1%en0"]) {
    const { agent, gw, calls } = gatewayWith(async () => [{ address: "192.0.2.10", family: 4 }, { address: zoned, family: 6 }]);
    const r = await gw.handleAction(agent.sign(call("nas.example.test")));
    assert.equal(r.allowed, true, zoned);
    assert.equal(r.receipt.payload.execution.state, "executed", `${zoned}: neither 192.0.2.10 nor fe80::1 is on the denylist`);
    assert.deepEqual(calls, ["https://nas.example.test/status"], zoned);
  }
});

test("a scoped address the denylist covers is still refused, and the reason names the address and the clause", async () => {
  const lan = async () => [{ address: "192.0.2.10", family: 4 }, { address: "fe80::1%eth0", family: 6 }];
  const denied = gatewayWith(lan, ["[fe80::1]"]);
  const r = await denied.gw.handleAction(denied.agent.sign(call("nas.example.test")));
  assert.equal(denied.calls.length, 0);
  assert.equal(r.receipt.payload.execution.state, "failed");
  const refusal = await executorRefusal(lan, "nas.example.test", ["[fe80::1]"]);
  assert.equal(refusal?.name, "ExecutorInputError");
  assert.match(refusal.message, /resolves to fe80::1%eth0, which endpoint_denylist clause no-internal denies/);
  // A scoped loopback address is loopback: a denied loopback name covers it.
  const loop = await executorRefusal(async () => [{ address: "::1%lo", family: 6 }], "alias.example.test", ["localhost"]);
  assert.match(loop?.message ?? "", /resolves to ::1%lo, which endpoint_denylist clause no-internal denies/);
});

test("an answer that is not an address is refused as unreadable, not as a denied address", async () => {
  const refusal = await executorRefusal(async () => [{ address: "not an address", family: 4 }], "odd.example.test", ["localhost"]);
  assert.equal(refusal?.name, "ExecutorInputError");
  assert.match(refusal.message, /odd\.example\.test resolved to an address that cannot be checked/);
  assert.doesNotMatch(refusal.message, /endpoint_denylist clause/);
});
