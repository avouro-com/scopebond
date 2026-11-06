// The macOS package's updater: a person's agent asks for a version, the root updater installs it only when it is newer,
// allowed on this Mac, named by a manifest signed with an updater key, the package the manifest names, and signed by
// Avouro LLC's Developer ID Installer identity and notarized; the asking agent reads the result as on Windows. The
// release, the signature check and `installer` are stand-ins; every folder is temporary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  MAC_INSTALLER_PUBLISHER, MANIFEST_DOMAIN, failedUpdate, macAutoUpdate, macPackageName, noteUpdateOutcome, readMacUpdateResult, readUpdatePending,
  requestMacUpdate, runMacUpdater, takeMacUpdateResult, writeUpdatePending,
} = await import("../dist/index.js");

const NEW = "9.9.9";
const pkg = Buffer.from("a package's bytes");
const AVOURO = "Developer ID Installer: Avouro LLC (ABCDE12345)";
const keys = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { pub: publicKey.export({ type: "spki", format: "der" }).toString("base64"), priv: privateKey };
};
/** A release of `version` with its signed manifest naming this Mac's package; counts each download. */
function release(k, { version = NEW, bytes = pkg, digestOf = pkg } = {}) {
  const name = macPackageName(version);
  const text = `${JSON.stringify({ type: "scopebond:agent-release", version, files: [{ name, sha256: createHash("sha256").update(digestOf).digest("hex"), size: digestOf.length }] })}\n`;
  const files = { [`scopebond-agent-${version}.manifest.json`]: text, [`scopebond-agent-${version}.manifest.json.sig`]: sign(null, Buffer.from(MANIFEST_DOMAIN + text), k.priv).toString("base64"), [name]: bytes };
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const file = url.split("/").pop();
    return file in files ? new Response(files[file]) : new Response("not found", { status: 404 });
  };
  return { fetchImpl, calls };
}
function updater() {
  const root = mkdtempSync(join(tmpdir(), "sb-mac-updater-"));
  const paths = { requests: join(root, "update-requests"), work: join(root, "updater"), result: join(root, "update-result.json") };
  mkdirSync(paths.requests, { recursive: true });
  return paths;
}
const installs = () => { const done = []; return { done, install: (file) => { done.push(readFileSync(file)); return 0; } }; };

test("the package's name, and the signer a release package must name", () => {
  assert.equal(macPackageName("1.2.3", "arm64"), "scopebond-agent-1.2.3-arm64.pkg");
  assert.equal(macPackageName("1.2.3", "x64"), "scopebond-agent-1.2.3-x86_64.pkg");
  assert.ok(MAC_INSTALLER_PUBLISHER.test(AVOURO));
  for (const other of ["Developer ID Installer: Avouro LLC", "Developer ID Installer: Avouro LLC Ltd (ABCDE12345)", "Developer ID Application: Avouro LLC (ABCDE12345)", "Developer ID Installer: Someone (ABCDE12345)"]) {
    assert.ok(!MAC_INSTALLER_PUBLISHER.test(other), other);
  }
});

test("updates are on unless the machine turns them off; a person's own preference changes nothing", () => {
  const managed = "/Library/Managed Preferences/com.scopebond.agent", machine = "/Library/Preferences/com.scopebond.agent", user = "~/Library/Preferences/com.scopebond.agent";
  const prefs = (values) => (domain, name) => (name === "AutoUpdate" ? values[domain] ?? null : null);
  assert.equal(macAutoUpdate(prefs({})), true);
  assert.equal(macAutoUpdate(prefs({ [managed]: "false" })), false);
  assert.equal(macAutoUpdate(prefs({ [machine]: "false" })), false);
  assert.equal(macAutoUpdate(prefs({ [managed]: "true", [machine]: "false" })), true, "the profile decides first");
  assert.equal(macAutoUpdate(prefs({ [user]: "false" })), true, "not the person");
});

test("a request names a version and nothing else", () => {
  const paths = updater();
  assert.equal(requestMacUpdate("9.9.9", 501, paths), null);
  const [name] = readdirSync(paths.requests);
  assert.match(name, /^501-[0-9a-f]{16}\.json$/, "a new name each time");
  assert.deepEqual(JSON.parse(readFileSync(join(paths.requests, name), "utf8")), { version: "9.9.9" });
  assert.equal(requestMacUpdate("../../etc", 501, paths), "not a version");
});

test("the updater installs the newest signed release asked for, from the file it checked, and records it", async () => {
  const paths = updater();
  const k = keys();
  const r = release(k);
  requestMacUpdate("9.9.8", 501, paths);
  requestMacUpdate(NEW, 502, paths);
  writeFileSync(join(paths.requests, "notes.txt"), "not a request");
  const { done, install } = installs();
  const result = await runMacUpdater({ paths, running: "1.0.0", autoUpdate: () => true, fetchImpl: r.fetchImpl, publicKey: k.pub, check: () => ({ valid: true, subject: AVOURO }), install, health: async () => null, startAgain: () => {}, log: () => {} });
  assert.equal(result?.installed, true, result?.reason ?? "");
  assert.equal(result.version, NEW, "the highest asked for");
  assert.deepEqual(done, [pkg], "installed exactly the package checked");
  assert.deepEqual(readdirSync(paths.requests), ["notes.txt"], "the requests were taken; anything else is left");
  assert.deepEqual(readMacUpdateResult(paths), { ...result, log: null });
  assert.ok(!existsSync(join(paths.work, "updates", macPackageName(NEW))), "the downloaded package is gone");
});

test("the updater installs nothing that is not newer, allowed, signed by the updater key, the manifest's, and Avouro's notarized package", async () => {
  const k = keys();
  const run = async (over) => {
    const paths = updater();
    requestMacUpdate(over.version ?? NEW, 501, paths);
    const { done, install } = installs();
    const r = over.release ?? release(k);
    const result = await runMacUpdater({ paths, running: "1.0.0", autoUpdate: () => true, fetchImpl: r.fetchImpl, publicKey: k.pub, check: () => ({ valid: true, subject: AVOURO }), install, health: async () => null, startAgain: () => {}, log: () => {}, ...over.options });
    return { result, done, calls: r.calls };
  };
  const same = await run({ options: { running: NEW } });
  assert.equal(same.result, null, "not newer: nothing to do");
  assert.equal(same.calls.length, 0, "nothing downloaded");
  const off = await run({ options: { autoUpdate: () => false } });
  assert.match(off.result.reason, /turned off for this Mac/);
  assert.equal(off.calls.length, 0);
  const forged = await run({ options: { publicKey: keys().pub } });
  assert.match(forged.result.reason, /not signed by the updater key/);
  const tampered = await run({ release: release(k, { bytes: Buffer.from("other bytes") }) });
  assert.match(tampered.result.reason, /not the one the manifest names/);
  const unsigned = await run({ options: { check: () => ({ valid: false, subject: "" }) } });
  assert.match(unsigned.result.reason, /signature is not valid/);
  const someoneElse = await run({ options: { check: () => ({ valid: true, subject: "Developer ID Installer: Someone Else (ZZZZZ99999)" }) } });
  assert.match(someoneElse.result.reason, /not Avouro LLC/);
  const failing = await run({ options: { install: () => 1 } });
  assert.deepEqual([failing.result.installed, failing.result.reason], [false, "installer exited with 1"]);
  for (const r of [off, forged, tampered, unsigned, someoneElse]) assert.deepEqual(r.done, [], "nothing installed");
});

test("the asking agent reads the updater's result once, as on Windows: a package that did not install is a failed update", async () => {
  const paths = updater();
  const dir = mkdtempSync(join(tmpdir(), "sb-mac-agent-"));
  writeUpdatePending(dir, NEW, Date.parse("2026-10-24T12:00:00Z"));
  // A result from before the request, or for another version, is not this agent's.
  writeFileSync(paths.result, JSON.stringify({ at: "2026-10-24T11:00:00.000Z", version: NEW, installed: false, reason: "old" }));
  assert.equal(takeMacUpdateResult(dir, paths), false);
  writeFileSync(paths.result, JSON.stringify({ at: "2026-10-24T12:01:00.000Z", version: "9.9.8", installed: false, reason: "other" }));
  assert.equal(takeMacUpdateResult(dir, paths), false);
  writeFileSync(paths.result, JSON.stringify({ at: "2026-10-24T12:01:00.000Z", version: NEW, installed: false, reason: "the package's signature is not valid" }));
  assert.equal(takeMacUpdateResult(dir, paths), true);
  const lines = [];
  noteUpdateOutcome(dir, (l) => lines.push(l), "1.0.0", Date.parse("2026-10-24T12:02:00Z"));
  assert.equal(readUpdatePending(dir), null);
  assert.equal(failedUpdate(dir, Date.parse("2026-10-24T12:03:00Z"))?.version, NEW);
  assert.deepEqual(lines, [`the update to ${NEW} was not installed: the package's signature is not valid`]);
});

// The root updater reads people's request files: never through a link, never waiting on a pipe, never more than 1 KiB.
// Before, lstat then readFile let a request swapped for a link to a pipe hang the root updater.
test("a request file is read only when it is itself a small regular file", async () => {
  const { readRequest, MAC_UPDATER_EXE } = await import("../dist/index.js");
  const paths = updater();
  const ok = join(paths.requests, "501-0123456789abcdef.json");
  writeFileSync(ok, JSON.stringify({ version: "1.2.3" }));
  assert.equal(readRequest(ok), JSON.stringify({ version: "1.2.3" }));
  const big = join(paths.requests, "502-0123456789abcdef.json");
  writeFileSync(big, "x".repeat(2048));
  assert.equal(readRequest(big), null);
  const target = join(paths.requests, "..", "elsewhere.json");
  writeFileSync(target, JSON.stringify({ version: "9.9.9" }));
  const link = join(paths.requests, "503-0123456789abcdef.json");
  let linked = true;
  try { symlinkSync(target, link); } catch { linked = false; }
  // macOS and Linux only: Windows has no O_NOFOLLOW, and the root updater runs on macOS alone.
  if (linked && process.platform !== "win32") assert.throws(() => readRequest(link), "a link is not followed");
  if (process.platform !== "win32") {
    const fifo = join(paths.requests, "504-0123456789abcdef.json");
    spawnSync("mkfifo", [fifo]);
    assert.equal(readRequest(fifo), null, "a pipe is opened without waiting and not read");
  }
  // The LaunchDaemon runs the root-only copy, the one the update-daemon command insists on.
  assert.equal(MAC_UPDATER_EXE, "/Library/PrivilegedHelperTools/com.scopebond.updater");
  const plist = readFileSync(join(import.meta.dirname, "..", "..", "native", "macos", "com.scopebond.updater.plist"), "utf8");
  assert.ok(plist.replace(/\s+/g, "").includes(`<string>${MAC_UPDATER_EXE}</string><string>update-daemon</string>`), "the daemon runs the helper's update-daemon");
  assert.doesNotMatch(plist, /\/usr\/local\/bin/);
});

// The requests folder is writable by everyone: whatever is put there under a request's name (a directory, a
// link, a pipe) is skipped and logged, never read, and never stops the root updater. Before, a directory named like a
// request made it throw on every run, so no update ever installed again.
test("a directory, a link or a pipe named like a request does not stop the updater", async () => {
  const paths = updater();
  const k = keys();
  const r = release(k);
  mkdirSync(join(paths.requests, "501-0123456789abcdef.json"));
  if (process.platform !== "win32") {
    spawnSync("mkfifo", [join(paths.requests, "502-0123456789abcdef.json")]);
    try { symlinkSync("/etc/hosts", join(paths.requests, "503-0123456789abcdef.json")); } catch { /* no links here */ }
  }
  requestMacUpdate(NEW, 504, paths);
  const lines = [];
  const { done, install } = installs();
  const result = await runMacUpdater({ paths, running: "1.0.0", autoUpdate: () => true, fetchImpl: r.fetchImpl, publicKey: k.pub, check: () => ({ valid: true, subject: AVOURO }), install, health: async () => null, startAgain: () => {}, log: (l) => lines.push(l) });
  assert.equal(result?.installed, true, result?.reason ?? "");
  assert.deepEqual(done, [pkg]);
  assert.ok(lines.some((l) => /skipped 501-0123456789abcdef\.json .*not a regular file/.test(l)), lines.join("\n"));
  // Run again: still nothing throws, and the directory is still only skipped.
  assert.equal(await runMacUpdater({ paths, running: NEW, autoUpdate: () => true, log: () => {} }), null);
});

/** A release server with several versions. */
function releases(k, versions) {
  const parts = versions.map((v) => release(k, { version: v }));
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    for (const p of parts) { const res = await p.fetchImpl(url); if (res.ok) return res; }
    return new Response("not found", { status: 404 });
  };
  return { fetchImpl, calls };
}

test("a new agent that does not start is rolled back to the package kept from the last install, and the agents start again", async () => {
  const paths = updater();
  const k = keys();
  const r = releases(k, ["9.9.8", NEW]);
  const installed = [];
  const install = (file) => { installed.push(file.split("/").pop()); return 0; };
  let started = 0;
  const base = { paths, autoUpdate: () => true, fetchImpl: r.fetchImpl, publicKey: k.pub, check: () => ({ valid: true, subject: AVOURO }), install, startAgain: () => { started += 1; }, log: () => {} };
  // 9.9.8 installs and runs: its package is kept.
  requestMacUpdate("9.9.8", 501, paths);
  assert.equal((await runMacUpdater({ ...base, running: "1.0.0", health: async () => null })).installed, true);
  assert.ok(existsSync(join(paths.work, "installed", macPackageName("9.9.8"))), "the package that worked is kept for going back");
  // 9.9.9 installs but its agent does not run: 9.9.8 goes back on from the kept package (no download).
  requestMacUpdate(NEW, 501, paths);
  const downloads = r.calls.length;
  const checked = [];
  const result = await runMacUpdater({ ...base, running: "9.9.8", health: async (v) => { checked.push(v); return v === NEW ? "the agent did not keep running for uid 501" : null; } });
  assert.equal(result.installed, false);
  assert.match(result.reason, /9\.9\.9 was installed but did not start: the agent did not keep running for uid 501; Scopebond went back to 9\.9\.8/);
  assert.deepEqual(installed, [macPackageName("9.9.8"), macPackageName(NEW), macPackageName("9.9.8")]);
  assert.deepEqual(checked, [NEW, "9.9.8"]);
  assert.ok(r.calls.slice(downloads).every((u) => u.includes(NEW)), "the kept package was used, not downloaded again");
  assert.ok(existsSync(join(paths.work, "installed", macPackageName("9.9.8"))), "still kept");
  assert.ok(!existsSync(join(paths.work, "installed", macPackageName(NEW))), "the one that failed is not kept");
  assert.deepEqual(readMacUpdateResult(paths), { ...result, log: null }, "the failure is what every agent reads (the tray shows it)");
});

test("with no kept package the release before is downloaded and checked; when that fails too, the failure is recorded and the agents start", async () => {
  const k = keys();
  const go = async (versions) => {
    const paths = updater();
    const r = releases(k, versions);
    const installed = [];
    let started = 0;
    requestMacUpdate(NEW, 501, paths);
    const result = await runMacUpdater({ paths, running: "9.9.7", autoUpdate: () => true, fetchImpl: r.fetchImpl, publicKey: k.pub, check: () => ({ valid: true, subject: AVOURO }),
      install: (file) => { installed.push(file.split("/").pop()); return 0; }, health: async (v) => (v === NEW ? "no answer" : null), startAgain: () => { started += 1; }, log: () => {} });
    return { result, installed, started };
  };
  const fetched = await go(["9.9.7", NEW]);
  assert.match(fetched.result.reason, /went back to 9\.9\.7/);
  assert.deepEqual(fetched.installed, [macPackageName(NEW), macPackageName("9.9.7")]);
  const none = await go([NEW]);
  assert.equal(none.result.installed, false);
  assert.match(none.result.reason, /going back to 9\.9\.7 did not work: the release has no signed manifest/);
  assert.equal(none.started, 1, "every agent is started again");
});

test("a package that fails part way starts every agent again (its preinstall stopped them)", async () => {
  const paths = updater();
  const k = keys();
  const r = release(k);
  let started = 0;
  requestMacUpdate(NEW, 501, paths);
  const result = await runMacUpdater({ paths, running: "1.0.0", autoUpdate: () => true, fetchImpl: r.fetchImpl, publicKey: k.pub, check: () => ({ valid: true, subject: AVOURO }), install: () => 1, health: async () => null, startAgain: () => { started += 1; }, log: () => {} });
  assert.equal(result.reason, "installer exited with 1");
  assert.equal(started, 1);
});

test("health: the installed executable reports the version and each person's agent keeps the same process", async () => {
  const { macAgentHealth } = await import("../dist/index.js");
  const sleep = async () => {};
  const steady = await macAgentHealth("9.9.9", { exe: "/x", reports: () => "agent/9.9.9 hook/1.0.0\n", uids: () => [501], pid: () => 42, steadyMs: 0, deadlineMs: 60_000, sleep });
  assert.equal(steady, null);
  let n = 0;
  const crashing = await macAgentHealth("9.9.9", { exe: "/x", reports: () => "agent/9.9.9 hook/1.0.0", uids: () => [501], pid: () => ++n, steadyMs: 0, deadlineMs: 50, sleep: () => new Promise((r) => setTimeout(r, 10)) });
  assert.match(crashing, /did not keep running for uid 501/);
  const old = await macAgentHealth("9.9.9", { exe: "/x", reports: () => "agent/9.9.8 hook/1.0.0", uids: () => [], pid: () => 1, deadlineMs: 0, sleep });
  assert.match(old, /reports "agent\/9\.9\.8 hook\/1\.0\.0", not agent\/9\.9\.9/);
  assert.equal(await macAgentHealth("9.9.9", { exe: "/x", reports: () => "agent/9.9.9 hook/1.0.0", uids: () => [], deadlineMs: 0, sleep }), null, "nobody signed in: the program is enough");
});
