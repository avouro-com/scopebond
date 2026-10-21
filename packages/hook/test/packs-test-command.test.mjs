// `packs test`: run the vectors of the packs in force (`--all`) or of one pack file with this engine, the check an engine
// update runs before it is used.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { installPack, hookVersion } from "../dist/index.js";

const require = createRequire(import.meta.url);
const example = JSON.parse(readFileSync(require.resolve("@scopebond/policy-schema/vectors/example-pack.json"), "utf8"));
const exampleKey = JSON.parse(readFileSync(require.resolve("@scopebond/policy-schema/vectors/example-pack-key.json"), "utf8"));
const KEYS = [{ key_id: exampleKey.key_id, public_key: exampleKey.public_key, not_before: exampleKey.not_before, not_after: exampleKey.not_after }];
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function run(dir, args) {
  const home = mkdtempSync(join(tmpdir(), "sb-packs-test-home-"));
  return spawnSync(process.execPath, [cli, "packs", "test", ...args], {
    cwd: dir, encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home, SCOPEBOND_HOME: home, SCOPEBOND_HOOK_DIR: dir, SCOPEBOND_POLICY_KEYS_JSON: JSON.stringify(KEYS), SCOPEBOND_POLICY_SYNC: "off" },
  });
}

test("--all: every vector of every pack in force passes, reported with the engine's version", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-packs-test-"));
  assert.equal(installPack(dir, `${JSON.stringify(example)}\n`, { keys: KEYS }).ok, true);
  const out = run(dir, ["--all", "--json"]);
  assert.equal(out.status, 0, out.stderr);
  const report = JSON.parse(out.stdout);
  assert.equal(report.engine, hookVersion());
  assert.deepEqual(report.packs, ["example@1.0.0"]);
  assert.equal(report.vectors, example.vectors.length);
  assert.deepEqual(report.failures, []);
  const text = run(dir, ["--all"]);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /example@1\.0\.0: \d+ vectors pass/);
});

test("--all with no pack passes with nothing to run", () => {
  const out = run(mkdtempSync(join(tmpdir(), "sb-packs-test-")), ["--all", "--json"]);
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), { engine: hookVersion(), packs: [], vectors: 0, failures: [], not_used: [] });
});

test("a pack file whose vectors this engine does not reproduce fails, naming the vector", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-packs-test-"));
  const changed = structuredClone(example);
  changed.vectors[0].expect = [];
  const file = join(dir, "pack.json");
  writeFileSync(file, JSON.stringify(changed));
  const out = run(dir, [file, "--json"]);
  assert.equal(out.status, 1);
  const report = JSON.parse(out.stdout);
  assert.deepEqual(report.failures.map((f) => f.vector), [changed.vectors[0].id]);
  // The unchanged pack file passes (a file is tested for its vectors; its signature is `packs verify`'s job).
  writeFileSync(file, JSON.stringify(example));
  assert.equal(run(dir, [file]).status, 0);
  assert.equal(run(dir, []).status, 1, "usage: --all or a file");
});
