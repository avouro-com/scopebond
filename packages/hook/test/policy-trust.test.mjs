// Verify on use (policy-trust.ts): a computer whose rules a workspace manages under a verified answer keeps that answer as
// received beside the compiled policy, and checks the files against it whenever they change. A compiled policy, workspace
// document or pack index changed outside the hook (still valid JSON) is a mismatch: the call is refused, the reason is recorded,
// and the next rules check, due at once, installs the workspace's rules again. An untouched install pays the full check once
// per change; an unmanaged computer is not checked at all. Keys are made here at run time: no private key is ever committed.
import { ENFORCE } from "./enforce-all.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical } from "@scopebond/gateway";
import { packSigningInput } from "@scopebond/policy-schema/pack";
import {
  scaffold, policyBuilds, digestRules, digestPacks, syncPolicy, syncIfDue, isManaged, readMeta, createHookRuntime, mapClaudeToolUse,
  checkTrust, trustVerifications, PolicyTrustError, TRUSTED_ANSWER_FILE, MANAGED_DOC_FILE, setActivePacks,
} from "../dist/index.js";

const require = createRequire(import.meta.url);
const INSTALLATION = "gw-trust-1";
const WORKSPACE = "org-trust-1";
const T = (day) => `2026-10-${String(day).padStart(2, "0")}T00:00:00Z`;
const NOW = new Date(T(20));
const ETAG = "\"rev-1-trust\"";

const trusted = generateKeyPairSync("ed25519");
const KEYS = [{ key_id: "ws-1", public_key: trusted.publicKey.export({ type: "spki", format: "pem" }), not_before: T(1), not_after: "2027-10-01T00:00:00Z" }];
const previousKeys = process.env.SCOPEBOND_POLICY_KEYS_JSON;
process.env.SCOPEBOND_POLICY_KEYS_JSON = JSON.stringify(KEYS);
after(() => { if (previousKeys === undefined) delete process.env.SCOPEBOND_POLICY_KEYS_JSON; else process.env.SCOPEBOND_POLICY_KEYS_JSON = previousKeys; setActivePacks([]); });

const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const sig = (payload) => cryptoSign(null, Buffer.from(canonical(payload), "utf8"), trusted.privateKey).toString("base64");
const rules = () => ({
  "force-push-protected": { mode: "block" }, "push-protected": { mode: "block" }, "destructive-shell": { mode: "block" },
  "secret-read": { mode: "block" }, "ci-config-write": { mode: "block" }, "network-egress": { mode: "monitor" },
});
function doc(revision, extra = {}) {
  const r = rules();
  return { type: "scopebond:managed-rules", version: 1, revision, export_id: `rev-${revision}-${INSTALLATION}`, environment_id: "env-1",
    agent_id: "agent-1", installation_id: INSTALLATION, rules: r, rules_digest: digestRules(r), ...extra };
}
const payload = (body, digest, extra = {}) => ({ v: 1, workspace: WORKSPACE, computer: INSTALLATION, revision: body.revision, rules_digest: digest, local_changes: false, managed: true, issued_at: body.issued_at, ...extra });
/** Sign a rules document as the workspace does (and, when `packs` is given, its pack list). */
function signed(body, { packs, issuedAt = T(19) } = {}) {
  const out = { ...body, workspace_id: WORKSPACE, issued_at: issuedAt, key_id: "ws-1" };
  out.signature = sig(payload(out, out.rules_digest));
  if (packs === undefined) return out;
  const packsDigest = digestPacks({ packs });
  return { ...out, packs, packs_digest: packsDigest, packs_signature: sig(payload(out, packsDigest, { kind: "packs" })) };
}

/** The public example pack, signed by the workspace key. */
const example = JSON.parse(readFileSync(require.resolve("@scopebond/policy-schema/vectors/example-pack.json"), "utf8"));
function packText() {
  const unsigned = { ...example, version: "1.0.0", signature: { alg: "Ed25519", key_id: "ws-1", value: "A".repeat(86) + "==" } };
  const value = cryptoSign(null, Buffer.from(packSigningInput(unsigned), "utf8"), trusted.privateKey).toString("base64");
  return JSON.stringify({ ...unsigned, signature: { alg: "Ed25519", key_id: "ws-1", value } });
}

function computer({ connect = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "scopebond-trust-"));
  const { agentKid } = scaffold(dir, ENFORCE);
  if (connect) writeFileSync(join(dir, "cloud.json"), JSON.stringify({ url: "https://cloud.example.test", credential: "sbm_x", credential_id: "c", organization_id: WORKSPACE, environment_id: "env-1", gateway_id: INSTALLATION, attester_kid: "k", scopes: [], expires_at: "2099-01-01T00:00:00Z" }));
  return { dir, agentKid };
}
/** A workspace that answers every rules check with `body` (200) and serves `served` (ref → text) at /v1/packs. */
function workspace(body, served = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, headers: init.headers ?? {} });
    if (u.endsWith("/v1/policy/ack")) return new Response("{}", { status: 200 });
    const m = /\/v1\/packs\/([^/]+)$/.exec(u);
    if (m) { const text = served[decodeURIComponent(m[1])]; return text === undefined ? new Response("{}", { status: 404 }) : new Response(text, { status: 200 }); }
    return new Response(JSON.stringify(body), { status: 200, headers: { etag: ETAG } });
  };
  const rulesChecks = () => calls.filter((c) => c.url.endsWith("/v1/policy"));
  return { calls, rulesChecks, fetchImpl };
}
const options = (h, w) => ({ agentKid: h.agentKid, hookVersion: "0.32.0", policyBuilds, fetchImpl: w.fetchImpl, now: () => NOW });
const sync = (h, w) => syncPolicy(h.dir, options(h, w));

/** Build the runtime as a hook call does; returns the error it throws, or the decision for `command`. */
async function decide(h, command) {
  let runtime;
  try {
    runtime = createHookRuntime({ policyPath: join(h.dir, "policy.json"), keyPath: join(h.dir, "agent.key"), attesterPath: join(h.dir, "attester.key"), dbPath: join(h.dir, "receipts.db"), cwd: "/repo" });
  } catch (error) { return { error }; }
  try { return { decision: (await runtime.evaluate(mapClaudeToolUse({ cwd: "/repo", tool_name: "Bash", tool_input: { command } }))).decision }; } finally { runtime.close(); }
}
const read = (h, rel) => readFileSync(join(h.dir, rel), "utf8");
const edit = (h, rel, change) => writeFileSync(join(h.dir, rel), `${JSON.stringify(change(JSON.parse(read(h, rel))), null, 2)}\n`);

/** A managed computer with a verified answer installed, and what it installed. */
async function installed(body = signed(doc(1)), served = {}) {
  const h = computer();
  const w = workspace(body, served);
  assert.deepEqual(await sync(h, w), { state: "applied", revision: 1 });
  assert.ok(existsSync(join(h.dir, TRUSTED_ANSWER_FILE)), "the verified answer is kept beside the compiled policy");
  return { h, w, policy: read(h, "policy.json"), doc: read(h, MANAGED_DOC_FILE) };
}

/** The tamper is refused, recorded, makes the rules check due at once, and that check heals it. */
async function refusedThenHealed({ h, w }, expect) {
  const { error } = await decide(h, "git push --force origin main");
  assert.ok(error instanceof PolicyTrustError, `the call is refused (${error?.message ?? "it was not"})`);
  assert.equal(error.kind, "policy");
  assert.equal(error.managed, true);
  assert.match(error.message, expect);
  const meta = readMeta(h.dir);
  assert.match(meta.policy_trust?.reason ?? "", expect, "the reason is recorded");
  // The rules check ran at NOW, a minute ago on its own clock; it is due at once all the same, and fetches in full.
  const before = w.rulesChecks().length;
  const outcome = await syncIfDue(h.dir, () => options(h, w), 5_000, NOW.getTime() + 60_000);
  assert.deepEqual(outcome, { state: "applied", revision: 1 });
  assert.equal(w.rulesChecks().length, before + 1);
  assert.equal(w.rulesChecks().at(-1).headers["if-none-match"], undefined, "a mismatch is not answered \"unchanged\"");
  assert.equal(readMeta(h.dir).policy_trust, null);
  assert.deepEqual(checkTrust(h.dir).ok, true);
  const { decision } = await decide(h, "git push --force origin main");
  assert.equal(decision, "deny", "the workspace's rules are back in force");
}

test("a compiled policy changed on disk (still valid JSON) is refused, then installed again by the next rules check", async () => {
  const s = await installed();
  try {
    assert.equal((await decide(s.h, "git push --force origin main")).decision, "deny");
    // Every rule records instead of blocking: the file still parses and builds.
    edit(s.h, "policy.json", (p) => ({ ...p, clauses: p.clauses.map((c) => (c.mode === "enforce" && !String(c.id).startsWith("protect-scopebond") ? { ...c, mode: "monitor" } : c)) }));
    await refusedThenHealed(s, /policy\.json changed/);
    assert.equal(read(s.h, "policy.json"), s.policy, "the workspace's compiled rules are back");
  } finally { rmSync(s.h.dir, { recursive: true, force: true }); }
});

test("a workspace document changed on disk is refused, then installed again", async () => {
  const s = await installed();
  try {
    edit(s.h, MANAGED_DOC_FILE, (d) => ({ ...d, local_changes: true, rules: { ...d.rules, "push-protected": { mode: "monitor" } } }));
    await refusedThenHealed(s, /managed-rules\.json is not the signed answer/);
    assert.equal(read(s.h, MANAGED_DOC_FILE), s.doc);
  } finally { rmSync(s.h.dir, { recursive: true, force: true }); }
});

test("a pack index changed on disk is refused, then written again from the signed pack list", async () => {
  const text = packText();
  const ref = { id: example.id, version: "1.0.0", sha256: sha(text) };
  const s = await installed(signed(doc(1), { packs: [ref] }), { [`${example.id}@1.0.0`]: text });
  try {
    const index = read(s.h, "packs/index.json");
    assert.deepEqual(JSON.parse(index).packs, [ref]);
    // The pack dropped from the index: it would no longer be used, and the file is a valid index.
    edit(s.h, "packs/index.json", (i) => ({ ...i, packs: [] }));
    await refusedThenHealed(s, /packs\/index\.json changed/);
    assert.deepEqual(JSON.parse(read(s.h, "packs/index.json")).packs, [ref], "the signed list's pack is listed again");
  } finally { rmSync(s.h.dir, { recursive: true, force: true }); }
});

test("the stored answer itself cannot be swapped: another document with its hashes recomputed does not verify", async () => {
  const s = await installed();
  try {
    const record = JSON.parse(read(s.h, TRUSTED_ANSWER_FILE));
    const forged = { ...record.answer, rules: { ...record.answer.rules, "destructive-shell": { mode: "monitor" } } };
    forged.rules_digest = digestRules(forged.rules);
    writeFileSync(join(s.h.dir, MANAGED_DOC_FILE), `${JSON.stringify(forged, null, 2)}\n`);
    const files = { ...record.files, [MANAGED_DOC_FILE]: sha(read(s.h, MANAGED_DOC_FILE)) };
    const binding = sha(canonical({ v: 1, answer: sha(canonical(forged)), files }));
    writeFileSync(join(s.h.dir, TRUSTED_ANSWER_FILE), JSON.stringify({ v: 1, answer: forged, files, binding }));
    await refusedThenHealed(s, /does not verify/);
  } finally { rmSync(s.h.dir, { recursive: true, force: true }); }
});

test("an untouched install is unaffected and pays the full check once per change", async () => {
  const s = await installed();
  try {
    const start = trustVerifications();
    for (let i = 0; i < 3; i++) assert.equal((await decide(s.h, "git push --force origin main")).decision, "deny");
    assert.equal((await decide(s.h, "ls")).decision, "allow");
    assert.equal(trustVerifications() - start, 1, "four loads, one full check");
    // A new process reads the cached result: no full check either.
    const fresh = await import(`../dist/policy-trust.js?process=${Date.now()}`);
    assert.equal(fresh.checkTrust(s.h.dir).ok, true);
    assert.equal(fresh.trustVerifications(), 0, "the result is cached on disk, keyed by the files' size and times");
    // The workspace's answer again (same version) changes none of the files: no further check.
    assert.deepEqual(await sync(s.h, s.w), { state: "unchanged", revision: 1 });
    for (let i = 0; i < 2; i++) assert.equal((await decide(s.h, "git push --force origin main")).decision, "deny");
    assert.equal(trustVerifications() - start, 1, "nothing changed, nothing checked again");
    // A change to a file the answer explains (the rules file rewritten byte for byte as the hook writes it) is checked once.
    writeFileSync(join(s.h.dir, "policy.json"), s.policy);
    for (let i = 0; i < 2; i++) assert.equal((await decide(s.h, "git push --force origin main")).decision, "deny");
    assert.equal(trustVerifications() - start, 2, "one full check for the change");
    assert.equal(readMeta(s.h.dir).policy_trust ?? null, null);
  } finally { rmSync(s.h.dir, { recursive: true, force: true }); }
});

test("an unmanaged computer behaves as before: nothing is kept or checked", async () => {
  // Not connected: no workspace answer was ever verified.
  const local = computer({ connect: false });
  // Connected, rules from an unsigned answer (dual mode): never latched.
  const unsigned = computer();
  try {
    const start = trustVerifications();
    assert.equal((await decide(local, "ls")).decision, "allow");
    edit(local, "policy.json", (p) => ({ ...p, version: 99 }));
    assert.equal((await decide(local, "ls")).decision, "allow", "a computer's own rules file is its own to edit");
    assert.deepEqual(checkTrust(local.dir), { applies: false });

    assert.deepEqual(await sync(unsigned, workspace(doc(1))), { state: "applied", revision: 1 });
    assert.ok(isManaged(unsigned.dir));
    assert.equal(existsSync(join(unsigned.dir, TRUSTED_ANSWER_FILE)), false, "no verified answer, nothing kept");
    edit(unsigned, "policy.json", (p) => ({ ...p, version: 99 }));
    assert.equal((await decide(unsigned, "ls")).decision, "allow", "as before: the rules file is used as it is");
    assert.deepEqual(checkTrust(unsigned.dir), { applies: false });
    assert.equal(trustVerifications(), start, "no check ran");
  } finally {
    rmSync(local.dir, { recursive: true, force: true });
    rmSync(unsigned.dir, { recursive: true, force: true });
  }
});

test("a latched computer whose verified answer is missing is refused and heals", async () => {
  const s = await installed();
  try {
    rmSync(join(s.h.dir, TRUSTED_ANSWER_FILE));
    await refusedThenHealed(s, /signed workspace answer behind these rules is missing/);
    assert.ok(existsSync(join(s.h.dir, TRUSTED_ANSWER_FILE)));
  } finally { rmSync(s.h.dir, { recursive: true, force: true }); }
});
