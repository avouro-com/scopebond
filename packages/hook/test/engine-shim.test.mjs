// The engine shim (engine-shim.ts): the signed install's hook entry loads the newer verified engine bundle named in
// <home>/engine/current.json, and falls back to the engine it carries (the baseline) when there is none, it is not newer, it
// does not verify, or it fails to start; a start failure is recorded, and after two the bundle is not tried again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  engineToRun, readCurrentEngine, writeCurrentEngine, engineStartFailures, recordEngineStartFailure, checkStagedEngine, verifyEngineManifest,
  engineHome, engineDir, ENGINE_MANIFEST_DOMAIN, ENGINE_FILE, ENGINE_CANDIDATE_ENV, MAX_ENGINE_START_FAILURES, userHome,
} from "../dist/index.js";

function updaterKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const key = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const kid = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 16);
  return { privateKey, entry: { kid, key, not_after: null } };
}

const BUNDLE = (marker) => `"use strict";\nmodule.exports.version = "${marker}";\nmodule.exports.run = async (args) => { require("node:fs").writeFileSync(process.env.SB_ENGINE_OUT, JSON.stringify({ engine: "${marker}", args })); };\n`;

/** Stage a bundle as the agent leaves it: <home>/engine/<v>/ with the bundle file and the signed manifest. */
function stage(home, version, key, { source = BUNDLE(version), tamper = false, manifestVersion = version } = {}) {
  const folder = join(engineDir(home), version);
  mkdirSync(folder, { recursive: true });
  const bytes = Buffer.from(source);
  writeFileSync(join(folder, ENGINE_FILE), tamper ? Buffer.concat([bytes, Buffer.from("//x")]) : bytes);
  const manifest = `${JSON.stringify({ type: "scopebond:hook-bundle", version: manifestVersion, kid: key.entry.kid, sha256: "0".repeat(64), built_from: "a".repeat(40),
    files: [{ name: ENGINE_FILE, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length }] }, null, 2)}\n`;
  writeFileSync(join(folder, "manifest.json"), manifest);
  writeFileSync(join(folder, "manifest.json.sig"), sign(null, Buffer.from(ENGINE_MANIFEST_DOMAIN + manifest), key.privateKey).toString("base64"));
  return folder;
}

const freshHome = () => mkdtempSync(join(tmpdir(), "sb-engine-"));

async function runWith(home, key, options = {}) {
  const out = join(home, `out-${Math.random().toString(16).slice(2)}.json`);
  process.env.SB_ENGINE_OUT = out;
  const engine = engineToRun({ home, keys: [key.entry], baselineVersion: "0.31.1", env: {}, ...options });
  if (!engine) return null;
  await engine.run(["claude"]);
  return JSON.parse(readFileSync(out, "utf8"));
}

test("engineHome is the hook's own home (SCOPEBOND_HOME, else ~/.scopebond)", () => {
  assert.equal(engineHome({}), join(homedir(), ".scopebond"));
  assert.equal(engineHome({ SCOPEBOND_HOME: "/x/y" }), "/x/y");
  assert.equal(engineHome(process.env), userHome());
});

test("no current.json: the baseline runs", () => {
  const key = updaterKey();
  assert.equal(engineToRun({ home: freshHome(), keys: [key.entry], baselineVersion: "0.31.1", env: {} }), null);
});

test("a verified, newer bundle named by current.json runs with the hook's arguments", async () => {
  const key = updaterKey();
  const home = freshHome();
  stage(home, "0.32.0", key);
  writeCurrentEngine(home, { version: "0.32.0", at: Date.now(), previous: null });
  assert.deepEqual(await runWith(home, key), { engine: "0.32.0", args: ["claude"] });
  assert.equal(readCurrentEngine(home).version, "0.32.0");
});

test("not newer than the baseline, changed bytes, another key, a manifest for another version: the baseline runs", async () => {
  const key = updaterKey();
  const cases = [
    ["same as baseline", (h) => stage(h, "0.31.1", key), "0.31.1", [key.entry]],
    ["older", (h) => stage(h, "0.30.0", key), "0.30.0", [key.entry]],
    ["changed", (h) => stage(h, "0.32.0", key, { tamper: true }), "0.32.0", [key.entry]],
    ["another key", (h) => stage(h, "0.32.0", updaterKey()), "0.32.0", [key.entry]],
    ["no keys", (h) => stage(h, "0.32.0", key), "0.32.0", []],
    ["manifest for another version", (h) => stage(h, "0.32.0", key, { manifestVersion: "0.33.0" }), "0.32.0", [key.entry]],
    ["a path out of the engine folder", (h) => stage(h, "0.32.0", key), "../0.32.0", [key.entry]],
  ];
  for (const [name, setUp, version, keys] of cases) {
    const home = freshHome();
    setUp(home);
    writeCurrentEngine(home, { version, at: Date.now(), previous: null });
    assert.equal(engineToRun({ home, keys, baselineVersion: "0.31.1", env: {} }), null, name);
  }
});

test("a bundle that fails to start is recorded; after two failures it is not tried again", async () => {
  const key = updaterKey();
  const home = freshHome();
  stage(home, "0.32.0", key, { source: "throw new Error('broken bundle');\n" });
  const at = Date.now() - 1000;
  writeCurrentEngine(home, { version: "0.32.0", at, previous: null });
  assert.equal(engineToRun({ home, keys: [key.entry], baselineVersion: "0.31.1", env: {} }), null);
  assert.equal(engineStartFailures(home, "0.32.0", at), 1);
  assert.equal(engineToRun({ home, keys: [key.entry], baselineVersion: "0.31.1", env: {} }), null);
  assert.equal(engineStartFailures(home, "0.32.0", at), MAX_ENGINE_START_FAILURES);
  // A working bundle with two failures recorded since it became current is not loaded any more.
  stage(home, "0.32.0", key);
  assert.equal(engineToRun({ home, keys: [key.entry], baselineVersion: "0.31.1", env: {} }), null);
  // Failures from before it became current do not count.
  writeCurrentEngine(home, { version: "0.32.0", at: Date.now() + 10, previous: null });
  assert.ok(engineToRun({ home, keys: [key.entry], baselineVersion: "0.31.1", env: {} }));
  // A bundle with no run export is a start failure too.
  const other = freshHome();
  stage(other, "0.32.0", key, { source: "module.exports.other = 1;\n" });
  writeCurrentEngine(other, { version: "0.32.0", at: Date.now() - 1, previous: null });
  assert.equal(engineToRun({ home: other, keys: [key.entry], baselineVersion: "0.31.1", env: {} }), null);
  assert.equal(engineStartFailures(other, "0.32.0", 0), 1);
  recordEngineStartFailure(other, "0.32.0", new Error("x"));
  assert.equal(engineStartFailures(other, "0.32.0", 0), 2);
});

test("the candidate (an update being checked) runs from its folder whatever current says, and never falls back", async () => {
  const key = updaterKey();
  const home = freshHome();
  stage(home, "0.32.0", key);
  assert.deepEqual(await runWith(home, key, { env: { [ENGINE_CANDIDATE_ENV]: "0.32.0" } }), { engine: "0.32.0", args: ["claude"] });
  stage(home, "0.33.0", key, { tamper: true });
  assert.throws(() => engineToRun({ home, keys: [key.entry], baselineVersion: "0.31.1", env: { [ENGINE_CANDIDATE_ENV]: "0.33.0" } }), /candidate engine 0\.33\.0/);
  assert.throws(() => engineToRun({ home, keys: [key.entry], baselineVersion: "0.31.1", env: { [ENGINE_CANDIDATE_ENV]: "../x" } }), /candidate/);
  assert.equal(existsSync(join(engineDir(home), "start-failures.log")), false, "a candidate's failure is the agent's to record");
});

test("checkStagedEngine and verifyEngineManifest: the signature covers the domain and the manifest bytes", () => {
  const key = updaterKey();
  const home = freshHome();
  const folder = stage(home, "0.32.0", key);
  const checked = checkStagedEngine(home, "0.32.0", [key.entry]);
  assert.equal(checked.ok, true);
  assert.equal(checked.manifest.version, "0.32.0");
  const text = readFileSync(join(folder, "manifest.json"), "utf8");
  const bare = sign(null, Buffer.from(text), key.privateKey).toString("base64");
  assert.equal(verifyEngineManifest(text, bare, [key.entry]), null);
  assert.equal(verifyEngineManifest(text, readFileSync(join(folder, "manifest.json.sig"), "utf8"), [{ ...key.entry, not_after: "2020-01-01" }]), null, "a key past its last day");
  assert.equal(verifyEngineManifest(text, readFileSync(join(folder, "manifest.json.sig"), "utf8"), [{ ...key.entry, kid: "0000000000000000" }]), null, "the manifest names its key");
});
