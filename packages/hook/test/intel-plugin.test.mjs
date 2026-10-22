// The optional plugin slot (intel-plugin.ts): a signed module in <home>/intel/current is asked about each action and its
// answer is signed into the receipt as pattern_id and intel. Without the module nothing is loaded and receipts are what they
// were: the same members, the same values.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openReceiptStore } from "@scopebond/gateway/node";
import { verifyReceipt, canonical } from "@scopebond/gateway";
import { loadOrCreateAttester } from "@scopebond/gateway/node";
import {
  scaffold, createHookRuntime, mapClaudeToolUse, loadIntelPlugin, intelComponentState, pluginFrom, checkIntelComponent,
  INTEL_COMPONENT_DOMAIN, INTEL_BUDGET_MS, INTEL_COLD_ALLOWANCE_MS, importVerifiedModule,
} from "../dist/index.js";
import { ENFORCE } from "./enforce-all.mjs";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const PATTERN = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

function testKey(id = "pol_test_intel", window = { not_before: "2026-01-01T00:00:00Z", not_after: "2030-01-01T00:00:00Z" }) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { privateKey, entry: { key_id: id, public_key: publicKey.export({ type: "spki", format: "pem" }).toString(), ...window } };
}

/** Put a module and its signed manifest in <home>/intel/current. */
function installModule(home, source, key, { version = "1.0.0", keyId, tamper } = {}) {
  const folder = join(home, "intel", "current");
  mkdirSync(folder, { recursive: true });
  const bytes = Buffer.from(source, "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const signature = sign(null, Buffer.from(INTEL_COMPONENT_DOMAIN + sha256, "utf8"), key.privateKey).toString("base64");
  writeFileSync(join(folder, "intel.mjs"), tamper ? Buffer.concat([bytes, Buffer.from("\n// changed")]) : bytes);
  writeFileSync(join(folder, "manifest.json"), JSON.stringify({ version, sha256, signature, ...(keyId ? { key_id: keyId } : {}) }));
  return folder;
}

const MODULE = `export function inspect(action) { return { pattern_id: "${PATTERN}", slot: Buffer.from(action.action_type).toString("base64") }; }\n`;
const home = () => mkdtempSync(join(tmpdir(), "sb-intel-"));

test("no module: nothing is loaded", async () => {
  const h = home();
  assert.equal(intelComponentState(h).reason, "none");
  assert.equal(await loadIntelPlugin(h), null);
});

test("a module signed by a pinned key loads, and its answer becomes the two members", async () => {
  const key = testKey();
  const h = home();
  installModule(h, MODULE, key);
  const plugin = await loadIntelPlugin(h, { keys: [key.entry] });
  assert.ok(plugin);
  assert.equal(plugin.version, "1.0.0");
  assert.deepEqual(plugin.inspect({ action_type: "shell.exec", params: { program: "ls" } }), { pattern_id: PATTERN, intel: Buffer.from("shell.exec").toString("base64") });
  // Named by its key id, too.
  const named = home();
  installModule(named, MODULE, key, { keyId: key.entry.key_id });
  assert.ok(await loadIntelPlugin(named, { keys: [key.entry] }));
});

test("a changed module, another key, a key out of its window or a manifest naming an unknown key: no plugin", async () => {
  const key = testKey();
  const cases = [
    ["changed module", (h) => installModule(h, MODULE, key, { tamper: true }), [key.entry]],
    ["another key", (h) => installModule(h, MODULE, testKey()), [key.entry]],
    ["expired key", (h) => installModule(h, MODULE, key), [{ ...key.entry, not_before: "2020-01-01T00:00:00Z", not_after: "2021-01-01T00:00:00Z" }]],
    ["unknown key id", (h) => installModule(h, MODULE, key, { keyId: "pol_other" }), [key.entry]],
    ["no keys", (h) => installModule(h, MODULE, key), []],
  ];
  for (const [name, setUp, keys] of cases) {
    const h = home();
    setUp(h);
    assert.equal(intelComponentState(h, { keys }).ok, false, name);
    assert.equal(await loadIntelPlugin(h, { keys }), null, name);
  }
  // The signature covers the domain: the bare digest signed is refused.
  const bytes = Buffer.from(MODULE);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const bare = sign(null, Buffer.from(sha256), key.privateKey).toString("base64");
  assert.equal(checkIntelComponent({ version: "1.0.0", sha256, signature: bare }, bytes, { keys: [key.entry] }).ok, false);
});

test("a module that does not export inspect, or fails to load, gives no plugin", async () => {
  const key = testKey();
  for (const source of ["export const other = 1;\n", "throw new Error('broken');\n", "this is not javascript"]) {
    const h = home();
    installModule(h, source, key);
    assert.equal(await loadIntelPlugin(h, { keys: [key.entry] }), null, source);
  }
});

test("inspect: a throw, a promise, a wrong shape or an answer over the time budget gives no slot; the action is a copy", () => {
  const action = { action_type: "file.read", params: { path: "a.txt" } };
  const answers = [
    () => { throw new Error("x"); },
    () => Promise.resolve({ pattern_id: PATTERN }),
    () => ({ pattern_id: PATTERN.toUpperCase() }),
    () => ({ slot: "not base64!" }),
    () => ({ pattern_id: PATTERN, slot: Buffer.alloc(4097).toString("base64") }),
    () => "text",
    () => null,
  ];
  for (const answer of answers) assert.deepEqual(pluginFrom("1.0.0", answer).inspect(action), {}, String(answer));
  // Over the budget: the clock says the call took longer than allowed (the budget and all of the cold-start allowance).
  let t = 0;
  const slow = pluginFrom("1.0.0", () => ({ pattern_id: PATTERN }), INTEL_BUDGET_MS, () => (t += INTEL_BUDGET_MS + INTEL_COLD_ALLOWANCE_MS + 1));
  assert.deepEqual(slow.inspect(action), {});
  assert.equal(INTEL_BUDGET_MS, 2);
  // Within it, with only the members given.
  assert.deepEqual(pluginFrom("1.0.0", () => ({ pattern_id: PATTERN }), INTEL_BUDGET_MS, () => 0).inspect(action), { pattern_id: PATTERN });
  const mutating = pluginFrom("1.0.0", (a) => { a.params.path = "/etc/shadow"; a.action_type = "x"; return undefined; });
  assert.deepEqual(mutating.inspect(action), {});
  assert.deepEqual(action, { action_type: "file.read", params: { path: "a.txt" } });
});

test("while the plugin's code is cold, a process's calls may run over the budget by the cold-start allowance in all", () => {
  const action = { action_type: "file.read", params: { path: "a.txt" } };
  assert.equal(INTEL_COLD_ALLOWANCE_MS, 25);
  // A clock by which each call takes the next of `times` ms.
  const timed = (...times) => { let t = 0; let start = true; return () => { const now = start ? t : (t += times.shift() ?? 0); start = !start; return now; }; };
  const answer = () => ({ pattern_id: PATTERN });
  const ok = { pattern_id: PATTERN };
  // One cold call may take the budget and the whole allowance; a call that takes more gives nothing.
  assert.deepEqual(pluginFrom("1.0.0", answer, INTEL_BUDGET_MS, timed(INTEL_BUDGET_MS + INTEL_COLD_ALLOWANCE_MS)).inspect(action), ok);
  assert.deepEqual(pluginFrom("1.0.0", answer, INTEL_BUDGET_MS, timed(INTEL_BUDGET_MS + INTEL_COLD_ALLOWANCE_MS + 1)).inspect(action), {});
  // The allowance is shared: 20 ms (18 over), then 20 ms again (18 over, 7 left) gives nothing and ends it; then even 3 ms is over.
  const shared = pluginFrom("1.0.0", answer, INTEL_BUDGET_MS, timed(20, 20, 3, 1));
  assert.deepEqual(shared.inspect(action), ok);
  assert.deepEqual(shared.inspect(action), {});
  assert.deepEqual(shared.inspect(action), {});
  assert.deepEqual(shared.inspect(action), ok, "within the budget itself");
  // Several cold calls of 6 ms (4 over each): six fit in 25 ms, the seventh does not.
  const many = pluginFrom("1.0.0", answer, INTEL_BUDGET_MS, timed(6, 6, 6, 6, 6, 6, 6));
  for (let i = 0; i < 6; i++) assert.deepEqual(many.inspect(action), ok, `call ${i + 1}`);
  assert.deepEqual(many.inspect(action), {});
  // A call that throws is charged too.
  let calls = 0;
  const throwsFirst = pluginFrom("1.0.0", () => { if (calls++ === 0) throw new Error("x"); return ok; }, INTEL_BUDGET_MS, timed(20, 20));
  assert.deepEqual(throwsFirst.inspect(action), {});
  assert.deepEqual(throwsFirst.inspect(action), {});
});

test("the checked bytes are imported from memory, not from a data: URL; the data: URL remains the fallback", async () => {
  const source = "export const url = import.meta.url;\nexport function inspect() { return undefined; }\n";
  const fromMemory = await importVerifiedModule(Buffer.from(source));
  assert.match(String(fromMemory.url), /^scopebond-plugin:[0-9a-f]{64}$/);
  assert.equal(typeof fromMemory.inspect, "function");
  // The same bytes again: the same module.
  assert.equal(await importVerifiedModule(Buffer.from(source)), fromMemory);
  const viaData = await importVerifiedModule(Buffer.from(`${source}// data\n`), { via: "data" });
  assert.match(String(viaData.url), /^data:text\/javascript;base64,/);
  // A module that fails to load fails the same way either way.
  await assert.rejects(importVerifiedModule(Buffer.from("this is not javascript")));
  await assert.rejects(importVerifiedModule(Buffer.from("this is not javascript"), { via: "data" }));
});

/** The receipt payload without what differs between two runs (time, ids, the agent's signature over them). */
function stable(payload) {
  const p = structuredClone(payload);
  delete p.timestamp;
  delete p.intent_hash;
  delete p.action_ref;
  delete p.authorization;
  delete p.intent.params.action_group;
  return p;
}

// One folder (keys, policy) for every run, so only what a run itself makes can differ.
const runtimeDir = (() => { const d = mkdtempSync(join(tmpdir(), "sb-intel-rt-")); scaffold(d, ENFORCE); return d; })();

async function receiptsFor(intel) {
  const dir = runtimeDir;
  const runtime = createHookRuntime({
    policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"), attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db"),
    ...(intel === undefined ? {} : { intel }),
  });
  try {
    const decision = await runtime.evaluate(mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "ls -la" } }));
    const { attester } = loadOrCreateAttester({ file: join(dir, "attester.key") });
    for (const r of decision.receipts) assert.equal(verifyReceipt(r, attester.publicKeyPem).valid, true);
    return decision.receipts;
  } finally { runtime.close(); }
}

test("the runtime: without a plugin receipts carry no new member and equal today's; with one, exactly the two members are added", async () => {
  const [today] = await receiptsFor(undefined);
  const [none] = await receiptsFor(null);
  assert.equal("pattern_id" in none.payload || "intel" in none.payload, false);
  assert.deepEqual(Object.keys(none.payload).sort(), Object.keys(today.payload).sort());
  assert.equal(canonical(stable(none.payload)), canonical(stable(today.payload)));
  const plugin = pluginFrom("1.0.0", (a) => ({ pattern_id: PATTERN, slot: Buffer.from(a.action_type).toString("base64") }), INTEL_BUDGET_MS, () => 0);
  const [slotted] = await receiptsFor(plugin);
  const { pattern_id, intel, ...rest } = slotted.payload;
  assert.equal(pattern_id, PATTERN);
  assert.equal(Buffer.from(intel, "base64").toString(), slotted.payload.intent.action_type);
  assert.equal(canonical(stable(rest)), canonical(stable(today.payload)));
});

function runHook(cwd, h, input, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, "claude"], {
      cwd,
      env: { ...process.env, SCOPEBOND_HOOK_DIR: cwd, SCOPEBOND_HOME: h, HOME: h, USERPROFILE: h, SCOPEBOND_POLICY_SYNC: "off", SCOPEBOND_OBSERVATIONS_HEARTBEAT: "off", ...env },
    });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; }); child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

async function storedReceipts(dir) {
  const { store } = openReceiptStore({ db: join(dir, "receipts.db") });
  try { return await Promise.resolve(store.list()); } finally { await Promise.resolve(store.close?.()); }
}

test("the hook process loads a signed module from its home and signs its answer into the receipt", async () => {
  const key = testKey();
  const h = home();
  installModule(h, MODULE, key);
  const dir = mkdtempSync(join(tmpdir(), "sb-intel-cli-"));
  scaffold(dir, ENFORCE);
  const input = { hook_event_name: "PreToolUse", session_id: "s1", cwd: dir, tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "call-1" };
  const run = await runHook(dir, h, input, { SCOPEBOND_POLICY_KEYS_JSON: JSON.stringify([key.entry]) });
  assert.equal(run.status, 0, run.stderr);
  // Loading the module prints nothing into the agent's transcript (no Node warning about how it is loaded).
  assert.doesNotMatch(run.stderr, /Warning/, run.stderr);
  const receipts = await storedReceipts(dir);
  assert.ok(receipts.length > 0);
  for (const r of receipts) {
    assert.equal(r.payload.pattern_id, PATTERN);
    assert.equal(Buffer.from(r.payload.intel, "base64").toString(), r.payload.intent.action_type);
  }
  // The same home without the key that signed it: no plugin, no members.
  const other = mkdtempSync(join(tmpdir(), "sb-intel-cli-"));
  scaffold(other, ENFORCE);
  const plain = await runHook(other, h, { ...input, cwd: other });
  assert.equal(plain.status, 0, plain.stderr);
  for (const r of await storedReceipts(other)) assert.equal("pattern_id" in r.payload || "intel" in r.payload, false);
});
