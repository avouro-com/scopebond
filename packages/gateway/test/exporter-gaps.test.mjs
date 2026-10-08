// What the workspace can learn about records a bounded queue could not keep. A record dropped at capacity takes a
// number before it is dropped, so the numbers the workspace sees leave a hole where it was, and the exporter reports
// the drop to its gap handler.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAttester, createGateway, createCloudExporter, createMemoryCloudOutbox, LOSSLESS_CLOUD_OUTBOX } from "../dist/index.js";
import { SqliteCloudOutbox } from "../dist/node.js";

const policy = {
  vocabulary_version: "1.0", policy_id: "gaps", version: 1,
  clauses: [{ id: "allowed", type: "action_allowlist", mode: "enforce", action_types: ["shell.exec", "git.push"] }],
};
const attester = createAttester();
async function receipts(n, from = 0) {
  const gw = createGateway({ authentication: { mode: "insecure-development" }, mode: "check_only", attester, policy });
  const out = [];
  for (let i = from; i < from + n; i++) out.push((await gw.check({ intent: { action_type: "shell.exec", params: { command: `echo ${i}`, program: "echo" } } })).receipt);
  return out;
}
/** The workspace's accounting: numbers between the lowest and highest seen that never arrived. */
function workspaceMissing(bodies) {
  const seen = new Set(bodies.flatMap((b) => (b.seq ?? []).filter((s) => s !== null)));
  if (!seen.size) return 0;
  const first = Math.min(...seen), max = Math.max(...seen);
  return Math.max(0, max - first + 1 - seen.size);
}
function workspace() {
  const bodies = [];
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    return { ok: true, status: 200, json: async () => ({ accepted: body.receipts.length }), text: async () => "{}", headers: new Map() };
  };
  return { bodies, fetch };
}

const outboxes = {
  sqlite: (o) => new SqliteCloudOutbox(join(mkdtempSync(join(tmpdir(), "sb-gaps-")), "o.db"), o),
  memory: (o) => createMemoryCloudOutbox(o),
};

for (const [kind, open] of Object.entries(outboxes)) {
  test(`${kind}: a record dropped at capacity takes a number, is reported, and shows as missing to the workspace`, async () => {
    const rs = await receipts(5);
    const outbox = open({ maxPending: 3 });
    const ws = workspace();
    const gaps = [];
    const exporter = createCloudExporter({ url: "https://ws.example", credential: "sbm_x", outbox, flushMs: 1e9, fetch: ws.fetch, onGap: (g) => gaps.push(g) });
    for (const r of rs) exporter.enqueue(r);
    const st = exporter.status();
    assert.equal(st.gaps, 2);
    assert.deepEqual(gaps.map((g) => g.reason), ["capacity", "capacity"]);
    assert.deepEqual(gaps.map((g) => g.seq), [4, 5], "each dropped record took the next number");
    assert.equal(st.seqAssigned, 5, "the dropped records were numbered before they were dropped");
    await exporter.flush();
    // The next record that fits carries a number past the dropped ones, so the hole is counted.
    for (const r of await receipts(1, 5)) exporter.enqueue(r);
    await exporter.flush();
    exporter.stop();
    assert.deepEqual(ws.bodies.flatMap((b) => b.seq).sort((x, y) => x - y), [1, 2, 3, 6]);
    assert.equal(workspaceMissing(ws.bodies), 2, "the workspace counts both dropped records as missing");
  });

  test(`${kind}: a lossless queue keeps more than the default cap`, async () => {
    const outbox = open(LOSSLESS_CLOUD_OUTBOX);
    const base = (await receipts(1))[0];
    for (let i = 0; i < 10_050; i++) outbox.enqueue({ ...base, payload: { ...base.payload, action_ref: { ...base.payload.action_ref, action_id: `a${i}` } } });
    const st = outbox.status();
    outbox.close?.();
    assert.equal(st.gaps, 0);
    assert.equal(st.pending, 10_050);
  });
}
