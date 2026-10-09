// The proxy keeps its signing key, its binding key (`<key>.binding`), its Cloud credential (`<key>.cloud.json`) and its
// delivery queue beside the key, often in a project folder other local users can open. Each is readable by its owner
// alone from its first byte, a credential file an older version wrote is restricted when it is read, the credential write
// replaces a link at its name instead of writing through it, and proxies that start together agree on one binding key.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { chmodSync, existsSync, linkSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Worker } from "node:worker_threads";
import { randomBytes } from "node:crypto";
import { loadOrCreateAttester } from "@scopebond/gateway/node";
import { connectCloud, connectionFileFor, loadMcpConnection, openExporter } from "../dist/index.js";
import { loadOrCreateHexKey } from "../dist/key-file.js";

const windows = process.platform === "win32";
const self = (process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : String(process.env.USERNAME)).toLowerCase();

/** Who besides this user and SYSTEM may open `path` (Windows: its ACL; elsewhere: group or other mode bits). */
function others(path) {
  if (!windows) return (statSync(path).mode & 0o077) === 0 ? [] : [`mode ${(statSync(path).mode & 0o777).toString(8)}`];
  const lines = execFileSync("icacls", [path], { encoding: "utf8" }).split(/\r?\n/);
  lines[0] = lines[0].slice(path.length);
  return lines.map((l) => l.trim()).filter((l) => l.includes(":("))
    .map((l) => l.slice(0, l.indexOf(":(")).toLowerCase())
    .filter((name) => name !== self && !/(^|\\)system$/.test(name));
}

function sharedFolder(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  // *S-1-5-11 is Authenticated Users.
  if (windows) execFileSync("icacls", [dir, "/grant", "*S-1-5-11:(OI)(CI)M"], { stdio: "ignore" });
  else chmodSync(dir, 0o755);
  return dir;
}

function startFakeCloud(attesterKid) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.url === "/v1/enroll") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ credential_id: "cred-1", credential: "sbm_mcp_credential", organization_id: "org-1", environment_id: "env-1",
          gateway_id: "gw-1", attester_kid: attesterKid, scopes: ["ingest"], expires_at: "2027-01-01T00:00:00.000Z" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }); res.end("{\"ok\":true}");
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}
const bundle = {
  enrollment_token: "sbe_test_owner_only",
  proof_canonical: JSON.stringify({ challenge: "c1", enrollment_id: "e1", type: "scopebond:gateway-enrollment", version: 1 }),
  expires_at: "2027-01-01T00:00:00.000Z",
};

test("the proxy's keys, credential and delivery queue are owner-only beside a key in a folder others can open", async () => {
  const dir = sharedFolder("sb-mcp-owner-only-");
  const keyPath = join(dir, "scopebond-agent.key");
  const { attester } = loadOrCreateAttester({ file: keyPath });
  loadOrCreateHexKey(`${keyPath}.binding`);
  const cloud = await startFakeCloud(attester.kid);
  let exporter;
  try {
    const connection = await connectCloud(keyPath, cloud.url, bundle);
    exporter = openExporter(keyPath, connection);
    const files = [keyPath, `${keyPath}.binding`, connectionFileFor(keyPath), `${keyPath}.cloud-outbox.db`, `${keyPath}.cloud-outbox.db-wal`, `${keyPath}.cloud-outbox.db-shm`];
    const open = files.filter((f) => existsSync(f)).map((f) => ({ file: f, others: others(f) })).filter((r) => r.others.length);
    assert.ok(existsSync(`${keyPath}.cloud-outbox.db`));
    assert.deepEqual(open, []);
  } finally {
    exporter?.stop?.();
    cloud.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("a credential file an older version wrote is restricted when the proxy reads it", () => {
  const dir = sharedFolder("sb-mcp-older-");
  const keyPath = join(dir, "scopebond-agent.key");
  writeFileSync(connectionFileFor(keyPath), JSON.stringify({ url: "https://cloud.example.com", credential: "sbm_older" }), { mode: 0o644 });
  try {
    assert.equal(loadMcpConnection(keyPath)?.credential, "sbm_older");
    assert.deepEqual(others(connectionFileFor(keyPath)), []);
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); }
});

test("connect replaces a link at the credential file instead of writing the credential through it", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sb-mcp-link-"));
  const keyPath = join(dir, "scopebond-agent.key");
  const { attester } = loadOrCreateAttester({ file: keyPath });
  const victim = join(dir, "victim.txt");
  writeFileSync(victim, "placeholder\n");
  try { linkSync(victim, connectionFileFor(keyPath)); } catch { t.skip("hard links are not available here"); return; }
  const cloud = await startFakeCloud(attester.kid);
  try {
    await connectCloud(keyPath, cloud.url, bundle);
    assert.equal(readFileSync(victim, "utf8"), "placeholder\n");
    assert.match(readFileSync(connectionFileFor(keyPath), "utf8"), /sbm_mcp_credential/);
    assert.notEqual(lstatSync(connectionFileFor(keyPath)).ino, lstatSync(victim).ino);
  } finally { cloud.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); }
});

test("a binding key another proxy has claimed but not yet written is waited for, not replaced", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-mcp-claimed-"));
  try {
    const file = join(dir, "scopebond-agent.key.binding");
    const theirs = randomBytes(32).toString("hex");
    writeFileSync(file, "");
    const worker = new Worker(`
      const { workerData } = require("node:worker_threads");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60);
      require("node:fs").writeFileSync(workerData.file, workerData.key + "\\n");`, { eval: true, workerData: { file, key: theirs } });
    const got = loadOrCreateHexKey(file);
    await new Promise((resolve) => worker.once("exit", resolve));
    assert.equal(got, theirs);
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); }
});
