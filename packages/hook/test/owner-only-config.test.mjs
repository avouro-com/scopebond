// The hook's folder holds the machine credential (cloud.json), the signing keys, the digest and binding keys and the
// receipt log: it is readable by this user alone, so every file in it is owner-only from its first byte (the journal files
// SQLite creates included), and files an older version left there are restricted on the hook's next run. The credential
// write replaces whatever is at cloud.json, a link included, instead of writing through it. On Windows the check is each
// file's ACL (only this user and SYSTEM); elsewhere it is the folder's mode (no group or other access).
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, linkSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { canonical } from "@scopebond/gateway";
import { startFakeCloud } from "@scopebond/fake-cloud";
import { scaffold, connectCloud, connectionPath, createHookRuntime, mapClaudeToolUse, loadOrCreateBindingKey } from "../dist/index.js";

const sandbox = mkdtempSync(join(tmpdir(), "sb-owner-only-home-"));
for (const k of ["HOME", "USERPROFILE", "SCOPEBOND_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) process.env[k] = sandbox;

const windows = process.platform === "win32";
const self = (process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : String(process.env.USERNAME)).toLowerCase();

/** Windows: the principals other than this user and SYSTEM in the ACL of `path`. */
function others(path) {
  const lines = execFileSync("icacls", [path], { encoding: "utf8" }).split(/\r?\n/);
  lines[0] = lines[0].slice(path.length);
  return lines.map((l) => l.trim()).filter((l) => l.includes(":("))
    .map((l) => l.slice(0, l.indexOf(":(")).toLowerCase())
    .filter((name) => name !== self && !/(^|\\)system$/.test(name));
}

/** A folder other local users may open and change, as for a checkout outside the user profile. */
function sharedFolder(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  // *S-1-5-11 is Authenticated Users.
  if (windows) execFileSync("icacls", [dir, "/grant", "*S-1-5-11:(OI)(CI)M"], { stdio: "ignore" });
  else chmodSync(dir, 0o755);
  return dir;
}

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? [join(dir, e.name), ...walk(join(dir, e.name))] : [join(dir, e.name)]);

/** Who besides this user can open the folder or anything in it. */
function openToOthers(dir) {
  if (!windows) return (statSync(dir).mode & 0o077) === 0 ? [] : [{ file: dir, mode: (statSync(dir).mode & 0o777).toString(8) }];
  return [dir, ...walk(dir)].map((file) => ({ file, others: others(file) })).filter((r) => r.others.length);
}

const bundle = {
  enrollment_token: "sbe_fake_owner_only",
  proof_canonical: canonical({ challenge: "c1", enrollment_id: "e1", type: "scopebond:gateway-enrollment", version: 1 }),
  expires_at: "2027-01-01T00:00:00.000Z",
};
const paths = (dir) => ({ policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"), attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db") });

test("connect replaces a file or link at cloud.json; the credential is never written through it", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sb-cloud-json-"));
  scaffold(dir);
  const victim = join(dir, "victim-cloud.txt");
  writeFileSync(victim, "placeholder\n");
  // A hard link stands in for a symlink or junction someone placed at the name: an open-for-write follows both.
  try { linkSync(victim, connectionPath(dir)); } catch { t.skip("hard links are not available here"); return; }
  const cloud = await startFakeCloud();
  try {
    const connection = await connectCloud(dir, cloud.url, bundle);
    assert.match(connection.credential, /^sbm_/);
    assert.equal(readFileSync(victim, "utf8"), "placeholder\n", "the credential did not reach the linked file");
    assert.ok(readFileSync(connectionPath(dir), "utf8").includes(connection.credential), "cloud.json holds the credential");
    assert.notEqual(lstatSync(connectionPath(dir)).ino, lstatSync(victim).ino, "cloud.json is a new file, not the linked one");
  } finally { await cloud.close?.(); }
});

test("set up in a folder other users can open, the credential, keys and receipt log are readable by this user alone", async () => {
  const dir = sharedFolder("sb-hook-setup-");
  const cloud = await startFakeCloud();
  let runtime;
  try {
    scaffold(dir);
    await connectCloud(dir, cloud.url, bundle);
    loadOrCreateBindingKey(dir);
    runtime = createHookRuntime(paths(dir));
    await runtime.evaluate(mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "git status" } }), { groupKey: "call-1" });
    // While the log is open its journal files are there too.
    assert.deepEqual(openToOthers(dir), []);
  } finally {
    runtime?.close();
    await cloud.close?.();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("a folder an older version set up is made readable by this user alone on the hook's next run", async () => {
  const template = mkdtempSync(join(tmpdir(), "sb-hook-template-"));
  scaffold(template);
  // What an older version left: its files under the folder's ACL (copies do not take the source's ACL), a credential, a
  // digest key and a receipt log.
  const dir = sharedFolder("sb-hook-upgraded-");
  for (const f of ["agent.key", "attester.key", "policy.json", "rules.json"]) copyFileSync(join(template, f), join(dir, f));
  writeFileSync(join(dir, "cloud.json"), JSON.stringify({ url: "https://cloud.example.com", credential: "sbm_us_older" }), { mode: 0o644 });
  writeFileSync(join(dir, "digest.key"), randomBytes(32).toString("hex") + "\n", { mode: 0o644 });
  const old = new DatabaseSync(join(dir, "receipts.db")); old.exec("CREATE TABLE t (x)"); old.close();
  let runtime;
  try {
    runtime = createHookRuntime(paths(dir));
    await runtime.evaluate(mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "git status" } }), { groupKey: "call-1" });
    assert.deepEqual(openToOthers(dir), []);
  } finally {
    runtime?.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    rmSync(template, { recursive: true, force: true, maxRetries: 5 });
  }
});
