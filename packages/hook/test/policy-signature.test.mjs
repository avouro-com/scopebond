// Signed workspace rules. A signed answer (a rules document, or the "no rules for this computer" answer) is installed only
// when its signature verifies under a trusted key for this computer and this workspace, and it is not older than the one in
// force. Dual mode (the default) still accepts an unsigned answer and records it; enforce mode refuses it and keeps the
// rules in force. Keys are made here at run time: no private key is ever committed.
import { ENFORCE } from "./enforce-all.mjs";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scaffold, policyBuilds, digestRules, syncPolicy, isManaged, readMeta, checkPolicySignature, signedPolicyBytes, signatureMode,
  publicKeyFrom, policyKeys, policyKeyProblems, buildStatusJson, describeDelivery, withHookVersion, versionedFetch, reportUninstall, HOOK_VERSION_HEADER,
} from "../dist/index.js";

const INSTALLATION = "gw-sig-1";
const WORKSPACE = "org-sig-1";
const T = (day) => `2026-10-${String(day).padStart(2, "0")}T00:00:00Z`;
const NOW = new Date(T(20));

const trusted = generateKeyPairSync("ed25519");
const attacker = generateKeyPairSync("ed25519");
const pem = (pair) => pair.publicKey.export({ type: "spki", format: "pem" });
const KEYS = [
  { key_id: "ws-1", public_key: pem(trusted), not_before: T(1), not_after: "2027-10-01T00:00:00Z" },
  // The same key, already expired: it signed something once, and is no longer trusted.
  { key_id: "ws-old", public_key: pem(trusted), not_before: "2025-01-01T00:00:00Z", not_after: T(10) },
  // The raw 32-byte form of the key is read too.
  { key_id: "ws-raw", public_key: trusted.publicKey.export({ format: "jwk" }).x.replace(/-/g, "+").replace(/_/g, "/") + "=", not_before: T(1), not_after: "2027-10-01T00:00:00Z" },
];

const defaults = () => ({
  "force-push-protected": { mode: "block" }, "push-protected": { mode: "block" }, "destructive-shell": { mode: "block" },
  "secret-read": { mode: "block" }, "ci-config-write": { mode: "block" }, "network-egress": { mode: "monitor" },
});
function doc(revision, overrides = {}, extra = {}) {
  const rules = { ...defaults(), ...overrides };
  return {
    type: "scopebond:managed-rules", version: 1, revision, export_id: `rev-${revision}-${INSTALLATION}`, environment_id: "env-1",
    agent_id: "agent-1", installation_id: INSTALLATION, rules, rules_digest: digestRules(rules), ...extra,
  };
}
const unmanaged = (extra = {}) => ({
  type: "scopebond:managed-rules", version: 1, managed: false, installation_id: INSTALLATION, revision: 0, rules_digest: "0".repeat(64), local_changes: false, ...extra,
});
/** Sign `body` as the workspace would; each option changes one thing a forger might. */
function signed(body, { workspace = WORKSPACE, computer = INSTALLATION, managed = body.managed !== false, key = trusted.privateKey, keyId = "ws-1", issuedAt = T(15) } = {}) {
  const payload = { v: 1, workspace, computer, revision: body.revision, rules_digest: body.rules_digest, local_changes: body.local_changes === true, managed, issued_at: issuedAt };
  return { ...body, issued_at: issuedAt, key_id: keyId, signature: cryptoSign(null, signedPolicyBytes(payload), key).toString("base64") };
}

function connected() {
  const dir = mkdtempSync(join(tmpdir(), "scopebond-sig-"));
  const { agentKid } = scaffold(dir, ENFORCE);
  writeFileSync(join(dir, "cloud.json"), JSON.stringify({ url: "https://cloud.example.test", credential: "sbm_x", credential_id: "c", organization_id: WORKSPACE, environment_id: "env-1", gateway_id: INSTALLATION, attester_kid: "k", scopes: [], expires_at: "2099-01-01T00:00:00Z" }));
  return { dir, agentKid };
}
function workspace(responses) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined });
    if (String(url).endsWith("/v1/policy/ack")) return new Response("{}", { status: 200 });
    const next = responses.shift();
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), { status: next.status });
  };
  return { calls, fetchImpl };
}
const sync = (h, body, status = 200) => {
  const w = workspace([{ status, body }]);
  return syncPolicy(h.dir, { agentKid: h.agentKid, hookVersion: "0.23.0", policyBuilds, fetchImpl: w.fetchImpl, now: () => NOW }).then((outcome) => ({ outcome, calls: w.calls }));
};
const policyOf = (h) => readFileSync(join(h.dir, "policy.json"), "utf8");
const status = (h) => buildStatusJson({ version: "test", activeDir: h.dir, candidateDirs: [h.dir], hasPolicy: true, agents: { claude: true, cursor: false, codex: false }, now: NOW.getTime() });

process.env.SCOPEBOND_POLICY_KEYS_JSON = JSON.stringify(KEYS);
afterEach(() => { delete process.env.SCOPEBOND_POLICY_SIGNATURE_MODE; });

test("a valid signature verifies, installs, and is reported as verified", async () => {
  const h = connected();
  try {
    const { outcome } = await sync(h, signed(doc(1, { "push-protected": { mode: "monitor" } })));
    assert.deepEqual(outcome, { state: "applied", revision: 1 });
    // A verified answer latches the computer to signed answers from this workspace: enforce from now on.
    assert.deepEqual(status(h).policy_signature, { mode: "enforce", last: "verified", reason: null });
    assert.equal(readMeta(h.dir).policy_issued_at, T(15));
    assert.ok(describeDelivery(h.dir, { url: "https://cloud.example.test" }).lines.some((l) => /rules signature\s+verified/.test(l)));
    // The raw 32-byte key form verifies the same signature.
    const raw = signed(doc(2), { keyId: "ws-raw", issuedAt: T(16) });
    assert.equal(checkPolicySignature(raw, { workspace: WORKSPACE, computer: INSTALLATION, managed: true, lastIssuedAt: null, keys: KEYS, now: NOW }).result, "verified");
    assert.ok(publicKeyFrom(KEYS[2].public_key));
    assert.equal(publicKeyFrom("not a key"), null);
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

/** Each forgery, as the workspace's answer to a computer already running signed revision 1 issued on day 15. */
const forgeries = [
  ["tampered rules and digest", () => {
    const good = signed(doc(2));
    const rules = { ...good.rules, "secret-read": { mode: "monitor" } };
    return { body: { ...good, rules, rules_digest: digestRules(rules) }, reason: "bad_signature" };
  }],
  ["tampered local_changes", () => ({ body: { ...signed(doc(2)), local_changes: true }, reason: "bad_signature" })],
  ["forged unmanaged answer (attacker's key under a trusted id)", () => ({ body: signed(unmanaged(), { key: attacker.privateKey }), reason: "bad_signature" })],
  ["a managed document's signature moved onto an unmanaged answer", () => {
    const good = signed(unmanaged(), { managed: true });
    return { body: good, reason: "bad_signature" };
  }],
  ["signed for another computer", () => ({ body: signed(doc(2), { computer: "gw-other" }), reason: "bad_signature" })],
  ["naming another computer", () => ({ body: signed({ ...doc(2), installation_id: "gw-other", export_id: "rev-2-gw-other" }, { computer: "gw-other" }), reason: "wrong_computer", inspected: true })],
  ["signed for another workspace", () => ({ body: signed(doc(2), { workspace: "org-other" }), reason: "bad_signature" })],
  ["naming another workspace", () => ({ body: signed(doc(2, {}, { workspace_id: "org-other" })), reason: "wrong_workspace" })],
  ["signed with an expired key", () => ({ body: signed(doc(2), { keyId: "ws-old", issuedAt: T(16) }), reason: "key_not_valid" })],
  ["signed with an unknown key", () => ({ body: signed(doc(2), { keyId: "ws-unknown", key: attacker.privateKey }), reason: "unknown_key" })],
  ["replayed: issued before the document in force", () => ({ body: signed(doc(2), { issuedAt: T(14) }), reason: "replayed" })],
  ["a malformed signature", () => ({ body: { ...signed(doc(2)), signature: "not base64!" }, reason: "malformed_signature" })],
];

for (const mode of ["enforce", "dual"]) {
  for (const [name, make] of forgeries) {
    test(`${mode}: ${name} is refused and the rules in force stay`, async () => {
      if (mode === "enforce") process.env.SCOPEBOND_POLICY_SIGNATURE_MODE = "enforce";
      const h = connected();
      try {
        assert.equal((await sync(h, signed(doc(1, { "push-protected": { mode: "monitor" } })))).outcome.state, "applied");
        const inForce = policyOf(h);
        const { body, reason, inspected } = make();
        const { outcome, calls } = await sync(h, body);
        assert.equal(outcome.state, "refused", JSON.stringify(outcome));
        assert.equal(policyOf(h), inForce, "a refused answer never changes the policy");
        assert.ok(isManaged(h.dir), "never back to no rules, nor to the computer's own rules");
        if (inspected) { assert.equal(outcome.reason, reason); return; } // refused by the document check, before the signature
        assert.equal(outcome.signature, reason, outcome.message);
        // Latched by the signed revision 1 (policy-freshness.ts): enforce in either configured mode.
        assert.deepEqual(status(h).policy_signature, { mode: "enforce", last: "refused", reason });
        assert.ok(describeDelivery(h.dir, { url: "https://cloud.example.test" }).problems.some((p) => p.includes(reason)));
        // The workspace is told: a rejected confirmation, in the reasons it already reads.
        const ack = calls.find((c) => c.url.endsWith("/v1/policy/ack"));
        assert.equal(ack?.body.result, "rejected");
        assert.match(ack.body.reason, /^(invalid_document|wrong_computer|stale_revision)$/);
      } finally { rmSync(h.dir, { recursive: true, force: true }); }
    });
  }
}

test("dual: an unsigned answer is accepted and recorded as unsigned_policy", async () => {
  const h = connected();
  try {
    assert.deepEqual((await sync(h, doc(1))).outcome, { state: "applied", revision: 1 });
    assert.deepEqual(status(h).policy_signature, { mode: "dual", last: "unsigned", reason: "unsigned_policy" });
    const report = describeDelivery(h.dir, { url: "https://cloud.example.test" });
    assert.ok(report.lines.some((l) => l.includes("unsigned_policy")));
    assert.equal(report.problems.length, 0, "accepted in dual mode: recorded, not a problem");
    // The next rules check tells the workspace.
    const { calls } = await sync(h, undefined, 304);
    assert.deepEqual(JSON.parse(calls[0].headers["x-scopebond-policy-signature"]), { mode: "dual", last: "unsigned", reason: "unsigned_policy" });
    // A 204 is unsigned too: accepted, back to the computer's own rules.
    assert.equal((await sync(h, undefined, 204)).outcome.state, "own_rules");
    assert.equal(isManaged(h.dir), false);
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("enforce: an unsigned answer is refused and the previous policy stays in force (never no rules)", async () => {
  process.env.SCOPEBOND_POLICY_SIGNATURE_MODE = "enforce";
  const h = connected();
  try {
    assert.equal((await sync(h, signed(doc(1, { "push-protected": { mode: "monitor" } })))).outcome.state, "applied");
    const inForce = policyOf(h);
    for (const [body, code] of [[doc(2), 200], [unmanaged(), 200], [undefined, 204], [undefined, 401]]) {
      const { outcome } = await sync(h, body, code);
      assert.notEqual(outcome.state, "applied");
      assert.notEqual(outcome.state, "own_rules");
      assert.equal(policyOf(h), inForce, `the policy in force stays after an unsigned ${code}`);
      assert.ok(isManaged(h.dir));
      assert.deepEqual(status(h).policy_signature, { mode: "enforce", last: "refused", reason: "unsigned_policy" });
    }
    // A signed, newer document still applies.
    assert.deepEqual((await sync(h, signed(doc(3), { issuedAt: T(17) }))).outcome, { state: "applied", revision: 3 });
    // And the workspace's signed "no rules" answer returns the computer to its own rules.
    assert.equal((await sync(h, signed(unmanaged(), { issuedAt: T(18) }))).outcome.state, "own_rules");
    assert.equal(isManaged(h.dir), false);
    assert.equal(status(h).policy_signature.last, "verified");
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("replay protection holds per workspace: a computer moved to another workspace is not held to the old one's clock", async () => {
  const h = connected();
  try {
    assert.equal((await sync(h, signed(doc(1), { issuedAt: T(15) }))).outcome.state, "applied");
    assert.equal((await sync(h, signed(doc(2), { issuedAt: T(14) }))).outcome.signature, "replayed");
    const conn = JSON.parse(readFileSync(join(h.dir, "cloud.json"), "utf8"));
    writeFileSync(join(h.dir, "cloud.json"), JSON.stringify({ ...conn, organization_id: "org-sig-2" }));
    assert.deepEqual((await sync(h, signed(doc(2), { workspace: "org-sig-2", issuedAt: T(14) }))).outcome, { state: "applied", revision: 2 });
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("an answer issued more than an hour ahead is refused, so it cannot become the replay mark", async () => {
  const h = connected();
  try {
    assert.equal((await sync(h, signed(doc(1), { issuedAt: T(15) }))).outcome.state, "applied");
    const far = await sync(h, signed(doc(2), { issuedAt: "2026-10-20T02:00:00Z" }));
    assert.equal(far.outcome.signature, "issued_in_future");
    assert.equal(readMeta(h.dir).policy_issued_at, T(15), "the replay mark did not move");
    // Within the hour's skew it is accepted, and the next answer from the workspace still applies.
    assert.equal((await sync(h, signed(doc(2), { issuedAt: "2026-10-20T00:30:00Z" }))).outcome.state, "applied");
    assert.equal((await sync(h, signed(doc(3), { issuedAt: "2026-10-20T00:45:00Z" }))).outcome.state, "applied");
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("a key shipped ahead of a rotation signs nothing before its window opens, even a document dated inside it", () => {
  const early = [{ key_id: "ws-next", public_key: pem(trusted), not_before: "2026-10-20T00:20:00Z", not_after: "2027-12-01T00:00:00Z" }];
  const body = signed(doc(1), { keyId: "ws-next", issuedAt: "2026-10-20T00:30:00Z" });
  const at = (now) => checkPolicySignature(body, { workspace: WORKSPACE, computer: INSTALLATION, managed: true, lastIssuedAt: null, keys: early, now: new Date(now) });
  assert.equal(at("2026-10-20T00:00:00Z").reason, "key_not_valid", "now is before the key's window");
  assert.equal(at("2026-10-20T00:31:00Z").result, "verified", "once the window is open, the same document verifies");
});

test("enforce: the version in force served again without its signature is refused, not confirmed as loaded", async () => {
  process.env.SCOPEBOND_POLICY_SIGNATURE_MODE = "enforce";
  const h = connected();
  try {
    const d1 = signed(doc(1));
    assert.equal((await sync(h, d1)).outcome.state, "applied");
    const stripped = { ...d1 };
    for (const field of ["issued_at", "key_id", "signature"]) delete stripped[field];
    const { outcome, calls } = await sync(h, stripped);
    assert.equal(outcome.state, "refused");
    assert.equal(outcome.signature, "unsigned_policy");
    assert.deepEqual(status(h).policy_signature, { mode: "enforce", last: "refused", reason: "unsigned_policy" });
    assert.ok(!calls.some((c) => c.url.endsWith("/v1/policy/ack") && c.body.result === "loaded"), "never confirmed as loaded");
    // The signed one served again is confirmed once more and the state is fresh.
    const again = await sync(h, d1);
    assert.deepEqual(again.outcome, { state: "unchanged", revision: 1 });
    assert.equal(again.calls.find((c) => c.url.endsWith("/v1/policy/ack"))?.body.result, "loaded");
    assert.equal(status(h).policy_signature.last, "verified");
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("a configured key that cannot be used is left out when the list is read, and doctor is told why", () => {
  const good = { key_id: "ok", public_key: pem(trusted), not_before: T(1), not_after: T(30) };
  const env = { SCOPEBOND_POLICY_KEYS_JSON: JSON.stringify([
    good,
    { ...good, key_id: "inverted", not_before: T(30), not_after: T(1) },
    { ...good, key_id: "unreadable", public_key: "bm90IGEga2V5" },
  ]) };
  const pinnedIds = policyKeys({}).map((k) => k.key_id);
  assert.deepEqual(policyKeys(env).map((k) => k.key_id), [...pinnedIds, "ok"]);
  const problems = policyKeyProblems(env);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /inverted: its window closes/);
  assert.match(problems[1], /unreadable: public_key is not an Ed25519 public key/);
  assert.match(policyKeyProblems({ SCOPEBOND_POLICY_KEYS_JSON: "{" })[0], /cannot be read/);
  assert.deepEqual(policyKeyProblems({}), []);
});

test("the mode: dual by default; enforce from the environment or cloud.json, and neither weakens the other", () => {
  assert.equal(signatureMode(null, {}), "dual");
  assert.equal(signatureMode(null, { SCOPEBOND_POLICY_SIGNATURE_MODE: "enforce" }), "enforce");
  assert.equal(signatureMode({ policy_signature_mode: "enforce" }, {}), "enforce");
  assert.equal(signatureMode({ policy_signature_mode: "enforce" }, { SCOPEBOND_POLICY_SIGNATURE_MODE: "dual" }), "enforce");
  assert.equal(signatureMode({ policy_signature_mode: "dual" }, { SCOPEBOND_POLICY_SIGNATURE_MODE: "ENFORCE " }), "enforce");
  assert.equal(signatureMode({ policy_signature_mode: "off" }, {}), "dual");
});

test("no key is pinned in this release; keys come from SCOPEBOND_POLICY_KEYS_JSON until one is", async () => {
  const saved = process.env.SCOPEBOND_POLICY_KEYS_JSON;
  delete process.env.SCOPEBOND_POLICY_KEYS_JSON;
  try {
    const check = checkPolicySignature(signed(doc(1)), { workspace: WORKSPACE, computer: INSTALLATION, managed: true, lastIssuedAt: null, now: NOW });
    assert.equal(check.result, "refused");
    assert.equal(check.reason, "unknown_key");
  } finally { process.env.SCOPEBOND_POLICY_KEYS_JSON = saved; }
});

test("every workspace call says which hook version makes it", async () => {
  assert.deepEqual(withHookVersion({ a: "1" }, "9.9.9"), { a: "1", [HOOK_VERSION_HEADER]: "9.9.9" });
  assert.equal(new Headers(withHookVersion(new Headers({ a: "1" }), "9.9.9")).get(HOOK_VERSION_HEADER), "9.9.9");
  assert.deepEqual(withHookVersion([["a", "1"]], "9.9.9"), [["a", "1"], [HOOK_VERSION_HEADER, "9.9.9"]]);
  assert.deepEqual(withHookVersion({ [HOOK_VERSION_HEADER]: "1.0.0" }, "9.9.9"), { [HOOK_VERSION_HEADER]: "1.0.0" }, "a version already set stays");
  const seen = [];
  await versionedFetch(async (_url, init) => { seen.push(new Headers(init.headers).get(HOOK_VERSION_HEADER)); return new Response("{}"); })("https://x.test/v1/receipts", { method: "POST", headers: { authorization: "Bearer x" } });
  assert.match(seen[0], /^\d+\.\d+\.\d+/, "the installed version, read from the package");
  // The rules check and its confirmation.
  const h = connected();
  try {
    const { calls } = await sync(h, doc(1));
    assert.ok(calls.length >= 2);
    for (const call of calls) assert.equal(new Headers(call.headers).get(HOOK_VERSION_HEADER), "0.23.0", call.url);
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
  // The uninstall notice.
  const sent = [];
  await reportUninstall({ url: "https://cloud.example.test", credential: "sbm_x" }, { purge: false, hookVersion: "0.23.0" },
    async (_url, init) => { sent.push(new Headers(init.headers).get(HOOK_VERSION_HEADER)); return new Response("{}"); });
  assert.deepEqual(sent, ["0.23.0"]);
});
