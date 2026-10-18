// Pack delivery: a workspace answer names the rule packs this computer should hold, signed beside the rules; the rules check
// fetches each pack it does not hold from /v1/packs/<id>@<version>, checks it (digest, format, signature, vectors) and puts
// exactly the named packs in the cache. A list that does not verify, or a pack that does not check out, changes nothing that
// was in force; an empty list leaves no pack. Keys are made here at run time: no private key is ever committed.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packSigningInput } from "@scopebond/policy-schema/pack";
import { ENFORCE } from "./enforce-all.mjs";
import {
  scaffold, policyBuilds, digestRules, syncPolicy, readMeta, signedPolicyBytes, digestPacks, readPackIndex, loadPacks, packsDir, syncPacks, restampPacks,
  packRefsOf, HOOK_CAPABILITIES, activatePacks, mapClaudeToolUse, setActivePacks,
} from "../dist/index.js";

const require = createRequire(import.meta.url);
const INSTALLATION = "gw-pack-1";
const WORKSPACE = "org-pack-1";
const T = (day) => `2026-10-${String(day).padStart(2, "0")}T00:00:00Z`;
const NOW = new Date(T(20));
const trusted = generateKeyPairSync("ed25519");
const stranger = generateKeyPairSync("ed25519");
const pem = (pair) => pair.publicKey.export({ type: "spki", format: "pem" });
const KEYS = [{ key_id: "ws-1", public_key: pem(trusted), not_before: T(1), not_after: "2027-10-01T00:00:00Z" }];
const previousKeys = process.env.SCOPEBOND_POLICY_KEYS_JSON;
process.env.SCOPEBOND_POLICY_KEYS_JSON = JSON.stringify(KEYS);
after(() => { if (previousKeys === undefined) delete process.env.SCOPEBOND_POLICY_KEYS_JSON; else process.env.SCOPEBOND_POLICY_KEYS_JSON = previousKeys; setActivePacks([]); });

/** The public example pack, signed by the workspace key (or another), at a version. */
const example = JSON.parse(readFileSync(require.resolve("@scopebond/policy-schema/vectors/example-pack.json"), "utf8"));
function packText({ version = "1.0.0", key = trusted.privateKey, keyId = "ws-1" } = {}) {
  const unsigned = { ...example, version, signature: { alg: "Ed25519", key_id: keyId, value: "A".repeat(86) + "==" } };
  const value = cryptoSign(null, Buffer.from(packSigningInput(unsigned), "utf8"), key).toString("base64");
  return JSON.stringify({ ...unsigned, signature: { alg: "Ed25519", key_id: keyId, value } });
}
const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const refOf = (text) => { const p = JSON.parse(text); return { id: p.id, version: p.version, sha256: sha(text) }; };

const defaults = () => ({
  "force-push-protected": { mode: "block" }, "push-protected": { mode: "block" }, "destructive-shell": { mode: "block" },
  "secret-read": { mode: "block" }, "ci-config-write": { mode: "block" }, "network-egress": { mode: "monitor" },
});
function doc(revision, extra = {}) {
  const rules = defaults();
  return { type: "scopebond:managed-rules", version: 1, revision, export_id: `rev-${revision}-${INSTALLATION}`, environment_id: "env-1", agent_id: "agent-1", installation_id: INSTALLATION, rules, rules_digest: digestRules(rules), ...extra };
}
const unmanaged = () => ({ type: "scopebond:managed-rules", version: 1, managed: false, installation_id: INSTALLATION, workspace_id: WORKSPACE, revision: 0, rules_digest: "0".repeat(64), local_changes: false });

/** Sign an answer as the workspace does: its rules and, when it names packs, its pack list. */
function signed(body, { packs, issuedAt = T(15), packKey = trusted.privateKey } = {}) {
  const managed = body.managed !== false;
  const base = { v: 1, workspace: WORKSPACE, computer: INSTALLATION, revision: body.revision, local_changes: false, managed, issued_at: issuedAt };
  const out = { ...body, workspace_id: WORKSPACE, issued_at: issuedAt, key_id: "ws-1",
    signature: cryptoSign(null, signedPolicyBytes({ ...base, rules_digest: body.rules_digest, local_changes: body.local_changes === true }), trusted.privateKey).toString("base64") };
  if (packs === undefined) return out;
  const packsDigest = digestPacks({ packs });
  return { ...out, packs, packs_digest: packsDigest, packs_signature: cryptoSign(null, signedPolicyBytes({ ...base, rules_digest: packsDigest, kind: "packs" }), packKey).toString("base64") };
}

function connected() {
  const dir = mkdtempSync(join(tmpdir(), "scopebond-packsync-"));
  const { agentKid } = scaffold(dir, ENFORCE);
  writeFileSync(join(dir, "cloud.json"), JSON.stringify({ url: "https://cloud.example.test", credential: "sbm_x", credential_id: "c", organization_id: WORKSPACE, environment_id: "env-1", gateway_id: INSTALLATION, attester_kid: "k", scopes: [], expires_at: "2099-01-01T00:00:00Z" }));
  return { dir, agentKid };
}
/** A workspace that answers the rules check with `answers` in turn and serves `served` (ref → text) at /v1/packs. */
function workspace(answers, served = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, headers: init.headers ?? {} });
    if (u.endsWith("/v1/policy/ack")) return new Response("{}", { status: 200 });
    const m = /\/v1\/packs\/([^/]+)$/.exec(u);
    if (m) { const text = served[decodeURIComponent(m[1])]; return text === undefined ? new Response("{}", { status: 404 }) : new Response(text, { status: 200 }); }
    const next = answers.shift();
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), { status: next.status ?? 200, headers: next.etag ? { etag: next.etag } : {} });
  };
  return { calls, fetchImpl };
}
const sync = (h, w) => syncPolicy(h.dir, { agentKid: h.agentKid, hookVersion: "0.29.0", policyBuilds, fetchImpl: w.fetchImpl, now: () => NOW });
const packFetches = (w) => w.calls.filter((c) => c.url.includes("/v1/packs/")).map((c) => c.url.slice(c.url.indexOf("/v1/packs/") + 10));

test("the rules check says the hook reads pack lists", async () => {
  assert.ok(HOOK_CAPABILITIES.includes("packs"));
  const h = connected();
  const w = workspace([{ body: signed(doc(1)) }]);
  await sync(h, w);
  assert.match(w.calls[0].headers["x-scopebond-hook-capabilities"], /(?:^|,)packs(?:,|$)/);
});

test("a signed list: the named pack is fetched with the computer's credential, checked, cached and put in force", async () => {
  const h = connected();
  const text = packText();
  const ref = refOf(text);
  const w = workspace([{ body: signed(doc(1), { packs: [ref] }) }], { "example@1.0.0": text });
  const outcome = await sync(h, w);
  assert.equal(outcome.state, "applied");
  assert.deepEqual(packFetches(w), ["example@1.0.0"]);
  const fetch = w.calls.find((c) => c.url.includes("/v1/packs/"));
  assert.equal(fetch.headers.authorization, "Bearer sbm_x");
  const index = readPackIndex(h.dir);
  assert.deepEqual(index.packs, [ref]);
  assert.equal(index.checked_at, NOW.toISOString());
  assert.deepEqual(loadPacks(h.dir, { now: NOW }).packs.map((p) => `${p.id}@${p.version}`), ["example@1.0.0"]);
  assert.equal(readMeta(h.dir).packs.complete, true);
  // In force for the mapper: the example pack reads `examplectl`.
  activatePacks(h.dir, { now: NOW });
  const mapped = mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "examplectl bucket delete ex://old --yes" } });
  assert.deepEqual(mapped.map((m) => m.intent.action_type), ["shell.exec", "cloud.resource.delete"]);
  setActivePacks([]);
});

test("a pack already held byte for byte is not fetched again; a new version replaces it", async () => {
  const h = connected();
  const v1 = packText();
  const v2 = packText({ version: "1.1.0" });
  const w = workspace([
    { body: signed(doc(1), { packs: [refOf(v1)] }) },
    { body: signed(doc(1), { packs: [refOf(v1)], issuedAt: T(16) }) },
    { body: signed(doc(2), { packs: [refOf(v2)], issuedAt: T(17) }) },
  ], { "example@1.0.0": v1, "example@1.1.0": v2 });
  await sync(h, w);
  await sync(h, w);
  await sync(h, w);
  assert.deepEqual(packFetches(w), ["example@1.0.0", "example@1.1.0"]);
  assert.deepEqual(readPackIndex(h.dir).packs.map((p) => p.version), ["1.1.0"]);
  assert.ok(!existsSync(join(packsDir(h.dir), "example@1.0.0.json")), "the old version's file is removed");
});

test("an empty list (a computer that is not licensed) leaves no pack: the starter protections alone apply", async () => {
  const h = connected();
  const text = packText();
  const w = workspace([{ body: signed(doc(1), { packs: [refOf(text)] }) }, { body: signed(doc(2), { packs: [], issuedAt: T(16) }) }], { "example@1.0.0": text });
  await sync(h, w);
  assert.equal(readPackIndex(h.dir).packs.length, 1);
  await sync(h, w);
  assert.deepEqual(readPackIndex(h.dir).packs, []);
  assert.equal(loadPacks(h.dir, { now: NOW }).packs.length, 0);
  assert.ok(!existsSync(join(packsDir(h.dir), "example@1.0.0.json")));
});

test("the signed 'no rules for this computer' answer can name packs too", async () => {
  const h = connected();
  const text = packText();
  const w = workspace([{ body: signed(unmanaged(), { packs: [refOf(text)] }) }], { "example@1.0.0": text });
  const outcome = await sync(h, w);
  assert.equal(outcome.state, "own_rules");
  assert.deepEqual(readPackIndex(h.dir).packs.map((p) => p.id), ["example"]);
});

test("fail closed: a list that does not verify, or a pack that does not check out, changes nothing in force", async (t) => {
  const text = packText();
  const ref = refOf(text);
  await t.test("a list changed after signing", async () => {
    const h = connected();
    const answer = signed(doc(1), { packs: [ref] });
    const w = workspace([{ body: { ...answer, packs: [{ ...ref, version: "9.9.9" }] } }], { "example@9.9.9": text });
    await sync(h, w);
    assert.equal(readPackIndex(h.dir), null);
    assert.deepEqual(packFetches(w), []);
    assert.match(readMeta(h.dir).packs.error, /does not match its signed digest/);
  });
  await t.test("a list signed by a key this release does not trust", async () => {
    const h = connected();
    const w = workspace([{ body: signed(doc(1), { packs: [ref], packKey: stranger.privateKey }) }], { "example@1.0.0": text });
    await sync(h, w);
    assert.equal(readPackIndex(h.dir), null);
    assert.match(readMeta(h.dir).packs.error, /packs signature/);
  });
  await t.test("a list with no signature", async () => {
    const h = connected();
    const w = workspace([{ body: { ...signed(doc(1)), packs: [ref] } }], { "example@1.0.0": text });
    await sync(h, w);
    assert.equal(readPackIndex(h.dir), null);
  });
  await t.test("a pack whose bytes are not the ones the list names", async () => {
    const h = connected();
    const w = workspace([{ body: signed(doc(1), { packs: [ref] }) }], { "example@1.0.0": `${text} ` });
    await sync(h, w);
    assert.deepEqual(readPackIndex(h.dir).packs, []);
    assert.equal(readMeta(h.dir).packs.complete, false);
    assert.match(readMeta(h.dir).packs.error, /does not match the digest/);
  });
  await t.test("a pack signed by another key", async () => {
    const h = connected();
    const forged = packText({ key: stranger.privateKey });
    const w = workspace([{ body: signed(doc(1), { packs: [refOf(forged)] }) }], { "example@1.0.0": forged });
    await sync(h, w);
    assert.deepEqual(readPackIndex(h.dir).packs, []);
    assert.match(readMeta(h.dir).packs.error, /does not verify/);
  });
  await t.test("a newer version that cannot be fetched keeps the one held, and the cache keeps its last complete check-in", async () => {
    const h = connected();
    const v2 = packText({ version: "2.0.0" });
    const w = workspace([{ body: signed(doc(1), { packs: [ref] }) }, { body: signed(doc(2), { packs: [refOf(v2)], issuedAt: T(16) }) }], { "example@1.0.0": text });
    await sync(h, w);
    const first = readPackIndex(h.dir).checked_at;
    await sync(h, w);
    const index = readPackIndex(h.dir);
    assert.deepEqual(index.packs, [ref]);
    assert.equal(index.checked_at, first);
    assert.match(readMeta(h.dir).packs.error, /answered 404/);
  });
});

test("an answer that names no packs leaves the cache alone, and a 304 check-in renews a complete one", async () => {
  const h = connected();
  const text = packText();
  const w = workspace([{ body: signed(doc(1), { packs: [refOf(text)] }), etag: '"1:x"' }], { "example@1.0.0": text });
  await sync(h, w);
  // An older workspace answer, without the field.
  const later = new Date(T(25));
  const w2 = workspace([{ body: signed(doc(2), { issuedAt: T(24) }) }]);
  await syncPolicy(h.dir, { agentKid: h.agentKid, hookVersion: "0.29.0", policyBuilds, fetchImpl: w2.fetchImpl, now: () => later });
  assert.deepEqual(readPackIndex(h.dir).packs.map((p) => p.id), ["example"]);
  assert.equal(readPackIndex(h.dir).checked_at, NOW.toISOString());
  assert.ok(restampPacks(h.dir, later));
  assert.equal(readPackIndex(h.dir).checked_at, later.toISOString());
});

test("syncPacks and packRefsOf refuse malformed lists", async () => {
  assert.equal(packRefsOf({ packs: [{ id: "Bad Id", version: "1.0.0", sha256: "a".repeat(64) }] }), null);
  assert.equal(packRefsOf({ packs: [{ id: "a", version: "1.0", sha256: "a".repeat(64) }] }), null);
  assert.equal(packRefsOf({ packs: [{ id: "a", version: "1.0.0", sha256: "a".repeat(64), extra: 1 }] }), null);
  assert.equal(packRefsOf({ packs: [{ id: "a", version: "1.0.0", sha256: "a".repeat(64) }, { id: "a", version: "1.0.1", sha256: "b".repeat(64) }] }), null);
  assert.deepEqual(packRefsOf({ packs: [{ id: "b", version: "1.0.0", sha256: "b".repeat(64) }, { id: "a", version: "1.0.0", sha256: "a".repeat(64) }] }).map((p) => p.id), ["a", "b"]);
  const dir = mkdtempSync(join(tmpdir(), "scopebond-packsync-"));
  assert.deepEqual(await syncPacks(dir, {}, { base: "https://x", headers: {}, fetchImpl: fetch, workspace: WORKSPACE, computer: INSTALLATION, lastIssuedAt: null }), { state: "not_named" });
});
