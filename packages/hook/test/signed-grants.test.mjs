// Signed grants. A rules document's allowances, revoked allowances, session budgets and request answers decide whether a blocked
// action is let through, so the workspace signs them too: `grants_digest` (sha256 of the canonical JSON of those four lists,
// absent as []) and `grants_signature`, over the rules payload with that digest, `local_changes: false`, `managed: true` and
// `kind: "grants"`. A changed list never verifies, a rules signature never verifies as a grants signature, and a change to the
// grants alone (same revision, same rules digest) is installed rather than treated as "unchanged".
// Keys are made here at run time: no private key is ever committed.
import { ENFORCE } from "./enforce-all.mjs";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical } from "@scopebond/gateway";
import * as hook from "../dist/index.js";
import { actionKey } from "../dist/override.js";

const {
  scaffold, policyBuilds, digestRules, syncPolicy, isManaged, readMeta, signedPolicyBytes, checkGrantsSignature,
  createHookRuntime, mapClaudeToolUse, createOverrideHandler, makeAllowance, writeAllowances, MANAGED_DOC_FILE,
} = hook;

const INSTALLATION = "gw-grants-1";
const WORKSPACE = "org-grants-1";
const T = (day) => `2026-10-${String(day).padStart(2, "0")}T00:00:00Z`;
const NOW = new Date(T(20));
const trusted = generateKeyPairSync("ed25519");
const KEYS = [{ key_id: "ws-1", public_key: trusted.publicKey.export({ type: "spki", format: "pem" }), not_before: T(1), not_after: "2027-10-01T00:00:00Z" }];
process.env.SCOPEBOND_POLICY_KEYS_JSON = JSON.stringify(KEYS);
afterEach(() => { delete process.env.SCOPEBOND_POLICY_SIGNATURE_MODE; });

const terms = (extra = {}) => ({ reason_min: 10, minutes: 0, daily_limit: 5, harness_prompt: false, ...extra });
const rulesWith = (overrides = {}) => ({
  "force-push-protected": { mode: "block" }, "push-protected": { mode: "block" }, "destructive-shell": { mode: "override", override: terms() },
  "secret-read": { mode: "block" }, "ci-config-write": { mode: "block" }, "network-egress": { mode: "monitor" }, ...overrides,
});
function doc(revision, extra = {}, rules = rulesWith()) {
  return {
    type: "scopebond:managed-rules", version: 1, revision, export_id: `rev-${revision}-${INSTALLATION}`, environment_id: "env-1",
    agent_id: "agent-1", installation_id: INSTALLATION, rules, rules_digest: digestRules(rules), ...extra,
  };
}
/** The grants digest, computed here from the contract rather than from the hook's own helper. */
const grantsDigest = (body) => createHash("sha256").update(canonical({
  allowances: body.allowances ?? [], revoked_allowances: body.revoked_allowances ?? [],
  session_budgets: body.session_budgets ?? [], request_answers: body.request_answers ?? [],
})).digest("hex");
const sig = (payload) => cryptoSign(null, signedPolicyBytes(payload), trusted.privateKey).toString("base64");
const base = (body, issuedAt) => ({ v: 1, workspace: WORKSPACE, computer: INSTALLATION, revision: body.revision, local_changes: false, managed: true, issued_at: issuedAt });
/** Sign the rules, and (unless `grants: false`) the grants, as the workspace does. */
function signed(body, { issuedAt = T(15), grants = true } = {}) {
  const out = { ...body, issued_at: issuedAt, key_id: "ws-1",
    signature: sig({ ...base(body, issuedAt), rules_digest: body.rules_digest, local_changes: body.local_changes === true }) };
  if (!grants) return out;
  const digest = grantsDigest(body);
  return { ...out, grants_digest: digest, grants_signature: sig({ ...base(body, issuedAt), rules_digest: digest, kind: "grants" }) };
}

function connected() {
  const dir = mkdtempSync(join(tmpdir(), "scopebond-grants-"));
  const { agentKid } = scaffold(dir, ENFORCE);
  writeFileSync(join(dir, "cloud.json"), JSON.stringify({ url: "https://cloud.example.test", credential: "sbm_x", credential_id: "c", organization_id: WORKSPACE, environment_id: "env-1", gateway_id: INSTALLATION, attester_kid: "k", scopes: [], expires_at: "2099-01-01T00:00:00Z" }));
  return { dir, agentKid };
}
async function sync(h, body, etag = `"e-${Math.random()}"`) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined });
    if (String(url).endsWith("/v1/policy/ack")) return new Response("{}", { status: 200 });
    return new Response(JSON.stringify(body), { status: 200, headers: { etag } });
  };
  const outcome = await syncPolicy(h.dir, { agentKid: h.agentKid, hookVersion: "0.25.1", policyBuilds, fetchImpl, now: () => NOW });
  return { outcome, calls };
}
const installed = (h) => JSON.parse(readFileSync(join(h.dir, MANAGED_DOC_FILE), "utf8"));

const bash = (command) => ({ tool_name: "Bash", tool_input: { command } });
const keyOf = (command) => actionKey(mapClaudeToolUse({ cwd: "/repo", ...bash(command) }).find((m) => m.intent.action_type === "shell.exec").intent);
async function decide(h, command) {
  const runtime = createHookRuntime({
    policyPath: join(h.dir, "policy.json"), keyPath: join(h.dir, "agent.key"), attesterPath: join(h.dir, "attester.key"), dbPath: join(h.dir, "receipts.db"), cwd: "/repo",
    override: (agentKid) => {
      const made = createOverrideHandler({ dir: h.dir, home: h.dir, agentKid, harness: "claude", waitMs: 50, ask: async () => ({ decision: "unavailable" }) });
      return made ? { handler: made.handler, hint: () => null } : null;
    },
  });
  try { return (await runtime.evaluate(mapClaudeToolUse({ cwd: "/repo", ...bash(command) }))).decision; } finally { runtime.close(); }
}

for (const [label, sign] of [["signed grants", (b, o) => signed(b, o)], ["an older workspace (no grants fields, dual mode)", (b) => b]]) {
  test(`${label}: an allowance revoked at the same revision is installed, and the action is denied afterwards`, async () => {
    const h = connected();
    try {
      const allowance = makeAllowance({ rule: "destructive-shell", actionKey: keyOf("rm -rf build"), reason: "release clean-up step", osUserDigest: null, lasts: "always" });
      writeAllowances(h.dir, [allowance]);
      assert.deepEqual((await sync(h, sign(doc(1)))).outcome, { state: "applied", revision: 1 });
      assert.equal(await decide(h, "rm -rf build"), "allow", "the person's allowance stands");
      // The reviewer revokes it: the same revision and rules digest, the revoked id, a new ETag.
      const revoked = await sync(h, sign(doc(1, { revoked_allowances: [allowance.id] }), { issuedAt: T(16) }));
      assert.deepEqual(revoked.outcome, { state: "applied", revision: 1 });
      assert.deepEqual(installed(h).revoked_allowances, [allowance.id]);
      assert.equal(await decide(h, "rm -rf build"), "deny", "the revocation applies on the computer");
      // The same answer again is unchanged.
      assert.deepEqual((await sync(h, sign(doc(1, { revoked_allowances: [allowance.id] }), { issuedAt: T(16) }))).outcome, { state: "unchanged", revision: 1 });
    } finally { rmSync(h.dir, { recursive: true, force: true }); }
  });
}

test("an ETag saved before grants were compared is not sent, so a revocation already missed is fetched again", async () => {
  const h = connected();
  try {
    assert.equal((await sync(h, signed(doc(1)))).outcome.state, "applied");
    const meta = readMeta(h.dir);
    assert.ok(meta.etag);
    writeFileSync(join(h.dir, "managed-meta.json"), JSON.stringify({ ...meta, grants_digest: undefined }));
    const { calls } = await sync(h, signed(doc(1)));
    assert.equal(calls[0].headers["if-none-match"], undefined);
    const saved = readMeta(h.dir);
    assert.equal(saved.grants_digest, grantsDigest(doc(1)), "the ETag is saved with the grants it was compared against");
    const { calls: next } = await sync(h, signed(doc(1)));
    assert.equal(next[0].headers["if-none-match"], saved.etag);
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

const delivered = () => ({ ...makeAllowance({ rule: "destructive-shell", actionKey: keyOf("rm -rf build"), reason: "never approved by anyone", osUserDigest: null, lasts: "always" }), created_by: "workspace" });
const tamperings = [
  ["an allowance added after signing", (good) => ({ ...good, allowances: [delivered()] }), "bad_signature"],
  ["a revocation removed after signing", (good) => { const out = { ...good }; delete out.revoked_allowances; return out; }, "bad_signature"],
  ["the digest recomputed over a changed list", (good) => { const out = { ...good, allowances: [delivered()] }; return { ...out, grants_digest: grantsDigest(out) }; }, "bad_signature"],
  ["the grants signature removed (digest kept)", (good) => { const out = { ...good }; delete out.grants_signature; return out; }, "malformed_signature"],
  ["a rules signature offered as the grants signature", (good) => ({ ...good, grants_signature: good.signature }), "bad_signature"],
  ["a rules-kind signature over the grants digest", (good) => ({ ...good, grants_signature: sig({ ...base(good, good.issued_at), rules_digest: good.grants_digest }) }), "bad_signature"],
];
for (const mode of ["dual", "enforce"]) {
  for (const [name, tamper, reason] of tamperings) {
    test(`${mode}: ${name} is refused with a valid rules signature, and the rules in force stay`, async () => {
      if (mode === "enforce") process.env.SCOPEBOND_POLICY_SIGNATURE_MODE = "enforce";
      const h = connected();
      try {
        const first = doc(1, { revoked_allowances: ["alw_AAAAAAAAAAAAAAAAAAAAAA"] });
        assert.equal((await sync(h, signed(first))).outcome.state, "applied");
        const inForce = readFileSync(join(h.dir, MANAGED_DOC_FILE), "utf8");
        for (const revision of [1, 2]) {
          const good = signed(doc(revision, { revoked_allowances: ["alw_AAAAAAAAAAAAAAAAAAAAAA"] }), { issuedAt: T(16) });
          const { outcome, calls } = await sync(h, tamper(good));
          assert.equal(outcome.state, "refused", `revision ${revision}: ${JSON.stringify(outcome)}`);
          assert.equal(outcome.signature, reason, outcome.message);
          assert.equal(readFileSync(join(h.dir, MANAGED_DOC_FILE), "utf8"), inForce, "a refused answer never changes the document in force");
          assert.ok(!calls.some((c) => c.url.endsWith("/v1/policy/ack") && c.body.result === "loaded"));
        }
        assert.equal(await decide(h, "rm -rf build"), "deny");
      } finally { rmSync(h.dir, { recursive: true, force: true }); }
    });
  }
}

test("a grants signature never verifies as a rules signature", async () => {
  const h = connected();
  try {
    const good = signed(doc(1));
    const { outcome } = await sync(h, { ...good, signature: good.grants_signature });
    assert.equal(outcome.signature, "bad_signature");
    assert.equal(isManaged(h.dir), false);
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("enforce: a signed document carrying allowances without a grants signature is refused; with none it applies", async () => {
  process.env.SCOPEBOND_POLICY_SIGNATURE_MODE = "enforce";
  const h = connected();
  try {
    const plain = await sync(h, signed(doc(1), { grants: false }));
    assert.deepEqual(plain.outcome, { state: "applied", revision: 1 }, "no grant fields: nothing to sign");
    const carrying = await sync(h, signed(doc(2, { allowances: [delivered()] }), { grants: false, issuedAt: T(16) }));
    assert.equal(carrying.outcome.state, "refused");
    assert.equal(carrying.outcome.signature, "unsigned_policy");
    assert.equal(installed(h).revision, 1);
    // Dual mode accepts it, as it accepts an unsigned document.
    delete process.env.SCOPEBOND_POLICY_SIGNATURE_MODE;
    assert.deepEqual((await sync(h, signed(doc(2, { allowances: [delivered()] }), { grants: false, issuedAt: T(16) }))).outcome, { state: "applied", revision: 2 });
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("checkGrantsSignature: verified for the workspace's grants; the digest covers all four lists", () => {
  const context = { workspace: WORKSPACE, computer: INSTALLATION, lastIssuedAt: null, now: NOW };
  const good = signed(doc(1, { allowances: [delivered()], session_budgets: [], request_answers: [] }));
  assert.equal(checkGrantsSignature(good, context).result, "verified");
  assert.equal(checkGrantsSignature(signed(doc(1), { grants: false }), context).result, "unsigned");
  for (const field of ["allowances", "revoked_allowances", "session_budgets", "request_answers"]) {
    assert.equal(checkGrantsSignature({ ...good, [field]: [{ changed: field }] }, context).reason, "bad_signature", field);
  }
});
