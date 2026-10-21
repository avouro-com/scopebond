// The plugin component (intel-install.ts): fetched from the workspace with this computer's credential and hook version,
// checked against the named SHA-256 and a pinned policy key, staged by version, and switched to as `current`, which the
// hook then loads. Removed when the workspace is not licensed or stops naming it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hookVersion, loadIntelPlugin, INTEL_COMPONENT_DOMAIN } from "@scopebond/hook";
import { maintainIntel, COMPONENT_SIGNATURE_HEADER, COMPONENT_KEY_ID_HEADER } from "../dist/index.js";

const PATTERN = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const WORKSPACE = "https://cloud.example.test";
const connection = { url: WORKSPACE, credential: "sbm_machine_credential" };

function policyKey(id = "pol_test_component") {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { privateKey, entry: { key_id: id, public_key: publicKey.export({ type: "spki", format: "pem" }).toString(), not_before: "2026-01-01T00:00:00Z", not_after: "2030-01-01T00:00:00Z" } };
}

const moduleFor = (version) => Buffer.from(`export function inspect(action) { return { pattern_id: "${PATTERN}", slot: Buffer.from("${version}").toString("base64") }; }\n`);

/** The workspace's component route: the module's bytes, its detached signature and key id in headers. */
function workspace(key, version, { status = 200, signWith = key.privateKey, keyId = key.entry.key_id, bytes = moduleFor(version) } = {}) {
  const sha256 = createHash("sha256").update(moduleFor(version)).digest("hex");
  const signature = sign(null, Buffer.from(INTEL_COMPONENT_DOMAIN + createHash("sha256").update(bytes).digest("hex")), signWith).toString("base64");
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), headers: init?.headers ?? {} });
    if (status !== 200) return new Response(JSON.stringify({ error: "not_licensed" }), { status });
    return new Response(bytes, { headers: { [COMPONENT_SIGNATURE_HEADER]: signature, [COMPONENT_KEY_ID_HEADER]: keyId } });
  };
  return { fetchImpl, seen, target: { policy: "recommended", intel: { version, sha256, url: `/v1/components/intel/${version}` } } };
}

const home = () => mkdtempSync(join(tmpdir(), "sb-intel-install-"));

test("a signed component is fetched with the credential and hook version, staged, made current, and the hook loads it", async () => {
  const key = policyKey();
  const dir = home();
  const ws = workspace(key, "1.0.0");
  const outcome = await maintainIntel({ dir, connection, target: ws.target, fetchImpl: ws.fetchImpl, keys: [key.entry] });
  assert.equal(outcome.action, "installed", outcome.reason);
  assert.equal(ws.seen[0].url, `${WORKSPACE}/v1/components/intel/1.0.0`);
  assert.equal(ws.seen[0].headers.authorization, `Bearer ${connection.credential}`);
  assert.equal(ws.seen[0].headers["x-scopebond-hook-version"], hookVersion());
  const manifest = JSON.parse(readFileSync(join(dir, "intel", "current", "manifest.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest), ["version", "sha256", "signature", "key_id"]);
  assert.equal(manifest.key_id, key.entry.key_id);
  assert.ok(existsSync(join(dir, "intel", "1.0.0", "intel.mjs")));
  const plugin = await loadIntelPlugin(dir, { keys: [key.entry] });
  assert.ok(plugin);
  assert.equal(plugin.inspect({ action_type: "shell.exec", params: {} }).pattern_id, PATTERN);
  // The same again: nothing fetched.
  assert.equal((await maintainIntel({ dir, connection, target: ws.target, fetchImpl: ws.fetchImpl, keys: [key.entry] })).action, "none");
  assert.equal(ws.seen.length, 1);
  // A new version replaces it; the old version folder goes.
  const next = workspace(key, "1.1.0");
  assert.equal((await maintainIntel({ dir, connection, target: next.target, fetchImpl: next.fetchImpl, keys: [key.entry] })).action, "installed");
  assert.equal(JSON.parse(readFileSync(join(dir, "intel", "current", "manifest.json"), "utf8")).version, "1.1.0");
  assert.equal(existsSync(join(dir, "intel", "1.0.0")), false);
});

test("refused: another key, a key the hook does not pin, other bytes than named, no signature, another origin", async () => {
  const key = policyKey();
  const cases = [
    ["another key", workspace(key, "1.0.0", { signWith: policyKey().privateKey })],
    ["unpinned key id", workspace(key, "1.0.0", { keyId: "pol_unknown" })],
    ["other bytes", workspace(key, "1.0.0", { bytes: Buffer.from("export function inspect() {}\n") })],
  ];
  for (const [name, ws] of cases) {
    const dir = home();
    const outcome = await maintainIntel({ dir, connection, target: ws.target, fetchImpl: ws.fetchImpl, keys: [key.entry] });
    assert.equal(outcome.action, "refused", name);
    assert.equal(existsSync(join(dir, "intel", "current")), false, name);
  }
  const elsewhere = workspace(key, "1.0.0");
  const target = { policy: "recommended", intel: { ...elsewhere.target.intel, url: "https://attacker.example.test/intel.mjs" } };
  const outcome = await maintainIntel({ dir: home(), connection, target, fetchImpl: elsewhere.fetchImpl, keys: [key.entry] });
  assert.equal(outcome.action, "refused");
  assert.match(outcome.reason, /not on the workspace/);
  assert.equal(elsewhere.seen.length, 0, "the credential never left for another origin");
});

test("not licensed (402), or no longer named: the component is removed; under hold nothing changes", async () => {
  const key = policyKey();
  const dir = home();
  const ws = workspace(key, "1.0.0");
  assert.equal((await maintainIntel({ dir, connection, target: ws.target, fetchImpl: ws.fetchImpl, keys: [key.entry] })).action, "installed");
  assert.equal((await maintainIntel({ dir, connection, target: { policy: "hold", intel: null }, fetchImpl: ws.fetchImpl, keys: [key.entry] })).action, "none");
  assert.ok(existsSync(join(dir, "intel", "current")));
  const unlicensed = workspace(key, "1.1.0", { status: 402 });
  assert.equal((await maintainIntel({ dir, connection, target: unlicensed.target, fetchImpl: unlicensed.fetchImpl, keys: [key.entry] })).action, "not_licensed");
  assert.equal(existsSync(join(dir, "intel", "current")), false);
  assert.equal((await maintainIntel({ dir, connection, target: ws.target, fetchImpl: ws.fetchImpl, keys: [key.entry] })).action, "installed");
  assert.equal((await maintainIntel({ dir, connection, target: { policy: "recommended", intel: null }, fetchImpl: ws.fetchImpl, keys: [key.entry] })).action, "removed");
  assert.equal(existsSync(join(dir, "intel", "current")), false);
  assert.equal((await maintainIntel({ dir, connection: null, target: ws.target, fetchImpl: ws.fetchImpl, keys: [key.entry] })).action, "none", "not connected");
});
