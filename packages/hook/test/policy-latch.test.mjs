// The signature latch, freshness proofs and signed revocations (policy-freshness.ts). Once an answer from the workspace has
// verified, the computer accepts only signed answers from it: an unsigned 200, a 204, unsigned grants and a 401 without a
// verified revocation all leave the rules in force. A 304 renews nothing (neither the proof's validity nor the packs' clock)
// unless it carries a verified freshness proof for the ETag in force, and past the last proof's `valid_until` the workspace's
// allowances let nothing through while its rules stay. A computer that never received a verified answer behaves as before.
// The freshness and revocation payloads are built here from the contract (canonical JSON from the gateway), not from the hook's
// own helpers. Keys are made here at run time: no private key is ever committed.
import { ENFORCE } from "./enforce-all.mjs";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical } from "@scopebond/gateway";
import * as hook from "../dist/index.js";
import { actionKey } from "../dist/override.js";

const {
  scaffold, policyBuilds, digestRules, syncPolicy, isManaged, readMeta, buildStatusJson, describeDelivery, checkFreshness,
  createHookRuntime, mapClaudeToolUse, createOverrideHandler, makeAllowance, writeAllowances, grantsExpired,
} = hook;

const INSTALLATION = "gw-latch-1";
const WORKSPACE = "org-latch-1";
const HOUR = 60 * 60 * 1000;
const T = (day) => `2026-10-${String(day).padStart(2, "0")}T00:00:00Z`;
const NOW = new Date(T(20));
const at = (hours) => new Date(NOW.getTime() + hours * HOUR);
const iso = (hours) => at(hours).toISOString();
const ETAG = "\"rev-1-abc\"";

const trusted = generateKeyPairSync("ed25519");
const attacker = generateKeyPairSync("ed25519");
const KEYS = [{ key_id: "ws-1", public_key: trusted.publicKey.export({ type: "spki", format: "pem" }), not_before: T(1), not_after: "2027-10-01T00:00:00Z" }];
process.env.SCOPEBOND_POLICY_KEYS_JSON = JSON.stringify(KEYS);
afterEach(() => { delete process.env.SCOPEBOND_POLICY_SIGNATURE_MODE; });

const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const sig = (payload, key = trusted.privateKey) => cryptoSign(null, Buffer.from(canonical(payload), "utf8"), key).toString("base64");
const terms = () => ({ reason_min: 10, minutes: 0, daily_limit: 5, harness_prompt: false });
const rules = () => ({
  "force-push-protected": { mode: "block" }, "push-protected": { mode: "block" }, "destructive-shell": { mode: "override", override: terms() },
  "secret-read": { mode: "block" }, "ci-config-write": { mode: "block" }, "network-egress": { mode: "monitor" },
});
function doc(revision, extra = {}) {
  const r = rules();
  return { type: "scopebond:managed-rules", version: 1, revision, export_id: `rev-${revision}-${INSTALLATION}`, environment_id: "env-1",
    agent_id: "agent-1", installation_id: INSTALLATION, rules: r, rules_digest: digestRules(r), ...extra };
}
const unmanaged = () => ({ type: "scopebond:managed-rules", version: 1, managed: false, installation_id: INSTALLATION, revision: 0, rules_digest: "0".repeat(64), local_changes: false });
const grantsDigest = (body) => createHash("sha256").update(canonical({
  allowances: body.allowances ?? [], revoked_allowances: body.revoked_allowances ?? [], session_budgets: body.session_budgets ?? [], request_answers: body.request_answers ?? [],
})).digest("hex");
const payload = (revision, digest, managed, issuedAt, extra = {}) => ({ v: 1, workspace: WORKSPACE, computer: INSTALLATION, revision, rules_digest: digest, local_changes: false, managed, issued_at: issuedAt, ...extra });
/** Sign the rules (and, unless `grants: false`, the grants) as the workspace does. */
function signed(body, { issuedAt = iso(-24), grants = true } = {}) {
  const managed = body.managed !== false;
  const out = { ...body, issued_at: issuedAt, key_id: "ws-1", signature: sig(payload(body.revision, body.rules_digest, managed, issuedAt)) };
  if (!grants || !managed) return out;
  const digest = grantsDigest(body);
  return { ...out, grants_digest: digest, grants_signature: sig(payload(body.revision, digest, true, issuedAt, { kind: "grants" })) };
}
/** A freshness proof as the workspace makes it. Each option changes one thing a forger might. */
function freshness({ etag = ETAG, managed = true, revision = 1, issuedAt = iso(0), validUntil, key = trusted.privateKey, computer = INSTALLATION, kind = "freshness", signedUntil } = {}) {
  const until = validUntil ?? new Date(Date.parse(issuedAt) + 72 * HOUR).toISOString();
  const digest = managed ? sha(etag) : sha("unmanaged");
  const body = { ...payload(revision, digest, managed, issuedAt), computer, ...(kind ? { kind } : {}), ...(kind ? { valid_until: signedUntil ?? until } : {}) };
  return { v: 1, issued_at: issuedAt, valid_until: until, etag_digest: digest, key_id: "ws-1", signature: sig(body, key) };
}
const header = (proof) => Buffer.from(JSON.stringify(proof), "utf8").toString("base64url");
function revocation({ issuedAt = iso(0), key = trusted.privateKey, kind = "revocation" } = {}) {
  return { v: 1, issued_at: issuedAt, key_id: "ws-1", signature: sig(payload(0, sha("revoked"), false, issuedAt, kind ? { kind } : {}), key) };
}

function connected() {
  const dir = mkdtempSync(join(tmpdir(), "scopebond-latch-"));
  const { agentKid } = scaffold(dir, ENFORCE);
  writeFileSync(join(dir, "cloud.json"), JSON.stringify({ url: "https://cloud.example.test", credential: "sbm_x", credential_id: "c", organization_id: WORKSPACE, environment_id: "env-1", gateway_id: INSTALLATION, attester_kid: "k", scopes: [], expires_at: "2099-01-01T00:00:00Z" }));
  return { dir, agentKid };
}
/** One rules check answered with `status`, an optional JSON `body` and `headers`, at `now`. */
async function sync(h, { status = 200, body, headers = {} } = {}, now = NOW) {
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/v1/policy/ack")) return new Response("{}", { status: 200 });
    return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: status === 200 && body?.managed !== false ? { etag: ETAG, ...headers } : headers });
  };
  return syncPolicy(h.dir, { agentKid: h.agentKid, hookVersion: "0.32.0", policyBuilds, fetchImpl, now: () => now });
}
const policyOf = (h) => readFileSync(join(h.dir, "policy.json"), "utf8");
const status = (h) => buildStatusJson({ version: "test", activeDir: h.dir, candidateDirs: [h.dir], hasPolicy: true, agents: { claude: true, cursor: false, codex: false }, now: NOW.getTime() });
/** Give the computer a pack index the 304 may renew, and say the last pack list was complete. */
function holdPacks(h) {
  mkdirSync(join(h.dir, "packs"), { recursive: true });
  writeFileSync(join(h.dir, "packs", "index.json"), JSON.stringify({ v: 1, checked_at: T(1), packs: [] }));
  const meta = readMeta(h.dir);
  writeFileSync(join(h.dir, "managed-meta.json"), JSON.stringify({ ...meta, packs: { at: T(1), digest: null, complete: true, error: null } }));
}
const packsCheckedAt = (h) => JSON.parse(readFileSync(join(h.dir, "packs", "index.json"), "utf8")).checked_at;

const bash = (command) => ({ tool_name: "Bash", tool_input: { command } });
const keyOf = (command) => actionKey(mapClaudeToolUse({ cwd: "/repo", ...bash(command) }).find((m) => m.intent.action_type === "shell.exec").intent);
async function decide(h, command, now) {
  const runtime = createHookRuntime({
    policyPath: join(h.dir, "policy.json"), keyPath: join(h.dir, "agent.key"), attesterPath: join(h.dir, "attester.key"), dbPath: join(h.dir, "receipts.db"), cwd: "/repo",
    override: (agentKid) => {
      const made = createOverrideHandler({ dir: h.dir, home: h.dir, agentKid, harness: "claude", waitMs: 50, now: () => now.getTime(), ask: async () => ({ decision: "unavailable" }) });
      return made ? { handler: made.handler, hint: () => null } : null;
    },
  });
  try { return (await runtime.evaluate(mapClaudeToolUse({ cwd: "/repo", ...bash(command) }))).decision; } finally { runtime.close(); }
}

test("the first verified answer latches the computer: recorded beside the rules, and enforce from then on", async () => {
  const h = connected();
  try {
    // Unlatched and in dual mode, an unsigned answer is accepted as before and latches nothing.
    assert.deepEqual(await sync(h, { body: doc(1) }), { state: "applied", revision: 1 });
    assert.equal(readMeta(h.dir).policy_latch ?? null, null);
    assert.equal(status(h).policy_signature.mode, "dual");
    // The first signed answer verifies: latched to this workspace, with its proof kept.
    assert.deepEqual(await sync(h, { body: { ...signed(doc(2), { issuedAt: iso(-1) }), freshness: freshness({ revision: 2 }) } }), { state: "applied", revision: 2 });
    const meta = readMeta(h.dir);
    assert.equal(meta.policy_latch.workspace, WORKSPACE);
    assert.equal(meta.policy_latch.key_id, "ws-1");
    assert.equal(meta.policy_freshness.valid_until, iso(72));
    assert.equal(meta.policy_freshness.etag_digest, sha(ETAG));
    assert.equal(status(h).policy_signature.mode, "enforce");
    // The signed "no rules" answer latches too, and its proof is for "unmanaged".
    const g = connected();
    try {
      assert.equal((await sync(g, { body: { ...signed(unmanaged()), freshness: freshness({ managed: false, revision: 0 }) } })).state, "own_rules");
      assert.equal(readMeta(g.dir).policy_latch.workspace, WORKSPACE);
      assert.equal(readMeta(g.dir).policy_freshness.etag_digest, sha("unmanaged"));
    } finally { rmSync(g.dir, { recursive: true, force: true }); }
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

/** Answers a latched computer (signed revision 1 in force) must not act on, in dual mode. */
const ignoredOnceLatched = [
  ["an unsigned rules document", { body: doc(2) }],
  ["an unsigned \"no rules\" answer", { body: unmanaged() }],
  ["a 204", { status: 204 }],
  ["a 401 with no revocation", { status: 401 }],
  ["a 401 with a revocation signed by another key", { status: 401, body: { revocation: revocation({ key: attacker.privateKey }) } }],
  ["a 401 with a rules-kind signature offered as a revocation", { status: 401, body: { revocation: revocation({ kind: null }) } }],
  ["a 401 replaying a revocation older than the rules in force", { status: 401, body: { revocation: revocation({ issuedAt: iso(-48) }) } }],
  ["a signed document carrying unsigned grants", { body: signed(doc(2, { allowances: [{ ...makeAllowance({ rule: "destructive-shell", actionKey: "k", reason: "never approved by anyone", osUserDigest: null, lasts: "always", now: NOW.getTime() }), created_by: "workspace" }] }), { issuedAt: iso(-1), grants: false }) }],
];
for (const [name, answer] of ignoredOnceLatched) {
  test(`latched (dual mode): ${name} leaves the workspace rules in force`, async () => {
    const h = connected();
    try {
      assert.equal((await sync(h, { body: signed(doc(1)) })).state, "applied");
      const inForce = policyOf(h);
      const outcome = await sync(h, answer);
      assert.notEqual(outcome.state, "applied");
      assert.notEqual(outcome.state, "own_rules");
      assert.equal(policyOf(h), inForce, "the policy in force stays");
      assert.ok(isManaged(h.dir), "never back to the computer's own rules");
      assert.equal(readMeta(h.dir).rules_dropped_at ?? null, null);
      assert.equal(status(h).policy_signature.last, "refused");
    } finally { rmSync(h.dir, { recursive: true, force: true }); }
  });
}

for (const mode of ["dual", "enforce"]) {
  test(`${mode}: a verified revocation drops the workspace rules, latched or not`, async () => {
    if (mode === "enforce") process.env.SCOPEBOND_POLICY_SIGNATURE_MODE = "enforce";
    const h = connected();
    try {
      assert.equal((await sync(h, { body: signed(doc(1)) })).state, "applied");
      const outcome = await sync(h, { status: 401, body: { error: "revoked", revocation: revocation() } });
      assert.deepEqual(outcome, { state: "disconnected" });
      assert.equal(isManaged(h.dir), false, "the workspace's rules no longer apply: the computer's own rules do");
      const meta = readMeta(h.dir);
      assert.ok(meta.rules_dropped_at, "the person is told once");
      assert.equal(meta.policy_signature.last, "verified");
      assert.equal(meta.policy_issued_at, iso(0));
    } finally { rmSync(h.dir, { recursive: true, force: true }); }
  });
}

/** A latched computer with signed revision 1 (ETag `ETAG`) and its proof (issued now, valid 72 hours), holding packs. */
async function latchedWithProof() {
  const h = connected();
  assert.equal((await sync(h, { body: { ...signed(doc(1)), freshness: freshness() } })).state, "applied");
  holdPacks(h);
  assert.equal(readMeta(h.dir).policy_freshness.valid_until, iso(72));
  return h;
}

test("latched: a 304 without a freshness proof keeps the rules and renews nothing", async () => {
  const h = await latchedWithProof();
  try {
    const inForce = policyOf(h);
    assert.deepEqual(await sync(h, { status: 304 }, at(24)), { state: "unchanged", revision: 1 });
    assert.equal(policyOf(h), inForce);
    assert.equal(readMeta(h.dir).policy_freshness.valid_until, iso(72), "the proof's validity is not extended");
    assert.equal(packsCheckedAt(h), T(1), "the packs' clock is not renewed");
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("latched: a 304 with a verified freshness proof for the ETag in force extends it and renews the packs", async () => {
  const h = await latchedWithProof();
  try {
    const proof = freshness({ issuedAt: iso(24) });
    assert.deepEqual(await sync(h, { status: 304, headers: { "x-scopebond-policy-freshness": header(proof) } }, at(24)), { state: "unchanged", revision: 1 });
    assert.equal(readMeta(h.dir).policy_freshness.valid_until, iso(96));
    assert.equal(readMeta(h.dir).policy_freshness.issued_at, iso(24));
    assert.equal(packsCheckedAt(h), iso(24));
    assert.equal(readMeta(h.dir).last_error, null);
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

/** Proofs a 304 may carry that must not renew anything. */
const tamperedProofs = [
  ["valid_until moved after signing", () => ({ ...freshness({ issuedAt: iso(24) }), valid_until: iso(200) })],
  ["issued_at moved after signing", () => ({ ...freshness({ issuedAt: iso(24) }), issued_at: iso(30) })],
  ["for another ETag", () => freshness({ issuedAt: iso(24), etag: "\"rev-0-old\"" })],
  ["for another revision", () => freshness({ issuedAt: iso(24), revision: 7 })],
  ["the \"no rules\" proof offered for a rules document", () => ({ ...freshness({ issuedAt: iso(24), managed: false, revision: 1 }), etag_digest: sha(ETAG) })],
  ["signed for another computer", () => freshness({ issuedAt: iso(24), computer: "gw-other" })],
  ["signed by another key", () => freshness({ issuedAt: iso(24), key: attacker.privateKey })],
  ["a rules-kind signature (no kind, no valid_until)", () => freshness({ issuedAt: iso(24), kind: null })],
  ["valid for more than 72 hours (correctly signed)", () => freshness({ issuedAt: iso(24), validUntil: iso(24 + 73) })],
  ["valid_until before issued_at (correctly signed)", () => freshness({ issuedAt: iso(24), validUntil: iso(23) })],
  ["older than the proof kept (replayed)", () => freshness({ issuedAt: iso(-1) })],
  ["not base64url JSON", () => "%%%"],
];
for (const [name, make] of tamperedProofs) {
  test(`latched: a 304 whose freshness proof is ${name} is refused and renews nothing`, async () => {
    const h = await latchedWithProof();
    try {
      const inForce = policyOf(h);
      const proof = make();
      const value = typeof proof === "string" ? proof : header(proof);
      assert.deepEqual(await sync(h, { status: 304, headers: { "x-scopebond-policy-freshness": value } }, at(24)), { state: "unchanged", revision: 1 });
      assert.equal(policyOf(h), inForce, "the rules stay");
      assert.equal(readMeta(h.dir).policy_freshness.valid_until, iso(72), "not extended");
      assert.equal(packsCheckedAt(h), T(1), "the packs' clock is not renewed");
      assert.match(readMeta(h.dir).last_error ?? "", /freshness/);
    } finally { rmSync(h.dir, { recursive: true, force: true }); }
  });
}

test("a tampered freshness proof beside a signed document is not kept (the document itself is installed)", async () => {
  const h = connected();
  try {
    const outcome = await sync(h, { body: { ...signed(doc(1)), freshness: { ...freshness(), valid_until: iso(500) } } });
    assert.deepEqual(outcome, { state: "applied", revision: 1 });
    assert.equal(readMeta(h.dir).policy_freshness ?? null, null);
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("expiry: past the last proof the workspace's allowances let nothing through, the rules stay, and a fresh proof restores them", async () => {
  const h = connected();
  try {
    const fromWorkspace = { ...makeAllowance({ rule: "destructive-shell", actionKey: keyOf("rm -rf ../build"), reason: "approved by the reviewer", osUserDigest: null, lasts: "always", now: NOW.getTime() }), created_by: "workspace" };
    const mine = makeAllowance({ rule: "destructive-shell", actionKey: keyOf("rm -rf ../dist"), reason: "my own clean-up step", osUserDigest: null, lasts: "always", now: NOW.getTime() });
    writeAllowances(h.dir, [mine], NOW.getTime());
    assert.equal((await sync(h, { body: { ...signed(doc(1, { allowances: [fromWorkspace] })), freshness: freshness() } })).state, "applied");
    const inForce = policyOf(h);
    assert.equal(await decide(h, "rm -rf ../build", at(1)), "allow", "the workspace's allowance applies while fresh");
    assert.equal(grantsExpired(h.dir, at(71).getTime()), false);
    // 73 hours on, with no fresh signed answer since: expired.
    assert.equal(grantsExpired(h.dir, at(73).getTime()), true);
    assert.equal(await decide(h, "rm -rf ../build", at(73)), "deny", "an expired workspace allowance allows nothing");
    assert.equal(await decide(h, "rm -rf ../dist", at(73)), "allow", "the person's own allowance is not the workspace's");
    assert.equal(await decide(h, "git push --force origin main", at(73)), "deny", "the rules stay in force");
    assert.equal(policyOf(h), inForce);
    assert.ok(isManaged(h.dir));
    // doctor says so (it reads this computer's clock, which is past the proof made for 2026-10-20).
    assert.ok(describeDelivery(h.dir, { url: "https://cloud.example.test" }).problems.some((p) => /no fresh signed answer/.test(p)));
    // A 304 without a proof restores nothing.
    await sync(h, { status: 304 }, at(74));
    assert.equal(await decide(h, "rm -rf ../build", at(74)), "deny");
    // A 304 with a verified proof restores the grants.
    await sync(h, { status: 304, headers: { "x-scopebond-policy-freshness": header(freshness({ issuedAt: iso(75) })) } }, at(75));
    assert.equal(await decide(h, "rm -rf ../build", at(76)), "allow", "a fresh verified answer restores the workspace's allowances");
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("unlatched: a computer that never received a verified answer behaves as before", async () => {
  const h = connected();
  try {
    assert.deepEqual(await sync(h, { body: doc(1) }), { state: "applied", revision: 1 });
    holdPacks(h);
    // A 304 without a proof renews the packs as before.
    assert.deepEqual(await sync(h, { status: 304 }, at(1)), { state: "unchanged", revision: 1 });
    assert.equal(packsCheckedAt(h), iso(1));
    // A signed answer by a key this computer does not trust verifies nothing, so it latches nothing.
    const foreign = { ...doc(2), issued_at: iso(-1), key_id: "ws-unknown", signature: sig(payload(2, doc(2).rules_digest, true, iso(-1)), attacker.privateKey) };
    assert.equal((await sync(h, { body: foreign })).state, "refused");
    assert.equal(readMeta(h.dir).policy_latch ?? null, null);
    // An unsigned answer still applies, nothing ever expires, a 204 returns to the computer's own rules.
    assert.deepEqual(await sync(h, { body: doc(3) }), { state: "applied", revision: 3 });
    assert.equal(grantsExpired(h.dir, at(10_000).getTime()), false);
    assert.equal((await sync(h, { status: 204 })).state, "own_rules");
    assert.equal(isManaged(h.dir), false);
    // And a 401 drops the workspace's rules as before.
    assert.equal((await sync(h, { body: doc(4) })).state, "applied");
    assert.deepEqual(await sync(h, { status: 401 }), { state: "disconnected" });
    assert.equal(isManaged(h.dir), false);
    assert.equal(status(h).policy_signature.mode, "dual");
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("checkFreshness: the contract's payload verifies; the same bytes under another kind do not", () => {
  const proof = freshness({ issuedAt: iso(0) });
  const context = { workspace: WORKSPACE, computer: INSTALLATION, revision: 1, managed: true, etag: ETAG, lastIssuedAt: null, keys: KEYS, now: NOW };
  const ok = checkFreshness(proof, context);
  assert.equal(ok.result, "verified");
  assert.deepEqual(ok.freshness, { workspace: WORKSPACE, etag_digest: sha(ETAG), issued_at: iso(0), valid_until: iso(72), key_id: "ws-1" });
  assert.equal(checkFreshness(undefined, context).result, "absent");
  assert.equal(checkFreshness(proof, { ...context, workspace: "org-other" }).reason, "bad_signature");
  assert.equal(checkFreshness(proof, { ...context, etag: "\"other\"" }).reason, "freshness_mismatch");
  assert.equal(checkFreshness(freshness({ kind: "revocation" }), context).reason, "bad_signature");
});
