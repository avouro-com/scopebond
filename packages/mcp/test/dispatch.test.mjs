import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { budgetDigest, defaultBudgetTemplate, deriveKid, requestHash, signDispatchApproval, StaticPrincipalKeyRegistry, scopeDigest } from "@scopebond/gateway";
import { createDispatchGuard, DispatchStore } from "@scopebond/gateway/node";
import { createMcpProxy } from "../dist/index.js";

const policy = { vocabulary_version: "1.0", policy_id: "mcp", version: 1, clauses: [{ id: "any", type: "action_allowlist", mode: "enforce", action_types: ["mcp.tool.call"] }] };
const keyPem = () => generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const call = (id, args = {}) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "deploy", arguments: args } });
const dir = () => mkdtempSync(join(tmpdir(), "sb-mcp-dispatch-"));
const SUBJECT = "client:c7";

function setup(guardConfig, extra = {}) {
  const calls = [];
  const upstream = { call: async (m) => { calls.push(m); return { jsonrpc: "2.0", id: m.id ?? null, result: { ok: true } }; } };
  const guard = createDispatchGuard({ dbPath: join(dir(), "d.db"), ...guardConfig });
  const proxy = createMcpProxy({ policy, principal: { subject: SUBJECT, issuer: "scopebond:mcp-proxy" }, server: "ops", attesterKeyPem: keyPem(), upstream, dispatch: { guard, ...extra } });
  return { calls, guard, proxy };
}

function budget(max, over = {}) {
  const b = { ...defaultBudgetTemplate(SUBJECT, ["mcp.tool.call"]), max, window_seconds: 3600, mode: "enforce", expires_at: "2099-01-01T00:00:00.000Z", ...over };
  b.acknowledgement = { digest: budgetDigest(b), acknowledged_at: new Date().toISOString() };
  return b;
}

test("an over-budget tools/call is answered with an error and never forwarded; a retry of the same request is not a new dispatch", async () => {
  const { calls, proxy } = setup({ budgets: () => [budget(2)] });
  assert.ok((await proxy.handle(call(1, { a: 1 }))).result);
  assert.ok((await proxy.handle(call(1, { a: 1 }))).result, "same transport request retried");
  assert.ok((await proxy.handle(call(2, { a: 2 }))).result);
  const over = await proxy.handle(call(3, { a: 3 }));
  assert.match(over.error.message, /budget_exceeded/);
  assert.equal(calls.length, 3, "the refused call never reached the upstream (the retry did, and did not consume a slot)");
});

test("a tool error after dispatch still consumes its slot", async () => {
  const calls = [];
  const upstream = { call: async (m) => { calls.push(m); return { jsonrpc: "2.0", id: m.id, result: { isError: true } }; } };
  const guard = createDispatchGuard({ dbPath: join(dir(), "d.db"), budgets: () => [budget(1)] });
  const proxy = createMcpProxy({ policy, principal: { subject: SUBJECT, issuer: "x" }, server: "ops", attesterKeyPem: keyPem(), upstream, dispatch: { guard } });
  await proxy.handle(call(1));
  assert.match((await proxy.handle(call(2))).error.message, /budget_exceeded/);
  assert.equal(calls.length, 1);
});

test("a single-use approval is bound to the exact forwarded request and consumed once", async () => {
  const approver = { ...generateKeyPairSync("ed25519") };
  const publicKeyPem = approver.publicKey.export({ type: "spki", format: "pem" }).toString();
  const raw = approver.publicKey.export({ format: "jwk" });
  const kid = deriveKid({ crv: raw.crv, kty: raw.kty, x: raw.x });
  const inbox = [];
  const { calls, proxy } = setup({
    keys: new StaticPrincipalKeyRegistry([{ kid, publicKeyPem, purposes: ["approver"], status: "active" }]), requireApproval: ["mcp.tool.call"], approvals: () => inbox,
  });
  const message = call(1, { target: "prod" });
  const request = { server: "ops", method: "tools/call", params: message.params };
  const digestOfPolicy = (await import("node:crypto")).createHash("sha256");
  const { canonical } = await import("@scopebond/gateway");
  digestOfPolicy.update(canonical(policy));
  const now = Date.now();
  const approval = signDispatchApproval(approver.privateKey, {
    version: "1.0", approval_id: "approval:mcp-once-0001", approver: { kid, alg: "Ed25519" }, actor: SUBJECT, action_type: "mcp.tool.call", target: "ops/deploy",
    policy_digest: digestOfPolicy.digest("hex"), request_hash: requestHash(request), issued_at: new Date(now).toISOString(), expires_at: new Date(now + 120_000).toISOString(),
  });
  assert.match((await proxy.handle(message)).error.message, /approval_required/);
  inbox.push(approval);
  assert.ok((await proxy.handle(message)).result, "the exact approved request is forwarded");
  assert.match((await proxy.handle(call(2, { target: "prod" }))).error.message, /approval_replayed/);
  inbox.length = 0; inbox.push({ ...approval, approval_id: "approval:mcp-other-001" });
  assert.match((await proxy.handle(call(3, { target: "staging" }))).error.message, /approval_rejected/, "a changed argument is a changed request");
  assert.equal(calls.length, 1, "the upstream saw exactly the one approved dispatch");
});

test("a delegated proxy is bounded by its delegation and refused when it is revoked", async () => {
  const path = join(dir(), "d.db");
  const store = new DispatchStore(path);
  const scope = { action_types: ["mcp.tool.call"], targets: ["ops/read_*"] };
  const now = Date.now();
  store.addDelegation({ delegation_id: "deleg:mcp-child-001", parent_id: null, actor: SUBJECT, scope, scope_digest: scopeDigest(scope), issued_at: new Date(now).toISOString(), expires_at: new Date(now + 3_600_000).toISOString() });
  const calls = [];
  const upstream = { call: async (m) => { calls.push(m); return { jsonrpc: "2.0", id: m.id, result: { ok: true } }; } };
  const guard = createDispatchGuard({ dbPath: path });
  const proxy = createMcpProxy({ policy, principal: { subject: SUBJECT, issuer: "x" }, server: "ops", attesterKeyPem: keyPem(), upstream, dispatch: { guard, delegationId: "deleg:mcp-child-001" } });
  assert.ok((await proxy.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_file", arguments: {} } })).result);
  assert.match((await proxy.handle(call(2))).error.message, /delegation_out_of_scope/);
  store.revoke("deleg:mcp-child-001");
  assert.match((await proxy.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "read_file", arguments: {} } })).error.message, /delegation_revoked/);
  assert.equal(calls.length, 1);
  store.close();
});
