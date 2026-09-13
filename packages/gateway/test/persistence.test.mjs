import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGateway, verifyReceipt, attesterFromPrivateKeyPem } from "../dist/index.js";
import { loadOrCreateAttester, FileReceiptStore, SqliteReceiptStore, openReceiptStore } from "../dist/node.js";

const policy = {
  vocabulary_version: "1.0", policy_id: "t", version: 1,
  clauses: [{ id: "tx", type: "spend_limit", mode: "enforce", asset: "USDC", max_per_action: 1000000 }],
};
const post = (app, path, body) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), "scopebond-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("attester key persists: same kid + public key across loads, distinct instances differ", () => {
  const { dir, cleanup } = tmp();
  try {
    const file = join(dir, "attester.key");
    const a = loadOrCreateAttester({ file });
    const b = loadOrCreateAttester({ file });
    assert.equal(a.created, true);
    assert.equal(b.created, false);
    assert.equal(a.attester.kid, b.attester.kid);
    assert.equal(a.attester.publicKeyPem, b.attester.publicKeyPem);
    assert.ok(a.attester.kid.startsWith("key:"), "kid is derived from the public key");

    const other = loadOrCreateAttester({ file: join(dir, "other.key") });
    assert.notEqual(other.attester.kid, a.attester.kid);
  } finally { cleanup(); }
});

test("verifyReceipt validates a genuine receipt and rejects tampering", async () => {
  const { dir, cleanup } = tmp();
  try {
    const { attester } = loadOrCreateAttester({ file: join(dir, "attester.key") });
    const { app } = createGateway({ authentication: { mode: "insecure-development" }, policy, attester });
    const res = await post(app, "/v1/evaluate", { intent: { action_type: "payout.create", asset: "USDC", amount: 500000 } });
    const { receipt } = await res.json();

    const ok = verifyReceipt(receipt, attester.publicKeyPem);
    assert.equal(ok.valid, true);
    assert.equal(ok.signature_valid, true);
    assert.equal(ok.contract_valid, true);
    assert.equal(ok.intent_hash_valid, true);
    assert.equal(ok.policy_ref_valid, true);
    assert.equal(ok.supported_version, true);
    assert.equal(ok.key_binding_valid, true);
    assert.equal(ok.legacy, false);
    assert.equal(ok.external_effect_verified, false);

    // Tamper the amount: intent no longer matches the signed intent_hash.
    const tamperedIntent = structuredClone(receipt);
    tamperedIntent.payload.intent.amount = 9999999;
    const t1 = verifyReceipt(tamperedIntent, attester.publicKeyPem);
    assert.equal(t1.valid, false);

    // Tamper the signature.
    const tamperedSig = structuredClone(receipt);
    tamperedSig.signature.sig = Buffer.from("nope").toString("base64");
    const t2 = verifyReceipt(tamperedSig, attester.publicKeyPem);
    assert.equal(t2.signature_valid, false);

    // A different key does not verify it.
    const other = loadOrCreateAttester({ file: join(dir, "other.key") });
    assert.equal(verifyReceipt(receipt, other.attester.publicKeyPem).signature_valid, false);
  } finally { cleanup(); }
});

test("receipts survive a restart and enforce prior-state across a new instance", async () => {
  const { dir, cleanup } = tmp();
  try {
    const keyFile = join(dir, "attester.key");
    const dbFile = join(dir, "receipts.db");
    const { attester } = loadOrCreateAttester({ file: keyFile });

    // First process: record two receipts, then close.
    {
      const { store } = openReceiptStore({ db: dbFile });
      const { app } = createGateway({ authentication: { mode: "insecure-development" }, policy, attester, store });
      await post(app, "/v1/evaluate", { intent: { action_type: "payout.create", asset: "USDC", amount: 100000 } });
      await post(app, "/v1/evaluate", { intent: { action_type: "payout.create", asset: "USDC", amount: 200000 } });
      assert.equal((await store.list()).length, 2);
      await store.close?.();
    }

    // Second process: a fresh store on the same DB sees the prior receipts.
    {
      const { store, kind } = openReceiptStore({ db: dbFile });
      assert.ok(kind === "sqlite" || kind === "file", `durable store kind: ${kind}`);
      const prior = await store.list();
      assert.equal(prior.length, 2);
      // And a receipt from the reopened gateway still verifies against the persisted key.
      const { app } = createGateway({ authentication: { mode: "insecure-development" }, policy, attester, store });
      const res = await post(app, "/v1/evaluate", { intent: { action_type: "payout.create", asset: "USDC", amount: 300000 } });
      const { receipt } = await res.json();
      assert.equal(verifyReceipt(receipt, attester.publicKeyPem).valid, true);
      assert.equal((await store.list()).length, 3);
      await store.close?.();
    }
  } finally { cleanup(); }
});

test("FileReceiptStore is durable (append-only JSONL)", async () => {
  const { dir, cleanup } = tmp();
  try {
    const file = join(dir, "receipts.jsonl");
    const { attester } = loadOrCreateAttester({ file: join(dir, "attester.key") });
    {
      const store = new FileReceiptStore(file);
      const { app } = createGateway({ authentication: { mode: "insecure-development" }, policy, attester, store });
      await post(app, "/v1/evaluate", { intent: { action_type: "payout.create", asset: "USDC", amount: 100000 } });
    }
    const reopened = new FileReceiptStore(file);
    assert.equal(reopened.list().length, 1);
  } finally { cleanup(); }
});

test("GET /v1/attester and JWKS expose the key; served receipts verify against it", async () => {
  const { dir, cleanup } = tmp();
  try {
    const { attester } = loadOrCreateAttester({ file: join(dir, "attester.key") });
    const { app } = createGateway({ authentication: { mode: "insecure-development" }, policy, attester });

    const meta = await (await app.request("/v1/attester")).json();
    assert.equal(meta.kid, attester.kid);
    assert.equal(meta.alg, "Ed25519");
    assert.ok(meta.public_key_pem.includes("BEGIN PUBLIC KEY"));

    const jwks = await (await app.request("/.well-known/jwks.json")).json();
    assert.equal(jwks.keys.length, 1);
    assert.equal(jwks.keys[0].kid, attester.kid);
    assert.equal(jwks.keys[0].crv, "Ed25519");

    const res = await post(app, "/v1/evaluate", { intent: { action_type: "payout.create", asset: "USDC", amount: 500000 } });
    const { receipt } = await res.json();
    assert.equal(verifyReceipt(receipt, meta.public_key_pem).valid, true);
  } finally { cleanup(); }
});

test("attesterFromPrivateKeyPem round-trips a persisted key", () => {
  const { dir, cleanup } = tmp();
  try {
    const { attester } = loadOrCreateAttester({ file: join(dir, "attester.key") });
    // Rebuilding from the same public identity yields the same kid.
    const rebuilt = attesterFromPrivateKeyPem(
      readFileSync(join(dir, "attester.key"), "utf8"),
    );
    assert.equal(rebuilt.kid, attester.kid);
    assert.equal(rebuilt.publicKeyPem, attester.publicKeyPem);
  } finally { cleanup(); }
});
