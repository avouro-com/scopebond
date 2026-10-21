// Rules as data, end to end: a new blockable rule with its own title, on a new action type a signed taxonomy extension adds,
// read by an existing operator, published as a level-2 pack, blocks on this hook with no code change. The pack and the
// extension are built and signed here with a key made at run time, named in a workspace's signed pack list, fetched through
// the real rules check (syncPolicy → syncPacks), put in force (activatePacks) and used to decide a command. A level-1 engine
// (simulated with SCOPEBOND_PACK_ENGINE_LEVEL=1) skips the level-2 pack, reports why, and keeps the others. A killed version
// is dropped at once and the version before it is used; a pack in shadow records what it would block.

import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packSigningInput, validatePack, PACK_ENGINE_LEVEL } from "@scopebond/policy-schema/pack";
import { taxonomyExtSigningInput, TAXONOMY_EXT_FORMAT } from "@scopebond/policy-schema/taxonomy-ext";
import { getActionType } from "@scopebond/policy-schema/registry";
import { ENFORCE } from "./enforce-all.mjs";
import {
  scaffold, policyBuilds, syncPolicy, readMeta, signedPolicyBytes, digestPacks, readPackIndex, loadPacks, activatePacks, setActivePacks, packsDir,
  createHookRuntime, mapClaudeToolUse, runPackVectors, HOOK_CAPABILITIES, hookCapabilities, packEngineLevel, readPackFlags, setTaxonomyExtension,
  targetOptInTypes, PACK_ENGINE_ENV, TAXONOMY_EXT_FILE, blockTitle,
} from "../dist/index.js";

const require = createRequire(import.meta.url);
const INSTALLATION = "gw-engine-1";
const WORKSPACE = "org-engine-1";
const T = (day) => `2026-10-${String(day).padStart(2, "0")}T00:00:00Z`;
const NOW = new Date(T(20));
const trusted = generateKeyPairSync("ed25519");
const KEYS = [{ key_id: "ws-1", public_key: trusted.publicKey.export({ type: "spki", format: "pem" }), not_before: T(1), not_after: "2027-10-01T00:00:00Z" }];
const previousKeys = process.env.SCOPEBOND_POLICY_KEYS_JSON;
process.env.SCOPEBOND_POLICY_KEYS_JSON = JSON.stringify(KEYS);
after(() => {
  if (previousKeys === undefined) delete process.env.SCOPEBOND_POLICY_KEYS_JSON; else process.env.SCOPEBOND_POLICY_KEYS_JSON = previousKeys;
  delete process.env[PACK_ENGINE_ENV];
});
afterEach(() => { setActivePacks([]); setTaxonomyExtension(null); delete process.env[PACK_ENGINE_ENV]; });

const PLACEHOLDER = { alg: "Ed25519", key_id: "ws-1", value: "A".repeat(86) + "==" };
const signWith = (input) => cryptoSign(null, Buffer.from(input, "utf8"), trusted.privateKey).toString("base64");
const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const refOf = (text, id, extra = {}) => { const p = JSON.parse(text); return { id: id ?? p.id, version: p.version ?? "1.0.0", sha256: sha(text), ...extra }; };

/** The signed taxonomy extension: one new action type, which opts a policy into deciding it. */
function extensionText() {
  const unsigned = { format: TAXONOMY_EXT_FORMAT, issued_at: T(10), types: [
    { action_type: "demo.vault.purge", params: { scope: "string", vault: "string" }, mutating: true, target_opt_in: true },
  ], signature: PLACEHOLDER };
  return JSON.stringify({ ...unsigned, signature: { ...PLACEHOLDER, value: signWith(taxonomyExtSigningInput(unsigned)) } });
}

/** A level-2 pack: a grammar for a made-up tool that emits the new type with an existing operator (`if` / `has` / `const`), and
 *  a new rule with its own title that may block and blocks by default. */
function purgePack({ version = "1.0.0", requires = { engine: 2, action_types: ["demo.vault.purge"] } } = {}) {
  const unsigned = {
    format: "scopebond:pack/v1", id: "demo-purge", version, issued_at: T(10), requires, signature: PLACEHOLDER,
    grammars: [{ id: "demovault", programs: ["demovault"], options: { flags: ["--all"] }, commands: [
      { path: ["purge"], emit: [{ action_type: "demo.vault.purge", params: { scope: { if: { has: ["--all"] }, then: { const: "all" }, else: { const: "one" } }, vault: { const: "demo" } } }] },
    ] }],
    profiles: [],
    rules: [{ id: "vault-purge-all", type: "action_allowlist", mode: "monitor", action_types: ["demo.vault.purge"], param_bounds: { scope: { pattern: "^(?!all$).+" } },
      description: "Deny purging every secret in a demo vault.", title: "Purge a whole demo vault", blockable: true, default_mode: "block",
      safer_way: "Purge one named secret instead." }],
    vectors: [
      { id: "all", shell: { command: "demovault purge --all" }, expect: [{ action_type: "demo.vault.purge", params: { scope: "all", vault: "demo", via: "demovault", derived_from: "shell.exec" } }] },
      { id: "one", shell: { command: "demovault purge" }, expect: [{ action_type: "demo.vault.purge", params: { scope: "one", vault: "demo", via: "demovault", derived_from: "shell.exec" } }] },
    ],
  };
  return JSON.stringify({ ...unsigned, signature: { ...PLACEHOLDER, value: signWith(packSigningInput(unsigned)) } });
}

/** The public example pack (level 1), signed by the workspace key. */
const example = JSON.parse(readFileSync(require.resolve("@scopebond/policy-schema/vectors/example-pack.json"), "utf8"));
function examplePack() {
  const unsigned = { ...example, signature: PLACEHOLDER };
  return JSON.stringify({ ...unsigned, signature: { ...PLACEHOLDER, value: signWith(packSigningInput(unsigned)) } });
}

const unmanaged = () => ({ type: "scopebond:managed-rules", version: 1, managed: false, installation_id: INSTALLATION, workspace_id: WORKSPACE, revision: 0, rules_digest: "0".repeat(64), local_changes: false });
/** The workspace's signed "no rules for this computer" answer, naming packs (and what it kills). */
function signed(body, { packs, killed, issuedAt = T(15) }) {
  const base = { v: 1, workspace: WORKSPACE, computer: INSTALLATION, revision: body.revision, local_changes: false, managed: false, issued_at: issuedAt };
  const out = { ...body, issued_at: issuedAt, key_id: "ws-1", signature: cryptoSign(null, signedPolicyBytes({ ...base, rules_digest: body.rules_digest }), trusted.privateKey).toString("base64") };
  const list = { packs, ...(killed ? { killed } : {}) };
  const packsDigest = digestPacks(list);
  return { ...out, ...list, packs_digest: packsDigest, packs_signature: cryptoSign(null, signedPolicyBytes({ ...base, rules_digest: packsDigest, kind: "packs" }), trusted.privateKey).toString("base64") };
}

function connected() {
  const dir = mkdtempSync(join(tmpdir(), "scopebond-engine-"));
  const { agentKid } = scaffold(dir, ENFORCE);
  writeFileSync(join(dir, "cloud.json"), JSON.stringify({ url: "https://cloud.example.test", credential: "sbm_x", credential_id: "c", organization_id: WORKSPACE, environment_id: "env-1", gateway_id: INSTALLATION, attester_kid: "k", scopes: [], expires_at: "2099-01-01T00:00:00Z" }));
  return { dir, agentKid };
}
function workspace(answers, served) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, headers: init.headers ?? {} });
    if (u.endsWith("/v1/policy/ack")) return new Response("{}", { status: 200 });
    const m = /\/v1\/packs\/([^/]+)$/.exec(u);
    if (m) { const text = served[decodeURIComponent(m[1])]; return text === undefined ? new Response("{}", { status: 404 }) : new Response(text, { status: 200 }); }
    return new Response(JSON.stringify(answers.shift()), { status: 200 });
  };
  return { calls, fetchImpl };
}
const sync = (h, w) => syncPolicy(h.dir, { agentKid: h.agentKid, hookVersion: "0.40.0", policyBuilds, fetchImpl: w.fetchImpl, now: () => NOW });
const packFetches = (w) => w.calls.filter((c) => c.url.includes("/v1/packs/")).map((c) => c.url.slice(c.url.indexOf("/v1/packs/") + 10));
const runtimeAt = (h) => createHookRuntime({ policyPath: join(h.dir, "policy.json"), keyPath: join(h.dir, "agent.key"), attesterPath: join(h.dir, "attester.key"), dbPath: join(h.dir, "receipts.db"), cwd: "/repo" });
const bash = (command) => mapClaudeToolUse({ tool_name: "Bash", tool_input: { command }, cwd: "/repo" });

/** Everything a workspace publishes: the level-1 example pack, the level-2 pack and the extension. */
function published() {
  const ext = extensionText();
  const purge = purgePack();
  const ex = examplePack();
  return {
    texts: { ext, purge, ex },
    served: { "example@1.0.0": ex, "demo-purge@1.0.0": purge, "taxonomy-ext@1.0.0": ext },
    refs: [refOf(ex), refOf(purge, undefined, { requires_engine: 2 }), refOf(ext, "taxonomy-ext")],
  };
}

test("the built pack and extension are valid, level 2, and their vectors pass on this engine with the extension in force", () => {
  const { texts } = published();
  assert.equal(PACK_ENGINE_LEVEL, 2);
  assert.deepEqual(validatePack(JSON.parse(texts.purge)).errors, []);
  assert.equal(validatePack(JSON.parse(texts.purge), { engine: 1 }).valid, false, "a level-1 engine reads it as invalid");
  assert.equal(getActionType("demo.vault.purge"), undefined, "the type is not built in");
  assert.deepEqual(runPackVectors(JSON.parse(texts.purge)).failures, []);
});

test("a new rule on a new action type, published as a level-2 pack, blocks on this hook with no code change", async () => {
  const h = connected();
  const { served, refs } = published();
  const w = workspace([signed(unmanaged(), { packs: refs })], served);
  const outcome = await sync(h, w);
  assert.equal(outcome.state, "own_rules");
  // The rules check says the engine level, and each fetch does too.
  const check = w.calls.find((c) => c.url.endsWith("/v1/policy"));
  assert.equal(check.headers["x-scopebond-pack-engine"], "2");
  assert.ok(check.headers["x-scopebond-hook-capabilities"].split(",").includes("pack_engine_2"));
  assert.ok(w.calls.filter((c) => c.url.includes("/v1/packs/")).every((c) => c.headers["x-scopebond-pack-engine"] === "2"));
  // The extension is fetched first, then the packs.
  assert.equal(packFetches(w)[0], "taxonomy-ext@1.0.0");
  assert.deepEqual(packFetches(w).slice(1).sort(), ["demo-purge@1.0.0", "example@1.0.0"]);
  assert.ok(existsSync(join(h.dir, TAXONOMY_EXT_FILE)));
  assert.equal(readMeta(h.dir).packs.complete, true, JSON.stringify(readMeta(h.dir).packs));
  assert.deepEqual(readPackIndex(h.dir).packs.map((p) => `${p.id}@${p.version}`), ["demo-purge@1.0.0", "example@1.0.0"]);

  // A fresh process: the extension and the packs are read from disk and put in force.
  setTaxonomyExtension(null);
  const loaded = activatePacks(h.dir, { now: NOW });
  assert.deepEqual(loaded.problems, []);
  assert.equal(getActionType("demo.vault.purge").risk_class, "sensitive");
  assert.ok(targetOptInTypes().includes("demo.vault.purge"));
  const runtime = runtimeAt(h);
  try {
    const denied = await runtime.evaluate(bash("demovault purge --all"));
    assert.equal(denied.decision, "deny", denied.reason);
    assert.equal(denied.clauseId, "vault-purge-all");
    assert.match(denied.reason, /\("Purge a whole demo vault"\)/);
    assert.match(denied.reason, /What to do: .* A safer way: Purge one named secret instead\./);
    assert.equal(blockTitle(null, "vault-purge-all"), "Purge a whole demo vault");
    const allowed = await runtime.evaluate(bash("demovault purge"));
    assert.equal(allowed.decision, "allow", allowed.reason);
    // The level-1 pack keeps working beside it.
    const exampleCall = bash("examplectl bucket delete ex://old --yes");
    assert.deepEqual(exampleCall.map((m) => m.intent.action_type), ["shell.exec", "cloud.resource.delete"]);
  } finally { runtime.close(); }
});

test("a level-1 engine skips the level-2 pack, says why, and keeps the others", async () => {
  process.env[PACK_ENGINE_ENV] = "1";
  assert.equal(packEngineLevel(), 1);
  assert.ok(!hookCapabilities().includes("pack_engine_2"));
  assert.ok(HOOK_CAPABILITIES.includes("pack_engine_2"));
  const h = connected();
  const { served, refs, texts } = published();
  // Without the list's requires_engine too: the engine reads the pack's own requires.
  const plainRefs = refs.map(({ requires_engine, ...r }) => { void requires_engine; return r; });
  for (const list of [refs, plainRefs]) {
    const w = workspace([signed(unmanaged(), { packs: list, issuedAt: list === refs ? T(15) : T(16) })], served);
    await sync(h, w);
    const check = w.calls.find((c) => c.url.endsWith("/v1/policy"));
    assert.equal(check.headers["x-scopebond-pack-engine"], "1");
    assert.ok(!check.headers["x-scopebond-hook-capabilities"].split(",").includes("pack_engine_2"));
    // A list entry that says it needs level 2 is not even fetched; nor is the extension.
    if (list === refs) assert.deepEqual(packFetches(w), ["example@1.0.0"]);
    else assert.deepEqual(packFetches(w), ["demo-purge@1.0.0"], "the example pack is held byte for byte");
    const packs = readMeta(h.dir).packs;
    assert.equal(packs.complete, false);
    assert.deepEqual(packs.failed.map((f) => [f.id, f.version, f.code, f.needs ?? null, f.held]), [["demo-purge", "1.0.0", "engine_too_old", list === refs ? 2 : null, null]]);
    assert.deepEqual(readPackIndex(h.dir).packs.map((p) => p.id), ["example"], "the other packs are kept");
  }
  assert.ok(!existsSync(join(h.dir, TAXONOMY_EXT_FILE)), "a level-1 engine does not read the extension");
  // A level-2 pack held on disk is refused by a level-1 reading too, and the others load.
  writeFileSync(join(packsDir(h.dir), "demo-purge@1.0.0.json"), texts.purge);
  const index = readPackIndex(h.dir);
  writeFileSync(join(packsDir(h.dir), "index.json"), JSON.stringify({ ...index, packs: [...index.packs, refOf(texts.purge)] }));
  const loaded = loadPacks(h.dir, { now: NOW });
  assert.deepEqual(loaded.packs.map((p) => p.id), ["example"]);
  assert.deepEqual(loaded.problems.map((p) => [p.ref, p.reason]), [["demo-purge@1.0.0", "engine_too_old"]]);
});

test("a pack that requires an action type no extension in force names is skipped as unknown_action_type", async () => {
  const h = connected();
  const { served, refs } = published();
  const w = workspace([signed(unmanaged(), { packs: refs.filter((r) => r.id !== "taxonomy-ext") })], served);
  await sync(h, w);
  const failed = readMeta(h.dir).packs.failed;
  assert.deepEqual(failed.map((f) => [f.id, f.code]), [["demo-purge", "unknown_action_type"]]);
  assert.deepEqual(readPackIndex(h.dir).packs.map((p) => p.id), ["example"]);
});

test("a killed version is dropped at once, even one held here, and the version before it is used", async () => {
  const h = connected();
  const { served, refs } = published();
  const v2 = purgePack({ version: "1.0.1" });
  const v3 = purgePack({ version: "1.0.2" });
  const at = (version, text) => ({ ...refs[1], version, sha256: sha(text) });
  const w = workspace([
    signed(unmanaged(), { packs: refs, issuedAt: T(15) }),
    signed(unmanaged(), { packs: [refs[0], at("1.0.1", v2), refs[2]], issuedAt: T(16) }),
    // 1.0.1 is killed, and 1.0.2 cannot be fetched: the version before 1.0.1 is used.
    signed(unmanaged(), { packs: [refs[0], at("1.0.2", v3), refs[2]], killed: ["demo-purge@1.0.1"], issuedAt: T(17) }),
  ], { ...served, "demo-purge@1.0.1": v2 });
  await sync(h, w);
  await sync(h, w);
  assert.deepEqual(readPackIndex(h.dir).packs.map((p) => `${p.id}@${p.version}`), ["demo-purge@1.0.1", "example@1.0.0"]);
  assert.deepEqual(readPackFlags(h.dir).fallback.map((f) => `${f.id}@${f.version}`), ["demo-purge@1.0.0"]);
  await sync(h, w);
  assert.deepEqual(readPackIndex(h.dir).packs.map((p) => `${p.id}@${p.version}`), ["demo-purge@1.0.0", "example@1.0.0"]);
  assert.ok(!existsSync(join(packsDir(h.dir), "demo-purge@1.0.1.json")), "the killed version's file is removed");
  assert.deepEqual(readPackFlags(h.dir).killed, ["demo-purge@1.0.1"]);
  const failed = readMeta(h.dir).packs.failed;
  assert.deepEqual(failed.map((f) => [`${f.id}@${f.version}`, f.code, f.held]), [["demo-purge@1.0.2", "not_served", "demo-purge@1.0.0"]]);
  const loaded = loadPacks(h.dir, { now: NOW });
  assert.deepEqual(loaded.packs.map((p) => `${p.id}@${p.version}`), ["demo-purge@1.0.0", "example@1.0.0"]);
  // A killed version the index still lists (an older engine wrote it) is never used.
  const index = readPackIndex(h.dir);
  writeFileSync(join(packsDir(h.dir), "demo-purge@1.0.1.json"), v2);
  writeFileSync(join(packsDir(h.dir), "index.json"), JSON.stringify({ ...index, packs: [index.packs[1], { ...at("1.0.1", v2) , requires_engine: undefined }].map(({ requires_engine, ...p }) => { void requires_engine; return p; }) }));
  assert.deepEqual(loadPacks(h.dir, { now: NOW }).problems.map((p) => [p.ref, p.reason]), [["demo-purge@1.0.1", "killed"]]);
});

test("the killed list is covered by the list's signature", async () => {
  const h = connected();
  const { served, refs } = published();
  const answer = signed(unmanaged(), { packs: refs, killed: ["example@0.9.0"] });
  const w = workspace([{ ...answer, killed: [] }], served);
  await sync(h, w);
  assert.match(readMeta(h.dir).packs.error, /digest/);
  assert.equal(readPackIndex(h.dir), null);
});

test("a pack in shadow records what its rules would block, and never blocks", async () => {
  const h = connected();
  const { served, refs } = published();
  const w = workspace([signed(unmanaged(), { packs: refs.map((r) => (r.id === "demo-purge" ? { ...r, shadow: true } : r)) })], served);
  await sync(h, w);
  assert.deepEqual(readPackFlags(h.dir).shadow, ["demo-purge"]);
  const loaded = activatePacks(h.dir, { now: NOW });
  assert.deepEqual(loaded.shadow, ["demo-purge"]);
  const runtime = runtimeAt(h);
  try {
    const decision = await runtime.evaluate(bash("demovault purge --all"));
    assert.equal(decision.decision, "allow", decision.reason);
    assert.equal(decision.receipts.length, 2, "the derived action is recorded");
  } finally { runtime.close(); }
});
