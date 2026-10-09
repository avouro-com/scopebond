import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { MemoryReceiptStore, canonical } from "@scopebond/gateway";
import { CHAIN_HEADS_FILE, loadOrCreateAttester, readChainHeads, recordChainHead } from "@scopebond/gateway/node";
import { attachExporter, checkChains } from "../dist/index.js";

// The hook keeps the chain head each delivery answer carries, and `verify --anchor` checks the kept heads against a
// published day of anchors and the segments downloaded from the workspace.

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const sha = (text) => createHash("sha256").update(text).digest("hex");
const ANCHOR = "a".repeat(64);

function segmentKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  return { spki, kid: "seg_" + sha(spki).slice(0, 16), sign: (text) => edSign(null, Buffer.from(text), privateKey).toString("base64") };
}
function head(key, seq, at, segment = null) {
  const body = { type: "scopebond:chain-head", version: 1, anchor_id: ANCHOR, ingest_seq: seq, segment, issued_at: at };
  return key ? { head: body, signed: true, signature: { alg: "Ed25519", kid: key.kid, sig: key.sign("scopebond:chain-head/v1\n" + canonical(body)) } }
    : { head: body, signed: false, signature: null };
}
function list(key, date, heads) {
  const body = { type: "scopebond:chain-anchors", version: 1, date, key: { alg: "Ed25519", kid: key.kid, public_key_spki: key.spki }, heads };
  return { ...body, signed: true, signature: { alg: "Ed25519", kid: key.kid, sig: key.sign("scopebond:chain-anchors/v1\n" + canonical(body)) } };
}
function merkle(leaves) {
  let level = leaves.slice();
  while (level.length > 1) { const next = []; for (let i = 0; i < level.length; i += 2) next.push(sha(level[i] + (level[i + 1] ?? level[i]))); level = next; }
  return level[0];
}
function segment(previous, first, count) {
  const records = Array.from({ length: count }, (_, i) => {
    const receipt = { payload: { type: "fixture", n: first + i }, signature: { alg: "Ed25519", sig: "fixture" } };
    return { ingest_seq: first + i, event_id: `e${first + i}`, leaf: sha(canonical(receipt.payload)), receipt };
  });
  const text = canonical({ type: "scopebond:evidence-segment", version: 1, bounds: { first_ingest_seq: first, last_ingest_seq: first + count - 1 },
    previous_segment_digest: previous, records, proof: { algorithm: "sha256-merkle", merkle_root: merkle(records.map((r) => r.leaf)), leaf_count: count } });
  return { text, digest: sha(text) };
}

function folder() {
  const dir = mkdtempSync(join(tmpdir(), "sb-hook-chain-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("the hook keeps the chain head of each delivery answer beside its receipts", async () => {
  const { dir, done } = folder();
  try {
    const { attester } = loadOrCreateAttester({ file: join(dir, "attester.key") });
    const answer = head(null, 1, "2026-10-07T10:00:00.000Z");
    const fetchImpl = async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ ok: true, ingested: 1, chain_head: answer }) });
    const connection = { url: "https://cloud.example", credential: "sbm_chain", credential_id: "cred_chain", organization_id: "org_1", environment_id: "env_1", gateway_id: "gw_1", attester_kid: attester.kid, scopes: ["ingest"], expires_at: "2099-01-01T00:00:00Z" };
    const { store, exporter } = attachExporter(join(dir, "receipts.db.cloud-outbox.db"), connection, new MemoryReceiptStore(), fetchImpl);
    try {
      await store.put({ payload: { action_ref: { action_id: "action:chain-head-hook-1" } }, signature: { alg: "Ed25519", sig: "fixture" } });
      await exporter.flush();
    } finally { exporter.stop(); }
    const [kept, ...more] = readChainHeads(join(dir, CHAIN_HEADS_FILE)).chains[ANCHOR];
    assert.deepEqual(more, []);
    const { local, ...signed } = kept;
    assert.deepEqual(signed, answer);
    // Beside it, this computer's own times: when the delivery left and when its answer arrived.
    assert.ok(Date.parse(local.sent_at) <= Date.parse(local.received_at), JSON.stringify(local));
  } finally { done(); }
});

test("kept heads that agree with a published day and with the segments pass", async () => {
  const { dir, done } = folder();
  try {
    const key = segmentKey();
    const a = segment(null, 1, 3), b = segment(a.digest, 4, 3);
    recordChainHead(join(dir, CHAIN_HEADS_FILE), head(key, 3, "2026-10-06T10:00:00.000Z", { digest: a.digest, last_ingest_seq: 3 }));
    recordChainHead(join(dir, CHAIN_HEADS_FILE), head(key, 6, "2026-10-07T10:00:00.000Z", { digest: b.digest, last_ingest_seq: 6 }));
    const anchorFile = join(dir, "2026-10-07.json");
    writeFileSync(anchorFile, JSON.stringify(list(key, "2026-10-07", [head(key, 6, "2026-10-07T10:05:00.000Z", { digest: b.digest, last_ingest_seq: 6 })])));
    const segments = join(dir, "segments");
    mkdirSync(segments);
    writeFileSync(join(segments, "000000000001.json.gz"), gzipSync(a.text));
    writeFileSync(join(segments, "000000000004.json.gz"), gzipSync(b.text));
    const report = await checkChains({ dir, anchors: [anchorFile], segmentsDir: segments });
    assert.deepEqual(report.problems, []);
    assert.equal(report.ok, true);
    assert.ok(report.lines.join("\n").includes(`Anchor 2026-10-07: signed by ${key.kid}; 1 chain(s), 1 of them this computer's`), report.lines.join("\n"));
    assert.match(report.lines.join("\n"), /every kept head's segment is in its chain \(through sequence 6\)/);
    // An https address is fetched; a plain http one elsewhere is refused.
    const fetched = await checkChains({ dir, anchors: ["https://anchors.example/2026/10/07.json"], fetchImpl: async () => new Response(JSON.stringify(list(key, "2026-10-07", []))) });
    assert.equal(fetched.ok, true);
    const refused = await checkChains({ dir, anchors: ["http://anchors.example/x.json"], fetchImpl: async () => { throw new Error("not called"); } });
    assert.match(refused.problems.join("\n"), /only https addresses are fetched/);
  } finally { done(); }
});

test("verify --anchor fails when the published chain went back below a head this computer kept, or a segment is gone", () => {
  const { dir, done } = folder();
  try {
    const project = join(dir, "project");
    const hookDir = join(project, ".scopebond");
    mkdirSync(hookDir, { recursive: true });
    const env = { ...process.env, SCOPEBOND_HOOK_DIR: hookDir };
    const key = segmentKey();
    const a = segment(null, 1, 3), b = segment(a.digest, 4, 3), c = segment(b.digest, 7, 3);
    recordChainHead(join(hookDir, CHAIN_HEADS_FILE), head(key, 9, "2026-10-07T12:00:00.000Z", { digest: c.digest, last_ingest_seq: 9 }));
    // Published later that day: the chain is back at 6.
    const anchorFile = join(dir, "anchors.json");
    writeFileSync(anchorFile, JSON.stringify(list(key, "2026-10-07", [head(key, 6, "2026-10-07T23:00:00.000Z", { digest: b.digest, last_ingest_seq: 6 })])));
    const segments = join(dir, "segments");
    mkdirSync(segments);
    writeFileSync(join(segments, "a.json.gz"), gzipSync(a.text));
    writeFileSync(join(segments, "b.json.gz"), gzipSync(b.text));
    const result = spawnSync(process.execPath, [cli, "verify", "--anchor", anchorFile, "--segments", segments], { encoding: "utf8", cwd: project, env });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /went back: sequence 9 \(kept/);
    assert.match(result.stderr, /is not among the segments given/);
    assert.match(result.stderr, /records may have been removed, reordered or re-chained/);
    assert.ok(!existsSync(join(hookDir, "receipts.db")), "no receipts were needed for the chain check");
    const unknown = spawnSync(process.execPath, [cli, "verify", "--anchors", anchorFile], { encoding: "utf8", cwd: project, env });
    assert.equal(unknown.status, 2);
  } finally { done(); }
});
