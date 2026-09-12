import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createGateway, verifyReceipt, createWebCryptoAttester, generateAttesterJwk,
  KvReceiptStore, loadOrCreateKvAttester, createWorkerGateway,
} from "../dist/index.js";

const policy = {
  policy_id: "t", version: 1,
  clauses: [{ id: "tx", type: "spend_limit", mode: "enforce", asset: "USDC", max_per_action: 1000000 }],
};
const post = (app, path, body) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// A minimal in-memory stand-in for a Cloudflare KVNamespace.
function fakeKv() {
  const m = new Map();
  return { get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => void m.set(k, v), _m: m };
}

test("WebCrypto attester signs receipts that the Node verifier accepts", async () => {
  const jwk = await generateAttesterJwk();
  const attester = await createWebCryptoAttester(jwk);
  assert.ok(attester.kid.startsWith("key:"));
  assert.ok(attester.publicKeyPem.includes("BEGIN PUBLIC KEY"));

  const { app } = createGateway({ policy, attester });
  const res = await post(app, "/v1/evaluate", { intent: { action_type: "payout.create", asset: "USDC", amount: 500000 } });
  const { receipt } = await res.json();

  // Cross-runtime: signed with WebCrypto, verified with node:crypto.
  assert.equal(verifyReceipt(receipt, attester.publicKeyPem).valid, true);

  // Tamper → invalid.
  receipt.payload.intent.amount = 9999999;
  assert.equal(verifyReceipt(receipt, attester.publicKeyPem).valid, false);
});

test("WebCrypto attester kid + public key are stable for the same key", async () => {
  const jwk = await generateAttesterJwk();
  const a = await createWebCryptoAttester(jwk);
  const b = await createWebCryptoAttester(jwk);
  assert.equal(a.kid, b.kid);
  assert.equal(a.publicKeyPem, b.publicKeyPem);
});

test("KV attester persists across a restart; KV receipts are durable", async () => {
  const kv = fakeKv();
  const a1 = await loadOrCreateKvAttester(kv);
  const a2 = await loadOrCreateKvAttester(kv); // second load reuses the stored key
  assert.equal(a1.kid, a2.kid);

  const gw1 = await createWorkerGateway({ policy, kv });
  await post(gw1.app, "/v1/evaluate", { intent: { action_type: "payout.create", asset: "USDC", amount: 100000 } });
  await post(gw1.app, "/v1/evaluate", { intent: { action_type: "payout.create", asset: "USDC", amount: 200000 } });

  // "Restart": a fresh gateway on the same KV sees prior receipts and the same key.
  const gw2 = await createWorkerGateway({ policy, kv });
  assert.equal(gw2.attester.kid, a1.kid);
  const list = await gw2.store.list();
  assert.equal(list.length, 2);
  const res = await post(gw2.app, "/v1/evaluate", { intent: { action_type: "payout.create", asset: "USDC", amount: 300000 } });
  const { receipt } = await res.json();
  assert.equal(verifyReceipt(receipt, gw2.attester.publicKeyPem).valid, true);
  assert.equal((await gw2.store.list()).length, 3);
});

test("KvReceiptStore caps stored receipts", async () => {
  const kv = fakeKv();
  const store = new KvReceiptStore(kv, "receipts", 3);
  for (let i = 0; i < 5; i++) await store.put({ payload: { intent: { n: i } }, signature: { alg: "Ed25519", sig: "x" } });
  const all = await store.list();
  assert.equal(all.length, 3);
  assert.equal(all[0].payload.intent.n, 2); // oldest two dropped
});
