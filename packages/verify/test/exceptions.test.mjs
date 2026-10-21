// An action_allowlist clause may carry `exceptions`: sets of field bounds that excuse an action from the clause's own bounds.
// An action that meets every bound of one set is not checked against `param_bounds`; the clause still covers its type. A field
// an exception names that the action does not carry never meets it (fail closed), and nothing else is excused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { validatePolicy } from "../dist/violates.js";
import { violatesBoth as violates } from "./bounded.mjs";

const policy = (clause) => ({ vocabulary_version: "1.0", policy_id: "test", version: 1, clauses: [clause] });
const act = (action_type, params) => ({ intent: { action_type, params }, executed: true, realtime_result: "allow", timestamp: "2026-10-21T12:00:00Z", attester: { kind: "gateway", kid: "g1" } });
const destructive = {
  id: "cloud-destructive", type: "action_allowlist", mode: "enforce", action_types: ["k8s.delete", "cloud.resource.delete"],
  param_bounds: { risk_class: { pattern: "^(?!destructive$).+" } },
};

test("an action that meets every bound of one exception is excused from the clause's bounds", () => {
  const p = policy({ ...destructive, exceptions: [{ context: { pattern: "^(?:kind-.+|minikube)$" } }] });
  assert.equal(validatePolicy(p).valid, true, JSON.stringify(validatePolicy(p).errors));
  assert.equal(violates(p, [], act("k8s.delete", { context: "kind-dev", risk_class: "destructive" })).violated, false);
  assert.equal(violates(p, [], act("k8s.delete", { context: "minikube", risk_class: "destructive" })).violated, false);
  const prod = violates(p, [], act("k8s.delete", { context: "prod-cluster", risk_class: "destructive" }));
  assert.equal(prod.violated, true);
  assert.equal(prod.clause_id, "cloud-destructive");
  assert.equal(prod.failed_bound, "risk_class:pattern");
});

test("a field the action does not carry never meets an exception", () => {
  const p = policy({ ...destructive, exceptions: [{ context: { pattern: "^kind-.+$" } }] });
  assert.equal(violates(p, [], act("cloud.resource.delete", { risk_class: "destructive" })).violated, true);
  assert.equal(violates(p, [], act("k8s.delete", { context: 7, risk_class: "destructive" })).violated, true);
});

test("every bound of an exception must hold; any one exception is enough", () => {
  const p = policy({ ...destructive, exceptions: [
    { context: { pattern: "^kind-.+$" }, namespace: { enum: ["dev"] } },
    { context: { enum: ["docker-desktop"] } },
  ] });
  assert.equal(violates(p, [], act("k8s.delete", { context: "kind-a", namespace: "dev", risk_class: "destructive" })).violated, false);
  assert.equal(violates(p, [], act("k8s.delete", { context: "kind-a", namespace: "prod", risk_class: "destructive" })).violated, true);
  assert.equal(violates(p, [], act("k8s.delete", { context: "docker-desktop", risk_class: "destructive" })).violated, false);
});

test("an array bound in an exception: every element must match, and an empty or absent list never does", () => {
  const p = policy({
    id: "safe-shell", type: "action_allowlist", mode: "enforce", action_types: ["shell.exec"], param_bounds: { program_scope: { pattern: "^(?!rm$).+" } },
    exceptions: [{ program: { pattern: "^rm$" }, delete_targets: { items: { pattern: "^/tmp/scratch/.+$" }, match: "all" } }],
  });
  assert.equal(validatePolicy(p).valid, true);
  assert.equal(violates(p, [], act("shell.exec", { program: "rm", program_scope: "rm", delete_targets: ["/tmp/scratch/a", "/tmp/scratch/b"] })).violated, false);
  assert.equal(violates(p, [], act("shell.exec", { program: "rm", program_scope: "rm", delete_targets: ["/tmp/scratch/a", "/etc"] })).violated, true);
  assert.equal(violates(p, [], act("shell.exec", { program: "rm", program_scope: "rm", delete_targets: [] })).violated, true);
  assert.equal(violates(p, [], act("shell.exec", { program: "rm", program_scope: "rm" })).violated, true);
});

test("exceptions are checked like bounds when the policy is validated", () => {
  const bad = (exceptions) => validatePolicy(policy({ ...destructive, exceptions })).valid;
  assert.equal(bad([]), false, "an empty list says nothing");
  assert.equal(bad([{}]), false, "an exception with no bound would excuse everything");
  assert.equal(bad([{ context: { pattern: 7 } }]), false);
  assert.equal(bad([{ context: { pattern: "(" } }]), false, "an invalid pattern is refused, never thrown from violates()");
  assert.equal(bad(Array.from({ length: 51 }, () => ({ context: { enum: ["a"] } }))), false);
  assert.equal(bad([{ context: { enum: ["a"] } }]), true);
  assert.equal(validatePolicy(policy({ id: "x", type: "rate_limit", action_types: ["a"], max_count: 1, window: "PT1M", exceptions: [{ a: { enum: ["b"] } }] })).valid, false, "only an action allowlist takes exceptions");
});
