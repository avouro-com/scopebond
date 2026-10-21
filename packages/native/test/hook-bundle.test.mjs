// The engine bundle: built into one file and an archive the agent reads, signed with the updater key so the signed install
// loads it, and deciding exactly as the npm hook does when the shim runs it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildBundle, signBundle, bundleName, manifestName, hookVersion, BUNDLE_FILE, BUNDLE_DOMAIN } from "../hook-bundle.mjs";
import { unpackTgz } from "@scopebond/agent";
import { verifyEngineManifest, ENGINE_MANIFEST_DOMAIN, ENGINE_FILE, scaffold } from "@scopebond/hook";
import { keyId } from "../manifest.mjs";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const hookCli = fileURLToPath(new URL("../../hook/dist/cli.js", import.meta.url));
const shimModule = pathToFileURL(fileURLToPath(new URL("../../hook/dist/engine-shim.js", import.meta.url))).href;
const folder = mkdtempSync(join(tmpdir(), "sb-bundle-"));
const built = await buildBundle(folder, COMMIT);
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pem = privateKey.export({ type: "pkcs8", format: "pem" });
const keyB64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
const keys = [{ kid: keyId(keyB64), key: keyB64, not_after: null }];

test("the archive holds the one-file hook, LICENSE and NOTICE, as the manifest names them", () => {
  assert.equal(BUNDLE_FILE, ENGINE_FILE);
  assert.equal(BUNDLE_DOMAIN, ENGINE_MANIFEST_DOMAIN);
  const tgz = readFileSync(built.archive);
  assert.equal(built.archive, join(folder, bundleName(hookVersion())));
  const files = unpackTgz(tgz);
  assert.ok(Array.isArray(files), String(files));
  assert.deepEqual(files.map((f) => f.name), [BUNDLE_FILE, "LICENSE", "NOTICE"]);
  const manifest = JSON.parse(readFileSync(built.manifest, "utf8"));
  assert.equal(manifest.type, "scopebond:hook-bundle");
  assert.equal(manifest.version, hookVersion());
  assert.equal(manifest.built_from, COMMIT);
  assert.equal(manifest.sha256, createHash("sha256").update(tgz).digest("hex"));
  for (const f of files) assert.deepEqual(manifest.files.find((m) => m.name === f.name), { name: f.name, sha256: createHash("sha256").update(f.bytes).digest("hex"), size: f.bytes.length });
  const code = files[0].bytes.toString("utf8");
  assert.doesNotMatch(code, /__SCOPEBOND_HOOK_VERSION__|__SCOPEBOND_HOOK_BUNDLE__/, "fixed at build time");
  assert.doesNotMatch(code, /\bimport\(\s*["'`]/, "nothing left to load at run time");
});

test("signed with the updater key, the manifest verifies as the shim checks it; the signing step checks before it signs", () => {
  const signed = signBundle(folder, COMMIT, pem);
  assert.equal(signed, join(folder, manifestName(hookVersion())));
  const text = readFileSync(signed, "utf8");
  const manifest = verifyEngineManifest(text, readFileSync(`${signed}.sig`, "utf8"), keys);
  assert.ok(manifest);
  assert.equal(manifest.kid, keys[0].kid);
  assert.equal(verifyEngineManifest(text.replace(COMMIT, "f".repeat(40)), readFileSync(`${signed}.sig`, "utf8"), keys), null);
  assert.throws(() => signBundle(folder, "f".repeat(40), pem), /names commit/);
  const other = mkdtempSync(join(tmpdir(), "sb-bundle-"));
  writeFileSync(join(other, bundleName(hookVersion())), "changed");
  writeFileSync(join(other, manifestName(hookVersion())), readFileSync(signed));
  assert.throws(() => signBundle(other, COMMIT, pem), /not the one the manifest names/);
});

test("Node runs the bundle as the hook's command line: packs test --all", () => {
  const home = mkdtempSync(join(tmpdir(), "sb-bundle-home-"));
  const files = unpackTgz(readFileSync(built.archive));
  const file = join(home, BUNDLE_FILE);
  writeFileSync(file, files[0].bytes);
  const run = spawnSync(process.execPath, [file, "packs", "test", "--all", "--json"], { encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home, SCOPEBOND_HOME: home, SCOPEBOND_HOOK_DIR: home } });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).engine, hookVersion());
});

test("loaded by the shim from a staged folder, the bundle decides a Claude Code call exactly as the npm hook does", () => {
  const home = mkdtempSync(join(tmpdir(), "sb-bundle-home-"));
  const version = hookVersion();
  const staged = join(home, "engine", version);
  mkdirSync(staged, { recursive: true });
  for (const f of unpackTgz(readFileSync(built.archive))) writeFileSync(join(staged, f.name), f.bytes);
  writeFileSync(join(staged, "manifest.json"), readFileSync(built.manifest));
  writeFileSync(join(staged, "manifest.json.sig"), readFileSync(`${built.manifest}.sig`));
  writeFileSync(join(home, "engine", "current.json"), JSON.stringify({ version, at: Date.now(), previous: null }));
  // The executable's hook path, in a script: the shim with a lower baseline, so the staged bundle is the newer engine.
  const runner = join(home, "run-engine.mjs");
  writeFileSync(runner, [
    `import { engineToRun } from ${JSON.stringify(shimModule)};`,
    `const engine = engineToRun({ keys: ${JSON.stringify(keys)}, baselineVersion: "0.0.1" });`,
    `if (!engine) { console.error("no engine"); process.exit(9); }`,
    `process.stderr.write("engine " + engine.version + "\\n");`,
    `await engine.run(process.argv.slice(2));`,
  ].join("\n"));
  const project = join(home, "proj");
  mkdirSync(project);
  scaffold(join(project, ".scopebond"));
  const env = { ...process.env, HOME: home, USERPROFILE: home, SCOPEBOND_HOME: home, SCOPEBOND_HOOK_DIR: join(project, ".scopebond"), SCOPEBOND_POLICY_SYNC: "off", SCOPEBOND_OBSERVATIONS_HEARTBEAT: "off" };
  const event = (tool, input) => JSON.stringify({ hook_event_name: "PreToolUse", session_id: "bundle", tool_name: tool, tool_input: input, cwd: project });
  const decide = (program, input) => {
    const run = spawnSync(process.execPath, [program, "claude"], { input, env, cwd: project, encoding: "utf8" });
    return { status: run.status, decision: run.stdout ? JSON.parse(run.stdout).hookSpecificOutput?.permissionDecision ?? null : null, stderr: run.stderr };
  };
  for (const [tool, input] of [["Write", { file_path: join(project, ".scopebond", "policy.json"), content: "{}" }], ["Bash", { command: "git status" }], ["Bash", { command: "rm -rf /" }]]) {
    const viaBundle = decide(runner, event(tool, input));
    const viaNpm = decide(hookCli, event(tool, input));
    assert.match(viaBundle.stderr, new RegExp(`engine ${version.replace(/\./g, "\\.")}`));
    assert.deepEqual({ status: viaBundle.status, decision: viaBundle.decision }, { status: viaNpm.status, decision: viaNpm.decision }, `${tool} ${JSON.stringify(input)}: ${viaBundle.stderr}`);
  }
});
