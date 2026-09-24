import { test } from "node:test";
import assert from "node:assert/strict";
import { createGateway, verifyReceipt } from "../dist/index.js";
import { loadOrCreateAttester } from "../dist/node.js";
import { verifyReceiptSignature } from "@scopebond/verify/signature";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Cross-implementation check: a receipt the gateway signs verifies with the runtime-
// neutral WebCrypto verifier exactly as it does with the gateway's node:crypto verifier.
test("gateway receipts verify with @scopebond/verify/signature (WebCrypto)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-webcrypto-"));
  try {
    const { attester } = loadOrCreateAttester({ file: join(dir, "attester.key") });
    const policy = { vocabulary_version: "1.0", policy_id: "t", version: 1, clauses: [{ id: "b", type: "action_allowlist", mode: "enforce", action_types: ["git.push"], param_bounds: { ref: { pattern: "^(?!main$).+" } } }] };
    const { app } = createGateway({ authentication: { mode: "insecure-development" }, policy, attester });
    const res = await app.request("/v1/evaluate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ intent: { action_type: "git.push", params: { ref: "main" } } }) });
    const { receipt } = await res.json();
    assert.equal(verifyReceipt(receipt, attester.publicKeyPem).signature_valid, true);
    const web = await verifyReceiptSignature(receipt, attester.publicKeyPem);
    assert.equal(web.valid, true, JSON.stringify(web));
    const tampered = structuredClone(receipt);
    tampered.payload.intent.params.ref = "feature";
    assert.equal((await verifyReceiptSignature(tampered, attester.publicKeyPem)).valid, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
