// The macOS package's updater: a person's agent asks for a version, the root updater installs it only when it is newer,
// allowed on this Mac, named by a manifest signed with an updater key, the package the manifest names, and signed by
// Avouro LLC's Developer ID Installer identity and notarized; the asking agent reads the result as on Windows. The
// release, the signature check and `installer` are stand-ins; every folder is temporary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const {
  MAC_INSTALLER_PUBLISHER, MANIFEST_DOMAIN, failedUpdate, macAutoUpdate, macPackageName, noteUpdateOutcome, readMacUpdateResult, readUpdatePending,
  requestMacUpdate, runMacUpdater, takeMacUpdateResult, writeUpdatePending, macMaxVersion, macAgentStarted, launchdJob, takeInstallResult,
} = await import("../dist/index.js");

/** Tests cannot make files as other people: the number in a request's name stands in for its owner. */
const byName = (file) => Number(basename(file).split("-")[0]);
/** The new agent starts (the default check runs the installed program and launchctl). */
const starts = async () => null;

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
  const result = await runMacUpdater({ paths, running: "1.0.0", autoUpdate: () => true, maxVersion: () => null, fetchImpl: r.fetchImpl, publicKey: k.pub, check: () => ({ valid: true, subject: AVOURO }), install, started: starts, ownerOf: byName, log: () => {} });
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
    const result = await runMacUpdater({ paths, running: "1.0.0", autoUpdate: () => true, maxVersion: () => null, fetchImpl: r.fetchImpl, publicKey: k.pub, check: () => ({ valid: true, subject: AVOURO }), install, started: starts, log: () => {}, ...over.options });
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

/** Several releases at the release address at once. */
const either = (...rs) => ({ calls: rs.flatMap((r) => r.calls), fetchImpl: async (url) => { for (const r of rs) { const res = await r.fetchImpl(url); if (res.ok) return res; } return new Response("not found", { status: 404 }); } });
const baseOptions = (k, r, more = {}) => ({ running: "1.0.0", autoUpdate: () => true, maxVersion: () => null, fetchImpl: r.fetchImpl, publicKey: k.pub, check: () => ({ valid: true, subject: AVOURO }), started: starts, log: () => {}, ...more });

// H1 (2026-10-27 review): a folder named like a request made `rmSync` throw outside the try, so nothing was recorded and
// every later run failed the same way: anyone could switch updates off for the whole Mac.
test("a folder, a link or a pipe named like a request is never read and never stops the updater", { skip: process.platform === "win32" && "links and pipes as on macOS" }, async () => {
  const paths = updater();
  const k = keys();
  const folder = join(paths.requests, "666-0123456789abcdef.json");
  mkdirSync(folder);
  writeFileSync(join(folder, "inside"), "kept");
  const target = join(paths.requests, "..", "elsewhere.json");
  writeFileSync(target, JSON.stringify({ version: "99.0.0" }));
  symlinkSync(target, join(paths.requests, "667-0123456789abcdef.json"));
  spawnSync("mkfifo", [join(paths.requests, "668-0123456789abcdef.json")]);
  for (const round of [1, 2]) {
    requestMacUpdate(NEW, 501, paths);
    const { done, install } = installs();
    const result = await runMacUpdater({ paths, ...baseOptions(k, release(k)), install });
    assert.equal(result?.installed, true, `round ${round}: ${result?.reason}`);
    assert.equal(result.version, NEW);
    assert.equal(done.length, 1);
    assert.deepEqual(readdirSync(paths.requests), ["666-0123456789abcdef.json"], "only the folder is left, untouched");
  }
  assert.equal(readFileSync(join(folder, "inside"), "utf8"), "kept");
  assert.equal(readFileSync(target, "utf8"), JSON.stringify({ version: "99.0.0" }), "a link goes, never what it points to");
});

test("one person counts once, with their latest request", async () => {
  const k = keys();
  const run = async (older, newer) => {
    const paths = updater();
    // The same owner (this test's user), whatever the names say.
    const a = join(paths.requests, "501-000000000000000a.json"), b = join(paths.requests, "777-000000000000000b.json");
    writeFileSync(a, JSON.stringify({ version: older }));
    writeFileSync(b, JSON.stringify({ version: newer }));
    utimesSync(a, new Date("2026-10-01T00:00:00Z"), new Date("2026-10-01T00:00:00Z"));
    const r = either(release(k), release(k, { version: "9.9.8" }));
    const { install } = installs();
    return { result: await runMacUpdater({ paths, ...baseOptions(k, r), install }), calls: r.calls };
  };
  const latestNewer = await run("9.9.8", NEW);
  assert.equal(latestNewer.result.version, NEW);
  const latestOlder = await run(NEW, "9.9.8");
  assert.equal(latestOlder.result.version, "9.9.8", "not the highest any file names: the person's latest");
  assert.ok(!latestOlder.calls.some((u) => u.includes(NEW)), "the person's older request is not fetched");
});

test("a version with no signed release cannot keep the release people asked for from installing", async () => {
  const k = keys();
  const paths = updater();
  for (let i = 0; i < 20; i++) requestMacUpdate("99.0.0", 666, paths);
  requestMacUpdate(NEW, 501, paths);
  const lines = [];
  const { done, install } = installs();
  const result = await runMacUpdater({ paths, ...baseOptions(k, release(k)), install, ownerOf: byName, log: (l) => lines.push(l) });
  assert.equal(result?.installed, true, result?.reason ?? "");
  assert.equal(result.version, NEW, "99.0.0 was asked for, but has no signed release");
  assert.deepEqual(done, [pkg]);
  assert.ok(lines.some((l) => /passed over the Scopebond Agent 99\.0\.0.*no signed manifest/.test(l)), lines.join("\n"));
  // Asked for alone, it is what the result names (the CI install test asks for 99.0.0 and reads this).
  requestMacUpdate("99.0.0", 666, paths);
  const alone = await runMacUpdater({ paths, ...baseOptions(k, release(k)), install, ownerOf: byName });
  assert.deepEqual([alone.version, alone.installed, alone.reason], ["99.0.0", false, "the release has no signed manifest"]);
  // A genuine release that fails its checks is not passed over for an older one.
  requestMacUpdate(NEW, 501, paths);
  requestMacUpdate("9.9.8", 502, paths);
  const tampered = await runMacUpdater({ paths, ...baseOptions(k, either(release(k, { bytes: Buffer.from("other") }), release(k, { version: "9.9.8" }))), install, ownerOf: byName });
  assert.deepEqual([tampered.version, tampered.installed], [NEW, false]);
  assert.match(tampered.reason, /not the one the manifest names/);
});

test("the machine's MaxVersion caps what the updater installs; a person's own preference changes nothing", async () => {
  const managed = "/Library/Managed Preferences/com.scopebond.agent", machine = "/Library/Preferences/com.scopebond.agent", user = "~/Library/Preferences/com.scopebond.agent";
  const prefs = (values) => (domain, name) => (name === "MaxVersion" ? values[domain] ?? null : null);
  assert.equal(macMaxVersion(prefs({})), null);
  assert.equal(macMaxVersion(prefs({ [machine]: "2.0.0" })), "2.0.0");
  assert.equal(macMaxVersion(prefs({ [managed]: "1.5.0", [machine]: "2.0.0" })), "1.5.0", "the profile decides first");
  assert.equal(macMaxVersion(prefs({ [user]: "1.0.0" })), null, "not the person");
  assert.equal(macMaxVersion(prefs({ [managed]: "latest" })), "0.0.0", "a value that is not a version allows none");
  const k = keys();
  const r = either(release(k), release(k, { version: "9.9.8" }));
  const paths = updater();
  requestMacUpdate(NEW, 501, paths);
  requestMacUpdate("9.9.8", 502, paths);
  const { install } = installs();
  const capped = await runMacUpdater({ paths, ...baseOptions(k, r), install, ownerOf: byName, maxVersion: () => "9.9.8" });
  assert.deepEqual([capped.version, capped.installed], ["9.9.8", true]);
  requestMacUpdate(NEW, 501, paths);
  const none = await runMacUpdater({ paths, ...baseOptions(k, r), install, ownerOf: byName, maxVersion: () => "1.0.0" });
  assert.deepEqual([none.version, none.installed, none.reason], [NEW, false, "this Mac allows no version newer than 1.0.0 (MaxVersion)"]);
  assert.equal(r.calls.filter((u) => u.includes(NEW)).length, 0, "a version above the cap is never fetched");
});

// M1 (2026-10-27 review): success used to mean only that `installer` exited 0. Now the new agent must start, as on Windows.
test("an update whose agent does not start is rolled back to the version that ran before, and the asking agent hears so", async () => {
  const k = keys();
  const old = Buffer.from("the old package");
  const r = either(release(k), release(k, { version: "1.0.0", bytes: old, digestOf: old }));
  const paths = updater();
  requestMacUpdate(NEW, 501, paths);
  const dir = mkdtempSync(join(tmpdir(), "sb-mac-agent-"));
  writeUpdatePending(dir, NEW, Date.parse("2026-10-24T12:00:00Z"));
  const checked = [];
  const { done, install } = installs();
  const result = await runMacUpdater({
    paths, ...baseOptions(k, r), install, now: () => Date.parse("2026-10-24T12:05:00Z"),
    started: async (v) => { checked.push(v); return v === NEW ? "the agent did not keep running for user 501 within 3 minutes" : null; },
  });
  assert.deepEqual(checked, [NEW, "1.0.0"]);
  assert.deepEqual(done, [pkg, old], "the new package, then the previous one again");
  assert.equal(result.installed, false);
  assert.equal(result.rolled_back_to, "1.0.0");
  assert.match(result.reason, /9\.9\.9 was installed but did not start: the agent did not keep running for user 501.*; Scopebond went back to 1\.0\.0$/);
  assert.equal(readMacUpdateResult(paths).rolled_back_to, "1.0.0");
  assert.equal(takeMacUpdateResult(dir, paths), true);
  const lines = [];
  noteUpdateOutcome(dir, (l) => lines.push(l), "1.0.0", Date.parse("2026-10-24T12:06:00Z"));
  assert.match(lines[0], /^the update to 9\.9\.9 did not start, so Scopebond went back to 1\.0\.0/);
  assert.equal(failedUpdate(dir, Date.parse("2026-10-24T12:07:00Z"))?.version, NEW);
  assert.equal(takeInstallResult(dir), null, "read once");

  // No earlier release to go back to: said, and nothing else is installed.
  requestMacUpdate(NEW, 501, paths);
  const lonely = installs();
  const stuck = await runMacUpdater({ paths, ...baseOptions(k, release(k)), install: lonely.install, started: async () => "it crashed" });
  assert.equal(lonely.done.length, 1);
  assert.deepEqual([stuck.installed, stuck.rolled_back_to], [false, null]);
  assert.match(stuck.reason, /going back to 1\.0\.0 did not work: the release has no signed manifest$/);
});

test("a rollback reaches the agent that runs again even when the new agent cleared the request before it stopped", () => {
  const paths = updater();
  const dir = mkdtempSync(join(tmpdir(), "sb-mac-agent-"));
  // No request any more: the new agent started, took its request as done, then crashed; the updater went back.
  writeFileSync(paths.result, JSON.stringify({ at: "2026-10-24T12:05:00.000Z", version: NEW, installed: false, reason: "did not start; Scopebond went back to 1.0.0", rolled_back_to: "1.0.0" }));
  assert.equal(takeMacUpdateResult(dir, paths, "9.9.8"), false, "not a rollback to this agent's version");
  assert.equal(takeMacUpdateResult(dir, paths, "1.0.0"), true);
  const lines = [];
  noteUpdateOutcome(dir, (l) => lines.push(l), "1.0.0", Date.parse("2026-10-24T12:06:00Z"));
  assert.match(lines[0], /did not start, so Scopebond went back to 1\.0\.0/);
  assert.equal(failedUpdate(dir, Date.parse("2026-10-24T12:07:00Z"))?.version, NEW, "not asked for again at once");
  // Taken once: not again after the retry time, so the backoff counts real tries only.
  assert.equal(takeMacUpdateResult(dir, paths, "1.0.0"), false);
});

/** launchd and the installed program, as the start check sees them; time moves only when the check waits. */
function fakeMac({ answer = `agent/${NEW} hook/1.0.0\n`, jobs }) {
  let t = 0;
  return {
    run(program, args) {
      if (args[0] === "--version") return { status: 0, stdout: answer };
      if (program === "/bin/ps") return { status: 0, stdout: "    0 /sbin/launchd\n  501 /System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow\n  502 /System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow\n  501 /bin/zsh\n" };
      const job = jobs[Number(/^gui\/(\d+)\//.exec(args[1] ?? "")?.[1])];
      return job ? { status: 0, stdout: job(t) } : { status: 113, stdout: "" };
    },
    sleep: async (ms) => { t += ms; },
    now: () => t,
  };
}

test("the start check: the installed program answers with the new version, and launchd keeps the agent running for each person it is loaded for", async () => {
  assert.deepEqual(launchdJob("gui/501/com.scopebond.agent = {\n\tstate = running\n\tpid = 4242\n}"), { running: true, pid: 4242 });
  assert.deepEqual(launchdJob("\tstate = spawn scheduled\n"), { running: false, pid: null });
  const steady = () => "\tstate = running\n\tpid = 4242\n";
  const o = { exe: "/x/scopebond-agent", deadlineMs: 180_000, settleMs: 10_000 };
  // 502 has autostart off (nothing loaded for them): not waited for.
  assert.equal(await macAgentStarted(NEW, { ...o, deps: fakeMac({ jobs: { 501: steady } }) }), null);
  assert.match(await macAgentStarted(NEW, { ...o, deps: fakeMac({ answer: "agent/1.0.0 hook/1.0.0\n", jobs: { 501: steady } }) }), /^\/x\/scopebond-agent did not answer as 9\.9\.9 \(agent\/1\.0\.0/);
  // Restarted by launchd every time it is looked at: a crash loop, never "started".
  const crashing = (t) => `\tstate = running\n\tpid = ${1000 + t}\n`;
  assert.equal(await macAgentStarted(NEW, { ...o, deps: fakeMac({ jobs: { 501: steady, 502: crashing } }) }), "the agent did not keep running for user 502 within 3 minutes");
  const never = () => "\tstate = not running\n";
  assert.match(await macAgentStarted(NEW, { ...o, deps: fakeMac({ jobs: { 501: never } }) }), /user 501/);
  // Slow to start, then steady: it waits.
  const slow = (t) => (t < 60_000 ? "\tstate = spawn scheduled\n" : "\tstate = running\n\tpid = 77\n");
  assert.equal(await macAgentStarted(NEW, { ...o, deps: fakeMac({ jobs: { 501: slow } }) }), null);
});
