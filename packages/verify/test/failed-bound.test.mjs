// A violated verdict names the clause that matched (`clause_id`) and the bound that failed (`failed_bound`): a short
// machine string `<param>:<bound>` that names the param and the bound, never the param's value. Receipts carry both, so a
// reader does not have to work the rule out again from its own copy of the policy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { canonical } from "@scopebond/policy-schema/canonical";
import { verifyReceiptSignature } from "../dist/signature.js";
import { violatesBoth as violates } from "./bounded.mjs";

const at = "2026-09-12T12:00:00Z";
const valid = (clauses) => ({ vocabulary_version: "1.0", policy_id: "test", version: 1, clauses });
const action = (action_type, params = {}, extra = {}) => ({ intent: { action_type, params, ...extra }, executed: true, timestamp: at, intent_hash: "h" });
const safeShell = (mode) => ({ id: "safe-shell", type: "action_allowlist", mode, action_types: ["shell.exec"], param_bounds: { program: { pattern: "^(?!rm$).+" } } });

test("a denied rm names safe-shell and the program pattern, never the program itself", () => {
  const v = violates(valid([safeShell("enforce")]), [], action("shell.exec", { program: "rm", args: ["-rf", "/"] }));
  assert.equal(v.violated, true);
  assert.equal(v.clause_id, "safe-shell");
  assert.equal(v.failed_bound, "program:pattern");
});

test("a monitored rm names the same clause and bound", () => {
  const v = violates(valid([safeShell("monitor")]), [], action("shell.exec", { program: "rm" }));
  assert.equal(v.clause_id, "safe-shell");
  assert.equal(v.failed_bound, "program:pattern");
});

test("an allowed action names neither", () => {
  const v = violates(valid([safeShell("enforce")]), [], action("shell.exec", { program: "ls" }));
  assert.equal(v.violated, false);
  assert.equal(v.clause_id, null);
  assert.equal(v.failed_bound, undefined);
});

test("several monitored matches: the first clause by policy order is named", () => {
  const read = { id: "protect-read", type: "action_allowlist", mode: "monitor", action_types: ["file.read"], param_bounds: { path: { pattern: "^(?!\\.env$).+" } } };
  const hours = { id: "hours", type: "time_window", mode: "monitor", start: "00:00", end: "01:00" };
  const other = { id: "net", type: "action_allowlist", mode: "monitor", action_types: ["http.call"] };
  for (const clauses of [[hours, read, other], [read, hours, other]]) {
    const v = violates(valid(clauses), [], action("file.read", { path: ".env" }));
    assert.equal(v.clause_id, clauses[0].id);
  }
  // An action no allowlist lists is checked against the allowlists first, but `hours` comes first in the policy.
  const first = violates(valid([hours, read, other]), [], action("shell.exec", { program: "ls" }));
  assert.equal(first.clause_id, "hours");
  assert.equal(first.failed_bound, "timestamp:hours");
  const listed = violates(valid([other, hours, read]), [], action("shell.exec", { program: "ls" }));
  assert.equal(listed.clause_id, "net");
  assert.equal(listed.failed_bound, "action_type:action_types");
});

test("an enforced match still wins over an earlier monitored one", () => {
  const v = violates(valid([{ ...safeShell("monitor"), id: "watch" }, safeShell("enforce")]), [], action("shell.exec", { program: "rm" }));
  assert.equal(v.clause_id, "safe-shell");
});

test("every clause type names the param and bound that failed", () => {
  const cases = [
    [{ id: "c", type: "action_allowlist", action_types: ["git.push"], param_bounds: { ref: { pattern: "^(?!main$).+" } } }, action("git.push", { ref: "main" }), "ref:pattern"],
    [{ id: "c", type: "action_allowlist", action_types: ["x.y"], param_bounds: { size: { enum: [1, 2] } } }, action("x.y", { size: 3 }), "size:enum"],
    [{ id: "c", type: "action_allowlist", action_types: ["x.y"], param_bounds: { size: { min: 2 } } }, action("x.y", { size: 1 }), "size:min"],
    [{ id: "c", type: "action_allowlist", action_types: ["x.y"], param_bounds: { size: { max: 2 } } }, action("x.y", { size: 3 }), "size:max"],
    [{ id: "c", type: "action_allowlist", action_types: ["x.y"], param_bounds: { size: { max: 2 } } }, action("x.y", { size: "big" }), "size:type"],
    [{ id: "c", type: "action_allowlist", action_types: ["x.y"], param_bounds: { paths: { items: { pattern: "^src/" } } } }, action("x.y", { paths: ["etc/x"] }), "paths:items"],
    [{ id: "c", type: "action_allowlist", action_types: ["x.y"], param_bounds: { paths: { items: { pattern: "^src/" } } } }, action("x.y", { paths: "src/a" }), "paths:type"],
    [{ id: "c", type: "spend_limit", asset: "USDC", max_per_action: 10 }, action("pay", {}, { asset: "USDC", amount: 11 }), "amount:max_per_action"],
    [{ id: "c", type: "rate_limit", action_types: ["x.y"], max_count: 0, window: "P1D" }, action("x.y"), "action_type:max_count"],
    [{ id: "c", type: "require_approval", action_types: ["x.y"], approvers: ["a"] }, action("x.y"), "approval:approvers"],
    [{ id: "c", type: "time_window", start: "00:00", end: "01:00" }, action("x.y"), "timestamp:hours"],
    [{ id: "c", type: "time_window", days: ["Mon"], start: "00:00", end: "23:59" }, action("x.y"), "timestamp:days"],
    [{ id: "c", type: "endpoint_allowlist", hosts: ["a.example"] }, action("http.call", { host: "b.example", path: "/" }), "host:hosts"],
    [{ id: "c", type: "endpoint_allowlist", hosts: ["a.example"], paths: ["/ok"] }, action("http.call", { host: "a.example", path: "/no" }), "path:paths"],
    [{ id: "c", type: "endpoint_allowlist", hosts: ["a.example"], methods: ["GET"] }, action("http.call", { host: "a.example", path: "/", method: "POST" }), "method:methods"],
    [{ id: "c", type: "endpoint_denylist", hosts: ["a.example"] }, action("http.call", { host: "a.example", path: "/" }), "host:hosts"],
    [{ id: "c", type: "address_allowlist", addresses: ["0xa"] }, action("tx", { to: "0xb" }), "to:addresses"],
    [{ id: "c", type: "address_denylist", addresses: ["0xa"] }, action("tx", { to: "0xa" }), "to:addresses"],
    [{ id: "c", type: "contract_allowlist", contracts: ["0xa"] }, action("tx", { contract: "0xb" }), "contract:contracts"],
    [{ id: "c", type: "contract_allowlist", contracts: ["0xa"], selectors: ["0x1"] }, action("tx", { contract: "0xa", selector: "0x2" }), "selector:selectors"],
    [{ id: "c", type: "key_policy", active_keys: ["k1"] }, action("x.y", {}, { signer: "k2" }), "signer:active_keys"],
    [{ id: "c", type: "force_push_guard" }, action("git.push", { ref: "main", force: true }), "ref:protected_refs"],
  ];
  for (const [clause, claimed, bound] of cases) {
    const v = violates(valid([clause]), [], claimed);
    assert.equal(v.violated, true, `${clause.type} ${bound}`);
    assert.equal(v.clause_id, "c", `${clause.type} ${bound}`);
    assert.equal(v.failed_bound, bound, `${clause.type}`);
    assert.match(v.failed_bound, /^[A-Za-z0-9_.-]{1,64}:[a-z_]{1,32}$/);
  }
});

test("a verdict that names no clause names no bound", () => {
  const uncovered = violates(valid([{ id: "keys", type: "key_policy", active_keys: ["k1"] }]), [], action("file.read", { path: "a" }));
  assert.equal(uncovered.violated, true);
  assert.equal(uncovered.clause_id, null);
  assert.equal(uncovered.failed_bound, undefined);
});

// A receipt signed the way the gateway signs: Ed25519 over the RFC 8785 canonical payload.
function signed(extra) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" });
  const kid = "key:" + createHash("sha256").update(canonical({ crv: jwk.crv, kty: jwk.kty, x: jwk.x })).digest("hex").slice(0, 16);
  const payload = { evidence_version: "1.0", attester: { kind: "gateway", kid }, intent: { action_type: "shell.exec", params: { program: "rm" } }, realtime_result: "deny", ...extra };
  const sig = sign(null, Buffer.from(canonical(payload)), privateKey).toString("base64");
  return { receipt: { payload, signature: { alg: "Ed25519", sig } }, pem: publicKey.export({ type: "spki", format: "pem" }).toString() };
}

test("receipts with and without clause_id and failed_bound verify; the fields are covered by the signature", async () => {
  const old = signed({});
  assert.equal((await verifyReceiptSignature(old.receipt, old.pem)).valid, true, "a receipt without the fields still verifies");
  const named = signed({ clause_id: "safe-shell", failed_bound: "program:pattern" });
  assert.equal((await verifyReceiptSignature(named.receipt, named.pem)).valid, true);
  const tampered = structuredClone(named.receipt);
  tampered.payload.clause_id = "protect-read";
  assert.equal((await verifyReceiptSignature(tampered, named.pem)).valid, false);
});

test("a prior receipt that carries the fields evaluates like one that does not", () => {
  const policy = valid([{ id: "rl", type: "rate_limit", action_types: ["x.y"], max_count: 2, window: "P1D" }]);
  const prior = { ...action("x.y"), timestamp: "2026-09-12T11:00:00Z", action_id: "action:000000000000001" };
  const claimed = { ...action("x.y"), action_id: "action:000000000000002" };
  const plain = violates(policy, [prior], claimed);
  const named = violates(policy, [{ payload: { ...prior, clause_id: "rl", failed_bound: "action_type:max_count" } }], claimed);
  assert.equal(plain.violated, false);
  assert.equal(named.violated, plain.violated);
});
