import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { MemoryReceiptStore, canonical } from "@scopebond/gateway";
import { CHAIN_HEADS_FILE, loadOrCreateAttester, readChainHeads, recordChainHead } from "@scopebond/gateway/node";
import { attachExporter, checkChains } from "../dist/index.js";

// `scopebond verify --anchor` against a workspace that is the party being checked: a rollback it hides behind the issue
// times it signs is still reported, and documents it shapes to break the check are reported, not crashed on.

const sha = (text) => createHash("sha256").update(text).digest("hex");
const ANCHOR = "a".repeat(64);

function segmentKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  return { spki, kid: "seg_" + sha(spki).slice(0, 16), sign: (text) => edSign(null, Buffer.from(text), privateKey).toString("base64") };
}
function head(key, seq, digest, at) {
  const body = { type: "scopebond:chain-head", version: 1, anchor_id: ANCHOR, ingest_seq: seq, segment: { digest: digest.repeat(64), last_ingest_seq: seq }, issued_at: at };
  return { head: body, signed: true, signature: { alg: "Ed25519", kid: key.kid, sig: key.sign("scopebond:chain-head/v1\n" + canonical(body)) } };
}
function list(key, date, heads) {
  const body = { type: "scopebond:chain-anchors", version: 1, date, key: { alg: "Ed25519", kid: key.kid, public_key_spki: key.spki }, heads };
  return { ...body, signed: true, signature: { alg: "Ed25519", kid: key.kid, sig: key.sign("scopebond:chain-anchors/v1\n" + canonical(body)) } };
}
function folder() {
  const dir = mkdtempSync(join(tmpdir(), "sb-hook-rollback-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a rolled-back chain whose new head is backdated is reported by verify --anchor", async () => {
  for (const at of ["2026-10-09T09:59:59.000Z", "2026-10-09T10:00:00.000Z"]) {
    const { dir, done } = folder();
    try {
      const key = segmentKey();
      const A = head(key, 100, "1", "2026-10-09T10:00:00.000Z");
      const B = head(key, 50, "2", at);
      // The workspace answers the first delivery with seq 100 and the next one, after it dropped records 51-100, with 50.
      const answers = [A, B];
      let n = 0;
      const fetchImpl = async () => {
        const answer = { ok: true, ingested: 1, chain_head: answers[Math.min(n++, answers.length - 1)] };
        return { ok: true, status: 200, headers: new Headers(), json: async () => answer };
      };
      const { attester } = loadOrCreateAttester({ file: join(dir, "attester.key") });
      const connection = { url: "https://cloud.example", credential: "sbm_chain", credential_id: "cred_chain", organization_id: "org_1", environment_id: "env_1", gateway_id: "gw_1", attester_kid: attester.kid, scopes: ["ingest"], expires_at: "2099-01-01T00:00:00Z" };
      const { store, exporter } = attachExporter(join(dir, "receipts.db.cloud-outbox.db"), connection, new MemoryReceiptStore(), fetchImpl);
      try {
        for (const id of ["action:rollback-1", "action:rollback-2"]) {
          await store.put({ payload: { action_ref: { action_id: id } }, signature: { alg: "Ed25519", sig: "fixture" } });
          await exporter.flush();
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      } finally { exporter.stop(); }
      assert.deepEqual(readChainHeads(join(dir, CHAIN_HEADS_FILE)).chains[ANCHOR].map((h) => h.head.ingest_seq), [100, 50]);

      // The workspace's signed day list agrees with the lower head.
      const anchorFile = join(dir, "anchors-2026-10-09.json");
      writeFileSync(anchorFile, JSON.stringify(list(key, "2026-10-09", [B])));
      const report = await checkChains({ dir, anchors: [anchorFile] });
      assert.equal(report.ok, false, `${at}: ${JSON.stringify(report)}`);
      assert.match(report.problems.join("\n"), /went back: sequence 100 \(kept/);
      assert.ok(!report.lines.some((l) => /Chain heads agree/.test(l)), report.lines.join("\n"));
    } finally { done(); }
  }
});

test("verify --anchor reports a hostile list or segment as a problem instead of crashing", async () => {
  const { dir, done } = folder();
  try {
    const key = segmentKey();
    const kept = head(key, 3, "1", "2026-10-09T10:00:00.000Z");
    recordChainHead(join(dir, CHAIN_HEADS_FILE), kept);
    // A list whose key cannot be canonical JSON.
    const lone = join(dir, "lone.json");
    writeFileSync(lone, JSON.stringify({ type: "scopebond:chain-anchors", version: 1, date: "2026-10-09", key: { alg: "Ed25519", kid: "seg_x", public_key_spki: "\ud800" }, heads: [], signed: true, signature: { kid: "seg_x", sig: "AA==" } }));
    // A list that names this computer's head key but publishes something that is not a key.
    const notKey = join(dir, "not-a-key.json");
    writeFileSync(notKey, JSON.stringify({ type: "scopebond:chain-anchors", version: 1, date: "2026-10-09", key: { alg: "Ed25519", kid: key.kid, public_key_spki: 123 }, heads: [kept], signed: true, signature: { alg: "Ed25519", kid: key.kid, sig: "AA==" } }));
    // A segment with a record that is not an object.
    const segments = join(dir, "segments");
    mkdirSync(segments);
    writeFileSync(join(segments, "a.json.gz"), gzipSync(canonical({ type: "scopebond:evidence-segment", version: 1, bounds: { first_ingest_seq: 1, last_ingest_seq: 1 }, previous_segment_digest: null, records: [null], proof: { merkle_root: "x" } })));
    const report = await checkChains({ dir, anchors: [lone, notKey], segmentsDir: segments });
    assert.equal(report.ok, false);
    const problems = report.problems.join("\n");
    assert.match(problems, /anchor 2026-10-09: the list signature does not verify/);
    assert.match(problems, /anchor 2026-10-09: a signed list must publish its key/);
    assert.match(problems, /the record at position 0 is not an object/);
  } finally { done(); }
});
