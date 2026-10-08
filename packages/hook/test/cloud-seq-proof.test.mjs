import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryReceiptStore, canonical } from "@scopebond/gateway";
import { loadOrCreateAttester } from "@scopebond/gateway/node";
import { attachExporter, sequenceProofFor } from "../dist/index.js";

const receipt = (id) => ({ payload: { action_ref: { action_id: id }, value: 1 }, signature: { alg: "Ed25519", sig: "fixture" } });

function material(credentialId, body) {
  const digests = body.receipts.map((r) => createHash("sha256").update(Buffer.from(canonical(r), "utf8")).digest("hex"));
  return "scopebond:delivery-sequence/v1\n" + canonical({ credential_id: credentialId, queue: body.queue ?? null, seq: body.seq, receipts: digests });
}

function connectionFor(attester, extra = {}) {
  return {
    url: "https://cloud.example", credential: "sbm_hook_seq", credential_id: "cred_hook_seq", organization_id: "org_1",
    environment_id: "env_1", gateway_id: "gw_1", attester_kid: attester.kid, scopes: ["ingest"], expires_at: "2099-01-01T00:00:00Z", ...extra,
  };
}

async function deliverOne(dir, connection) {
  const bodies = [];
  const fetchImpl = async (_url, opts) => { bodies.push(JSON.parse(opts.body)); return { ok: true, status: 200, headers: new Headers() }; };
  const { store, exporter } = attachExporter(join(dir, "receipts.db.cloud-outbox.db"), connection, new MemoryReceiptStore(), fetchImpl);
  try {
    await store.put(receipt("action:hook-seq-proof-0001"));
    await exporter.flush();
  } finally { exporter.stop(); }
  return bodies;
}

test("the hook signs delivered record numbers with its enrolled key and the connection's credential id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-hook-seqproof-"));
  try {
    const { attester } = loadOrCreateAttester({ file: join(dir, "attester.key") });
    const bodies = await deliverOne(dir, connectionFor(attester));
    assert.equal(bodies.length, 1);
    const [body] = bodies;
    assert.deepEqual(body.seq, [1]);
    assert.match(body.queue, /^[0-9a-f]{32}$/);
    assert.equal(body.seq_proof.kid, attester.kid);
    assert.ok(verify(null, Buffer.from(material("cred_hook_seq", body), "utf8"), createPublicKey(attester.publicKeyPem), Buffer.from(body.seq_proof.signature, "base64")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the hook sends no seq_proof without a key, without a credential id, or under a key the connection did not enroll", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-hook-seqproof-none-"));
  try {
    const other = loadOrCreateAttester({ file: join(dir, "elsewhere", "attester.key") }).attester;
    // No attester.key in the folder: nothing to sign with.
    const [unsigned] = await deliverOne(dir, connectionFor(other));
    assert.deepEqual(unsigned.seq, [1]);
    assert.equal("seq_proof" in unsigned, false);
    const { attester } = loadOrCreateAttester({ file: join(dir, "attester.key") });
    assert.equal(sequenceProofFor(connectionFor(attester, { credential_id: undefined }), attester), undefined);
    assert.equal(sequenceProofFor(connectionFor(other), attester), undefined);
    assert.equal(sequenceProofFor(connectionFor(attester), undefined), undefined);
    assert.deepEqual(sequenceProofFor(connectionFor(attester), attester), { attester, credentialId: "cred_hook_seq" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
