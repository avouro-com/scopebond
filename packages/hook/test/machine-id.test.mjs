// The machine id the hook sends its workspace: in the enrollment's body (in the scope it knows then), and in the
// x-scopebond-machine-id header of the rules check, a delivery and an observation upload (in the connected workspace's
// scope). machine-id.json is written beforehand with made-up ids, so nothing here depends on this computer's own id;
// the OS readers and the hash are tested in @scopebond/gateway.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryReceiptStore } from "@scopebond/gateway";
import { loadOrCreateAttester } from "@scopebond/gateway/node";
import {
  approvedWorkspaceId, attachExporter, connectCloud, machineIdField, machineIdFor, openObservations, scaffold, syncPolicy, MACHINE_ID_FILE,
} from "../dist/index.js";
import { ENFORCE } from "./enforce-all.mjs";
import { makeHome, startServer } from "./observation-helpers.mjs";

const HEADER = "x-scopebond-machine-id";
const ID_UNSCOPED = "m1:" + "U".repeat(43);
const ID_ORG = "m1:" + "O".repeat(43);
const ID_OTHER = "m1:" + "X".repeat(43);

/** Keep `id` as this folder's machine id in `scope`, as if it had just been worked out. */
const keep = (dir, scope, id) => writeFileSync(join(dir, MACHINE_ID_FILE), JSON.stringify({ version: 1, scope, machine_id: id, checked_at: Date.now() }));
const kept = (dir) => JSON.parse(readFileSync(join(dir, MACHINE_ID_FILE), "utf8"));

const bundle = {
  enrollment_token: "sbe_test123", expires_at: "2099-01-01T00:00:00.000Z",
  proof_canonical: JSON.stringify({ challenge: "c1", enrollment_id: "e1", type: "scopebond:gateway-enrollment", version: 1 }),
};

/** A workspace's enrollment route that records what it was sent and enrolls into `org`. */
function enrollRoute(dir, org) {
  const bodies = [];
  const fetchImpl = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    const { attester } = loadOrCreateAttester({ file: join(dir, "attester.key") });
    const { attester: agent } = loadOrCreateAttester({ file: join(dir, "agent.key") });
    return new Response(JSON.stringify({
      credential_id: "cred-1", credential: "sbm_test_credential", organization_id: org, environment_id: "env-1", gateway_id: "gw-1",
      attester_kid: attester.kid, agent_kid: agent.kid, scopes: ["receipt:ingest"], expires_at: "2099-01-01T00:00:00.000Z",
    }), { status: 201 });
  };
  return { bodies, fetchImpl };
}

test("a first enrollment sends the unscoped machine id, then the id is kept in the workspace's scope", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-machine-id-"));
  scaffold(dir, ENFORCE);
  keep(dir, "unscoped", ID_UNSCOPED);
  const route = enrollRoute(dir, "org-1");
  const connection = await connectCloud(dir, "http://127.0.0.1:9", bundle, route.fetchImpl);
  assert.equal(route.bodies.length, 1);
  assert.equal(route.bodies[0].machine_id, ID_UNSCOPED, "sent in the enrollment body");
  assert.ok(!readFileSync(join(dir, "cloud.json"), "utf8").includes("machine_id"), "not part of the connection");
  // Enrolled: the id is now worked out in the workspace's scope (from this computer's own OS id, or none).
  assert.equal(connection.organization_id, "org-1");
  const after = kept(dir);
  assert.equal(after.scope, "org-1");
  assert.ok(after.machine_id === null || /^m1:[A-Za-z0-9_-]{43}$/.test(after.machine_id));
});

test("connecting again uses the scope of the workspace the folder is connected to, or one the sign-in names", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-machine-id-"));
  scaffold(dir, ENFORCE);
  keep(dir, "org-1", ID_ORG);
  const first = enrollRoute(dir, "org-1");
  await connectCloud(dir, "http://127.0.0.1:9", bundle, first.fetchImpl);
  assert.equal(first.bodies[0].machine_id, ID_ORG, "a folder that enrolled with a workspace keeps its scope");
  const again = enrollRoute(dir, "org-1");
  await connectCloud(dir, "http://127.0.0.1:9", bundle, again.fetchImpl);
  assert.equal(again.bodies[0].machine_id, ID_ORG, "a reconnecting computer sends the same id");
  // A sign-in approved into another workspace says so: the id is worked out for that workspace instead.
  keep(dir, "org-2", ID_OTHER);
  const other = enrollRoute(dir, "org-2");
  await connectCloud(dir, "http://127.0.0.1:9", bundle, other.fetchImpl, "org-2");
  assert.equal(other.bodies[0].machine_id, ID_OTHER);
  assert.equal(approvedWorkspaceId({ organization_id: "org-2", enrollment: {} }), "org-2");
  assert.equal(approvedWorkspaceId({ enrollment: {} }), null);
  assert.equal(approvedWorkspaceId({ organization_id: 7 }), null);
});

test("no machine id: the enrollment and the sign-in carry no machine_id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-machine-id-"));
  scaffold(dir, ENFORCE);
  keep(dir, "unscoped", null);
  assert.deepEqual(machineIdField(dir), {});
  const route = enrollRoute(dir, "org-1");
  await connectCloud(dir, "http://127.0.0.1:9", bundle, route.fetchImpl);
  assert.ok(!("machine_id" in route.bodies[0]));
  keep(dir, "unscoped", ID_UNSCOPED);
  assert.deepEqual(machineIdField(dir), { machine_id: ID_UNSCOPED });
});

test("the rules check and its confirmation carry the header in the connected workspace's scope", async () => {
  const { dir, connection } = makeHome();
  keep(dir, connection.organization_id, ID_ORG);
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url: String(url), headers: init.headers }); return new Response(null, { status: 204 }); };
  await syncPolicy(dir, { agentKid: "kid-agent", hookVersion: "0.0.0", policyBuilds: () => true, fetchImpl, timeoutMs: 2000 });
  const rules = seen.find((r) => r.url.endsWith("/v1/policy"));
  assert.ok(rules, "the rules were checked");
  const header = (h) => (h instanceof Headers ? h.get(HEADER) : h[HEADER]);
  assert.equal(header(rules.headers), ID_ORG);
  // None without an id.
  keep(dir, connection.organization_id, null);
  seen.length = 0;
  await syncPolicy(dir, { agentKid: "kid-agent", hookVersion: "0.0.0", policyBuilds: () => true, fetchImpl, timeoutMs: 2000 });
  assert.ok(seen.length >= 1);
  for (const r of seen) assert.equal(header(r.headers) ?? undefined, undefined, r.url);
});

test("record delivery carries the header", async () => {
  const { connection } = makeHome();
  // The delivery queue in its own folder without a countersigning key, so every record is sent as it is (no summaries).
  const queueDir = mkdtempSync(join(tmpdir(), "sb-machine-id-queue-"));
  keep(queueDir, connection.organization_id, ID_ORG);
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url: String(url), headers: init.headers }); return new Response(JSON.stringify({ accepted: 1 }), { status: 200 }); };
  const { exporter } = attachExporter(join(queueDir, "receipts.db.cloud-outbox.db"), connection, new MemoryReceiptStore(), fetchImpl);
  try {
    exporter.enqueue({ payload: { action_ref: { action_id: "action:machine-id-1" }, value: 1, timestamp: new Date().toISOString() }, signature: { alg: "Ed25519", sig: "fixture" } });
    await exporter.flush();
  } finally { exporter.stop(); }
  const ingest = seen.find((r) => r.url.endsWith("/v1/ingest"));
  assert.ok(ingest, "the record was delivered");
  assert.equal(new Headers(ingest.headers).get(HEADER), ID_ORG);
});

test("an observation upload (the session heartbeat) carries the header", async () => {
  const server = await startServer();
  try {
    const { dir, connection } = makeHome({ url: server.url });
    keep(dir, connection.organization_id, ID_ORG);
    const opened = openObservations(dir, { spawnHeartbeat: false });
    assert.ok(opened.emitter, JSON.stringify(opened.status));
    const emitter = opened.emitter;
    try {
      emitter.emit({ kind: "session", occurredAt: Date.now(), sessionId: "sbs_machine_id", data: { event: "start" } });
      await emitter.flush(5000);
    } finally { emitter.close(); }
    assert.ok(server.requests.length >= 1, "the observation was sent");
    assert.equal(server.requests[0].headers[HEADER], ID_ORG);
    assert.equal(machineIdFor(dir, connection.organization_id), ID_ORG);
  } finally { await server.close(); }
});
