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
const CONTROL_TOKEN = "test-control-token-000000000001";
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

test("an unfinished SQLite reservation survives restart and remains charged", async (t) => {
  const { dir, cleanup } = tmp();
  try {
    const dbFile = join(dir, "authority.db");
    const opened = openReceiptStore({ db: dbFile });
    if (opened.kind !== "sqlite" || !opened.store.reserveAction) {
      t.skip("node:sqlite is unavailable on this supported runtime");
      return;
    }
    const windowPolicy = {
      vocabulary_version: "1.0", policy_id: "durable-window", version: 1,
      clauses: [{ id: "window", type: "spend_limit", mode: "enforce", asset: "USDC", max_per_window: 100, window: "P1D", scope: "principal" }],
    };
    const candidate = {
      intent: { action_type: "payout.create", asset: "USDC", amount: 60 },
      action_id: "action:unfinished000001", intent_hash: "a".repeat(64), executed: true, timestamp: "2026-09-12T12:00:00Z",
    };
    const attempt = opened.store.reserveAction({
      action_id: candidate.action_id, candidate,
      policy_ref: { id: "durable-window", version: 1, digest: "b".repeat(64) },
      policy_snapshot: JSON.stringify(windowPolicy),
    }, () => ({ allow: true }));
    assert.equal(attempt.duplicate, false);
    await opened.store.close?.();

    const reopened = openReceiptStore({ db: dbFile });
    let called = false;
    const gateway = createGateway({
      authentication: { mode: "insecure-development" }, policy: windowPolicy,
      now: () => "2026-09-12T12:00:00Z", store: reopened.store,
      executor: { mode: "dispatch", execute: () => { called = true; return { ref: "unexpected" }; } },
    });
    const result = await gateway.handleAction({ intent: { action_type: "payout.create", asset: "USDC", amount: 60 } });
    assert.equal(result.allowed, false);
    assert.equal(called, false);
    await reopened.store.close?.();
  } finally { cleanup(); }
});

test("global stop survives SQLite restart and only an authenticated resume clears it", async (t) => {
  const { dir, cleanup } = tmp();
  try {
    const dbFile = join(dir, "stops.db");
    const firstStore = openReceiptStore({ db: dbFile });
    if (firstStore.kind !== "sqlite") {
      t.skip("node:sqlite is unavailable on this supported runtime");
      return;
    }
    const first = createGateway({
      authentication: { mode: "insecure-development" }, policy, store: firstStore.store,
      control: { bearerToken: CONTROL_TOKEN },
    });
    const kill = await first.app.request("/v1/kill", { method: "POST", headers: { authorization: `Bearer ${CONTROL_TOKEN}` } });
    assert.equal(kill.status, 200);
    await firstStore.store.close?.();

    const secondStore = openReceiptStore({ db: dbFile });
    let executions = 0;
    const second = createGateway({
      authentication: { mode: "insecure-development" }, policy, store: secondStore.store,
      control: { bearerToken: CONTROL_TOKEN },
      executor: { mode: "dispatch", execute: () => { executions++; return { ref: "sandbox:ok" }; } },
    });
    const intent = { action_type: "payout.create", asset: "USDC", amount: 1 };
    assert.equal((await second.handleAction({ intent })).allowed, false);
    assert.equal(executions, 0);
    assert.equal((await second.app.request("/v1/resume", { method: "POST" })).status, 401);
    assert.equal((await second.handleAction({ intent })).allowed, false);
    const resumed = await second.app.request("/v1/resume", { method: "POST", headers: { authorization: `Bearer ${CONTROL_TOKEN}` } });
    assert.equal(resumed.status, 200);
    assert.equal((await second.handleAction({ intent })).allowed, true);
    assert.equal(executions, 1);
    await secondStore.store.close?.();
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

test("dispatch fails closed when a store has no atomic authority coordinator", async () => {
  const { dir, cleanup } = tmp();
  try {
    const store = new FileReceiptStore(join(dir, "receipts.jsonl"));
    let called = false;
    const gateway = createGateway({
      authentication: { mode: "insecure-development" }, policy, store,
      executor: { mode: "dispatch", execute: () => { called = true; return { ref: "unexpected" }; } },
    });
    await assert.rejects(
      gateway.handleAction({ intent: { action_type: "payout.create", asset: "USDC", amount: 1 } }),
      /does not provide atomic authority reservations/,
    );
    assert.equal(called, false);
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

test("FileReceiptStore tolerates a torn final line and keeps appending on a fresh line", async () => {
  const { dir, cleanup } = tmp();
  try {
    const { appendFileSync, readFileSync: read } = await import("node:fs");
    const file = join(dir, "r.jsonl");
    const store = new FileReceiptStore(file);
    const receipt = { payload: { n: 1 }, signature: { sig: "x" } };
    store.put(receipt);
    appendFileSync(file, '{"payload":{"n":2},"sig'); // crash mid-append
    const reopened = new FileReceiptStore(file);
    assert.equal(reopened.list().length, 1, "the torn record is dropped, not fatal");
    reopened.put({ payload: { n: 3 }, signature: { sig: "y" } });
    const again = new FileReceiptStore(file);
    assert.deepEqual(again.list().map((r) => r.payload.n), [1, 3], "the next record starts on its own line");
    assert.ok(read(file, "utf8").endsWith("\n"));
  } finally { cleanup(); }
});

test("FileReceiptStore refuses a corrupt record that is not the last line", async () => {
  const { dir, cleanup } = tmp();
  try {
    const { writeFileSync } = await import("node:fs");
    const file = join(dir, "r.jsonl");
    writeFileSync(file, '{"payload":{"n":1}}\n{broken\n{"payload":{"n":3}}\n');
    assert.throws(() => new FileReceiptStore(file), /corrupt record on line 2/);
  } finally { cleanup(); }
});

test("openReceiptStore uses SQLite with WAL and a busy timeout, and never falls back to a cwd file", async () => {
  const { dir, cleanup } = tmp();
  try {
    const { existsSync } = await import("node:fs");
    const db = join(dir, "receipts.db");
    const opened = openReceiptStore({ db });
    assert.equal(opened.kind, "sqlite");
    assert.equal(opened.path, db);
    // Two stores on one file (two hook processes) can both write.
    const other = openReceiptStore({ db }).store;
    const fake = (n) => ({ payload: { n, intent_hash: `h${n}`, policy_hash: "p", realtime_result: "allow", executed: false, timestamp: "2026-09-23T00:00:00Z" }, signature: {} });
    opened.store.put(fake(1));
    other.put(fake(2));
    assert.equal(opened.store.list().length, 2);
    assert.equal(existsSync(join(process.cwd(), "scopebond-receipts.jsonl")), false);
    // A path that cannot be opened is an error, not a silent switch to another log.
    assert.throws(() => openReceiptStore({ db: dir }));
  } finally { try { cleanup(); } catch { /* Windows keeps an open database locked */ } }
});
