// Engine updates without an installer (engine-update.ts): the signed install takes the engine bundle its workspace names
// only when the manifest is signed by an updater key, the archive is the one it names, the version is newer, and the new
// engine passes the pack vectors; then current.json names it. A bundle that fails its vectors or fails to start twice is
// rolled back and remembered as bad.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordEngineStartFailure, readCurrentEngine, writeCurrentEngine, engineVersionDir, ENGINE_MANIFEST_DOMAIN, ENGINE_FILE, installPack } from "@scopebond/hook";
import { maintainEngine, packTgz, badEngines, fetchClientVersion } from "../dist/index.js";

const BASELINE = "0.31.1";
const URL_BASE = "https://github.com/avouro-com/scopebond/releases/download/agent-native-v0.12.0";

function updaterKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const key = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  return { privateKey, entry: { kid: createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 16), key, not_after: null } };
}

/** A bundle that answers `packs test --all --json` as an engine would: passing, or failing one vector, or reporting packs. */
const bundleSource = (version, { fail = false, packs = [] } = {}) => [
  `"use strict";`,
  `const run = async (args) => {`,
  `  if (args[0] !== "packs") return;`,
  `  process.stdout.write(JSON.stringify({ engine: ${JSON.stringify(version)}, packs: ${JSON.stringify(packs)}, vectors: 3, failures: ${fail ? '[{ pack: "p@1.0.0", vector: "v1" }]' : "[]"}, not_used: [] }));`,
  `  if (${fail}) process.exit(1);`,
  `};`,
  `module.exports.run = run;`,
  `if (require.main === module) run(process.argv.slice(2));`,
].join("\n");

/** A published bundle: the archive, its manifest and the manifest's signature, served by a fake fetch. */
function publish(key, version, { source = bundleSource(version), signWith = key.privateKey, manifestVersion = version, tamperArchive = false, kid = key.entry.kid } = {}) {
  const files = [{ name: ENGINE_FILE, bytes: Buffer.from(source) }, { name: "LICENSE", bytes: Buffer.from("license") }];
  const tgz = packTgz(files);
  const manifest = `${JSON.stringify({ type: "scopebond:hook-bundle", version: manifestVersion, kid, sha256: createHash("sha256").update(tgz).digest("hex"),
    files: files.map((f) => ({ name: f.name, sha256: createHash("sha256").update(f.bytes).digest("hex"), size: f.bytes.length })), built_from: "a".repeat(40) }, null, 2)}\n`;
  const sig = sign(null, Buffer.from(ENGINE_MANIFEST_DOMAIN + manifest), signWith).toString("base64");
  const served = {
    [`scopebond-hook-bundle-${version}.tgz`]: tamperArchive ? Buffer.concat([tgz, Buffer.from("x")]) : tgz,
    [`scopebond-hook-bundle-${version}.manifest.json`]: manifest,
    [`scopebond-hook-bundle-${version}.manifest.json.sig`]: sig,
  };
  return { target: { version, url: `${URL_BASE}/scopebond-hook-bundle-${version}.tgz`, sha256: createHash("sha256").update(tgz).digest("hex"), signature: null }, served };
}

function fetchFrom(...published) {
  const all = Object.assign({}, ...published.map((p) => p.served));
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), auth: init?.headers?.authorization ?? null });
    const name = String(url).split("/").pop();
    return name in all ? new Response(all[name]) : new Response("not found", { status: 404 });
  };
  return { fetchImpl, seen };
}

const answer = (bundle, policy = "recommended") => ({ policy, hook: null, agent: null, native_agent: null, hook_bundle: bundle?.target ?? null, intel: null });
const home = () => mkdtempSync(join(tmpdir(), "sb-engine-update-"));
const run = (dir, key, target, fetchImpl, extra = {}) => maintainEngine({ dir, kind: "per-user", target, baseline: BASELINE, keys: [key.entry], fetchImpl, log: () => {}, ...extra });

test("a newer, signed bundle that passes its vectors is staged and named in current.json", async () => {
  const key = updaterKey();
  const dir = home();
  const bundle = publish(key, "0.32.0");
  const { fetchImpl, seen } = fetchFrom(bundle);
  const outcome = await run(dir, key, answer(bundle), fetchImpl);
  assert.equal(outcome.action, "installed", outcome.reason);
  assert.equal(readCurrentEngine(dir).version, "0.32.0");
  assert.equal(readCurrentEngine(dir).previous, null);
  for (const name of [ENGINE_FILE, "LICENSE", "manifest.json", "manifest.json.sig"]) assert.ok(existsSync(join(engineVersionDir(dir, "0.32.0"), name)), name);
  assert.ok(seen.every((s) => s.auth === null), "no credential goes to the release host");
  // Asked again: nothing to do.
  assert.equal((await run(dir, key, answer(bundle), fetchImpl)).action, "none");
  // The next one keeps the last as previous.
  const next = publish(key, "0.33.0");
  assert.equal((await run(dir, key, answer(next), fetchFrom(next).fetchImpl)).action, "installed");
  assert.deepEqual({ ...readCurrentEngine(dir), at: 0 }, { version: "0.33.0", at: 0, previous: "0.32.0" });
});

test("refused: another key, a changed archive, a manifest for another version, another digest than the answer's, a plain-http address", async () => {
  const key = updaterKey();
  const cases = [
    ["another key", publish(key, "0.32.0", { signWith: updaterKey().privateKey }), /not signed by a trusted updater key/],
    ["changed archive", publish(key, "0.32.0", { tamperArchive: true }), /not the one/],
    ["other version", publish(key, "0.32.0", { manifestVersion: "0.33.0" }), /for 0\.33\.0/],
  ];
  for (const [name, bundle, reason] of cases) {
    const dir = home();
    const outcome = await run(dir, key, answer(bundle), fetchFrom(bundle).fetchImpl);
    assert.equal(outcome.action, "refused", name);
    assert.match(outcome.reason, reason, name);
    assert.equal(readCurrentEngine(dir), null, name);
    assert.equal(existsSync(engineVersionDir(dir, "0.32.0")), false, `${name}: nothing is left staged`);
  }
  const bundle = publish(key, "0.32.0");
  const wrongDigest = { ...answer(bundle), hook_bundle: { ...bundle.target, sha256: "0".repeat(64) } };
  assert.match((await run(home(), key, wrongDigest, fetchFrom(bundle).fetchImpl)).reason, /not the one the workspace names/);
  const plain = { ...answer(bundle), hook_bundle: { ...bundle.target, url: bundle.target.url.replace("https:", "http:") } };
  assert.match((await run(home(), key, plain, fetchFrom(bundle).fetchImpl)).reason, /https/);
  assert.equal((await run(home(), key, answer(bundle), fetchFrom(bundle).fetchImpl, { keys: [] })).action, "refused", "a build with no updater key takes none");
});

test("nothing changes under hold, from npm, for the engine already carried, or for an older bundle than the one in use", async () => {
  const key = updaterKey();
  const bundle = publish(key, "0.32.0");
  const { fetchImpl, seen } = fetchFrom(bundle);
  assert.equal((await run(home(), key, answer(bundle, "hold"), fetchImpl)).action, "none");
  assert.equal((await run(home(), key, answer(bundle), fetchImpl, { kind: "npm" })).action, "none");
  assert.equal((await run(home(), key, answer(publish(key, BASELINE)), fetchImpl)).action, "none");
  assert.equal((await run(home(), key, answer(null), fetchImpl)).action, "none");
  assert.equal(seen.length, 0, "nothing was downloaded");
  // In use: 0.33.0. An answer naming 0.32.0 is a downgrade: refused.
  const dir = home();
  const newer = publish(key, "0.33.0");
  assert.equal((await run(dir, key, answer(newer), fetchFrom(newer).fetchImpl)).action, "installed");
  const older = await run(dir, key, answer(bundle), fetchFrom(bundle).fetchImpl);
  assert.equal(older.action, "refused");
  assert.match(older.reason, /never moves to an older bundle/);
  assert.equal(readCurrentEngine(dir).version, "0.33.0");
  // An answer naming the engine the executable carries goes back to it.
  const back = await run(dir, key, answer(publish(key, BASELINE)), fetchImpl);
  assert.equal(back.action, "baseline");
  assert.equal(readCurrentEngine(dir), null);
  // A per-machine install takes engine bundles too (into this user's Scopebond folder; the executable verifies each load).
  assert.equal((await run(home(), key, answer(bundle), fetchFrom(bundle).fetchImpl, { kind: "per-machine" })).action, "installed");
});

test("a bundle that fails a pack vector is not used, is removed and is remembered as bad", async () => {
  const key = updaterKey();
  const dir = home();
  const bundle = publish(key, "0.32.0", { source: bundleSource("0.32.0", { fail: true }) });
  const { fetchImpl, seen } = fetchFrom(bundle);
  const outcome = await run(dir, key, answer(bundle), fetchImpl);
  assert.equal(outcome.action, "refused");
  assert.match(outcome.reason, /pack vectors/);
  assert.equal(readCurrentEngine(dir), null);
  assert.equal(existsSync(engineVersionDir(dir, "0.32.0")), false);
  assert.ok(badEngines(dir)["0.32.0"]);
  const before = seen.length;
  assert.equal((await run(dir, key, answer(bundle), fetchImpl)).action, "none", "not tried again");
  assert.equal(seen.length, before);
});

test("a bundle that runs fewer of the packs in force than the engine carried is not used", async () => {
  const example = JSON.parse(readFileSync(new URL("../../policy-schema/vectors/example-pack.json", import.meta.url), "utf8"));
  const exampleKey = JSON.parse(readFileSync(new URL("../../policy-schema/vectors/example-pack-key.json", import.meta.url), "utf8"));
  const keys = [{ key_id: exampleKey.key_id, public_key: exampleKey.public_key, not_before: exampleKey.not_before, not_after: exampleKey.not_after }];
  const before = process.env.SCOPEBOND_POLICY_KEYS_JSON;
  process.env.SCOPEBOND_POLICY_KEYS_JSON = JSON.stringify(keys);
  try {
    const key = updaterKey();
    const dir = home();
    assert.equal(installPack(dir, JSON.stringify(example), { keys }).ok, true);
    const dropsIt = publish(key, "0.32.0", { source: bundleSource("0.32.0", { packs: [] }) });
    const outcome = await run(dir, key, answer(dropsIt), fetchFrom(dropsIt).fetchImpl);
    assert.equal(outcome.action, "refused");
    assert.match(outcome.reason, /1 pack/);
    const keepsIt = publish(key, "0.33.0", { source: bundleSource("0.33.0", { packs: ["example@1.0.0"] }) });
    assert.equal((await run(dir, key, answer(keepsIt), fetchFrom(keepsIt).fetchImpl)).action, "installed");
  } finally {
    if (before === undefined) delete process.env.SCOPEBOND_POLICY_KEYS_JSON; else process.env.SCOPEBOND_POLICY_KEYS_JSON = before;
  }
});

test("two start failures roll back to the previous bundle, or to the engine carried, and the bundle is remembered as bad", async () => {
  const key = updaterKey();
  const dir = home();
  const first = publish(key, "0.32.0");
  const second = publish(key, "0.33.0");
  assert.equal((await run(dir, key, answer(first), fetchFrom(first).fetchImpl)).action, "installed");
  assert.equal((await run(dir, key, answer(second), fetchFrom(second).fetchImpl)).action, "installed");
  const current = readCurrentEngine(dir);
  recordEngineStartFailure(dir, "0.33.0", new Error("broken"), current.at + 1);
  assert.equal((await run(dir, key, answer(second), fetchFrom(second).fetchImpl)).action, "none", "one failure is not enough");
  recordEngineStartFailure(dir, "0.33.0", new Error("broken"), current.at + 2);
  const rolled = await run(dir, key, answer(second), fetchFrom(second).fetchImpl);
  assert.equal(rolled.action, "rolled_back");
  assert.equal(readCurrentEngine(dir).version, "0.32.0");
  assert.ok(badEngines(dir)["0.33.0"]);
  // The workspace still names it: not installed again.
  assert.equal((await run(dir, key, answer(second), fetchFrom(second).fetchImpl)).action, "none");
  assert.equal(readCurrentEngine(dir).version, "0.32.0");
  // The previous one fails twice too: back to the engine carried.
  const now = readCurrentEngine(dir);
  recordEngineStartFailure(dir, "0.32.0", new Error("broken"), now.at + 1);
  recordEngineStartFailure(dir, "0.32.0", new Error("broken"), now.at + 2);
  assert.equal((await run(dir, key, answer(null), fetchFrom().fetchImpl)).action, "rolled_back");
  assert.equal(readCurrentEngine(dir), null);
});

test("a staged bundle damaged on disk is rolled back like one that does not start", async () => {
  const key = updaterKey();
  const dir = home();
  const bundle = publish(key, "0.32.0");
  assert.equal((await run(dir, key, answer(bundle), fetchFrom(bundle).fetchImpl)).action, "installed");
  writeFileSync(join(engineVersionDir(dir, "0.32.0"), ENGINE_FILE), "changed");
  assert.equal((await run(dir, key, answer(bundle), fetchFrom(bundle).fetchImpl)).action, "rolled_back");
  assert.equal(readCurrentEngine(dir), null);
});

test("the workspace's answer may name a hook bundle and an intel component; a malformed one is ignored, not the whole answer", async () => {
  const body = (extra) => async () => new Response(JSON.stringify({ policy: "recommended", hook: null, agent: null, native_agent: null, ...extra }));
  const connection = { url: "https://cloud.example.test", credential: "c" };
  const bundle = { version: "0.32.0", url: "https://github.com/x/y.tgz", sha256: "a".repeat(64), signature: "c2ln" };
  const intel = { version: "1.0.0", sha256: "b".repeat(64), url: "/v1/components/intel/1.0.0" };
  const parsed = await fetchClientVersion(connection, body({ hook_bundle: bundle, intel }), 1000, { agent: "0.11.4", hook: BASELINE });
  assert.deepEqual(parsed.hook_bundle, bundle);
  assert.deepEqual(parsed.intel, intel);
  const malformed = await fetchClientVersion(connection, body({ hook_bundle: { version: "x" }, intel: { version: "1.0.0" } }), 1000, { agent: "0.11.4", hook: BASELINE });
  assert.equal(malformed.policy, "recommended");
  assert.equal(malformed.hook_bundle ?? null, null);
  assert.equal(malformed.intel ?? null, null);
  const older = await fetchClientVersion(connection, body({}), 1000, { agent: "0.11.4", hook: BASELINE });
  assert.equal("hook_bundle" in older, false, "an answer without them reads as before");
  assert.equal("intel" in older, false);
});

test("writeCurrentEngine replaces current.json whole", () => {
  const dir = home();
  writeCurrentEngine(dir, { version: "0.32.0", at: 1, previous: null });
  writeCurrentEngine(dir, { version: "0.33.0", at: 2, previous: "0.32.0" });
  assert.deepEqual(readCurrentEngine(dir), { version: "0.33.0", at: 2, previous: "0.32.0" });
});
