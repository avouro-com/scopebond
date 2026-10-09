// Key, credential and evidence files are readable by their owner alone from their first byte, in a folder that other local
// users can open (a checkout under a shared drive, a server folder outside any profile): the keys, the binding key, the
// chain heads, the receipt and dispatch databases and the journal files SQLite keeps beside them. Files an older version
// left there are restricted when they are next opened. Processes that create a key at the same moment agree on one key.
// On Windows the check is the file's access list (only this user and SYSTEM); elsewhere it is the file mode (no group or
// other access).
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createGateway } from "../dist/index.js";
import { DispatchStore, FileReceiptStore, ensurePrivateDir, keepOwnerOnly, loadOrCreateAttester, loadOrCreateHexKey, openReceiptStore, ownerOnlyState, recordChainHead } from "../dist/node.js";

const windows = process.platform === "win32";
// The record of files restricted one by one goes to this run's own folder, not this computer's.
process.env.LOCALAPPDATA = mkdtempSync(join(tmpdir(), "sb-owner-only-appdata-"));
const self = (process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : String(process.env.USERNAME)).toLowerCase();

/** The principals other than this user and SYSTEM that may open `path` (Windows), or whether group/others have any access. */
function others(path) {
  if (!windows) return (statSync(path).mode & 0o077) === 0 ? [] : [`mode ${(statSync(path).mode & 0o777).toString(8)}`];
  const lines = execFileSync("icacls", [path], { encoding: "utf8" }).split(/\r?\n/);
  lines[0] = lines[0].slice(path.length);
  return lines.map((l) => l.trim()).filter((l) => l.includes(":("))
    .map((l) => l.slice(0, l.indexOf(":(")).toLowerCase())
    .filter((name) => name !== self && !/(^|\\)system$/.test(name));
}

/** A folder other local users may open and change, as on many machines outside the user profile. */
function sharedFolder(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  // *S-1-5-11 is Authenticated Users.
  if (windows) execFileSync("icacls", [dir, "/grant", "*S-1-5-11:(OI)(CI)M"], { stdio: "ignore" });
  else chmodSync(dir, 0o755);
  return dir;
}

const policy = { vocabulary_version: "1.0", policy_id: "p", version: 1, clauses: [{ id: "a", type: "action_allowlist", mode: "enforce", action_types: ["x.y"] }] };
const head = { head: { type: "scopebond:chain-head", version: 1, anchor_id: "a".repeat(64), ingest_seq: 1, segment: null, issued_at: "2026-10-09T00:00:00.000Z" }, signed: false, signature: null };
const newPem = () => generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();

test("keys, chain heads, databases and their journal files are owner-only in a folder other users can open", async () => {
  const dir = sharedFolder("sb-owner-only-");
  assert.notDeepEqual(others(dir), [], "the folder itself is open to other users");
  loadOrCreateAttester({ file: join(dir, "scopebond-attester.key") });
  const { store } = openReceiptStore({ db: join(dir, "scopebond.db") });
  const gw = createGateway({ policy, authentication: { mode: "insecure-development" }, store });
  await gw.handleAction({ intent: { action_type: "x.y", params: { note: "evidence row" } } });
  const dispatch = new DispatchStore(join(dir, "dispatch.db"));
  loadOrCreateHexKey(join(dir, "observation-binding.key"));
  recordChainHead(join(dir, "chain-heads.json"), head);
  const log = new FileReceiptStore(join(dir, "receipts.jsonl"));
  log.setStopped("global", true);
  try {
    const files = ["scopebond-attester.key", "scopebond.db", "scopebond.db-wal", "scopebond.db-shm", "dispatch.db", "dispatch.db-wal", "dispatch.db-shm",
      "observation-binding.key", "chain-heads.json", "receipts.jsonl.stops"];
    const open = files.filter((f) => existsSync(join(dir, f))).map((f) => ({ file: f, others: others(join(dir, f)) })).filter((r) => r.others.length);
    assert.ok(existsSync(join(dir, "scopebond.db-wal")) && existsSync(join(dir, "dispatch.db")), "the databases and a journal file exist");
    assert.deepEqual(open, [], "every file is readable by its owner alone");
  } finally {
    store.close?.(); dispatch.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("files an older version made in such a folder are restricted when they are next opened", () => {
  const dir = sharedFolder("sb-upgraded-");
  // What an older version left: files under the folder's access list (on POSIX, readable by others).
  for (const [file, text] of [["scopebond-attester.key", newPem()], ["scopebond-agent.key", newPem()], ["observation-binding.key", randomBytes(32).toString("hex")], ["receipts.jsonl", ""]]) {
    writeFileSync(join(dir, file), text, { mode: 0o644 });
  }
  const old = new DatabaseSync(join(dir, "scopebond.db")); old.exec("CREATE TABLE t (x)"); old.close();
  if (!windows) chmodSync(join(dir, "scopebond.db"), 0o644);
  const a = loadOrCreateAttester({ file: join(dir, "scopebond-attester.key") });
  const b = loadOrCreateAttester({ file: join(dir, "scopebond-agent.key") });
  assert.deepEqual([a.created, b.created], [false, false], "the existing keys are used");
  loadOrCreateHexKey(join(dir, "observation-binding.key"));
  const { store } = openReceiptStore({ db: join(dir, "scopebond.db") });
  new FileReceiptStore(join(dir, "receipts.jsonl"));
  try {
    const files = ["scopebond-attester.key", "scopebond-agent.key", "observation-binding.key", "scopebond.db", "scopebond.db-wal", "scopebond.db-shm", "receipts.jsonl"];
    const open = files.filter((f) => existsSync(join(dir, f))).map((f) => ({ file: f, others: others(join(dir, f)) })).filter((r) => r.others.length);
    assert.deepEqual(open, [], "every file made before is now readable by its owner alone");
  } finally {
    store.close?.();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

// Captures, inside the process that makes the key, who could open the file the private key was written to, right after
// the write: the file a polling reader would find.
const PRELOAD = `
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");
const original = fs.writeFileSync;
fs.writeFileSync = function (target, data, ...rest) {
  const result = original.call(fs, target, data, ...rest);
  if (typeof target === "string" && String(data).includes("PRIVATE KEY")) {
    fs.appendFileSync(process.env.KEY_ACL_LOG, JSON.stringify({ target, acl: execFileSync("icacls", [target], { encoding: "utf8" }) }) + "\\n");
  }
  return result;
};
syncBuiltinESMExports();
`;

test("a new private key is never on disk under the folder's access list", { skip: !windows && "the access list is a Windows concern (POSIX creates the file 0600)" }, () => {
  const dir = sharedFolder("sb-key-window-");
  const work = mkdtempSync(join(tmpdir(), "sb-key-window-work-"));
  try {
    const preload = join(work, "preload.cjs"); writeFileSync(preload, PRELOAD);
    const log = join(work, "acl.log"); writeFileSync(log, "");
    const script = join(work, "make-key.mjs");
    writeFileSync(script, `import { loadOrCreateAttester } from ${JSON.stringify(new URL("../dist/node.js", import.meta.url).href)};
loadOrCreateAttester({ file: ${JSON.stringify(join(dir, "scopebond-attester.key"))} });`);
    execFileSync(process.execPath, ["--require", preload, script], { env: { ...process.env, KEY_ACL_LOG: log } });
    const writes = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(writes.length >= 1, "the key was written");
    for (const w of writes) {
      assert.doesNotMatch(w.acl, /Authenticated Users|BUILTIN\\Users|Everyone/, `the key's first bytes sat in a file others could open: ${w.acl}`);
    }
    assert.deepEqual(others(join(dir, "scopebond-attester.key")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    rmSync(work, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("a key file another process has claimed but not yet filled is waited for, not replaced", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-key-claimed-"));
  try {
    const file = join(dir, "observation-binding.key");
    const theirs = randomBytes(32).toString("hex");
    writeFileSync(file, ""); // the other process has created the file and is about to write its key
    const worker = new Worker(`
      const { workerData } = require("node:worker_threads");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60);
      require("node:fs").writeFileSync(workerData.file, workerData.key + "\\n");`, { eval: true, workerData: { file, key: theirs } });
    const got = loadOrCreateHexKey(file);
    await new Promise((resolve) => worker.once("exit", resolve));
    assert.equal(got, theirs, "the key the other process wrote is used");
    assert.equal(readFileSync(file, "utf8").trim(), theirs);
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); }
});

test("processes creating a key at the same moment all end up with the same key", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-key-race-"));
  try {
    const node = new URL("../dist/node.js", import.meta.url).href;
    const worker = join(dir, "worker.mjs");
    // Each process takes part in every round; a round starts at the same wall-clock moment in all of them.
    writeFileSync(worker, `import { loadOrCreateAttester, loadOrCreateHexKey } from ${JSON.stringify(node)};
const [dir, start, rounds] = [process.argv[2], Number(process.argv[3]), Number(process.argv[4])];
const out = [];
for (let r = 0; r < rounds; r++) {
  while (Date.now() < start + r * 150) { /* wait for the round */ }
  let hex, kid;
  try { hex = loadOrCreateHexKey(dir + "/hex-" + r + ".key"); } catch (e) { hex = "error: " + e.message; }
  try { kid = loadOrCreateAttester({ file: dir + "/pem-" + r + ".key" }).attester.kid; } catch (e) { kid = "error: " + e.message; }
  out.push({ hex, kid });
}
process.stdout.write(JSON.stringify(out));`);
    const processes = 8, rounds = 10;
    const start = Date.now() + 1_500;
    const results = await Promise.all(Array.from({ length: processes }, () => new Promise((resolve) => {
      const p = spawn(process.execPath, [worker, dir, String(start), String(rounds)], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "", err = ""; p.stdout.on("data", (d) => { out += d; }); p.stderr.on("data", (d) => { err += d; });
      p.on("close", () => { try { resolve(JSON.parse(out)); } catch { resolve(Array.from({ length: rounds }, () => ({ hex: `crashed: ${err.slice(0, 200)}`, kid: "crashed" }))); } });
    })));
    const disagreements = [];
    for (let r = 0; r < rounds; r++) {
      const hex = new Set(results.map((p) => p[r].hex)), kid = new Set(results.map((p) => p[r].kid));
      if (hex.size > 1 || kid.size > 1 || [...hex, ...kid].some((v) => /error|crashed/.test(v))) disagreements.push({ round: r, hex: [...hex], kid: [...kid] });
      else assert.equal(readFileSync(join(dir, `hex-${r}.key`), "utf8").trim(), [...hex][0], "the key on disk is the one every process uses");
    }
    assert.deepEqual(disagreements, [], "every round converged on one key");
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); }
});

/** Windows: a folder this user may fill but whose own access list it may not change (OWNER RIGHTS limits the owner there to
 *  Modify), open to other users too, as for a folder an installer or an administrator made. Null where this user can change it
 *  all the same (an elevated administrator), so the case cannot be set up there. */
function folderWithoutAccessChanges(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("icacls", [dir, "/inheritance:r", "/grant:r", `${self}:(OI)(CI)M`, "*S-1-5-11:(OI)(CI)M", "*S-1-5-18:(OI)(CI)F", "*S-1-3-4:M"], { stdio: "ignore" });
  try { execFileSync("icacls", [dir, "/grant", "*S-1-5-18:(OI)(CI)F"], { stdio: "ignore" }); } catch { return dir; }
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  return null;
}

test("a folder whose own access cannot be changed: every file in it is still restricted on its own", { skip: !windows && "Windows access lists" }, (t) => {
  const dir = folderWithoutAccessChanges("sb-no-dac-");
  if (!dir) { t.skip("this user can change any folder's access list here (an elevated administrator)"); return; }
  try {
    assert.notEqual(ensurePrivateDir(dir), null, "the folder cannot be made private");
    assert.equal(ownerOnlyState(dir), "per-file", "status and doctor can say so");
    loadOrCreateAttester({ file: join(dir, "attester.key") });
    loadOrCreateHexKey(join(dir, "binding.key"));
    writeFileSync(join(dir, "cloud.json"), "{}\n"); // a credential an older version left
    keepOwnerOnly(join(dir, "cloud.json"));
    const { store } = openReceiptStore({ db: join(dir, "receipts.db") });
    const dispatch = new DispatchStore(join(dir, "dispatch.db"));
    try {
      const files = ["attester.key", "binding.key", "cloud.json", "receipts.db", "receipts.db-wal", "receipts.db-shm", "dispatch.db", "dispatch.db-wal", "dispatch.db-shm"];
      const open = files.filter((f) => existsSync(join(dir, f))).map((f) => ({ file: f, others: others(join(dir, f)) })).filter((r) => r.others.length);
      assert.ok(existsSync(join(dir, "receipts.db")) && existsSync(join(dir, "dispatch.db")));
      assert.deepEqual(open, [], "every file is readable by its owner alone");
    } finally { store.close?.(); dispatch.close(); }
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); }
});

test("outside a private folder a file is restricted once, not every time a process opens it", { skip: !windows && "icacls is Windows-only (POSIX restricts with a chmod)" }, () => {
  const dir = sharedFolder("sb-restrict-once-");
  const work = mkdtempSync(join(tmpdir(), "sb-restrict-once-work-"));
  try {
    // One start of a process that opens a key, a binding key and a credential: how many icacls runs it made.
    const script = join(work, "start.mjs");
    writeFileSync(script, `import { createRequire, syncBuiltinESMExports } from "node:module";
const cp = createRequire(import.meta.url)("node:child_process");
const original = cp.execFileSync;
let runs = 0;
cp.execFileSync = function (file, ...rest) { if (/icacls/i.test(String(file))) runs++; return original.call(this, file, ...rest); };
syncBuiltinESMExports();
const { keepOwnerOnly, loadOrCreateAttester, loadOrCreateHexKey } = await import(${JSON.stringify(new URL("../dist/node.js", import.meta.url).href)});
const dir = process.argv[2];
loadOrCreateAttester({ file: dir + "/attester.key" });
loadOrCreateHexKey(dir + "/binding.key");
keepOwnerOnly(dir + "/cloud.json");
process.stdout.write(String(runs));`);
    writeFileSync(join(dir, "cloud.json"), "{}\n"); // a credential an older version left
    const env = { ...process.env, LOCALAPPDATA: join(work, "appdata") };
    const start = () => Number(execFileSync(process.execPath, [script, dir], { encoding: "utf8", env }));
    assert.ok(start() > 0, "the first start restricts the files");
    assert.equal(start(), 0, "a later start finds them restricted");
    assert.equal(start(), 0);
    assert.deepEqual(["attester.key", "binding.key", "cloud.json"].map((f) => others(join(dir, f))).flat(), [], "and they are owner-only");
    // A file replaced by another is a new file: it is restricted again.
    rmSync(join(dir, "cloud.json"));
    writeFileSync(join(dir, "cloud.json"), "{}\n");
    assert.equal(start(), 1);
    assert.deepEqual(others(join(dir, "cloud.json")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    rmSync(work, { recursive: true, force: true, maxRetries: 5 });
  }
});
