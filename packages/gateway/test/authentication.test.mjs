import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonical, createGateway, deriveKid, intentHash, StaticPrincipalKeyRegistry,
  verifyReceipt,
} from "../dist/index.js";
import { openReceiptStore } from "../dist/node.js";

const AT = "2026-09-13T12:00:00.000Z";
const EXP = "2026-09-13T12:05:00.000Z";
const CONTROL_TOKEN = "test-control-token-000000000001";
const policy = {
  vocabulary_version: "1.0", policy_id: "auth-policy", version: 3,
  clauses: [{ id: "actions", type: "action_allowlist", mode: "enforce", action_types: ["tool.call"] }],
};

function principal(purposes) {
  const pair = generateKeyPairSync("ed25519");
  const publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const raw = pair.publicKey.export({ format: "jwk" });
  const kid = deriveKid({ crv: raw.crv, kty: raw.kty, x: raw.x });
  return { kid, publicKeyPem, privateKey: pair.privateKey, purposes };
}

function signIntent(agent, input, overrides = {}) {
  const intent = { ...structuredClone(input), signer: agent.kid };
  const claims = {
    version: "1.0", request_id: overrides.request_id ?? "request:0000000000000001",
    issued_at: overrides.issued_at ?? AT, expires_at: overrides.expires_at ?? EXP,
    signer: { kid: agent.kid, alg: "Ed25519" }, intent_hash: intentHash(intent),
  };
  return {
    intent,
    authorization: { ...claims, signature: edSign(null, Buffer.from(canonical(claims)), agent.privateKey).toString("base64") },
  };
}

function signApproval(approver, intent, policyRef, overrides = {}) {
  const claims = {
    version: "1.0", approval_id: overrides.approval_id ?? "approval:000000000000001",
    issued_at: overrides.issued_at ?? AT, expires_at: overrides.expires_at ?? EXP,
    approver: { kid: approver.kid, alg: "Ed25519" }, intent_hash: intentHash(intent),
    policy_ref: policyRef, decision: "approve",
  };
  return { ...claims, signature: edSign(null, Buffer.from(canonical(claims)), approver.privateKey).toString("base64") };
}

function secureGateway(selectedPolicy = policy, records, extra = {}) {
  const keys = new StaticPrincipalKeyRegistry(records.map(({ privateKey: _private, ...record }) => ({ ...record, status: "active" })));
  return createGateway({ policy: selectedPolicy, now: () => AT, authentication: { keys }, ...extra });
}

const post = (app, body) => app.request("/v1/evaluate", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

test("requires an explicit authentication configuration", () => {
  assert.throws(() => createGateway({ policy }), /authentication configuration is required/);
});

test("rejects unsigned requests before execution or receipt creation", async () => {
  const agent = principal(["agent"]);
  let executions = 0;
  const gw = secureGateway(policy, [agent], { executor: { mode: "dispatch", execute: () => { executions++; return { ref: "x" }; } } });
  const response = await post(gw.app, { intent: { action_type: "tool.call", signer: agent.kid } });
  assert.equal(response.status, 401);
  assert.match((await response.json()).error, /signed intent authorization/);
  assert.equal(executions, 0);
  assert.equal((await gw.store.list()).length, 0);
});

test("accepts a registered agent signature and preserves it in the receipt", async () => {
  const agent = principal(["agent"]);
  const gw = secureGateway(policy, [agent]);
  const request = signIntent(agent, { action_type: "tool.call", params: { target: "crm" } });
  const response = await post(gw.app, request);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.receipt.payload.authorization.mode, "authenticated");
  assert.deepEqual(result.receipt.payload.authorization.agent, request.authorization);
  assert.equal(result.receipt.payload.authorization.approval, null);
  const verified = verifyReceipt(result.receipt, gw.attester.publicKeyPem, [{
    kid: agent.kid, publicKeyPem: agent.publicKeyPem, purposes: ["agent"], status: "active",
  }]);
  assert.equal(verified.valid, true);
  assert.equal(verified.authorization_valid, true);
  assert.equal(verified.fully_valid, true);

  const mismatchedPayload = structuredClone(result.receipt.payload);
  mismatchedPayload.action_ref.action_id = "request:different-action-0001";
  const mismatched = {
    payload: mismatchedPayload,
    signature: { alg: "Ed25519", sig: await gw.attester.sign(canonical(mismatchedPayload)) },
  };
  assert.equal(verifyReceipt(mismatched, gw.attester.publicKeyPem, [{
    kid: agent.kid, publicKeyPem: agent.publicKeyPem, purposes: ["agent"], status: "active",
  }]).contract_valid, false);
});

test("rejects substituted fields, signer names, and signed-envelope metadata", async () => {
  const agent = principal(["agent"]);
  const other = principal(["agent"]);
  for (const mutate of [
    (request) => { request.intent.params.target = "payments"; },
    (request) => { request.intent.signer = other.kid; },
    (request) => { request.authorization.request_id = "request:substituted00001"; },
  ]) {
    const gw = secureGateway(policy, [agent, other]);
    const request = signIntent(agent, { action_type: "tool.call", params: { target: "crm" } });
    mutate(request);
    assert.equal((await post(gw.app, request)).status, 401);
  }
});

test("rejects expired, future, and replayed authorizations", async () => {
  const agent = principal(["agent"]);
  for (const times of [
    { issued_at: "2026-09-13T11:50:00.000Z", expires_at: "2026-09-13T11:55:00.000Z" },
    { issued_at: "2026-09-13T12:01:00.000Z", expires_at: "2026-09-13T12:05:00.000Z" },
  ]) {
    const gw = secureGateway(policy, [agent]);
    assert.equal((await post(gw.app, signIntent(agent, { action_type: "tool.call" }, times))).status, 401);
  }
  const gw = secureGateway(policy, [agent]);
  const request = signIntent(agent, { action_type: "tool.call" });
  assert.equal((await post(gw.app, request)).status, 200);
  assert.equal((await post(gw.app, request)).status, 409);
  assert.equal((await gw.store.list()).length, 1);
});

test("replay rejection survives a durable store restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scopebond-auth-"));
  try {
    const agent = principal(["agent"]);
    const records = [{ kid: agent.kid, publicKeyPem: agent.publicKeyPem, purposes: ["agent"], status: "active" }];
    const request = signIntent(agent, { action_type: "tool.call" });
    const firstStore = openReceiptStore({ db: join(directory, "receipts.db") }).store;
    const first = createGateway({ policy, now: () => AT, store: firstStore, authentication: { keys: new StaticPrincipalKeyRegistry(records) } });
    assert.equal((await post(first.app, request)).status, 200);
    await firstStore.close?.();

    const secondStore = openReceiptStore({ db: join(directory, "receipts.db") }).store;
    const second = createGateway({ policy, now: () => AT, store: secondStore, authentication: { keys: new StaticPrincipalKeyRegistry(records) } });
    assert.equal((await post(second.app, request)).status, 409);
    await secondStore.close?.();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("accepts only an authenticated approval bound to this intent and active policy", async () => {
  const agent = principal(["agent"]);
  const approver = principal(["approver"]);
  const approvalPolicy = {
    vocabulary_version: "1.0", policy_id: "approvals", version: 7,
    clauses: [{ id: "review", type: "require_approval", mode: "require_approval", action_types: ["tool.call"], approvers: [approver.kid] }],
  };
  const gw = secureGateway(approvalPolicy, [agent, approver]);
  const request = signIntent(agent, { action_type: "tool.call" });
  const policyRef = { id: "approvals", version: 7, digest: gw.policyHash };
  request.approval = signApproval(approver, request.intent, policyRef);
  const allowed = await post(gw.app, request);
  assert.equal(allowed.status, 200);
  const result = await allowed.json();
  assert.equal(result.receipt.payload.realtime_result, "approved");
  assert.equal(result.receipt.payload.authorization.approval.approver.kid, approver.kid);
  const verified = verifyReceipt(result.receipt, gw.attester.publicKeyPem, [
    { kid: agent.kid, publicKeyPem: agent.publicKeyPem, purposes: ["agent"], status: "active" },
    { kid: approver.kid, publicKeyPem: approver.publicKeyPem, purposes: ["approver"], status: "active" },
  ]);
  assert.equal(verified.authorization_valid, true);
  assert.equal(verified.approval_signature_valid, true);

  const reuse = signIntent(agent, { action_type: "tool.call" }, { request_id: "request:0000000000000002" });
  reuse.approval = request.approval;
  assert.equal((await post(gw.app, reuse)).status, 409);

  const changedPolicy = secureGateway({ ...approvalPolicy, version: 8 }, [agent, approver]);
  const staleApprovalRequest = signIntent(agent, { action_type: "tool.call" }, { request_id: "request:0000000000000003" });
  staleApprovalRequest.approval = signApproval(approver, staleApprovalRequest.intent, policyRef, { approval_id: "approval:000000000000002" });
  assert.equal((await post(changedPolicy.app, staleApprovalRequest)).status, 401);
});

test("atomically consumes one approval across concurrent request ids", async () => {
  const agent = principal(["agent"]);
  const approver = principal(["approver"]);
  const approvalPolicy = {
    vocabulary_version: "1.0", policy_id: "approval-race", version: 1,
    clauses: [{ id: "review", type: "require_approval", mode: "require_approval", action_types: ["tool.call"], approvers: [approver.kid] }],
  };
  let release;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const released = new Promise((resolve) => { release = resolve; });
  let executions = 0;
  const gw = secureGateway(approvalPolicy, [agent, approver], {
    executor: {
      id: "test:approval-race", mode: "dispatch",
      execute: async () => { executions++; markStarted(); await released; return { ref: "sandbox:ok" }; },
    },
  });
  const first = signIntent(agent, { action_type: "tool.call" }, { request_id: "request:approval-race-01" });
  const second = signIntent(agent, { action_type: "tool.call" }, { request_id: "request:approval-race-02" });
  const sharedApproval = signApproval(
    approver,
    first.intent,
    { id: "approval-race", version: 1, digest: gw.policyHash },
    { approval_id: "approval:shared-race-0001" },
  );
  first.approval = sharedApproval;
  second.approval = sharedApproval;

  const firstResult = gw.handleAction(first);
  await started;
  await assert.rejects(gw.handleAction(second), /already been consumed/);
  release();
  assert.equal((await firstResult).allowed, true);
  assert.equal(executions, 1);
});

test("rejects fabricated approver names and revoked agent keys", async () => {
  const agent = principal(["agent"]);
  const approver = principal(["approver"]);
  const attacker = principal(["approver"]);
  const approvalPolicy = {
    vocabulary_version: "1.0", policy_id: "approvals", version: 1,
    clauses: [{ id: "review", type: "require_approval", mode: "require_approval", action_types: ["tool.call"], approvers: [approver.kid] }],
  };
  const gw = secureGateway(approvalPolicy, [agent, approver, attacker]);
  const request = signIntent(agent, { action_type: "tool.call" });
  const approval = signApproval(attacker, request.intent, { id: "approvals", version: 1, digest: gw.policyHash });
  approval.approver.kid = approver.kid;
  request.approval = approval;
  assert.equal((await post(gw.app, request)).status, 401);

  const revoked = new StaticPrincipalKeyRegistry([{ kid: agent.kid, publicKeyPem: agent.publicKeyPem, purposes: ["agent"], status: "revoked" }]);
  const stopped = createGateway({ policy, now: () => AT, authentication: { keys: revoked } });
  assert.equal((await post(stopped.app, signIntent(agent, { action_type: "tool.call" }))).status, 401);
});

test("a bearer-protected per-agent stop leaves other registered agents available", async () => {
  const stoppedAgent = principal(["agent"]);
  const activeAgent = principal(["agent"]);
  const gw = secureGateway(policy, [stoppedAgent, activeAgent], { control: { bearerToken: CONTROL_TOKEN } });
  assert.equal((await gw.app.request("/v1/kill", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent: stoppedAgent.kid }),
  })).status, 401);
  assert.equal((await gw.app.request("/v1/kill", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${CONTROL_TOKEN}` },
    body: JSON.stringify({ agent: stoppedAgent.kid }),
  })).status, 200);

  const stopped = await post(gw.app, signIntent(stoppedAgent, { action_type: "tool.call" }, { request_id: "request:stopped-agent-0001" }));
  const active = await post(gw.app, signIntent(activeAgent, { action_type: "tool.call" }, { request_id: "request:active-agent-00001" }));
  assert.equal(stopped.status, 403);
  assert.equal(active.status, 200);
});
