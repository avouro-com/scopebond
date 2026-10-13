import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  createAttester, createGateway, verifyReceipt, validateEvidencePayload, validateReceiptContext, RECEIPT_CONTEXT_KEYS,
} from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(join(here, "../../policy-schema/vectors/evidence-contract.json"), "utf8")).receipt_context;
const policy = {
  vocabulary_version: "1.0", policy_id: "context-test", version: 1,
  clauses: [{ id: "actions", type: "action_allowlist", mode: "enforce", action_types: ["shell.exec"] }],
};
const context = { harness: "claude", harness_version: null, model: "example-model-1", session_id: "sbs_0123456789abcdef0123456789abcdef", repository: "github.com/example/app", branch: "main" };
const gatewayWith = (attester) => createGateway({ authentication: { mode: "insecure-development" }, policy, attester, mode: "check_only" });

test("the context members match the receipt schema", () => {
  const schema = JSON.parse(readFileSync(join(here, "../../policy-schema/schema/receipt.schema.json"), "utf8"));
  assert.deepEqual(Object.keys(schema.properties.payload.properties.context.properties), [...RECEIPT_CONTEXT_KEYS]);
});

test("the shared context vectors: valid contexts pass, invalid ones (an unknown key included) do not", () => {
  for (const vector of vectors.valid) assert.equal(validateReceiptContext(vector.context), true, vector.name);
  for (const vector of vectors.invalid) assert.equal(validateReceiptContext(vector.context), false, vector.name);
});

test("a receipt signed with a context verifies, and the context is covered by the signature", async () => {
  const attester = createAttester();
  const gateway = gatewayWith(attester);
  const { receipt } = await gateway.handleAction({ intent: { action_type: "shell.exec", params: { program: "ls" } } }, { context });
  assert.deepEqual(receipt.payload.context, context);
  const verified = verifyReceipt(receipt, attester.publicKeyPem);
  assert.equal(verified.valid, true);
  assert.equal(verified.contract_valid, true);

  const tampered = structuredClone(receipt);
  tampered.payload.context.repository = "github.com/example/other";
  assert.equal(verifyReceipt(tampered, attester.publicKeyPem).valid, false);
});

test("an observed action carries the context too; without one the receipt is unchanged", async () => {
  const attester = createAttester();
  const gateway = gatewayWith(attester);
  const observed = await gateway.observeAction({ intent: { action_type: "tool.custom", params: {} } }, { context: { harness: "cursor" } });
  assert.deepEqual(observed.receipt.payload.context, { harness: "cursor" });
  assert.equal(verifyReceipt(observed.receipt, attester.publicKeyPem).valid, true);

  const plain = await gateway.handleAction({ intent: { action_type: "shell.exec", params: { program: "ls" } } });
  assert.equal("context" in plain.receipt.payload, false);
  assert.equal(verifyReceipt(plain.receipt, attester.publicKeyPem).valid, true);
});

test("an unknown key inside context makes the receipt invalid like any other unknown key", async () => {
  const attester = createAttester();
  const { receipt } = await gatewayWith(attester).handleAction({ intent: { action_type: "shell.exec", params: { program: "ls" } } }, { context });
  const payload = structuredClone(receipt.payload);
  assert.equal(validateEvidencePayload(payload), true);
  payload.context.cwd = "/work/app";
  assert.equal(validateEvidencePayload(payload), false);
  for (const bad of [{ harness: "Claude" }, { repository: "https://github.com/example/app" }, { model: 7 }, "claude", null]) {
    assert.equal(validateEvidencePayload({ ...receipt.payload, context: bad }), false, JSON.stringify(bad));
  }
});

test("the gateway refuses to sign an invalid context", async () => {
  const gateway = gatewayWith(createAttester());
  await assert.rejects(
    gateway.handleAction({ intent: { action_type: "shell.exec", params: { program: "ls" } } }, { context: { harness: "claude", path: "/work" } }),
    /invalid receipt context/,
  );
  await assert.rejects(gateway.observeAction({ intent: { action_type: "tool.custom", params: {} } }, { context: { session_id: "" } }), /invalid receipt context/);
  assert.equal((await gateway.store.list()).length, 0, "nothing was recorded");
});
