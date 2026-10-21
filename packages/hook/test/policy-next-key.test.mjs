// The next policy-signing key: a document signed by the current key hands this computer the key that follows it, so a key
// rotation needs no release. It is checked on its own (a key the release carries signs it, the next key's window extends the
// current one's without a gap), pinned beside policy.json, checked again each time it is read, and may make a computer its
// workspace manages enforce signatures. Keys are made here at run time: no private key is ever committed.

import { ENFORCE } from "./enforce-all.mjs";
import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scaffold, policyBuilds, digestRules, syncPolicy, readMeta, signedPolicyBytes, isManaged, policyKeys, setPinnedNextKeys, buildStatusJson,
  checkNextKey, pinNextKey, readNextKey, useNextKey, signatureModeAt, nextKeySigningInput, NEXT_KEY_FORMAT, NEXT_KEY_FILE, PINNED_POLICY_KEYS,
} from "../dist/index.js";

const INSTALLATION = "gw-next-1";
const WORKSPACE = "org-next-1";
const T = (day) => `2026-10-${String(day).padStart(2, "0")}T00:00:00Z`;
const NOW = new Date(T(20));
const current = generateKeyPairSync("ed25519");
const next = generateKeyPairSync("ed25519");
const stranger = generateKeyPairSync("ed25519");
const pem = (pair) => pair.publicKey.export({ type: "spki", format: "pem" });
const CURRENT = { key_id: "ws-1", public_key: pem(current), not_before: T(1), not_after: "2027-10-13T21:00:18Z" };
const NEXT = { key_id: "ws-2", public_key: pem(next), not_before: "2027-09-01T00:00:00Z", not_after: "2028-10-13T21:00:18Z" };
const previousKeys = process.env.SCOPEBOND_POLICY_KEYS_JSON;
process.env.SCOPEBOND_POLICY_KEYS_JSON = JSON.stringify([CURRENT]);
after(() => { if (previousKeys === undefined) delete process.env.SCOPEBOND_POLICY_KEYS_JSON; else process.env.SCOPEBOND_POLICY_KEYS_JSON = previousKeys; });
afterEach(() => setPinnedNextKeys([]));

/** A next-key document signed by `by` (the current key unless told otherwise). */
function nextKeyDoc({ key = NEXT, by = current.privateKey, byId = "ws-1", issuedAt = T(15), extra = {} } = {}) {
  const unsigned = { format: NEXT_KEY_FORMAT, issued_at: issuedAt, key, ...extra, signature: { alg: "Ed25519", key_id: byId, value: "A".repeat(86) + "==" } };
  return { ...unsigned, signature: { ...unsigned.signature, value: cryptoSign(null, Buffer.from(nextKeySigningInput(unsigned), "utf8"), by).toString("base64") } };
}

const defaults = () => ({
  "force-push-protected": { mode: "block" }, "push-protected": { mode: "block" }, "destructive-shell": { mode: "block" },
  "secret-read": { mode: "block" }, "ci-config-write": { mode: "block" }, "network-egress": { mode: "monitor" },
});
const doc = (revision, extra = {}) => {
  const rules = defaults();
  return { type: "scopebond:managed-rules", version: 1, revision, export_id: `rev-${revision}-${INSTALLATION}`, environment_id: "env-1", agent_id: "agent-1", installation_id: INSTALLATION, rules, rules_digest: digestRules(rules), ...extra };
};
function signed(body, { key = current.privateKey, keyId = "ws-1", issuedAt = T(15) } = {}) {
  const payload = { v: 1, workspace: WORKSPACE, computer: INSTALLATION, revision: body.revision, rules_digest: body.rules_digest, local_changes: false, managed: body.managed !== false, issued_at: issuedAt };
  return { ...body, workspace_id: WORKSPACE, issued_at: issuedAt, key_id: keyId, signature: cryptoSign(null, signedPolicyBytes(payload), key).toString("base64") };
}
function connected() {
  const dir = mkdtempSync(join(tmpdir(), "scopebond-nextkey-"));
  const { agentKid } = scaffold(dir, ENFORCE);
  writeFileSync(join(dir, "cloud.json"), JSON.stringify({ url: "https://cloud.example.test", credential: "sbm_x", credential_id: "c", organization_id: WORKSPACE, environment_id: "env-1", gateway_id: INSTALLATION, attester_kid: "k", scopes: [], expires_at: "2099-01-01T00:00:00Z" }));
  return { dir, agentKid };
}
function workspace(answers) {
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/v1/policy/ack")) return new Response("{}", { status: 200 });
    const next = answers.shift();
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), { status: next.status ?? 200 });
  };
  return { fetchImpl };
}
const sync = (h, w, now = NOW) => syncPolicy(h.dir, { agentKid: h.agentKid, hookVersion: "0.40.0", policyBuilds, fetchImpl: w.fetchImpl, now: () => now });

test("the release pins one key; its window closes on 2027-10-13", () => {
  assert.equal(PINNED_POLICY_KEYS.length, 1);
  assert.equal(PINNED_POLICY_KEYS[0].not_after, "2027-10-13T21:00:18Z");
});

test("a next-key document signed by the current key is accepted; anything else is refused", () => {
  const ok = checkNextKey(nextKeyDoc(), { now: NOW });
  assert.equal(ok.ok, true, ok.message);
  const refused = (raw, why) => { const r = checkNextKey(raw, { now: NOW }); assert.equal(r.ok, false, why); return r.message; };
  assert.match(refused(nextKeyDoc({ by: stranger.privateKey }), "a forged signature"), /does not verify/);
  assert.match(refused(nextKeyDoc({ byId: "ws-9" }), "an unknown signer"), /does not trust/);
  assert.match(refused({ ...nextKeyDoc(), key: { ...NEXT, not_after: "2029-01-01T00:00:00Z" } }, "a changed key"), /does not verify/);
  assert.match(refused(nextKeyDoc({ key: { ...NEXT, not_before: "2027-11-01T00:00:00Z" } }), "a gap between the keys"), /opens after/);
  assert.match(refused(nextKeyDoc({ key: { ...NEXT, not_after: "2027-10-01T00:00:00Z" } }), "a key that shortens trust"), /close after/);
  assert.match(refused(nextKeyDoc({ key: { ...NEXT, key_id: "ws-1" } }), "the current key's id"), /reuses/);
  assert.match(refused(nextKeyDoc({ key: { ...NEXT, public_key: "not a key" } }), "not a key"), /cannot be trusted/);
  refused(nextKeyDoc({ extra: { managed_signature_mode: "dual" } }), "only enforce");
  refused(nextKeyDoc({ extra: { also: 1 } }), "a closed document");
  refused(nextKeyDoc({ issuedAt: "2027-10-14T00:00:00Z" }), "after the current key's window");
});

test("the chain is one step: a pinned next key never signs another", () => {
  setPinnedNextKeys([NEXT]);
  assert.ok(policyKeys().some((k) => k.key_id === "ws-2"), "the pinned next key is trusted for documents");
  const third = { key_id: "ws-3", public_key: pem(stranger), not_before: "2028-09-01T00:00:00Z", not_after: "2029-10-13T00:00:00Z" };
  const r = checkNextKey(nextKeyDoc({ key: third, by: next.privateKey, byId: "ws-2", issuedAt: "2027-10-14T00:00:00Z" }), { now: new Date("2027-10-15T00:00:00Z") });
  assert.equal(r.ok, false);
  assert.match(r.message, /does not trust/);
});

test("the rules check pins the next key, and the workspace may then sign with it", async () => {
  const h = connected();
  const w = workspace([
    { body: signed(doc(1, { policy_next_key: nextKeyDoc() })) },
    // After the current key's window has closed, an answer signed by the next key verifies.
    { body: signed(doc(2), { key: next.privateKey, keyId: "ws-2", issuedAt: "2027-10-20T00:00:00Z" }) },
  ]);
  assert.equal((await sync(h, w)).state, "applied");
  assert.equal(readMeta(h.dir).next_key.state, "pinned");
  assert.equal(readNextKey(h.dir, { now: NOW }).key.key_id, "ws-2");
  const later = new Date("2027-10-21T00:00:00Z");
  const outcome = await sync(h, w, later);
  assert.equal(outcome.state, "applied", outcome.message);
  assert.equal(readMeta(h.dir).policy_signature.last, "verified");
});

test("a changed pinned file adds no key", async () => {
  const h = connected();
  assert.equal(pinNextKey(h.dir, nextKeyDoc(), { now: NOW }).state, "pinned");
  const file = join(h.dir, NEXT_KEY_FILE);
  const changed = JSON.parse(readFileSync(file, "utf8"));
  changed.key.public_key = pem(stranger);
  writeFileSync(file, JSON.stringify(changed));
  assert.equal(readNextKey(h.dir, { now: NOW }), null);
  assert.equal(useNextKey(h.dir, { now: NOW }), null);
  assert.ok(!policyKeys().some((k) => k.key_id === "ws-2"));
});

test("an older next-key document never replaces a newer one", () => {
  const h = connected();
  assert.equal(pinNextKey(h.dir, nextKeyDoc({ issuedAt: T(16) }), { now: NOW }).state, "pinned");
  assert.equal(pinNextKey(h.dir, nextKeyDoc({ issuedAt: T(15), extra: { managed_signature_mode: "enforce" } }), { now: NOW }).state, "unchanged");
  assert.equal(readNextKey(h.dir, { now: NOW }).managed_signature_mode, undefined);
});

test("a computer its workspace manages defaults to enforce when the document says so; others keep their mode", async () => {
  const h = connected();
  const w = workspace([
    { body: signed(doc(1, { policy_next_key: nextKeyDoc({ extra: { managed_signature_mode: "enforce" } }) })) },
    // An unsigned answer is now refused, and the rules in force stay.
    { body: doc(2) },
  ]);
  assert.equal((await sync(h, w)).state, "applied");
  assert.ok(isManaged(h.dir));
  assert.equal(signatureModeAt(h.dir, JSON.parse(readFileSync(join(h.dir, "cloud.json"), "utf8"))), "enforce");
  const refused = await sync(h, w);
  assert.equal(refused.state, "refused");
  assert.equal(refused.signature, "unsigned_policy");
  assert.equal(readMeta(h.dir).revision, 1);
  assert.equal(buildStatusJson({ version: "0.40.0", activeDir: h.dir, candidateDirs: [h.dir], hasPolicy: true, agents: {} }).policy_signature.mode, "enforce");

  const own = connected();
  pinNextKey(own.dir, nextKeyDoc({ extra: { managed_signature_mode: "enforce" } }), { now: NOW });
  assert.equal(isManaged(own.dir), false);
  assert.equal(signatureModeAt(own.dir, {}), "dual", "a computer on its own rules keeps dual");
});
