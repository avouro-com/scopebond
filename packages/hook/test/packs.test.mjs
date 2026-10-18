// Rule packs in the hook: the interpreter runs every vector of the public example pack (conformance), the cache uses only a
// pack whose signature, digest and age check out (fail closed for the pack, never open), the mapper reads packs only where
// the built-in readers derive nothing, and a derived action from a pack is decided by the rules like any other.

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { packSigningInput, validatePack } from "@scopebond/policy-schema/pack";
import {
  runPackVectors, setActivePacks, activePackRefs, derivePackTargets, installPack, loadPacks, activatePacks, removePack, readPackIndex,
  verifyPackSignature, packsDir, PACK_TTL_MS, mapClaudeToolUse, mapCursorEvent, createHookRuntime, scaffold, packDigest,
} from "../dist/index.js";
import { ENFORCE } from "./enforce-all.mjs";

const require = createRequire(import.meta.url);
const example = JSON.parse(readFileSync(require.resolve("@scopebond/policy-schema/vectors/example-pack.json"), "utf8"));
const exampleKey = JSON.parse(readFileSync(require.resolve("@scopebond/policy-schema/vectors/example-pack-key.json"), "utf8"));
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const NOW = new Date("2026-10-17T12:00:00Z");
const TEST_KEYS = [{ key_id: exampleKey.key_id, public_key: exampleKey.public_key, not_before: exampleKey.not_before, not_after: exampleKey.not_after }];

/** A fresh signing key and the trusted-key entry for it. */
function signer(key_id = "pack-test-fresh") {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const entry = { key_id, public_key: publicKey.export({ format: "pem", type: "spki" }), not_before: "2026-01-01T00:00:00Z", not_after: "2028-01-01T00:00:00Z" };
  const signPack = (unsigned) => {
    const withKey = { ...unsigned, signature: { alg: "Ed25519", key_id, value: "A".repeat(86) + "==" } };
    return { ...withKey, signature: { ...withKey.signature, value: sign(null, Buffer.from(packSigningInput(withKey), "utf8"), privateKey).toString("base64") } };
  };
  return { entry, signPack };
}

const stateDir = () => { const dir = mkdtempSync(join(tmpdir(), "sb-packs-")); return dir; };
const text = (pack) => `${JSON.stringify(pack, null, 2)}\n`;

test("conformance: every vector of the public example pack passes on this interpreter", () => {
  assert.equal(validatePack(example).valid, true);
  const run = runPackVectors(example);
  assert.deepEqual(run.failures, []);
  assert.equal(run.passed, example.vectors.length);
});

test("conformance: a pack whose vectors do not match this interpreter is reported, vector by vector", () => {
  const changed = structuredClone(example);
  changed.vectors[0].expect = [];
  const run = runPackVectors(changed);
  assert.deepEqual(run.failures.map((f) => f.id), [changed.vectors[0].id]);
});

test("the example pack's signature verifies only with its key, inside the key's window", () => {
  assert.deepEqual(verifyPackSignature(example, { keys: TEST_KEYS, now: NOW }), { ok: true, keyId: exampleKey.key_id });
  assert.equal(verifyPackSignature(example, { keys: [], now: NOW }).reason, "unknown_key");
  assert.equal(verifyPackSignature(example, { keys: TEST_KEYS, now: new Date("2037-01-01T00:00:00Z") }).reason, "key_not_valid");
  assert.equal(verifyPackSignature({ ...example, title: "changed" }, { keys: TEST_KEYS, now: NOW }).reason, "bad_signature");
  const other = signer("pack-test-vectors");
  assert.equal(verifyPackSignature(example, { keys: [other.entry], now: NOW }).reason, "bad_signature");
  assert.equal(verifyPackSignature({ ...example, issued_at: "2026-10-18T12:00:00Z" }, { keys: TEST_KEYS, now: NOW }).reason, "issued_in_future");
});

test("the cache: an installed pack is in force; damaged, unsigned, unknown or expired packs are not (and nothing else changes)", () => {
  const dir = stateDir();
  const installed = installPack(dir, text(example), { keys: TEST_KEYS, now: NOW });
  assert.equal(installed.ok, true);
  const index = readPackIndex(dir);
  assert.equal(index.checked_at, NOW.toISOString());
  assert.deepEqual(index.packs.map((p) => `${p.id}@${p.version}`), ["example@1.0.0"]);
  let loaded = loadPacks(dir, { keys: TEST_KEYS, now: NOW });
  assert.deepEqual(loaded.packs.map((p) => p.id), ["example"]);
  assert.deepEqual(loaded.problems, []);
  assert.equal(loaded.expiresAt, new Date(NOW.getTime() + PACK_TTL_MS).toISOString());

  // 30 days after the last check-in, no pack is used.
  loaded = loadPacks(dir, { keys: TEST_KEYS, now: new Date(NOW.getTime() + PACK_TTL_MS + 1000) });
  assert.deepEqual(loaded.packs, []);
  assert.equal(loaded.problems[0].reason, "expired");
  // Just inside the 30 days it still is.
  assert.equal(loadPacks(dir, { keys: TEST_KEYS, now: new Date(NOW.getTime() + PACK_TTL_MS - 1000) }).packs.length, 1);
  // A key this computer does not trust.
  assert.equal(loadPacks(dir, { keys: [], now: NOW }).problems[0].reason, "unknown_key");

  // A file changed after it was cached no longer matches the index.
  const file = join(packsDir(dir), "example@1.0.0.json");
  writeFileSync(file, readFileSync(file, "utf8").replace("examplectl", "examplecli"));
  loaded = loadPacks(dir, { keys: TEST_KEYS, now: NOW });
  assert.deepEqual(loaded.packs, []);
  assert.equal(loaded.problems[0].reason, "digest_mismatch");

  // An index that is not exactly the documented shape: no pack.
  writeFileSync(join(packsDir(dir), "index.json"), JSON.stringify({ v: 1, checked_at: NOW.toISOString(), packs: [], extra: true }));
  loaded = loadPacks(dir, { keys: TEST_KEYS, now: NOW });
  assert.deepEqual(loaded.packs, []);
  assert.equal(loaded.problems[0].reason, "invalid");
});

test("the cache: a pack that is not valid, not signed or whose vectors fail is never installed", () => {
  const dir = stateDir();
  assert.equal(installPack(dir, "{", { keys: TEST_KEYS, now: NOW }).reason, "invalid");
  assert.equal(installPack(dir, text({ ...example, extra: 1 }), { keys: TEST_KEYS, now: NOW }).reason, "invalid");
  assert.equal(installPack(dir, text({ ...example, title: "tampered" }), { keys: TEST_KEYS, now: NOW }).reason, "bad_signature");
  const s = signer();
  const unsigned = structuredClone(example);
  delete unsigned.signature;
  unsigned.vectors[0].expect = [];
  assert.equal(installPack(dir, text(s.signPack(unsigned)), { keys: [s.entry], now: NOW }).reason, "vectors_failed");
  assert.equal(readPackIndex(dir), null);
});

test("the cache: a newer version replaces the older one, and remove takes a pack out", () => {
  const dir = stateDir();
  const s = signer();
  const base = structuredClone(example);
  delete base.signature;
  assert.equal(installPack(dir, text(s.signPack(base)), { keys: [s.entry], now: NOW }).ok, true);
  assert.equal(installPack(dir, text(s.signPack({ ...base, version: "1.1.0" })), { keys: [s.entry], now: NOW }).ok, true);
  assert.deepEqual(readPackIndex(dir).packs.map((p) => p.version), ["1.1.0"]);
  assert.deepEqual(loadPacks(dir, { keys: [s.entry], now: NOW }).packs.map((p) => p.version), ["1.1.0"]);
  assert.equal(removePack(dir, "example"), true);
  assert.deepEqual(loadPacks(dir, { keys: [s.entry], now: NOW }).packs, []);
  assert.equal(removePack(dir, "example"), false);
});

test("activatePacks puts the verified packs in force for the mapper, and no packs (or bad ones) switch them off", () => {
  const dir = stateDir();
  installPack(dir, text(example), { keys: TEST_KEYS, now: NOW });
  activatePacks(dir, { keys: TEST_KEYS, now: NOW });
  assert.deepEqual(activePackRefs(), ["example@1.0.0"]);
  activatePacks(dir, { keys: TEST_KEYS, now: new Date(NOW.getTime() + PACK_TTL_MS + 1) });
  assert.deepEqual(activePackRefs(), []);
  activatePacks(stateDir(), { keys: TEST_KEYS, now: NOW });
  assert.deepEqual(activePackRefs(), []);
});

const derived = (mapped) => mapped.filter((m) => m.derived).map((m) => m.intent);

test("the mapper: with a pack in force, a command the pack reads derives its actions beside the shell command", () => {
  setActivePacks([example]);
  try {
    const mapped = mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "examplectl bucket delete ex://logs --profile prod" }, cwd: "/w" });
    assert.equal(mapped[0].intent.action_type, "shell.exec");
    assert.deepEqual(derived(mapped), [{ action_type: "cloud.resource.delete", params: {
      provider: "unknown", service: "storage", kind: "bucket", env: "production", resource_digest: packDigest("example", "storage", "logs"), risk_class: "destructive",
      via: "examplectl", derived_from: "shell.exec",
    } }]);
    // Cursor's shell hook reads the same.
    assert.equal(derived(mapCursorEvent("beforeShellExecution", { command: "examplectl deploy --env prod", cwd: "/w" }))[0].action_type, "deploy.release");
    // An MCP call a profile covers.
    const mcp = mapClaudeToolUse({ tool_name: "mcp__exampletracker__create_item", tool_input: { project: "OPS" }, cwd: "/w" });
    assert.equal(mcp[0].intent.action_type, "mcp.tool.call");
    assert.deepEqual(derived(mcp).map((i) => i.action_type), ["work.item.create"]);
  } finally { setActivePacks([]); }
});

test("the mapper: with no pack in force, the same command is only the shell command", () => {
  setActivePacks([]);
  const mapped = mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "examplectl bucket delete ex://logs" }, cwd: "/w" });
  assert.deepEqual(mapped.map((m) => m.intent.action_type), ["shell.exec"]);
  assert.deepEqual(derived(mapClaudeToolUse({ tool_name: "mcp__exampletracker__create_item", tool_input: {}, cwd: "/w" })), []);
});

test("among packs, the first by id that derives anything wins, whatever order they were found in", () => {
  const s = signer();
  const make = (id, kind) => s.signPack({
    format: "scopebond:pack/v1", id, version: "1.0.0", issued_at: "2026-10-01T00:00:00Z",
    grammars: [{ id: "g", programs: ["sharedtool"], commands: [{ path: ["go"], emit: [{ action_type: "k8s.apply", params: { kind: { const: kind } } }] }] }],
    profiles: [], rules: [], vectors: [{ id: "v", shell: { command: "sharedtool go" }, expect: [{ action_type: "k8s.apply", params: { kind, via: "sharedtool", derived_from: "shell.exec" } }] }],
  });
  for (const order of [[make("b-pack", "b"), make("a-pack", "a")], [make("a-pack", "a"), make("b-pack", "b")]]) {
    setActivePacks(order);
    assert.deepEqual(derived(mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "sharedtool go" }, cwd: "/w" })).map((i) => i.params.kind), ["a"]);
  }
  setActivePacks([]);
});

test("a pack never fails a call: a grammar that throws derives nothing", () => {
  const broken = { ...example, grammars: [{ ...example.grammars[0], commands: null }] };
  assert.deepEqual(derivePackTargets({ program: "examplectl", programRaw: "examplectl", argv: ["deploy"], redirects: [], raw: "examplectl deploy", opaque: false }, {}, [broken]), []);
});

function runtimeWith(policy) {
  const dir = mkdtempSync(join(tmpdir(), "sb-packs-rt-"));
  scaffold(dir, ENFORCE);
  writeFileSync(join(dir, "policy.json"), JSON.stringify(policy));
  return createHookRuntime({ policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"), attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db") });
}

test("a rule decides what a pack derives: a destructive delete is denied, and the receipt records the derived action", async () => {
  const policy = {
    vocabulary_version: "1.0", policy_id: "packs", version: 1,
    clauses: [
      { id: "shell", type: "action_allowlist", mode: "enforce", action_types: ["shell.exec"] },
      { id: "no-destroy", type: "action_allowlist", mode: "enforce", action_types: ["cloud.resource.delete"], param_bounds: { risk_class: { pattern: "^(?!destructive$).+" } } },
    ],
  };
  setActivePacks([example]);
  try {
    const rt = runtimeWith(policy);
    const denied = await rt.evaluate(mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "examplectl bucket delete ex://logs" }, cwd: "/w" }));
    assert.equal(denied.decision, "deny");
    assert.ok(denied.receipts.some((r) => r.payload.intent.action_type === "cloud.resource.delete" && r.payload.intent.params.via === "examplectl"));
    const allowed = await rt.evaluate(mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "examplectl deploy --env staging" }, cwd: "/w" }));
    assert.notEqual(allowed.decision, "deny");
  } finally { setActivePacks([]); }
  // With no pack in force the same command is only a shell command, which this policy allows.
  const rt = runtimeWith(policy);
  assert.equal((await rt.evaluate(mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "examplectl bucket delete ex://logs" }, cwd: "/w" }))).decision, "allow");
});

test("the starter protections hold with a bad or expired pack in the cache", async () => {
  const dir = stateDir();
  installPack(dir, text(example), { keys: TEST_KEYS, now: NOW });
  activatePacks(dir, { keys: TEST_KEYS, now: new Date(NOW.getTime() + PACK_TTL_MS + 1) });
  assert.deepEqual(activePackRefs(), []);
  const rt = runtimeWith(JSON.parse(readFileSync(join((() => { const d = mkdtempSync(join(tmpdir(), "sb-packs-st-")); scaffold(d, ENFORCE); return d; })(), "policy.json"), "utf8")));
  const d = await rt.evaluate(mapClaudeToolUse({ tool_name: "Read", tool_input: { file_path: "/w/.env" }, cwd: "/w" }));
  assert.equal(d.decision, "deny");
});

function cliRun(dir, args) {
  try {
    return { status: 0, stdout: execFileSync(process.execPath, [cli, ...args], { encoding: "utf8", env: { ...process.env, SCOPEBOND_HOOK_DIR: dir, SCOPEBOND_POLICY_KEYS_JSON: JSON.stringify(TEST_KEYS) }, stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (error) { return { status: error.status, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? "") }; }
}

test("cli: packs verify checks a file, packs add puts it in force, packs list shows it", () => {
  const dir = stateDir();
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "example.json");
  writeFileSync(file, text(example));
  const verified = cliRun(dir, ["packs", "verify", file]);
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /ok: example@1\.0\.0, signature verified, \d+ vectors pass/);
  const tampered = join(dir, "tampered.json");
  writeFileSync(tampered, text({ ...example, title: "x" }));
  assert.equal(cliRun(dir, ["packs", "verify", tampered]).status, 1);
  assert.equal(cliRun(dir, ["packs", "add", file]).status, 1, "add needs a terminal or --yes");
  assert.equal(cliRun(dir, ["packs", "add", file, "--yes"]).status, 0);
  const listed = JSON.parse(cliRun(dir, ["packs", "list", "--json"]).stdout);
  assert.deepEqual(listed.packs.map((p) => `${p.id}@${p.version}`), ["example@1.0.0"]);
  assert.deepEqual(listed.problems, []);
  assert.equal(cliRun(dir, ["packs", "remove", "example", "--yes"]).status, 0);
  assert.deepEqual(JSON.parse(cliRun(dir, ["packs", "list", "--json"]).stdout).packs, []);
});

test("toolNames: the program a command runs, then the tool a package runner starts", async () => {
  const { toolNames, decomposeShell } = await import("../dist/index.js");
  const names = (command) => toolNames(decomposeShell(command)[0]);
  assert.deepEqual(names("examplectl deploy"), ["examplectl"]);
  assert.deepEqual(names("npx -y examplectl deploy"), ["npx", "examplectl"]);
  assert.deepEqual(names("pnpm exec examplectl deploy"), ["pnpm", "examplectl"]);
  assert.deepEqual(names("python -m exampledb upgrade"), ["python", "exampledb"]);
  assert.deepEqual(names("$TOOL deploy"), []);
});
