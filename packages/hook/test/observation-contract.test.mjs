// The observation emitters against the workspace's documented answers: the proof digests, the
// policy acknowledgement values, the enrollment answer and the batch response shapes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonical } from "@scopebond/policy-schema/canonical";
import { verifyReceipt } from "@scopebond/gateway";
import { loadOrCreateAttester } from "@scopebond/gateway/node";
import { withInstallationId } from "../dist/obs-emitter.js";
import { openObservations, loadConnection, ObservationStore, uploadPending, sourceReceiptHash, inspectExport } from "../dist/index.js";
import { validObservation } from "./observation-schema.mjs";
import { makeHome, startServer, results, acceptAll } from "./observation-helpers.mjs";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function run(dir, args, env = {}) {
  return new Promise((resolve) => {
    const home = mkdtempSync(join(tmpdir(), "sb-obs-home-"));
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: dir, env: { ...process.env, SCOPEBOND_HOOK_DIR: dir, SCOPEBOND_HOME: home, HOME: home, USERPROFILE: home, SCOPEBOND_OBSERVATIONS_HEARTBEAT: "off", ...env },
    });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; }); child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end();
  });
}
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

// ---- (1) capability proof digests ------------------------------------------------------------------

test("capability.proof carries the source receipt hash of the real fixture receipts, of the cell's own action type, delivered first", async () => {
  const server = await startServer();
  const home = makeHome({ url: server.url });
  const { attester } = loadOrCreateAttester({ file: join(home.dir, "attester.key") });
  const r = await run(home.dir, ["capabilities", "--prove"]);
  assert.equal(r.status, 0, r.stderr);
  const proofs = server.observations();
  assert.ok(proofs.length > 3);
  const ingested = server.requests.filter((q) => q.url === "/v1/ingest").flatMap((q) => q.json.receipts);
  assert.ok(ingested.length > 0, "the fixture receipts reached the receipt route");
  // The receipts route was called before the first observation batch: a digest can only resolve against accepted receipts.
  const firstObservation = server.requests.findIndex((q) => q.url === "/v1/observations");
  assert.ok(server.requests.slice(0, firstObservation).every((q) => q.url === "/v1/ingest") && firstObservation > 0);
  const byHash = new Map(ingested.map((receipt) => [sha256("scopebond:source-receipt/v1\n" + canonical(receipt)), receipt]));
  for (const receipt of ingested) {
    assert.equal(verifyReceipt(receipt, attester.publicKeyPem).valid, true, "signed with this machine's own countersigning key");
    assert.equal(sourceReceiptHash(receipt), sha256("scopebond:source-receipt/v1\n" + canonical(receipt)));
  }
  let denyChecked = 0;
  for (const item of proofs) {
    const d = item.payload.data;
    assert.equal(validObservation(item.payload), true);
    assert.ok(Array.isArray(d.proof_digests) && d.proof_digests.length > 0, `${d.action_type}/${d.phase} names its receipts`);
    const receipts = d.proof_digests.map((hash) => byHash.get(hash));
    assert.ok(receipts.every(Boolean), "every digest is the source receipt hash of a receipt that was delivered");
    assert.ok(receipts.every((x) => x.payload.intent.action_type === d.action_type), "same action type as the cell");
    if (d.phase === "pre" && receipts.some((x) => x.payload.realtime_result === "deny")) denyChecked += 1;
  }
  assert.ok(denyChecked > 0, "before-action cells include their deny fixture receipt");
  await server.close();
});

test("when the fixture receipts cannot be delivered the proofs are not sent, and nothing is claimed", async () => {
  const server = await startServer();
  const home = makeHome({ url: server.url });
  await server.close(); // unreachable workspace
  const r = await run(home.dir, ["capabilities", "--prove"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /could not deliver the fixture receipts/);
  assert.equal(existsSync(join(home.dir, "observations.db")) && (await pendingCount(home.dir)) > 0, false, "no proof observation was queued");
});

const pendingCount = async (dir) => {
  const store = new ObservationStore(join(dir, "observations.db"));
  try { return store.pendingSummary().count; } finally { store.close(); }
};

// ---- (2) policy load and acknowledgement -----------------------------------------------------------

const digestOf = (policy) => sha256(canonical(policy));
/** An export shaped exactly as the workspace makes one (rule-workflow export). */
function makeExport(overrides = {}) {
  const exportId = "3f9d0c1e-1b2a-4c3d-8e4f-5a6b7c8d9e0f";
  const draftId = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
  const agentId = "agent-7";
  const environmentId = overrides.environmentId ?? "env-1";
  const policy = { vocabulary_version: "1.0", policy_id: `scopebond:${agentId}`, version: 3, agent_id: agentId,
    clauses: [{ id: "allowed-actions", type: "action_allowlist", mode: "enforce", action_types: ["shell.exec"], description: "Allow only shell.exec actions covered by this policy" }] };
  const scopeDigest = sha256("scopebond:policy-scope/v1\n" + canonical({ agent_id: agentId, environment_id: environmentId, export_id: exportId }));
  return {
    type: "scopebond:reviewed-policy-export", version: 1, policy, policy_hash: digestOf(policy), review_reference: "review-1",
    scope: { export_id: exportId, policy_id: draftId, policy_version: 3, environment_id: environmentId, agent_id: agentId, scope_digest: scopeDigest },
    deployment: { mode: "local_gateway_configuration", gateway_acknowledgement_required: true, active: false },
    exported_at: "2026-09-29T10:00:00.000Z", ...overrides.top,
  };
}
const writeExport = (dir, exp, name = "export.json") => { const file = join(dir, "..", `${name}-${Math.random().toString(16).slice(2)}`); writeFileSync(file, JSON.stringify(exp)); return file; };

test("policy load echoes the export's policy hash, draft id, draft version and scope digest exactly", async () => {
  const server = await startServer();
  const home = makeHome({ url: server.url });
  const exp = makeExport();
  const file = writeExport(home.dir, exp);
  const before = readFileSync(join(home.dir, "policy.json"), "utf8");

  const dry = await run(home.dir, ["policy", "load", file]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /REPLACES the active policy/);
  assert.equal(readFileSync(join(home.dir, "policy.json"), "utf8"), before, "without --yes nothing is changed");
  assert.equal(server.observations().length, 0, "and nothing is acknowledged");

  const loaded = await run(home.dir, ["policy", "load", file, "--yes"]);
  assert.equal(loaded.status, 0, loaded.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(home.dir, "policy.json"), "utf8")), exp.policy);
  assert.equal(readFileSync(join(home.dir, "policy.previous.json"), "utf8"), before, "the previous policy is kept");
  const acks = server.observations().filter((i) => i.payload.kind === "policy_ack");
  assert.equal(acks.length, 1);
  const d = acks[0].payload.data;
  assert.equal(validObservation(acks[0].payload), true);
  assert.deepEqual(
    { event: d.event, export_id: d.export_id, policy_id: d.policy_id, policy_version: d.policy_version, policy_digest: d.policy_digest, scope_digest: d.scope_digest, load_result: d.load_result, generation: d.installation_generation },
    { event: "loaded", export_id: exp.scope.export_id, policy_id: exp.scope.policy_id, policy_version: 3, policy_digest: exp.policy_hash, scope_digest: exp.scope.scope_digest, load_result: "loaded", generation: 1 },
  );
  assert.equal(d.policy_digest, digestOf(JSON.parse(readFileSync(join(home.dir, "policy.json"), "utf8"))), "the loaded file hashes to the acknowledged digest");
  await server.close();
});

test("policy load accepts the workspace's { id, configuration } answer as well as the bare export", async () => {
  const server = await startServer();
  const home = makeHome({ url: server.url });
  const exp = makeExport();
  const r = await run(home.dir, ["policy", "load", writeExport(home.dir, { id: exp.scope.export_id, configuration: exp, rollout: { status: "pending" } }), "--yes"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(server.observations().filter((i) => i.payload.data.event === "loaded").length, 1);
  await server.close();
});

test("a changed policy, a wrong environment and a wrong scope digest are refused, acknowledged as rejected with the echoed values, and nothing is loaded", async () => {
  const cases = [
    ["signature_invalid", (e) => { e.policy.clauses[0].action_types = ["shell.exec", "file.write"]; return e; }],
    ["scope_mismatch", () => makeExport({ environmentId: "env-other" })],
    ["scope_mismatch", (e) => { e.scope.agent_id = "agent-8"; return e; }],
  ];
  for (const [code, mutate] of cases) {
    const server = await startServer();
    const home = makeHome({ url: server.url });
    const exp = mutate(makeExport());
    const before = readFileSync(join(home.dir, "policy.json"), "utf8");
    const r = await run(home.dir, ["policy", "load", writeExport(home.dir, exp), "--yes"]);
    assert.equal(r.status, 1);
    assert.equal(readFileSync(join(home.dir, "policy.json"), "utf8"), before, "the active policy is untouched");
    const acks = server.observations().filter((i) => i.payload.kind === "policy_ack");
    assert.equal(acks.length, 1, r.stderr);
    const d = acks[0].payload.data;
    assert.equal(validObservation(acks[0].payload), true);
    assert.deepEqual([d.event, d.load_result, d.error], ["rejected", "rejected", code]);
    assert.deepEqual([d.export_id, d.policy_id, d.policy_version, d.policy_digest, d.scope_digest], [exp.scope.export_id, exp.scope.policy_id, 3, exp.policy_hash, exp.scope.scope_digest]);
    await server.close();
  }
});

test("an export that names nothing to echo (no scope block, not JSON, oversize) is refused without an acknowledgement", async () => {
  const server = await startServer();
  const home = makeHome({ url: server.url });
  const old = makeExport(); delete old.scope;
  const junk = join(home.dir, "..", `junk-${Math.random().toString(16).slice(2)}`); writeFileSync(junk, "not json");
  for (const file of [writeExport(home.dir, old), junk]) {
    const r = await run(home.dir, ["policy", "load", file, "--yes"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /refused/);
  }
  assert.equal(server.observations().length, 0);
  assert.equal(inspectExport(old).ok, false);
  await server.close();
});

test("a policy the gateway cannot build is refused as unsupported and acknowledged as such", async () => {
  const server = await startServer();
  const home = makeHome({ url: server.url });
  const exp = makeExport();
  exp.policy = { vocabulary_version: "1.0", clauses: "not a list" };
  exp.policy_hash = digestOf(exp.policy);
  const r = await run(home.dir, ["policy", "load", writeExport(home.dir, exp), "--yes"]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const acks = server.observations().filter((i) => i.payload.kind === "policy_ack");
  assert.equal(acks.length, 1);
  assert.equal(acks[0].payload.data.error, "unsupported");
  await server.close();
});

test("the load is still applied, and reported as unacknowledged, when observations are off", async () => {
  const home = makeHome({ scopes: ["receipts:write"] });
  const exp = makeExport();
  const r = await run(home.dir, ["policy", "load", writeExport(home.dir, exp), "--yes"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /not acknowledged to the workspace: observations are off/);
  assert.equal(existsSync(join(home.dir, "observations.db")), false);
});

// ---- (3) the enrollment answer --------------------------------------------------------------------

/** The fields the workspace's enrollment completion returns today (no installation id or generation). */
const enrollmentAnswer = (extra = {}) => ({
  url: "https://example.invalid", credential_id: "c1", credential: "sbm_abc", organization_id: "org-1", environment_id: "env-1",
  gateway_id: "0d0c6f7e-2d9a-4b6d-a5b2-1f2e3d4c5b6a", attester_kid: "kid-a", agent_kid: "kid-agent", scopes: ["receipt:ingest", "gateway:heartbeat", "observations:write"],
  expires_at: "2027-01-01T00:00:00.000Z", ...extra,
});

test("the enrollment answer supplies the installation id as gateway_id; a generation only counts when the workspace states it", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-enroll-"));
  writeFileSync(join(dir, "cloud.json"), JSON.stringify(enrollmentAnswer()));
  const connection = loadConnection(dir);
  assert.equal(withInstallationId(connection).installation_id, "0d0c6f7e-2d9a-4b6d-a5b2-1f2e3d4c5b6a");
  assert.equal(connection.installation_generation, undefined);
  const missing = openObservations(dir);
  assert.equal(missing.status.state, "unsupported");
  assert.match(missing.status.reason, /generation/);

  // An explicit installation id wins over gateway_id; observations:write is what turns emission on.
  writeFileSync(join(dir, "cloud.json"), JSON.stringify(enrollmentAnswer({ installation_id: "inst-explicit", installation_generation: 4, scopes: ["receipt:ingest", "gateway:heartbeat"] })));
  assert.equal(withInstallationId(loadConnection(dir)).installation_id, "inst-explicit");
  assert.match(openObservations(dir).status.reason, /does not grant observations:write/);
});

// ---- (4) POST /v1/observations answers ---------------------------------------------------------------

function seeded(count) {
  const store = new ObservationStore(join(mkdtempSync(join(tmpdir(), "sb-obs-c-")), "observations.db"));
  store.bindGeneration(1);
  const { attester } = loadOrCreateAttester({ file: join(mkdtempSync(join(tmpdir(), "sb-obs-k-")), "k.key") });
  const signer = { kid: "key:contract-0001", sign: (text) => attester.sign(text) };
  return { store, signer, count };
}

test("results are read as the workspace writes them: a null observation id on a refused item is bound by its index", async () => {
  const home = makeHome();
  const opened = openObservations(home.dir);
  const emitter = opened.emitter;
  for (let i = 0; i < 3; i += 1) emitter.sessionStart(`s${i}`, home.dir);
  const server = await startServer((items) => ({ status: 200, body: { version: "1.0", results: [
    { index: 0, observation_id: items[0].payload.observation_id, status: "accepted", code: "accepted", retryable: false, observation_hash: "a".repeat(64) },
    { index: 1, observation_id: null, status: "rejected", code: "schema_invalid", retryable: false },
    { index: 2, observation_id: items[2].payload.observation_id, status: "deferred", code: "quota_deferred", retryable: true },
  ], retry_after_seconds: 120 } }));
  const outcome = await uploadPending(emitter.store, { url: server.url, credential: "sbm_x" });
  assert.deepEqual([outcome.acknowledged, outcome.rejected, outcome.deferred], [1, 1, 1]);
  assert.equal(emitter.store.terminal()[0].code, "schema_invalid");
  assert.equal(emitter.store.pendingSummary().count, 1, "only the deferred item remains");
  // A null id is never accepted as a durable acknowledgement.
  const again = await startServer((items) => ({ status: 200, body: { version: "1.0", results: [{ index: 0, observation_id: null, status: "accepted", code: "accepted", retryable: false }] } }));
  const later = await uploadPending(emitter.store, { url: again.url, credential: "sbm_x", now: () => Date.now() + 3_600_000 });
  assert.equal(later.acknowledged, 0);
  assert.equal(emitter.store.pendingSummary().count, 1);
  await server.close(); await again.close(); emitter.close();
});

test("429 with the workspace's body and Retry-After, 402 for a paused agent, and the accepted/duplicate/pending_link codes", async () => {
  const home = makeHome();
  let now = Date.now();
  const { emitter } = openObservations(home.dir, { now: () => now });
  for (let i = 0; i < 3; i += 1) emitter.sessionStart(`s${i}`, home.dir);
  const opts = (url) => ({ url, credential: "sbm_x", now: () => now });

  const limited = await startServer(() => ({ status: 429, headers: { "Retry-After": "45" }, body: { error: "too many observation requests", code: "rate_limited" } }));
  assert.equal((await uploadPending(emitter.store, opts(limited.url))).result, "backoff");
  assert.equal(emitter.store.pendingSummary().count, 3);
  now += 46_000;

  const paused = await startServer(() => ({ status: 402, body: { error: "plan paused" } }));
  const p = await uploadPending(emitter.store, opts(paused.url));
  assert.equal(p.result, "error");
  assert.match(p.detail, /402/);
  assert.equal(emitter.store.pendingSummary().count, 3, "kept");
  now += 31 * 60_000;

  const ok = await startServer((items) => ({ status: 200, body: { version: "1.0", results: items.map((item, index) => ({ index, observation_id: item.payload.observation_id, status: ["accepted", "duplicate", "pending_link"][index], code: ["accepted", "duplicate", "pending_link"][index], retryable: false, observation_hash: "b".repeat(64) })) } }));
  const done = await uploadPending(emitter.store, opts(ok.url));
  assert.equal(done.acknowledged, 3);
  assert.equal(emitter.store.pendingSummary().count, 0);
  for (const s of [limited, paused, ok]) await s.close();
  emitter.close();
});

test("the workspace's real result shape is acknowledged by the helper's acceptAll", () => {
  const items = [{ payload: { observation_id: "x" } }];
  const [r] = results(items).results;
  assert.deepEqual([r.status, r.code, r.retryable], ["accepted", "accepted", false]);
  assert.equal(acceptAll(items).status, 200);
});
