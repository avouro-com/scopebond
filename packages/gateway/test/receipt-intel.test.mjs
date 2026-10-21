// A receipt may carry what a signed plugin gave its action: `pattern_id` (64 hex) and the opaque `intel` slot (base64 of
// at most 4 KiB). The gateway signs them as given and checks only their shape; a receipt made without them is unchanged,
// byte for byte.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createAttester, createGateway, verifyReceipt, validateEvidencePayload, validateReceiptIntel, canonical } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const evidence = JSON.parse(readFileSync(join(here, "../../policy-schema/vectors/evidence-contract.json"), "utf8"));
const vectors = evidence.receipt_intel;
const policy = {
  vocabulary_version: "1.0", policy_id: "intel-test", version: 1,
  clauses: [{ id: "safe-shell", type: "action_allowlist", mode: "enforce", action_types: ["shell.exec"], param_bounds: { program: { pattern: "^(?!rm$).+" } } }],
};
const AT = "2026-10-21T00:00:00.000Z";
const gatewayWith = (attester) => createGateway({ authentication: { mode: "insecure-development" }, policy, attester, mode: "check_only", now: () => AT });
const ls = { intent: { action_type: "shell.exec", params: { program: "ls" } } };
const slot = { pattern_id: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", intel: Buffer.from("opaque").toString("base64") };

/** Run `fn` with crypto.randomUUID fixed, so two receipts made one after the other can be compared byte for byte. */
async function withFixedIds(fn) {
  const original = globalThis.crypto.randomUUID;
  globalThis.crypto.randomUUID = () => "00000000-0000-4000-8000-000000000000";
  try { return await fn(); } finally { globalThis.crypto.randomUUID = original; }
}

test("handleAction signs the slot as given, and the signature covers it", async () => {
  const attester = createAttester();
  const { receipt } = await gatewayWith(attester).handleAction(ls, { intel: slot });
  assert.equal(receipt.payload.pattern_id, slot.pattern_id);
  assert.equal(receipt.payload.intel, slot.intel);
  assert.equal(validateEvidencePayload(receipt.payload), true);
  assert.equal(verifyReceipt(receipt, attester.publicKeyPem).valid, true);
  const tampered = structuredClone(receipt);
  tampered.payload.intel = Buffer.from("changed").toString("base64");
  assert.equal(verifyReceipt(tampered, attester.publicKeyPem).valid, false, "the slot is covered by the signature");
});

test("observeAction and a denial carry it too", async () => {
  const attester = createAttester();
  const gateway = gatewayWith(attester);
  const observed = await gateway.observeAction(ls, { intel: { pattern_id: slot.pattern_id } });
  assert.equal(observed.receipt.payload.pattern_id, slot.pattern_id);
  assert.equal("intel" in observed.receipt.payload, false);
  assert.equal(verifyReceipt(observed.receipt, attester.publicKeyPem).valid, true);
  const denied = await gateway.handleAction({ intent: { action_type: "shell.exec", params: { program: "rm" } } }, { intel: slot });
  assert.equal(denied.allowed, false);
  assert.equal(denied.receipt.payload.intel, slot.intel);
  assert.equal(verifyReceipt(denied.receipt, attester.publicKeyPem).valid, true);
});

test("a slot of the wrong shape is refused before anything is decided, never signed", async () => {
  const attester = createAttester();
  const gateway = gatewayWith(attester);
  for (const vector of vectors.invalid) {
    await assert.rejects(gateway.handleAction(ls, { intel: vector.fields }), TypeError, vector.name);
    await assert.rejects(gateway.observeAction(ls, { intel: vector.fields }), TypeError, vector.name);
  }
  await assert.rejects(gateway.handleAction(ls, { intel: { ...slot, extra: "x" } }), TypeError, "a closed object");
  assert.equal((await gateway.store.list()).length, 0, "nothing was recorded");
});

test("the shared vectors: valid slots pass the payload check, invalid ones do not", () => {
  const base = evidence.receipt_context.receipt.payload;
  for (const vector of vectors.valid) {
    assert.equal(validateReceiptIntel(vector.fields), true, vector.name);
    assert.equal(validateEvidencePayload({ ...base, ...vector.fields }), true, vector.name);
  }
  for (const vector of vectors.invalid) {
    assert.equal(validateReceiptIntel(vector.fields), false, vector.name);
    assert.equal(validateEvidencePayload({ ...base, ...vector.fields }), false, vector.name);
  }
});

test("without a slot the receipt is byte-identical: no member is added, not even an empty one", async () => {
  const attester = createAttester();
  const [plain, empty, slotted] = await withFixedIds(async () => [
    (await gatewayWith(attester).handleAction(ls)).receipt,
    (await gatewayWith(attester).handleAction(ls, { intel: undefined })).receipt,
    (await gatewayWith(attester).handleAction(ls, { intel: slot })).receipt,
  ]);
  assert.equal(canonical(empty.payload), canonical(plain.payload));
  assert.equal(empty.signature.sig, plain.signature.sig);
  assert.equal("pattern_id" in plain.payload || "intel" in plain.payload, false);
  // With a slot, exactly the two members differ.
  const { pattern_id, intel, ...rest } = slotted.payload;
  assert.equal(pattern_id, slot.pattern_id);
  assert.equal(intel, slot.intel);
  assert.equal(canonical(rest), canonical(plain.payload));
});
