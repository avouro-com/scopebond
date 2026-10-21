// Local rule packs: packs a rules file names (pack-local.ts). They are checked like delivered packs, are skipped and named when
// they fail, lose to a delivered pack with the same id, and can only add rules: never replace one or cover a new type of call.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  activatePacks, activePackRefs, activePacks, createHookRuntime, derivePackMcp, derivePackTargets, installPack, loadLocalPacks,
  localPackIds, mapClaudeToolUse, scaffold, setActivePacks, withPackRules, localRuleProblem,
} from "../dist/index.js";
import { decomposeShell } from "../dist/shell.js";
import { packSigningInput } from "@scopebond/policy-schema/pack";
import { ENFORCE } from "./enforce-all.mjs";

const require = createRequire(import.meta.url);
const example = JSON.parse(readFileSync(require.resolve("@scopebond/policy-schema/vectors/example-pack.json"), "utf8"));
const exampleKey = JSON.parse(readFileSync(require.resolve("@scopebond/policy-schema/vectors/example-pack-key.json"), "utf8"));
const KEYS = [{ key_id: exampleKey.key_id, public_key: exampleKey.public_key, not_before: exampleKey.not_before, not_after: exampleKey.not_after }];
const packsFolder = fileURLToPath(new URL("../packs/", import.meta.url));
const generalPack = (id) => JSON.parse(readFileSync(join(packsFolder, `${id}.json`), "utf8"));
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

afterEach(() => setActivePacks([]));

/** A folder with the starter rules (monitor, or `opts`) and these local packs written beside it and named in rules.json. */
function setup(packs, { extra = {}, opts = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sb-local-packs-"));
  scaffold(dir, opts);
  mkdirSync(join(dir, "team-packs"));
  const names = [];
  for (const [name, pack] of Object.entries(packs)) {
    writeFileSync(join(dir, "team-packs", name), typeof pack === "string" ? pack : JSON.stringify(pack));
    names.push(`team-packs/${name}`);
  }
  const rules = JSON.parse(readFileSync(join(dir, "rules.json"), "utf8"));
  writeFileSync(join(dir, "rules.json"), JSON.stringify({ ...rules, packs: { local: names, ...extra } }));
  return dir;
}

const sc = (command) => decomposeShell(command)[0];

test("a valid local pack named in the rules file is in force after the delivered packs, without a signature", () => {
  const dir = setup({ "git-safety.json": generalPack("git-safety") });
  const loaded = activatePacks(dir);
  assert.deepEqual(loaded.local.problems, []);
  assert.deepEqual(activePackRefs(), ["git-safety@1.0.0"]);
  assert.ok(localPackIds().has("git-safety"));
  assert.equal(derivePackTargets(sc("git reset --hard HEAD~1"))[0]?.params.operation, "reset-hard");
  assert.equal(loaded.local.files["git-safety@1.0.0"], "team-packs/git-safety.json");
});

test("an invalid local pack is skipped and named; the others stay in force", () => {
  const broken = { ...generalPack("ci-guard"), surprise: true };
  const failing = generalPack("build-hygiene");
  failing.vectors[0].expect = [];
  const dir = setup({ "a.json": broken, "b.json": "{ not json", "c.json": failing, "d.json": generalPack("git-safety") });
  const loaded = activatePacks(dir);
  assert.deepEqual(activePackRefs(), ["git-safety@1.0.0"]);
  assert.deepEqual(loaded.local.problems.map((p) => [p.file, p.reason]), [
    ["team-packs/a.json", "invalid"], ["team-packs/b.json", "invalid"], ["team-packs/c.json", "vectors_failed"],
  ]);
  assert.match(loaded.local.problems[2].message, /npm-publish/);
  // A file that is not there, and one in the delivered packs folder (a check-in rewrites it), are named too.
  const dir2 = setup({});
  const rules = JSON.parse(readFileSync(join(dir2, "rules.json"), "utf8"));
  writeFileSync(join(dir2, "rules.json"), JSON.stringify({ ...rules, packs: { local: ["team-packs/gone.json", "packs/mine.json"] } }));
  mkdirSync(join(dir2, "packs"));
  writeFileSync(join(dir2, "packs", "mine.json"), JSON.stringify(generalPack("git-safety")));
  assert.deepEqual(loadLocalPacks(dir2).problems.map((p) => p.reason), ["missing", "in_pack_cache"]);
});

test("a local pack needs a pack engine level and action types this hook reads", () => {
  const future = { ...generalPack("git-safety"), requires: { engine: 99 } };
  const dir = setup({ "future.json": future });
  const [problem] = loadLocalPacks(dir).problems;
  assert.equal(problem.reason, "engine_too_old");
});

test("a delivered pack with the same id wins; a delivered grammar and MCP profile come before a local one", () => {
  // A local pack with the delivered pack's id is not used.
  const clash = structuredClone(example);
  delete clash.signature;
  clash.rules = [];
  const dir = setup({ "clash.json": clash, "mine.json": localExampleTool() });
  assert.equal(installPack(dir, `${JSON.stringify(example)}\n`, { keys: KEYS }).ok, true);
  const loaded = activatePacks(dir, { keys: KEYS });
  assert.deepEqual(activePackRefs(), ["example@1.0.0", "mine@1.0.0"]);
  assert.deepEqual(loaded.local.problems.map((p) => p.reason), ["id_taken"]);
  // Both read examplectl: the delivered grammar derives first; the local one reads what the delivered one does not.
  const delivered = derivePackTargets(sc("examplectl bucket delete ex://logs-prod"));
  assert.equal(delivered[0].params.via, "examplectl");
  assert.equal(derivePackTargets(sc("examplectl wipe-everything"))[0]?.params.via, "mine");
  // An MCP server the local profile names by its configured name, and a delivered profile by its URL: the delivered one owns it.
  const call = ["corp-files", "create_item", { title: "x" }, "https://tracker.example.com/mcp"];
  const deliveredOnly = derivePackMcp(...call, [example]);
  assert.deepEqual(derivePackMcp(...call), deliveredOnly);
  assert.equal(derivePackMcp("corp-files", "create_item", { title: "x" }).length, 1, "without the hint, the local profile reads it");
});

/** A local pack that reads `examplectl wipe-everything` and an MCP server named `corp`. */
function localExampleTool() {
  const pack = structuredClone(generalPack("git-safety"));
  pack.id = "mine";
  pack.grammars = [{ id: "mine", programs: ["examplectl"], via: "mine", commands: [{ path: ["wipe-everything"], emit: [{ action_type: "file.write", params: { path: { const: "." } } }] }] }];
  pack.profiles = [{ id: "corp", servers: ["corp"], via: "corp", tools: [{ names: ["create_item"], emit: [{ action_type: "work.item.create", params: { provider: { const: "corp" } } }] }] }];
  pack.rules = [];
  pack.vectors = [{ id: "wipe", shell: { command: "examplectl wipe-everything" }, expect: [{ action_type: "file.write", params: { path: ".", via: "mine", derived_from: "shell.exec" } }] }];
  return pack;
}

test("a local pack cannot replace a rule or cover a new type of call", () => {
  const takesId = structuredClone(generalPack("git-safety"));
  takesId.id = "takes-id";
  takesId.rules[0].id = "safe-shell";
  const coversCall = structuredClone(generalPack("git-safety"));
  coversCall.id = "covers-call";
  coversCall.rules = [{ id: "any-install", type: "action_allowlist", mode: "monitor", action_types: ["package.install"] }];
  const targetName = structuredClone(generalPack("git-safety"));
  targetName.id = "target-name";
  targetName.rules[0].id = "secret-write";
  const dir = setup({ "a.json": takesId, "b.json": coversCall, "c.json": targetName, "d.json": generalPack("build-hygiene") });
  const loaded = activatePacks(dir);
  assert.deepEqual(loaded.local.problems.map((p) => [p.file, p.reason]), [
    ["team-packs/a.json", "rule_not_added"], ["team-packs/b.json", "rule_not_added"], ["team-packs/c.json", "rule_not_added"],
  ]);
  assert.match(loaded.local.problems[1].message, /package\.install/);
  // A type the hook only derives (software.install, deploy.release) may be covered by a local rule.
  assert.deepEqual(activePackRefs(), ["build-hygiene@1.0.0"]);
  assert.equal(localRuleProblem({ id: "x", action_types: ["software.install"] }, new Set(), new Set()), null);
  // The runtime checks again: a rule put in force without the load check never joins the policy.
  setActivePacks([], [], [coversCall]);
  const policy = JSON.parse(readFileSync(join(dir, "policy.json"), "utf8"));
  const joined = withPackRules(policy, new Set());
  assert.equal(joined.clauses.some((c) => c.id === "any-install"), false);
  setActivePacks([], [], [takesId]);
  const safeShell = withPackRules(policy, new Set()).clauses.filter((c) => c.id === "safe-shell");
  assert.equal(safeShell.length, 1);
  assert.equal(safeShell[0].action_types[0], "shell.exec", "the policy's own rule stays");
});

test("a local pack's rules never turn a block into an allow", async () => {
  const loose = structuredClone(generalPack("git-safety"));
  loose.rules = [{ id: "any-push", type: "action_allowlist", mode: "monitor", action_types: ["git.push"] }, { id: "any-write", type: "action_allowlist", mode: "monitor", action_types: ["file.write"] }];
  const dir = setup({ "loose.json": loose }, { opts: ENFORCE });
  activatePacks(dir);
  assert.deepEqual(activePackRefs(), ["git-safety@1.0.0"]);
  const runtime = createHookRuntime({ policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"), attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db") });
  try {
    const push = await runtime.evaluate(mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "git push origin main" }, cwd: dir }));
    assert.equal(push.decision, "deny");
    assert.equal(push.clauseId, "protect-branches");
    const write = await runtime.evaluate(mapClaudeToolUse({ tool_name: "Write", tool_input: { file_path: ".git/hooks/pre-commit" }, cwd: dir }));
    assert.equal(write.decision, "deny");
  } finally { runtime.close(); }
});

test("with trusted_keys, every local pack must carry a signature that verifies with one of them", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const key = { key_id: "team-key", public_key: publicKey.export({ format: "pem", type: "spki" }), not_before: "2026-01-01T00:00:00Z", not_after: "2030-01-01T00:00:00Z" };
  const signedLocal = structuredClone(generalPack("ci-guard"));
  signedLocal.signature = { alg: "Ed25519", key_id: key.key_id, value: sign(null, Buffer.from(packSigningInput(generalPack("ci-guard")), "utf8"), privateKey).toString("base64") };
  const dir = setup({ "signed.json": signedLocal, "unsigned.json": generalPack("git-safety") }, { extra: { trusted_keys: [key] } });
  const loaded = loadLocalPacks(dir);
  assert.deepEqual(loaded.packs.map((p) => p.id), ["ci-guard"]);
  assert.deepEqual(loaded.problems.map((p) => p.reason), ["unsigned"]);
  // Changed after signing: refused.
  const dir2 = setup({ "changed.json": { ...signedLocal, title: "changed" } }, { extra: { trusted_keys: [key] } });
  assert.equal(loadLocalPacks(dir2).problems[0].reason, "bad_signature");
  // A trusted key that is not a key: no local pack is used.
  const dir3 = setup({ "signed.json": signedLocal }, { extra: { trusted_keys: [{ key_id: "x" }] } });
  assert.equal(loadLocalPacks(dir3).problems[0].reason, "invalid");
});

test("packs list, status and doctor name a local pack that is not used", () => {
  const dir = setup({ "ok.json": generalPack("ci-guard"), "bad.json": "{" });
  const home = mkdtempSync(join(tmpdir(), "sb-local-packs-home-"));
  const env = { ...process.env, HOME: home, USERPROFILE: home, SCOPEBOND_HOME: home, SCOPEBOND_HOOK_DIR: dir, SCOPEBOND_POLICY_SYNC: "off" };
  const list = spawnSync(process.execPath, [cli, "packs", "list", "--json"], { cwd: dir, encoding: "utf8", env });
  assert.equal(list.status, 0, list.stderr);
  const report = JSON.parse(list.stdout);
  assert.deepEqual(report.local.map((p) => [p.id, p.file]), [["ci-guard", "team-packs/ok.json"]]);
  assert.deepEqual(report.local_problems.map((p) => [p.file, p.reason]), [["team-packs/bad.json", "invalid"]]);
  const status = spawnSync(process.execPath, [cli, "status"], { cwd: dir, encoding: "utf8", env });
  assert.match(status.stdout, /rule packs\s+local: ci-guard@1\.0\.0 \(team-packs\/ok\.json\)/);
  assert.match(status.stdout, /rule packs\s+local, not used: team-packs\/bad\.json: the pack is not JSON/);
  const doctor = spawnSync(process.execPath, [cli, "doctor"], { cwd: dir, encoding: "utf8", env });
  assert.match(doctor.stdout, /local pack\s+team-packs\/bad\.json: the pack is not JSON NOT USED/);
  assert.match(`${doctor.stdout}${doctor.stderr}`, /a local rule pack is not used/);
});

test("the general packs leave the everyday decisions unchanged", async () => {
  const everyday = [
    ["Bash", { command: "npm test" }], ["Bash", { command: "pnpm -r build" }], ["Bash", { command: "git status" }], ["Bash", { command: "git diff --stat" }],
    ["Bash", { command: "git add -A && git commit -m 'fix: x'" }], ["Bash", { command: "git push origin feature/x" }], ["Bash", { command: "git push origin main" }],
    ["Bash", { command: "git checkout -b feature/y" }], ["Bash", { command: "git rebase main" }], ["Bash", { command: "git stash" }], ["Bash", { command: "npm install lodash" }],
    ["Bash", { command: "rm -rf /tmp/other" }], ["Bash", { command: "rm -rf dist" }], ["Bash", { command: "ls -la" }], ["Bash", { command: "cat README.md" }],
    ["Bash", { command: "echo hi > out.txt" }], ["Bash", { command: "curl -s https://example.com" }], ["Bash", { command: "node scripts/build.mjs" }],
    ["Write", { file_path: "src/app.ts" }], ["Edit", { file_path: "README.md" }], ["Read", { file_path: "src/x.ts" }], ["Read", { file_path: ".env" }],
    ["Write", { file_path: ".github/workflows/ci.yml" }], ["mcp__github__create_issue", { title: "x" }],
  ];
  const decide = async (dir) => {
    const runtime = createHookRuntime({ policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"), attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db") });
    try {
      const out = [];
      for (const [tool_name, tool_input] of everyday) out.push((await runtime.evaluate(mapClaudeToolUse({ tool_name, tool_input, cwd: dir }))).decision);
      return out;
    } finally { runtime.close(); }
  };
  for (const opts of [{}, ENFORCE]) {
    const plain = setup({}, { opts });
    activatePacks(plain);
    const without = await decide(plain);
    const all = Object.fromEntries(["git-safety", "secrets-hygiene", "build-hygiene", "ci-guard"].map((id) => [`${id}.json`, generalPack(id)]));
    const withPacks = setup(all, { opts });
    const loaded = activatePacks(withPacks);
    assert.deepEqual(loaded.local.problems, []);
    assert.equal(activePacks().length, 4);
    assert.deepEqual(await decide(withPacks), without, `everyday decisions with ${opts.enforce ? "the rules blocking" : "the default rules"}`);
  }
});

test("a pack file's vectors run once per hook version, and again whenever the file changes", () => {
  const dir = setup({ "git-safety.json": generalPack("git-safety") });
  assert.deepEqual(loadLocalPacks(dir).problems, []);
  const checked = JSON.parse(readFileSync(join(dir, "local-packs-checked.json"), "utf8"));
  assert.equal(checked.passed.length, 1);
  const changed = generalPack("git-safety");
  changed.vectors[0].expect = [];
  writeFileSync(join(dir, "team-packs", "git-safety.json"), JSON.stringify(changed));
  assert.deepEqual(loadLocalPacks(dir).problems.map((p) => p.reason), ["vectors_failed"]);
  // A record made by another version (or another engine level) is not trusted.
  writeFileSync(join(dir, "team-packs", "git-safety.json"), JSON.stringify(generalPack("git-safety")));
  writeFileSync(join(dir, "local-packs-checked.json"), JSON.stringify({ ...checked, engine: "0.0.0/2" }));
  assert.deepEqual(loadLocalPacks(dir).problems, []);
  assert.notEqual(JSON.parse(readFileSync(join(dir, "local-packs-checked.json"), "utf8")).engine, "0.0.0/2");
});
