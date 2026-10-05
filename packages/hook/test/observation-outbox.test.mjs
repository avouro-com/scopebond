import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { canonical } from "@scopebond/policy-schema/canonical";
import { OBSERVATION_DOMAIN } from "@scopebond/policy-schema";
import {
  AGENT_KINDS, assertAgentKind, observationSigner, signObservation, observationHash, sourceReceiptHash, signingBytes,
  buildPayload, bindingKeyFromHex, ObservationStore, uploadPending, parseRetryAfter, REQUEST_BINDING_DOMAIN,
} from "../dist/index.js";
import { validObservation, validSigned } from "./observation-schema.mjs";
import { startServer, results, acceptAll } from "./observation-helpers.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(join(here, "../../policy-schema/vectors/observation-contract.json"), "utf8"));
const CTX = { installationId: "inst-1", generation: 1 };
const keys = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const signer = observationSigner(privateKey.export({ type: "pkcs8", format: "pem" }).toString(), "key:test-0001");
  return { signer, publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString() };
};
const sessionDraft = (extra = {}) => ({ kind: "session", occurredAt: Date.UTC(2026, 0, 1), sessionId: "sbs_test", data: { event: "start" }, ...extra });
const freshStore = (now = () => Date.now()) => new ObservationStore(join(mkdtempSync(join(tmpdir(), "sb-obs-store-")), "observations.db"), now);
const sigOk = (wrapper, pem) => verify(null, signingBytes(wrapper.payload), createPublicKey(pem), Buffer.from(wrapper.signature.value, "base64url"));
const oversizeDraft = { kind: "capability", occurredAt: 1, data: { event: "proof", required_fields: Array.from({ length: 100 }, () => "x".repeat(200)), connector: "c", adapter_version: "1", host_variant: "h", action_type: "a", phase: "pre", fixture_version: "f" } };

// ---- signing domain, canonical bytes, wire wrapper ----------------------------------------

test("the signing bytes are the exact domain plus the RFC 8785 canonical payload, for every shared vector", () => {
  assert.equal(OBSERVATION_DOMAIN, "scopebond:observation/v1\n");
  for (const v of vectors.positive) {
    assert.equal(canonical(v.payload), v.canonical, `${v.name}: canonical bytes`);
    const bytes = signingBytes(v.payload);
    assert.equal(bytes.toString("utf8"), OBSERVATION_DOMAIN + v.canonical, `${v.name}: domain + canonical`);
    assert.equal(observationHash(v.payload), v.observation_hash, `${v.name}: hash`);
    // The shared vector's signature verifies under its published test-only key with OUR bytes.
    assert.ok(verify(null, bytes, createPublicKey(vectors.public_key_pem), Buffer.from(v.signature.value, "base64url")), `${v.name}: signature`);
  }
});

test("negative vectors: a changed hash, the wrong signer and a missing domain never verify", () => {
  const positive = vectors.positive[0];
  const pub = createPublicKey(vectors.public_key_pem);
  for (const n of vectors.negative) {
    if (n.expect.signature_valid === undefined) continue;
    const ok = verify(null, signingBytes(n.payload), n.name === "wrong_signer" ? createPublicKey(vectors.wrong_public_key_pem) : pub, Buffer.from(n.signature.value, "base64url"));
    assert.equal(ok, n.expect.signature_valid, n.name);
    if (n.expect.hash_differs) assert.notEqual(observationHash(n.payload), positive.observation_hash, `${n.name}: hash changed`);
  }
  assert.equal(verify(null, Buffer.from(canonical(positive.payload), "utf8"), pub, Buffer.from(positive.signature.value, "base64url")), false, "no domain prefix");
});

test("schema-negative vectors (unknown field, unknown version, unknown event) are refused by the closed schema", () => {
  for (const n of vectors.negative) if (n.expect.schema_valid === false) assert.equal(validObservation(n.payload), false, n.name);
  for (const v of vectors.positive) assert.equal(validObservation(v.payload), true, v.name);
});

test("an agent-adapter key emits only the six agent kinds and never verification, platform outcome, integrity or export", () => {
  assert.deepEqual([...AGENT_KINDS], ["session", "capability", "health", "policy_ack", "tool_intent", "tool_outcome"]);
  for (const kind of ["verification", "platform_outcome", "integrity", "export", "nope"]) assert.throws(() => assertAgentKind(kind), /may not emit/);
  const { signer } = keys();
  assert.throws(() => signObservation({ ...buildPayload(sessionDraft(), CTX, 1), kind: "verification" }, signer), /may not emit/);
});

test("the wrapper is {payload, signature:{alg,kid,value}} with an unpadded base64url Ed25519 signature that verifies", () => {
  const { signer, publicKeyPem } = keys();
  const wrapper = signObservation(buildPayload(sessionDraft(), CTX, 1), signer);
  assert.deepEqual(Object.keys(wrapper).sort(), ["payload", "signature"]);
  assert.deepEqual(Object.keys(wrapper.signature).sort(), ["alg", "kid", "value"]);
  assert.equal(wrapper.signature.alg, "Ed25519");
  assert.match(wrapper.signature.value, /^[A-Za-z0-9_-]{86}$/);
  assert.ok(sigOk(wrapper, publicKeyPem));
  assert.equal(validSigned(wrapper), true);
  const tampered = structuredClone(wrapper);
  tampered.payload.sequence = 2;
  assert.equal(sigOk(tampered, publicKeyPem), false);
  assert.notEqual(observationHash(tampered.payload), observationHash(wrapper.payload));
  assert.equal(sigOk(wrapper, keys().publicKeyPem), false, "a different signer does not verify");
});

test("an oversize observation is refused before it is stored, and repeated fields always equal the envelope", () => {
  const { signer } = keys();
  assert.throws(() => signObservation(buildPayload(oversizeDraft, CTX, 1), signer), RangeError);
  const payload = buildPayload(sessionDraft({ data: { event: "start", session_id: "attacker", sequence: 999 } }), CTX, 7);
  assert.equal(payload.data.session_id, "sbs_test");
  assert.equal(payload.data.sequence, 7);
  assert.equal(validObservation(payload), true);
});

test("source receipt hash and request binding use their exact domains and keyed HMAC", () => {
  const receipt = { payload: { action_ref: { action_id: "a1" } }, signature: "s" };
  assert.equal(sourceReceiptHash(receipt), createHash("sha256").update("scopebond:source-receipt/v1\n" + canonical(receipt), "utf8").digest("hex"));
  assert.equal(REQUEST_BINDING_DOMAIN, "scopebond:request-binding/v1\n");
  const hex = "ab".repeat(32);
  const a = bindingKeyFromHex(hex);
  const request = { action_type: "shell.exec", params: { program: "ls" } };
  const expected = createHmac("sha256", Buffer.from(hex, "hex")).update(REQUEST_BINDING_DOMAIN + canonical(request), "utf8").digest("hex");
  assert.equal(a.requestDigest(request), expected);
  assert.notEqual(a.requestDigest(request), createHash("sha256").update(REQUEST_BINDING_DOMAIN + canonical(request)).digest("hex"), "keyed, not a plain hash");
  const b = bindingKeyFromHex("cd".repeat(32));
  assert.notEqual(a.generation, b.generation, "each key has its own generation id");
  assert.notEqual(a.requestDigest(request), b.requestDigest(request), "digests cannot be joined across keys");
  assert.ok(!a.generation.includes(hex.slice(0, 8)));
});

// ---- transactional sequence allocation -----------------------------------------------------

test("sequences are contiguous from 1, persist across process restarts and never reuse a number", () => {
  const { signer } = keys();
  const dir = mkdtempSync(join(tmpdir(), "sb-obs-seq-"));
  const file = join(dir, "observations.db");
  let store = new ObservationStore(file);
  assert.deepEqual(store.bindGeneration(1), { ok: true, retired: 0 });
  const seqs = [];
  for (let i = 0; i < 3; i += 1) seqs.push(store.enqueue(sessionDraft(), CTX, signer).sequence);
  store.close(); // the process exits; nothing else is saved
  store = new ObservationStore(file);
  store.bindGeneration(1);
  for (let i = 0; i < 3; i += 1) seqs.push(store.enqueue(sessionDraft(), CTX, signer).sequence);
  assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6]);
  assert.equal(store.pendingSummary().count, 6);
  store.close();
});

test("a failed enqueue consumes no sequence, and an id already pending is not enqueued twice", () => {
  const { signer } = keys();
  const store = freshStore();
  store.bindGeneration(1);
  assert.equal(store.enqueue(oversizeDraft, CTX, signer).reason, "oversize");
  const first = store.enqueue(sessionDraft({ observationId: "11111111-1111-4111-8111-111111111111" }), CTX, signer);
  assert.equal(first.sequence, 1, "the refused observation did not use sequence 1");
  const again = store.enqueue(sessionDraft({ observationId: "11111111-1111-4111-8111-111111111111" }), CTX, signer);
  assert.equal(again.duplicate, true);
  assert.equal(again.sequence, 1);
  assert.equal(store.pendingSummary().count, 1);
  assert.equal(store.enqueue(sessionDraft(), CTX, signer).sequence, 2);
  store.close();
});

test("a crash inside the allocation transaction leaves neither a gap nor a stored row", () => {
  const { signer } = keys();
  const store = freshStore();
  store.bindGeneration(1);
  store.enqueue(sessionDraft(), CTX, signer);
  const broken = { kid: "key:test-0001", sign() { throw new Error("disk full"); } };
  assert.throws(() => store.enqueue(sessionDraft(), CTX, broken), /disk full/);
  assert.equal(store.enqueue(sessionDraft(), CTX, signer).sequence, 2);
  assert.equal(store.pendingSummary().count, 2);
  store.close();
});

test("concurrent hook processes allocate unique contiguous sequences", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-obs-conc-"));
  const file = join(dir, "observations.db");
  const seed = new ObservationStore(file); seed.bindGeneration(1); seed.close();
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const script = `
    import { ObservationStore, observationSigner } from ${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)};
    const s = new ObservationStore(${JSON.stringify(file)}); const signer = observationSigner(${JSON.stringify(pem)}, "key:test-0001");
    for (let i = 0; i < 20; i++) s.enqueue({ kind: "session", occurredAt: 1, sessionId: "sbs_x", data: { event: "start" } }, { installationId: "inst-1", generation: 1 }, signer);
    s.close();`;
  await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "pipe" });
    let err = ""; child.stderr.on("data", (d) => { err += d; });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(err))));
  })));
  const store = new ObservationStore(file);
  const rows = store.nextBatch(100);
  assert.deepEqual(rows.map((r) => r.sequence), Array.from({ length: 80 }, (_, i) => i + 1));
  assert.equal(new Set(rows.map((r) => r.observation_id)).size, 80);
  store.close();
});

test("a rotated generation retires the old backlog locally, restarts sequence at 1, and an older generation is not adopted", () => {
  const { signer } = keys();
  const store = freshStore();
  store.bindGeneration(1);
  store.enqueue(sessionDraft(), CTX, signer); store.enqueue(sessionDraft(), CTX, signer);
  assert.deepEqual(store.bindGeneration(2), { ok: true, retired: 2 });
  assert.equal(store.pendingSummary().count, 0);
  assert.deepEqual(store.terminalCounts(), { stale_generation: 2 });
  assert.equal(store.enqueue(sessionDraft(), { ...CTX, generation: 2 }, signer).sequence, 1);
  assert.equal(store.bindGeneration(1).ok, false);
  assert.equal(store.enqueue(sessionDraft(), CTX, signer).reason, "generation_mismatch");
  store.close();
});

// ---- upload semantics ------------------------------------------------------------------------

function seeded(count, now) {
  const { signer, publicKeyPem } = keys();
  const store = freshStore(now);
  store.bindGeneration(1);
  for (let i = 0; i < count; i += 1) store.enqueue(sessionDraft(), CTX, signer);
  return { store, signer, publicKeyPem };
}
const brief = (i) => ({ id: i.payload.observation_id, seq: i.payload.sequence, hash: observationHash(i.payload) });

test("partial batch: only acknowledged items leave; deferred are retried unchanged; rejected go to the visible terminal queue", async () => {
  const clock = { t: Date.now() };
  const { store } = seeded(6, () => clock.t);
  const sent = [];
  const server = await startServer((items) => {
    sent.push(items.map(brief));
    const statuses = [["accepted", "ok"], ["duplicate", "ok"], ["pending_link", "pending_source"], ["rejected", "bad_signature"], ["deferred", "quota_deferred"]];
    // Item 5 gets no result at all.
    return { status: 200, body: { version: "1.0", retry_after_seconds: 30, results: items.slice(0, 5).map((item, index) => ({ index, observation_id: item.payload.observation_id, status: statuses[index][0], code: statuses[index][1], retryable: statuses[index][0] === "deferred" })) } };
  });
  const outcome = await uploadPending(store, { url: server.url, credential: "sbm_x", now: () => clock.t });
  assert.deepEqual([outcome.acknowledged, outcome.rejected, outcome.deferred], [3, 1, 2]);
  assert.equal(store.pendingSummary().count, 2, "the deferred item and the item with no result stay");
  const terminal = store.terminal();
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].code, "bad_signature");
  assert.equal(terminal[0].observation_id, sent[0][3].id);
  const accepting = await startServer(acceptAll);
  clock.t += 60_000;
  await uploadPending(store, { url: accepting.url, credential: "sbm_x", now: () => clock.t });
  assert.deepEqual(accepting.observations().map(brief), [sent[0][4], sent[0][5]], "same ids, sequences and signed bytes");
  assert.equal(store.pendingSummary().count, 0);
  await server.close(); await accepting.close(); store.close();
});

test("a result naming the wrong observation id, an unknown status and an unreadable 200 acknowledge nothing", async () => {
  const clock = { t: Date.now() };
  const { store } = seeded(2, () => clock.t);
  let mode = 0;
  const server = await startServer((items) => {
    mode += 1;
    if (mode === 1) return { status: 200, body: { version: "1.0", results: [{ index: 0, observation_id: "someone-else", status: "accepted", code: "ok", retryable: false }, { index: 1, observation_id: items[1].payload.observation_id, status: "weird", code: "x", retryable: false }] } };
    return { status: 200, body: "not json" };
  });
  const opts = { url: server.url, credential: "sbm_x", now: () => clock.t };
  await uploadPending(store, opts);
  assert.equal(store.pendingSummary().count, 2);
  clock.t += 3_600_000;
  assert.equal((await uploadPending(store, opts)).result, "error");
  assert.equal(store.pendingSummary().count, 2);
  assert.equal(store.terminal().length, 0);
  await server.close(); store.close();
});

test("429 keeps everything and honours Retry-After; nothing is sent until it passes", async () => {
  const clock = { t: 1_000_000 };
  const { store } = seeded(3, () => clock.t);
  const server = await startServer(() => ({ status: 429, headers: { "retry-after": "90" }, body: { error: "rate_limited" } }));
  const opts = { url: server.url, credential: "sbm_x", now: () => clock.t };
  assert.equal((await uploadPending(store, opts)).result, "backoff");
  assert.equal(store.pendingSummary().count, 3);
  assert.equal(server.requests.length, 1);
  clock.t += 30_000;
  await uploadPending(store, opts);
  assert.equal(server.requests.length, 1, "still inside Retry-After: nothing sent");
  clock.t += 61_000;
  await uploadPending(store, opts);
  assert.equal(server.requests.length, 2);
  await server.close(); store.close();
  assert.equal(parseRetryAfter("120", 0), 120_000);
  assert.equal(parseRetryAfter("Wed, 21 Oct 2026 07:28:00 GMT", Date.parse("Wed, 21 Oct 2026 07:27:00 GMT")), 60_000);
  assert.ok(parseRetryAfter("999999999", 0) <= 6 * 3_600_000, "a hostile value is capped");
  assert.equal(parseRetryAfter("soon", 0), undefined);
});

test("no route (404/405) or a refused batch version (422) marks the capability unsupported: nothing lost, nothing more queued", async () => {
  for (const status of [404, 405, 422]) {
    const { store, signer } = seeded(2);
    const server = await startServer(() => ({ status, body: {} }));
    const outcome = await uploadPending(store, { url: server.url, credential: "sbm_x" });
    assert.equal(outcome.result, "unsupported", String(status));
    assert.equal(store.pendingSummary().count, 2, "kept locally");
    assert.equal(store.state().capability, "unsupported");
    assert.equal(store.enqueue(sessionDraft(), CTX, signer).reason, "unsupported");
    assert.equal(store.pendingSummary().count, 2, "no unbounded growth");
    store.setCapability("active", null); // what `observations retry` does
    assert.equal(store.enqueue(sessionDraft(), CTX, signer).queued, true);
    await server.close(); store.close();
  }
});

test("a stale generation is terminal: the backlog is kept locally, upload stops and is never retried forever", async () => {
  const { store, signer } = seeded(3);
  const server = await startServer((items) => ({ status: 200, body: results(items, "rejected", "stale_generation") }));
  const outcome = await uploadPending(store, { url: server.url, credential: "sbm_x" });
  assert.equal(outcome.result, "blocked");
  assert.equal(store.pendingSummary().count, 0);
  assert.deepEqual(store.terminalCounts(), { stale_generation: 3 });
  assert.equal(store.state().capability, "blocked");
  assert.equal(store.enqueue(sessionDraft(), CTX, signer).reason, "blocked");
  const before = server.requests.length;
  await uploadPending(store, { url: server.url, credential: "sbm_x" });
  assert.equal(server.requests.length, before, "no further attempts");
  assert.equal(store.bindGeneration(2).ok, true, "reconnecting with a new generation clears the block");
  assert.equal(store.state().capability, "active");
  await server.close(); store.close();
});

test("unsupported item version and identity or sequence conflicts are terminal per item; the rest of the batch is unaffected", async () => {
  const { store } = seeded(4);
  const codes = [["rejected", "unsupported_version"], ["accepted", "ok"], ["rejected", "identity_conflict"], ["rejected", "sequence_conflict"]];
  const server = await startServer((items) => ({ status: 200, body: { version: "1.0", results: items.map((item, index) => ({ index, observation_id: item.payload.observation_id, status: codes[index][0], code: codes[index][1], retryable: false })) } }));
  await uploadPending(store, { url: server.url, credential: "sbm_x" });
  assert.equal(store.pendingSummary().count, 0);
  assert.deepEqual(store.terminalCounts(), { unsupported_version: 1, identity_conflict: 1, sequence_conflict: 1 });
  const before = server.requests.length;
  await uploadPending(store, { url: server.url, credential: "sbm_x" });
  assert.equal(server.requests.length, before, "refused items are never resent");
  await server.close(); store.close();
});

test("a connection lost mid-response resends the whole batch byte for byte, and the server dedupes", async () => {
  const clock = { t: Date.now() };
  const { store } = seeded(3, () => clock.t);
  let attempt = 0;
  const server = await startServer((items) => (++attempt === 1 ? "drop" : { status: 200, body: results(items, "duplicate", "ok") }));
  const opts = { url: server.url, credential: "sbm_x", now: () => clock.t };
  assert.equal((await uploadPending(store, opts)).result, "error");
  assert.equal(store.pendingSummary().count, 3, "an interrupted response acknowledges nothing");
  clock.t += 3_600_000;
  await uploadPending(store, opts);
  assert.equal(store.pendingSummary().count, 0);
  assert.equal(server.requests[0].raw, server.requests[1].raw, "identical bytes on resend");
  await server.close(); store.close();
});

test("413 halves the batch; server errors and auth failures back off without dropping anything; batches respect the 100-item limit", async () => {
  const { store, signer } = seeded(0);
  for (let i = 0; i < 150; i += 1) store.enqueue(sessionDraft(), CTX, signer);
  let calls = 0;
  const server = await startServer((items) => (++calls === 1 ? { status: 413, body: {} } : { status: 200, body: results(items) }));
  await uploadPending(store, { url: server.url, credential: "sbm_x", maxBatches: 20 });
  assert.equal(server.requests[0].json.items.length, 100);
  assert.ok(server.requests[1].json.items.length <= 50, "batch halved after 413");
  assert.equal(store.pendingSummary().count, 0);
  assert.ok(server.requests.every((r) => r.json.version === "1.0" && r.json.items.length <= 100));
  await server.close(); store.close();
  for (const status of [500, 503, 401, 403, 400]) {
    const s = seeded(1);
    const bad = await startServer(() => ({ status, body: {} }));
    assert.equal((await uploadPending(s.store, { url: bad.url, credential: "sbm_x" })).result, "error", String(status));
    assert.equal(s.store.pendingSummary().count, 1);
    assert.equal(s.store.state().capability, "active", "not marked unsupported");
    await bad.close(); s.store.close();
  }
});

test("an unreachable workspace never throws and keeps the backlog", async () => {
  const { store } = seeded(2);
  const outcome = await uploadPending(store, { url: "http://127.0.0.1:9", credential: "sbm_x", timeoutMs: 500 });
  assert.equal(outcome.result, "error");
  assert.equal(store.pendingSummary().count, 2);
  store.close();
});

test("upload refuses a non-HTTPS, non-localhost workspace URL", async () => {
  const { store } = seeded(1);
  const outcome = await uploadPending(store, { url: "http://example.com", credential: "sbm_x", fetch: () => { throw new Error("must not send"); } });
  assert.equal(outcome.result, "unsupported");
  assert.equal(store.pendingSummary().count, 1);
  store.close();
});

test("a batch in flight is reserved for the process that took it; a lapsed or released reservation is available again", () => {
  const clock = { t: Date.now() };
  const { store } = seeded(3, () => clock.t);
  const first = store.nextBatch(undefined, true);
  assert.equal(first.length, 3);
  assert.deepEqual(store.nextBatch(undefined, true), [], "a second uploader does not resend the same items");
  store.release(first.map((r) => r.observation_id));
  assert.equal(store.nextBatch(undefined, true).length, 3);
  clock.t += 31_000;
  assert.equal(store.nextBatch(undefined, true).length, 3, "a crashed sender's reservation lapses");
  store.close();
});
