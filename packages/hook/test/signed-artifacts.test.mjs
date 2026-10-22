// Signed artifacts (signed-artifacts.ts): a workspace answer's signed pack list may name `artifacts`; the rules check fetches each
// from /v1/packs/<id>@<version>, checks its digest, envelope and Ed25519 signature over "scopebond:artifact/v1\n" + the canonical
// document, keeps exactly the listed ones and hands their bytes, unread, to the plugin slot by kind. A bad signature or a list
// that does not verify changes nothing; nothing is fetched when the answer names no artifacts. Keys are made here at run time.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical } from "@scopebond/gateway";
import { ENFORCE } from "./enforce-all.mjs";
import {
  scaffold, syncPolicy, policyBuilds, signedPolicyBytes, digestPacks, syncArtifacts, artifactRefsOf, checkArtifactText, heldArtifacts,
  readArtifactIndex, handArtifacts, artifactKindsOf, loadIntelPlugin, HOOK_CAPABILITIES, SIGNED_ARTIFACTS_CAPABILITY, ARTIFACT_SIGNATURE_DOMAIN,
  INTEL_COMPONENT_DOMAIN,
} from "../dist/index.js";

const INSTALLATION = "gw-artifact-1";
const WORKSPACE = "org-artifact-1";
const T = (day) => `2026-10-${String(day).padStart(2, "0")}T00:00:00Z`;
const NOW = new Date(T(20));
const trusted = generateKeyPairSync("ed25519");
const stranger = generateKeyPairSync("ed25519");
const pem = (pair) => pair.publicKey.export({ type: "spki", format: "pem" });
const KEYS = [{ key_id: "ws-1", public_key: pem(trusted), not_before: T(1), not_after: "2027-10-01T00:00:00Z" }];
const previousKeys = process.env.SCOPEBOND_POLICY_KEYS_JSON;
process.env.SCOPEBOND_POLICY_KEYS_JSON = JSON.stringify(KEYS);
after(() => { if (previousKeys === undefined) delete process.env.SCOPEBOND_POLICY_KEYS_JSON; else process.env.SCOPEBOND_POLICY_KEYS_JSON = previousKeys; });

const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
/** An artifact as a workspace serves it: an envelope the hook checks, and a body it never reads. */
function artifactText({ kind = "example-list", version = "1.0.0", key = trusted.privateKey, body = { entries: [["a", "b"]] } } = {}) {
  const unsigned = { format: "scopebond:artifact/v1", kind, version, issued_at: T(10), ...body };
  const value = cryptoSign(null, Buffer.from(ARTIFACT_SIGNATURE_DOMAIN + canonical(unsigned), "utf8"), key).toString("base64");
  return JSON.stringify({ ...unsigned, signature: { alg: "Ed25519", key_id: "ws-1", value } });
}
const refOf = (text, extra = {}) => { const d = JSON.parse(text); return { id: d.kind, version: d.version, sha256: sha(text), ...extra }; };

/** A signed "no rules for this computer" answer carrying a pack list (and, when given, artifacts), signed as a workspace does. */
function answer({ packs = [], artifacts, packKey = trusted.privateKey } = {}) {
  const base = { v: 1, workspace: WORKSPACE, computer: INSTALLATION, revision: 0, local_changes: false, managed: false, issued_at: T(15) };
  const body = { type: "scopebond:managed-rules", version: 1, managed: false, installation_id: INSTALLATION, workspace_id: WORKSPACE, revision: 0, rules_digest: "0".repeat(64), local_changes: false, issued_at: T(15), key_id: "ws-1" };
  body.signature = cryptoSign(null, signedPolicyBytes({ ...base, rules_digest: body.rules_digest }), trusted.privateKey).toString("base64");
  const list = { packs, ...(artifacts !== undefined ? { artifacts } : {}) };
  const packsDigest = digestPacks(list);
  return { ...body, ...list, packs_digest: packsDigest, packs_signature: cryptoSign(null, signedPolicyBytes({ ...base, rules_digest: packsDigest, kind: "packs" }), packKey).toString("base64") };
}

/** A workspace that serves `served` (ref → text, or a status number) at /v1/packs and records every call. */
function workspace(served = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, headers: init.headers ?? {} });
    const m = /\/v1\/packs\/([^/]+)$/.exec(u);
    const hit = m ? served[decodeURIComponent(m[1])] : undefined;
    if (typeof hit === "number") return new Response("{}", { status: hit });
    return hit === undefined ? new Response("{}", { status: 404 }) : new Response(hit, { status: 200 });
  };
  return { calls, fetchImpl };
}
const dirOf = () => mkdtempSync(join(tmpdir(), "scopebond-artifacts-"));
const options = (fetchImpl) => ({ base: "https://cloud.example.test", headers: { authorization: "Bearer sbm_x" }, fetchImpl, workspace: WORKSPACE, computer: INSTALLATION, lastIssuedAt: null, now: NOW, keys: KEYS });
const text = (bytes) => Buffer.from(bytes).toString("utf8");

test("the hook reports the capability", () => {
  assert.equal(SIGNED_ARTIFACTS_CAPABILITY, "signed_artifacts_1");
  assert.ok(HOOK_CAPABILITIES.includes(SIGNED_ARTIFACTS_CAPABILITY));
});

test("a good signature: fetched with the capability, kept byte for byte, handed over by kind", async () => {
  const dir = dirOf();
  const served = artifactText();
  const ws = workspace({ "example-list@1.0.0": served });
  const result = await syncArtifacts(dir, answer({ artifacts: [refOf(served)] }), options(ws.fetchImpl));
  assert.deepEqual(result, { state: "synced", artifacts: ["example-list@1.0.0"], fetched: ["example-list@1.0.0"], removed: [], failed: [] });
  assert.equal(ws.calls.length, 1);
  assert.match(ws.calls[0].url, /\/v1\/packs\/example-list@1\.0\.0$/);
  assert.equal(ws.calls[0].headers["x-scopebond-hook-capabilities"], SIGNED_ARTIFACTS_CAPABILITY);
  assert.equal(ws.calls[0].headers.authorization, "Bearer sbm_x");
  const held = heldArtifacts(dir, ["example-list"]);
  assert.equal(held.length, 1);
  assert.deepEqual({ ...held[0], bytes: text(held[0].bytes) }, { kind: "example-list", id: "example-list", version: "1.0.0", shadow: false, bytes: served });
  // Held byte for byte: the next answer naming the same artifact fetches nothing.
  const again = await syncArtifacts(dir, answer({ artifacts: [refOf(served)] }), options(ws.fetchImpl));
  assert.deepEqual(again.fetched, []);
  assert.equal(ws.calls.length, 1);
  // A shadow ref is handed over as such.
  await syncArtifacts(dir, answer({ artifacts: [refOf(served, { shadow: true })] }), options(ws.fetchImpl));
  assert.equal(heldArtifacts(dir, ["example-list"])[0].shadow, true);
});

test("a bad signature is refused: nothing is kept, and a copy already held stays", async () => {
  const dir = dirOf();
  const forged = artifactText({ key: stranger.privateKey });
  const ws = workspace({ "example-list@1.0.0": forged });
  const result = await syncArtifacts(dir, answer({ artifacts: [refOf(forged)] }), options(ws.fetchImpl));
  assert.equal(result.state, "synced");
  assert.deepEqual(result.artifacts, []);
  assert.deepEqual(result.failed.map((f) => [f.ref, f.code, f.held]), [["example-list@1.0.0", "bad_signature", null]]);
  assert.deepEqual(heldArtifacts(dir, ["example-list"]), []);
  assert.equal(checkArtifactText(forged, { keys: KEYS, now: NOW }).ok, false);

  // With a good copy held, a forged newer version leaves the good one in force.
  const good = artifactText();
  await syncArtifacts(dir, answer({ artifacts: [refOf(good)] }), options(workspace({ "example-list@1.0.0": good }).fetchImpl));
  const newer = artifactText({ version: "1.0.1", key: stranger.privateKey });
  const kept = await syncArtifacts(dir, answer({ artifacts: [refOf(newer)] }), options(workspace({ "example-list@1.0.1": newer }).fetchImpl));
  assert.deepEqual(kept.artifacts, ["example-list@1.0.0"]);
  assert.deepEqual(kept.failed.map((f) => [f.code, f.held]), [["bad_signature", "example-list@1.0.0"]]);
  assert.equal(text(heldArtifacts(dir, ["example-list"])[0].bytes), good);

  // Bytes other than the list names, a document of another id, and an envelope that is not an artifact: refused too.
  const other = artifactText({ kind: "other-list" });
  const swapped = await syncArtifacts(dirOf(), answer({ artifacts: [{ ...refOf(other), id: "example-list" }] }), options(workspace({ "example-list@1.0.0": other }).fetchImpl));
  assert.deepEqual(swapped.failed.map((f) => f.code), ["wrong_ref"]);
  const changed = await syncArtifacts(dirOf(), answer({ artifacts: [refOf(good)] }), options(workspace({ "example-list@1.0.0": `${good} ` }).fetchImpl));
  assert.deepEqual(changed.failed.map((f) => f.code), ["digest_mismatch"]);
  assert.equal(checkArtifactText(JSON.stringify({ format: "scopebond:pack/v1" }), { keys: KEYS, now: NOW }).ok, false);
});

test("a list that does not verify changes nothing and fetches nothing", async () => {
  const dir = dirOf();
  const served = artifactText();
  const ws = workspace({ "example-list@1.0.0": served });
  // Signed by a key the hook does not trust.
  const untrusted = await syncArtifacts(dir, answer({ artifacts: [refOf(served)], packKey: stranger.privateKey }), options(ws.fetchImpl));
  assert.equal(untrusted.state, "refused");
  // An artifact added to a signed list after it was signed.
  const signed = answer({ artifacts: [] });
  const added = await syncArtifacts(dir, { ...signed, artifacts: [refOf(served)] }, options(ws.fetchImpl));
  assert.equal(added.state, "refused");
  assert.equal(ws.calls.length, 0);
  assert.deepEqual(readArtifactIndex(dir), []);
  assert.equal(artifactRefsOf({ artifacts: [{ id: "x", version: "1.0.0", sha256: "z" }] }), null);
  assert.equal(artifactRefsOf({ artifacts: [{ id: "x", version: "1.0.0", sha256: "a".repeat(64), extra: 1 }] }), null);
});

test("nothing is fetched when the answer names no artifacts; a verified list without them leaves none", async () => {
  const dir = dirOf();
  const served = artifactText();
  const ws = workspace({ "example-list@1.0.0": served });
  await syncArtifacts(dir, answer({ artifacts: [refOf(served)] }), options(ws.fetchImpl));
  assert.equal(ws.calls.length, 1);
  // No pack list at all (an older workspace, an unsigned answer): nothing changes.
  const bare = answer({ artifacts: [refOf(served)] });
  for (const member of ["packs", "packs_digest", "packs_signature", "artifacts"]) delete bare[member];
  assert.deepEqual(await syncArtifacts(dir, bare, options(ws.fetchImpl)), { state: "not_named" });
  assert.equal(heldArtifacts(dir, ["example-list"]).length, 1);
  // A verified list that names none (the flag is off, or the computer is no longer licensed): nothing fetched, none kept.
  const none = await syncArtifacts(dir, answer(), options(ws.fetchImpl));
  assert.deepEqual(none, { state: "synced", artifacts: [], fetched: [], removed: ["example-list@1.0.0"], failed: [] });
  assert.equal(ws.calls.length, 1);
  assert.deepEqual(heldArtifacts(dir, ["example-list"]), []);
  // Refused as not licensed: the copy held goes.
  await syncArtifacts(dir, answer({ artifacts: [refOf(served)] }), options(ws.fetchImpl));
  const newer = artifactText({ version: "1.0.1" });
  const refused = await syncArtifacts(dir, answer({ artifacts: [refOf(newer)] }), options(workspace({ "example-list@1.0.1": 402 }).fetchImpl));
  assert.deepEqual(refused.artifacts, []);
  assert.deepEqual(refused.failed.map((f) => [f.code, f.held]), [["not_licensed", null]]);
});

test("the plugin is handed the bytes of the kinds it reads; an unknown kind is ignored", async () => {
  const dir = dirOf();
  const mine = artifactText({ kind: "example-list" });
  const other = artifactText({ kind: "other-list" });
  await syncArtifacts(dir, answer({ artifacts: [refOf(mine), refOf(other)] }), options(workspace({ "example-list@1.0.0": mine, "other-list@1.0.0": other }).fetchImpl));
  assert.deepEqual(readArtifactIndex(dir).map((e) => e.kind), ["example-list", "other-list"]);
  const handed = [];
  const plugin = { artifactKinds: ["example-list", "Not A Kind"], acceptArtifact: (a) => handed.push({ ...a, bytes: text(a.bytes) }) };
  assert.equal(handArtifacts(plugin, (kinds) => heldArtifacts(dir, kinds)), 1);
  assert.deepEqual(handed, [{ kind: "example-list", id: "example-list", version: "1.0.0", shadow: false, bytes: mine }]);
  // No kinds, no accept function, a throwing or rejecting plugin: nothing breaks.
  assert.equal(handArtifacts({ acceptArtifact: () => undefined }, (kinds) => heldArtifacts(dir, kinds)), 0);
  assert.equal(handArtifacts({ artifactKinds: ["example-list"] }, (kinds) => heldArtifacts(dir, kinds)), 0);
  assert.equal(handArtifacts({ artifactKinds: ["example-list"], acceptArtifact: () => { throw new Error("x"); } }, (kinds) => heldArtifacts(dir, kinds)), 0);
  assert.equal(handArtifacts({ artifactKinds: ["example-list"], acceptArtifact: () => Promise.reject(new Error("x")) }, (kinds) => heldArtifacts(dir, kinds)), 1);
  assert.deepEqual(artifactKindsOf(["a-b", 3, "A", "a-b"]), ["a-b"]);
  assert.deepEqual(artifactKindsOf("a"), []);
  // A file changed on disk after it was checked is never handed over.
  writeFileSync(join(dir, "artifacts", "example-list@1.0.0.json"), `${mine}\n`);
  assert.deepEqual(heldArtifacts(dir, ["example-list"]), []);
});

test("a signed plugin that reads a kind is handed its artifacts when it loads", async () => {
  const dir = dirOf();
  const served = artifactText();
  await syncArtifacts(dir, answer({ artifacts: [refOf(served)] }), options(workspace({ "example-list@1.0.0": served }).fetchImpl));
  const home = mkdtempSync(join(tmpdir(), "sb-artifact-home-"));
  const folder = join(home, "intel", "current");
  mkdirSync(folder, { recursive: true });
  const source = "export const artifactKinds = [\"example-list\"];\nexport function acceptArtifact(a) { globalThis.__sbHanded = { kind: a.kind, size: a.bytes.length }; }\nexport function inspect() { return {}; }\n";
  const bytes = Buffer.from(source, "utf8");
  const digest = createHash("sha256").update(bytes).digest("hex");
  writeFileSync(join(folder, "intel.mjs"), bytes);
  writeFileSync(join(folder, "manifest.json"), JSON.stringify({ version: "1.0.0", sha256: digest, signature: cryptoSign(null, Buffer.from(INTEL_COMPONENT_DOMAIN + digest, "utf8"), trusted.privateKey).toString("base64") }));
  const plugin = await loadIntelPlugin(home, { keys: KEYS, now: NOW, artifacts: (kinds) => heldArtifacts(dir, kinds) });
  assert.ok(plugin);
  assert.deepEqual(globalThis.__sbHanded, { kind: "example-list", size: Buffer.byteLength(served) });
  delete globalThis.__sbHanded;
});

test("the rules check takes the artifacts its signed answer names", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scopebond-artifacts-sync-"));
  const { agentKid } = scaffold(dir, ENFORCE);
  writeFileSync(join(dir, "cloud.json"), JSON.stringify({ url: "https://cloud.example.test", credential: "sbm_x", credential_id: "c", organization_id: WORKSPACE, environment_id: "env-1", gateway_id: INSTALLATION, attester_kid: "k", scopes: [], expires_at: "2099-01-01T00:00:00Z" }));
  const served = artifactText();
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, headers: init.headers ?? {} });
    if (u.endsWith("/v1/policy/ack")) return new Response("{}", { status: 200 });
    if (u.endsWith("/v1/packs/example-list@1.0.0")) return new Response(served, { status: 200 });
    return new Response(JSON.stringify(answer({ artifacts: [refOf(served)] })), { status: 200 });
  };
  const outcome = await syncPolicy(dir, { agentKid, hookVersion: "0.31.2", policyBuilds, fetchImpl, now: () => NOW });
  assert.equal(outcome.state, "own_rules");
  const check = calls.find((c) => c.url.endsWith("/v1/policy"));
  assert.ok(check.headers["x-scopebond-hook-capabilities"].split(",").includes(SIGNED_ARTIFACTS_CAPABILITY));
  assert.ok(calls.some((c) => c.url.endsWith("/v1/packs/example-list@1.0.0")));
  assert.equal(text(heldArtifacts(dir, ["example-list"])[0].bytes), served);
});
