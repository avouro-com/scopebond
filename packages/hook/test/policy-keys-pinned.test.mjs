// The pinned Scopebond Cloud policy signing key. The private key is never in this repository, so these tests check what can
// be checked from the public half: the entry reads as a trusted Ed25519 key, its id is the one Scopebond Cloud derives from
// it, and a document that names it is checked against it (a forgery under its id is refused). Dual mode stays the default.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import {
  PINNED_POLICY_KEYS, policyKeys, policyKeyProblems, publicKeyFrom, checkPolicySignature, signedPolicyBytes, signatureMode, digestRules,
} from "../dist/index.js";
import { admitSigned } from "../dist/policy-signature.js";

const CLOUD_KEY_ID = "pol_088707688c36e0f6";
const pinned = () => PINNED_POLICY_KEYS.find((k) => k.key_id === CLOUD_KEY_ID);

/** Scopebond Cloud's key id: `pol_` and the first 16 hex of sha256 over the base64 of the key's SPKI DER. */
const keyIdOf = (publicKey) => `pol_${createHash("sha256").update(publicKey.export({ format: "der", type: "spki" }).toString("base64")).digest("hex").slice(0, 16)}`;

test("the Scopebond Cloud key is pinned, reads as Ed25519, and is trusted with no configuration", () => {
  const entry = pinned();
  assert.ok(entry, "the Scopebond Cloud policy key is pinned");
  assert.deepEqual(Object.keys(entry).sort(), ["key_id", "not_after", "not_before", "public_key"]);
  const key = publicKeyFrom(entry.public_key);
  assert.ok(key, "the pinned public key reads");
  assert.equal(key.asymmetricKeyType, "ed25519");
  assert.equal(entry.not_before, "2026-10-13T21:00:18Z");
  assert.equal(entry.not_after, "2027-10-13T21:00:18Z");
  assert.ok(Date.parse(entry.not_before) < Date.parse(entry.not_after));
  assert.deepEqual(policyKeyProblems({}), []);
  assert.ok(policyKeys({}).some((k) => k.key_id === CLOUD_KEY_ID));
});

test("the pinned key id is the one derived from the pinned public key", () => {
  const entry = pinned();
  assert.equal(keyIdOf(publicKeyFrom(entry.public_key)), entry.key_id);
  // Every pinned key follows the same derivation, so an id can never point at another key.
  for (const k of PINNED_POLICY_KEYS) assert.equal(keyIdOf(publicKeyFrom(k.public_key)), k.key_id);
});

test("a document naming the pinned key is checked against it: a forgery under its id is refused", () => {
  const forger = generateKeyPairSync("ed25519");
  const rules = { "destructive-shell": { mode: "block" } };
  const issuedAt = "2026-10-20T00:00:00Z";
  const body = { revision: 1, rules_digest: digestRules(rules), installation_id: "gw-pin-1" };
  const payload = { v: 1, workspace: "org-pin-1", computer: "gw-pin-1", revision: 1, rules_digest: body.rules_digest, local_changes: false, managed: true, issued_at: issuedAt };
  const doc = { ...body, issued_at: issuedAt, key_id: CLOUD_KEY_ID, signature: cryptoSign(null, signedPolicyBytes(payload), forger.privateKey).toString("base64") };
  const context = { workspace: "org-pin-1", computer: "gw-pin-1", managed: true, lastIssuedAt: null, now: new Date("2026-10-21T00:00:00Z") };
  const check = checkPolicySignature(doc, context);
  assert.equal(check.result, "refused");
  assert.equal(check.reason, "bad_signature");
  // Before the key's window opens, the same document is refused for the window, so the pinned dates are the ones applied.
  const early = checkPolicySignature({ ...doc, issued_at: "2026-10-01T00:00:00Z" }, { ...context, now: new Date("2026-10-02T00:00:00Z") });
  assert.equal(early.reason, "key_not_valid");
});

test("a document signed with a key id that is not pinned is refused as unknown_key, in dual and in enforce mode", () => {
  const other = generateKeyPairSync("ed25519");
  const issuedAt = "2026-10-20T00:00:00Z";
  const rulesDigest = digestRules({ "destructive-shell": { mode: "block" } });
  const unpinnedId = "pol_0000000000000000";
  assert.ok(!policyKeys({}).some((k) => k.key_id === unpinnedId));
  const payload = { v: 1, workspace: "org-pin-1", computer: "gw-pin-1", revision: 1, rules_digest: rulesDigest, local_changes: false, managed: true, issued_at: issuedAt };
  const doc = {
    revision: 1, rules_digest: rulesDigest, installation_id: "gw-pin-1", issued_at: issuedAt, key_id: unpinnedId,
    signature: cryptoSign(null, signedPolicyBytes(payload), other.privateKey).toString("base64"),
  };
  // No `keys` override: the check uses the keys this release trusts by default.
  const check = checkPolicySignature(doc, { workspace: "org-pin-1", computer: "gw-pin-1", managed: true, lastIssuedAt: null, now: new Date("2026-10-21T00:00:00Z") });
  assert.equal(check.result, "refused");
  assert.equal(check.reason, "unknown_key");
  for (const mode of ["dual", "enforce"]) {
    const admitted = admitSigned(check, mode, "2026-10-21T00:00:00Z");
    assert.equal(admitted.ok, false, `${mode} refuses it`);
    assert.equal(admitted.reason, "unknown_key");
    assert.deepEqual(admitted.state, { mode, last: "refused", reason: "unknown_key", at: "2026-10-21T00:00:00Z" });
  }
});

test("pinning a key does not change the default mode: dual unless enforce is asked for", () => {
  assert.equal(signatureMode(null, {}), "dual");
  assert.equal(signatureMode({ organization_id: "org-pin-1" }, {}), "dual");
});
