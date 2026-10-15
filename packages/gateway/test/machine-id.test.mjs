// The machine id: its form and the shared test vectors, each OS reader with made-up command and file output, the kept
// copy and its scope, and where it travels (the enrollment body and the delivery header). Nothing here reads this
// computer's own id.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  completeCloudEnrollment, createCloudExporter, createMemoryCloudOutbox, createWebCryptoAttester, generateAttesterJwk,
  isMachineId, machineIdHeaders, resolveMachineId, MACHINE_ID_HEADER, MACHINE_ID_UNSCOPED,
} from "../dist/index.js";
import {
  cachedMachineId, computeMachineId, machineIdScope, normalizeRawMachineId, parseIoregPlatformUuid, parseRegQueryMachineGuid,
  readRawMachineId, LINUX_MACHINE_ID_FILES, MACHINE_ID_RECHECK_MS, MACOS_IOREG,
} from "../dist/node.js";

const vectors = JSON.parse(readFileSync(new URL("./machine-id-vectors.json", import.meta.url), "utf8")).vectors;
const RAW = "8f14e45f-ceea-467a-9575-0b3b0d6c4e2a";
const PATTERN = /^m1:[A-Za-z0-9_-]{43}$/;

test("the shared test vectors (the Rust tray checks the same file)", () => {
  assert.ok(vectors.length >= 4);
  for (const v of vectors) {
    assert.equal(computeMachineId(v.raw, v.scope), v.machine_id, JSON.stringify(v.raw) + " in " + v.scope);
    assert.match(v.machine_id, PATTERN);
    assert.ok(isMachineId(v.machine_id));
  }
});

test("the form: m1: and 43 base64url characters, scoped, and never the raw id", () => {
  const unscoped = computeMachineId(RAW);
  assert.match(unscoped, PATTERN);
  assert.equal(unscoped, computeMachineId(RAW, MACHINE_ID_UNSCOPED), "no scope means unscoped");
  assert.equal(computeMachineId(RAW, null), unscoped);
  assert.notEqual(computeMachineId(RAW, "org_a"), unscoped, "the scope changes the id");
  assert.notEqual(computeMachineId(RAW, "org_a"), computeMachineId(RAW, "org_b"), "each workspace sees a different id");
  assert.equal(computeMachineId(RAW.toUpperCase(), "org_a"), computeMachineId(` ${RAW}\n`, "org_a"), "trimmed and lowercased");
  assert.ok(!unscoped.includes(RAW) && !unscoped.toLowerCase().includes(RAW.slice(0, 8)));
  for (const bad of [undefined, null, 42, "", "   ", "uninitialized", "a\nb", "x".repeat(300)]) {
    assert.equal(normalizeRawMachineId(bad), null, JSON.stringify(bad));
    if (typeof bad === "string") assert.equal(computeMachineId(bad, "org_a"), null);
  }
  for (const odd of [undefined, null, 7, "", "  ", "org\nx", "x".repeat(300)]) assert.equal(machineIdScope(odd), MACHINE_ID_UNSCOPED);
  assert.equal(machineIdScope("org_a"), "org_a");
  for (const notOne of ["", "m1:short", `m2:${"a".repeat(43)}`, `m1:${"a".repeat(43)}=`, `m1:${"a".repeat(42)}+`, null, 1]) assert.equal(isMachineId(notOne), false);
});

test("Windows: MachineGuid from `reg query` of the 64-bit registry, by the system folder's reg.exe", () => {
  const calls = [];
  const output = "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    8F14E45F-CEEA-467A-9575-0B3B0D6C4E2A\r\n\r\n";
  const raw = readRawMachineId({ platform: "win32", env: { SystemRoot: "C:\\Windows" }, run: (file, args) => { calls.push([file, args]); return output; } });
  assert.equal(raw, RAW);
  assert.deepEqual(calls, [["C:\\Windows\\System32\\reg.exe", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid", "/reg:64"]]]);
  assert.equal(parseRegQueryMachineGuid("ERROR: The system was unable to find the specified registry key or value."), null);
  assert.equal(parseRegQueryMachineGuid("    MachineGuid    REG_SZ    \r\n"), null);
  assert.equal(readRawMachineId({ platform: "win32", run: () => { throw new Error("reg failed"); } }), null);
});

test("macOS: IOPlatformUUID from ioreg", () => {
  const calls = [];
  const output = `+-o J314sAP  <class IOPlatformExpertDevice, id 0x100000110, registered, matched, active, busy 0 (12 ms), retain 39>
    {
      "IOPlatformSerialNumber" = "C02XXXXXXXXX"
      "IOPlatformUUID" = "8F14E45F-CEEA-467A-9575-0B3B0D6C4E2A"
      "IOPolledInterface" = "AppleARMWatchdogTimerHibernateHandler is not serializable"
    }
`;
  assert.equal(readRawMachineId({ platform: "darwin", run: (file, args) => { calls.push([file, args]); return output; } }), RAW);
  assert.deepEqual(calls, [[MACOS_IOREG, ["-rd1", "-c", "IOPlatformExpertDevice"]]]);
  assert.equal(parseIoregPlatformUuid('"IOPlatformSerialNumber" = "C02XXXXXXXXX"'), null);
  assert.equal(readRawMachineId({ platform: "darwin", run: () => { throw new Error("no ioreg"); } }), null);
});

test("Linux: /etc/machine-id, else /var/lib/dbus/machine-id", () => {
  const files = (map) => (path) => { if (path in map) return map[path]; throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); };
  const id = "0123456789ABCDEF0123456789ABCDEF\n";
  assert.deepEqual([...LINUX_MACHINE_ID_FILES], ["/etc/machine-id", "/var/lib/dbus/machine-id"]);
  assert.equal(readRawMachineId({ platform: "linux", readFile: files({ "/etc/machine-id": id, "/var/lib/dbus/machine-id": "ffff" }) }), id.trim().toLowerCase());
  assert.equal(readRawMachineId({ platform: "linux", readFile: files({ "/var/lib/dbus/machine-id": id }) }), id.trim().toLowerCase(), "the D-Bus copy when the first is missing");
  assert.equal(readRawMachineId({ platform: "linux", readFile: files({ "/etc/machine-id": "\n", "/var/lib/dbus/machine-id": id }) }), id.trim().toLowerCase(), "an empty file does not count");
  assert.equal(readRawMachineId({ platform: "linux", readFile: files({ "/etc/machine-id": "uninitialized\n" }) }), null, "nor does a first boot's placeholder");
});

test("no machine id: nothing to send, and never a host name or address instead", () => {
  const nothing = { run: () => { throw new Error("unavailable"); }, readFile: () => { throw new Error("ENOENT"); } };
  for (const platform of ["win32", "darwin", "linux", "freebsd", "aix"]) assert.equal(readRawMachineId({ ...nothing, platform }), null, platform);
  assert.deepEqual(machineIdHeaders(null), {});
  assert.deepEqual(machineIdHeaders(() => null), {});
  assert.deepEqual(machineIdHeaders(() => { throw new Error("boom"); }), {});
  assert.deepEqual(machineIdHeaders("not-a-machine-id"), {});
  const id = computeMachineId(RAW, "org_a");
  assert.deepEqual(machineIdHeaders(id), { [MACHINE_ID_HEADER]: id });
  assert.equal(resolveMachineId(() => id), id);
});

test("kept with its scope: computed once, again when the workspace becomes known, and kept to that workspace", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-machine-id-"));
  try {
    const file = join(dir, "machine-id.json");
    let reads = 0;
    const readers = { platform: "linux", readFile: () => { reads += 1; return RAW + "\n"; } };
    let at = 1_000_000;
    const opts = { readers, now: () => at };
    const unscoped = cachedMachineId(file, null, opts);
    assert.equal(unscoped, computeMachineId(RAW, MACHINE_ID_UNSCOPED));
    assert.equal(cachedMachineId(file, undefined, opts), unscoped);
    assert.equal(reads, 1, "the second call used the kept copy");
    const text = readFileSync(file, "utf8");
    assert.ok(!text.toLowerCase().includes(RAW) && !text.includes(RAW.slice(0, 8)), "the raw id is never written");
    assert.deepEqual(JSON.parse(text), { version: 1, scope: "unscoped", machine_id: unscoped, checked_at: at });

    // Enrolled: the workspace's id is known now, so the id is worked out again in its scope.
    const scoped = cachedMachineId(file, "org_a", opts);
    assert.equal(scoped, computeMachineId(RAW, "org_a"));
    assert.equal(reads, 2);
    // Later calls that do not know the workspace keep using its scope.
    assert.equal(cachedMachineId(file, null, opts), scoped);
    assert.equal(reads, 2);
    // A day later it is read again (a copied folder does not keep another computer's id).
    at += MACHINE_ID_RECHECK_MS;
    assert.equal(cachedMachineId(file, null, opts), scoped);
    assert.equal(reads, 3);
    // A different workspace gets its own id.
    assert.equal(cachedMachineId(file, "org_b", opts), computeMachineId(RAW, "org_b"));

    // A damaged file is worked out again, not trusted.
    writeFileSync(file, JSON.stringify({ version: 1, scope: "unscoped", machine_id: "m1:forged", checked_at: at }));
    assert.equal(cachedMachineId(file, null, opts), computeMachineId(RAW, MACHINE_ID_UNSCOPED));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("no machine id is kept as none for a day, then tried again", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-machine-id-"));
  try {
    const file = join(dir, "machine-id.json");
    let tries = 0;
    let found = false;
    let at = 5_000;
    const readers = { platform: "linux", readFile: () => { tries += 1; if (!found) throw new Error("ENOENT"); return RAW; } };
    assert.equal(cachedMachineId(file, "org_a", { readers, now: () => at }), null);
    assert.equal(cachedMachineId(file, "org_a", { readers, now: () => at + 1000 }), null);
    assert.equal(tries, LINUX_MACHINE_ID_FILES.length, "not tried again within the day");
    found = true;
    at += MACHINE_ID_RECHECK_MS;
    assert.equal(cachedMachineId(file, "org_a", { readers, now: () => at }), computeMachineId(RAW, "org_a"));
    // A file that cannot be written still gives the id.
    assert.equal(cachedMachineId(join(dir, "missing-folder", "machine-id.json"), "org_a", { readers, now: () => at }), computeMachineId(RAW, "org_a"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const proof = '{"challenge":"challenge_abc","enrollment_id":"enrollment-1","type":"scopebond:gateway-enrollment","version":1}';
async function enrollWith(machineId) {
  const attester = await createWebCryptoAttester(await generateAttesterJwk());
  let submitted;
  await completeCloudEnrollment({
    url: "https://cloud.scopebond.test", bundle: { enrollment_token: "sbe_test-token", proof_canonical: proof }, attester, machineId,
    fetch: async (_url, init) => {
      submitted = JSON.parse(init.body);
      return new Response(JSON.stringify({
        credential_id: "credential-1", credential: "sbm_scoped-secret", organization_id: "org-1", environment_id: "env-1",
        gateway_id: "gateway-1", attester_kid: attester.kid, scopes: ["receipt:ingest"], expires_at: "2099-01-01T00:00:00.000Z",
      }), { status: 201 });
    },
  });
  return submitted;
}

test("enrollment carries machine_id in its body, and nothing without one", async () => {
  const id = computeMachineId(RAW, "unscoped");
  assert.equal((await enrollWith(id)).machine_id, id);
  assert.equal((await enrollWith(() => id)).machine_id, id);
  for (const none of [undefined, null, () => null, "m1:not-valid"]) assert.ok(!("machine_id" in (await enrollWith(none))), String(none));
});

const receipt = (id) => ({ payload: { action_ref: { action_id: id }, value: 1, timestamp: new Date().toISOString() }, signature: { alg: "Ed25519", sig: "fixture" } });
async function deliveryHeaders(machineId) {
  const seen = [];
  const ex = createCloudExporter({
    url: "https://cloud.scopebond.test", credential: "sbm_machine", outbox: createMemoryCloudOutbox(), flushMs: 1e9, machineId,
    fetch: async (url, init) => { seen.push({ url: String(url), headers: init.headers }); return new Response(JSON.stringify({ accepted: 1 }), { status: 200 }); },
  });
  try {
    ex.enqueue(receipt("action:machine-id-0001"));
    await ex.flush();
  } finally { ex.stop(); }
  assert.ok(seen.length >= 1);
  assert.equal(seen[0].url, "https://cloud.scopebond.test/v1/ingest");
  return seen[0].headers;
}

test("each delivery carries the x-scopebond-machine-id header, and none without an id", async () => {
  const id = computeMachineId(RAW, "org_a");
  assert.equal((await deliveryHeaders(id))[MACHINE_ID_HEADER], id);
  assert.equal((await deliveryHeaders(() => id))[MACHINE_ID_HEADER], id);
  for (const none of [undefined, null, () => null]) assert.ok(!(MACHINE_ID_HEADER in (await deliveryHeaders(none))));
});
