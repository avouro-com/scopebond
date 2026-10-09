// dispatch.json's approval_max_lifetime_seconds may shorten the five-minute approval lifetime, never lift it. A value
// that is not a whole number of seconds up to 300 is refused when the file is read, not turned into "no limit".
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "sb-lifetime-env-"));
for (const k of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SCOPEBOND_HOME"]) process.env[k] = sandbox;
delete process.env.SCOPEBOND_DELEGATION;

const { deriveKid, dispatchIntentOf, requestHash, signDispatchApproval, checkApproval, StaticPrincipalKeyRegistry } = await import("../dist/index.js");
const { openDispatchGuard } = await import("../dist/node.js");

function approverKey() {
  const pair = generateKeyPairSync("ed25519");
  const pem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const raw = pair.publicKey.export({ format: "jwk" });
  return { kid: deriveKid({ crv: raw.crv, kty: raw.kty, x: raw.x }), pem, privateKey: pair.privateKey };
}

function project(lifetimeSetting) {
  const dir = mkdtempSync(join(sandbox, "dispatch-"));
  const ap = approverKey();
  const file = { require_approval: ["git.push"], approver_keys: [{ kid: ap.kid, public_key_pem: ap.pem }], cloud: false };
  if (lifetimeSetting !== undefined) file.approval_max_lifetime_seconds = lifetimeSetting;
  writeFileSync(join(dir, "dispatch.json"), JSON.stringify(file));
  return { dir, ap };
}

async function decide(lifetimeSetting, lifetimeMs) {
  const { dir, ap } = project(lifetimeSetting);
  const intent = dispatchIntentOf({ action_type: "git.push", params: { ref: "feature/x", action_group: "g" } });
  const req = { actor: "agent-1", action_group: "group-1", policy_digest: "pd-1", intents: [intent] };
  const now = Date.now();
  const approval = signDispatchApproval(ap.privateKey, {
    version: "1.0", approval_id: `approval:${Math.random().toString(36).slice(2, 12)}`, approver: { kid: ap.kid, alg: "Ed25519" },
    actor: req.actor, action_type: "git.push", target: intent.target, policy_digest: req.policy_digest, request_hash: requestHash(intent.request),
    issued_at: new Date(now - 1000).toISOString(), expires_at: new Date(now - 1000 + lifetimeMs).toISOString(),
  });
  mkdirSync(join(dir, "approvals"));
  writeFileSync(join(dir, "approvals", "a.json"), JSON.stringify(approval));
  const guard = openDispatchGuard(dir, { cloud: null });
  try { return await guard.authorize(req); } finally { guard.close(); }
}

const YEAR = 365 * 24 * 3600_000;

test("without a setting a one-year approval is refused; a shorter setting refuses a longer approval", async () => {
  assert.equal((await decide(undefined, YEAR)).allow, false);
  const sixty = await decide(60, 120_000);
  assert.equal(sixty.allow, false);
  assert.match(sixty.detail ?? "", /bad_lifetime/);
  assert.equal((await decide(60, 30_000)).allow, true, "an approval within the setting passes");
});

for (const bad of ["5m", "300s", "120", { minutes: 5 }, [60, 120], 0, -5, 1.5, 301, 86400, true]) {
  test(`approval_max_lifetime_seconds ${JSON.stringify(bad)} is refused when dispatch.json is read`, () => {
    const { dir } = project(bad);
    assert.throws(() => openDispatchGuard(dir, { cloud: null }), /approval_max_lifetime_seconds/);
  });
}

test("checkApproval keeps the five-minute cap when given a lifetime that is not a number", async () => {
  const ap = approverKey();
  const keys = new StaticPrincipalKeyRegistry([{ kid: ap.kid, publicKeyPem: ap.pem, purposes: ["approver"], status: "active" }]);
  const intent = dispatchIntentOf({ action_type: "git.push", params: { ref: "feature/x" } });
  const now = Date.now();
  const approval = signDispatchApproval(ap.privateKey, {
    version: "1.0", approval_id: "approval:nan-check", approver: { kid: ap.kid, alg: "Ed25519" },
    actor: "agent-1", action_type: "git.push", target: intent.target, policy_digest: "pd-1", request_hash: requestHash(intent.request),
    issued_at: new Date(now - 1000).toISOString(), expires_at: new Date(now + YEAR).toISOString(),
  });
  const subject = { actor: "agent-1", action_type: "git.push", target: intent.target, policy_digest: "pd-1", request_hash: requestHash(intent.request) };
  for (const maxLifetimeMs of [Number.NaN, Infinity, -1, 0]) {
    const result = await checkApproval(approval, subject, keys, now, { maxLifetimeMs });
    assert.deepEqual(result, { ok: false, reason: "bad_lifetime" }, String(maxLifetimeMs));
  }
});
