import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { canonical, createAttester, createCloudExporter, createMemoryCloudOutbox } from "../dist/index.js";

// Each delivery batch's record numbers are signed with the computer's enrolled key, over a string the workspace
// rebuilds from what it received. The material is recomputed here from the body alone, not from the exporter's helper.

const receipt = (id, value = 1) => ({
  payload: { action_ref: { action_id: id }, value, note: "café" },
  signature: { alg: "Ed25519", sig: "fixture" },
});

function capture({ failFirst = 0 } = {}) {
  const bodies = [];
  let fail = failFirst;
  const f = async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    if (fail > 0) { fail--; return { ok: false, status: 500 }; }
    return { ok: true, status: 200 };
  };
  f.bodies = bodies;
  return f;
}

function expectedMaterial(credentialId, body) {
  const digests = body.receipts.map((r) => createHash("sha256").update(Buffer.from(canonical(r), "utf8")).digest("hex"));
  return "scopebond:delivery-sequence/v1\n" + canonical({
    credential_id: credentialId, queue: body.queue ?? null, seq: body.seq, receipts: digests,
  });
}

function proofVerifies(body, credentialId, attester) {
  const proof = body.seq_proof;
  if (!proof || proof.kid !== attester.kid || typeof proof.signature !== "string") return false;
  return verify(null, Buffer.from(expectedMaterial(credentialId, body), "utf8"), createPublicKey(attester.publicKeyPem), Buffer.from(proof.signature, "base64"));
}

test("seq_proof signs each batch's numbers with the enrolled key over the exact material sent", async () => {
  const attester = createAttester();
  const credentialId = "cred_seq_proof_1";
  const f = capture();
  const outbox = createMemoryCloudOutbox();
  const ex = createCloudExporter({
    url: "https://cloud.example", credential: "sbm_seq", outbox, batchSize: 2, flushMs: 1e9, fetch: f,
    sequenceProof: { attester, credentialId },
  });
  for (let i = 1; i <= 3; i++) ex.enqueue(receipt(`action:seq-proof-000${i}`, i));
  await ex.flush();
  ex.stop();
  assert.equal(f.bodies.length, 2);
  const queue = outbox.status().queueId;
  assert.deepEqual(f.bodies.map((b) => b.seq), [[1, 2], [3]]);
  for (const body of f.bodies) {
    assert.equal(body.queue, queue);
    assert.deepEqual(Object.keys(body.seq_proof).sort(), ["kid", "signature"]);
    assert.ok(proofVerifies(body, credentialId, attester), "the proof verifies over the body as sent");
    // Bound to the credential, the numbers and the records: change any of them and it no longer verifies.
    assert.equal(proofVerifies(body, "cred_other", attester), false);
    assert.equal(proofVerifies({ ...body, seq: body.seq.map((n) => n + 10) }, credentialId, attester), false);
    assert.equal(proofVerifies({ ...body, receipts: body.receipts.map((r, i) => (i === 0 ? receipt("action:seq-proof-swapped") : r)) }, credentialId, attester), false);
    assert.equal(proofVerifies({ ...body, queue: null }, credentialId, attester), false);
  }
});

test("no seq_proof without an attester or a credential id; the numbers still go as before", async () => {
  const attester = createAttester();
  for (const sequenceProof of [undefined, { attester, credentialId: "" }, { attester: undefined, credentialId: "cred_x" }]) {
    const f = capture();
    const ex = createCloudExporter({
      url: "https://cloud.example", credential: "sbm_seq", outbox: createMemoryCloudOutbox(), flushMs: 1e9, fetch: f,
      ...(sequenceProof ? { sequenceProof } : {}),
    });
    ex.enqueue(receipt("action:seq-proof-plain-0001"));
    await ex.flush();
    ex.stop();
    assert.equal(f.bodies.length, 1);
    assert.deepEqual(f.bodies[0].seq, [1]);
    assert.match(f.bodies[0].queue, /^[0-9a-f]{32}$/);
    assert.equal("seq_proof" in f.bodies[0], false);
  }
});

test("a resent batch carries a valid proof for the same numbers", async () => {
  const attester = createAttester();
  const credentialId = "cred_seq_proof_resend";
  let now = 1_000;
  const f = capture({ failFirst: 1 });
  const ex = createCloudExporter({
    url: "https://cloud.example", credential: "sbm_seq", outbox: createMemoryCloudOutbox({ now: () => now }),
    flushMs: 100, maxRetryMs: 1_000, fetch: f, now: () => now, sequenceProof: { attester, credentialId },
  });
  ex.enqueue(receipt("action:seq-proof-resend-0001"));
  ex.enqueue(receipt("action:seq-proof-resend-0002"));
  await ex.flush(); // refused with a 500: the records stay queued
  assert.equal(ex.pending(), 2);
  now += 100;
  await ex.flush(); // sent again
  ex.stop();
  assert.equal(ex.pending(), 0);
  assert.equal(f.bodies.length, 2);
  const [first, again] = f.bodies;
  assert.deepEqual(again.seq, first.seq);
  assert.equal(again.queue, first.queue);
  assert.deepEqual(again.receipts, first.receipts);
  assert.ok(proofVerifies(first, credentialId, attester));
  assert.ok(proofVerifies(again, credentialId, attester));
  assert.equal(again.seq_proof.kid, attester.kid);
});
