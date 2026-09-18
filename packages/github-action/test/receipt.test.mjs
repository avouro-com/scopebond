import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluatePullRequest, buildPullRequestReceipt } from "../dist/index.js";
import { verifyReceipt } from "@scopebond/gateway";
import { generateKeyPairSync, createPublicKey } from "node:crypto";

const policy = {
  vocabulary_version: "1.0", policy_id: "gh", version: 1,
  clauses: [{ id: "no-prod", type: "action_allowlist", mode: "enforce", action_types: ["pr.merge"], param_bounds: { paths: { items: { pattern: "^(?!infra/prod/).*" }, match: "all" } } }],
};
const ctx = (over) => ({
  event: "pull_request", repo: "acme/app", base: "main", head: "agent/x", headSha: "0f1e2d3c4b5a6978",
  paths: [], filesChanged: 1, additions: 1, deletions: 0, actor: "copilot-swe-agent[bot]", ...over,
});
const keyPem = () => generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();

test("a denied PR yields a signed boundary receipt that verifies, with the deny recorded", async () => {
  const pem = keyPem();
  const c = ctx({ paths: ["infra/prod/main.tf"] });
  const decision = evaluatePullRequest(c, policy);
  assert.equal(decision.decision, "deny");
  const receipt = await buildPullRequestReceipt(c, policy, decision, pem);

  // Verify against the signing key's own public half.
  const pub = createPublicKey(pem).export({ type: "spki", format: "pem" }).toString();
  const v = verifyReceipt(receipt, pub);
  assert.equal(v.valid, true);
  assert.equal(v.evidence_class, "boundary");
  assert.equal(receipt.payload.boundary.gate, "merge");
  assert.equal(receipt.payload.boundary.outcome_ref, "0f1e2d3c4b5a6978");
  assert.deepEqual(receipt.payload.boundary.attribution, { kind: "asserted", actor: "copilot-swe-agent[bot]" });
  assert.equal(receipt.payload.realtime_result, "deny");
  assert.equal(receipt.payload.executed, false);
});

test("an allowed PR yields a boundary receipt recording a cooperative allow", async () => {
  const pem = keyPem();
  const c = ctx({ paths: ["docs/readme.md"] });
  const decision = evaluatePullRequest(c, policy);
  assert.equal(decision.decision, "allow");
  const receipt = await buildPullRequestReceipt(c, policy, decision, pem);
  assert.equal(receipt.payload.execution.state, "cooperative_allow");
  assert.equal(receipt.payload.evidence_class, "boundary");
});

test("a not_evaluated (human) PR emits no receipt", async () => {
  const pem = keyPem();
  const c = ctx({ actor: "a-human-dev", paths: ["infra/prod/x"] });
  const decision = evaluatePullRequest(c, policy);
  assert.equal(decision.decision, "not_evaluated");
  await assert.rejects(() => buildPullRequestReceipt(c, policy, decision, pem), /attribution|no receipt/);
});
