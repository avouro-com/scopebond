// `uninstall` from the command line, against the shared stand-in workspace (@scopebond/fake-cloud): the workspace hears about
// the removal, a workspace that could not be told is said and shows in the exit code (the removal itself still happens), the
// Scopebond folder is named once, and a program that runs the uninstall for the person can name the folder itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeCloud } from "@scopebond/fake-cloud";
import { scaffold, UNINSTALL_NOT_TOLD_EXIT, UNINSTALL_CALLER_ENV, uninstallReportLine } from "../dist/index.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

/** A person's home with a Scopebond folder, connected to `cloud` (or to nothing). */
async function computer(cloud) {
  const home = mkdtempSync(join(tmpdir(), "sb-hook-uninstall-"));
  const dir = join(home, ".scopebond");
  mkdirSync(dir, { recursive: true });
  scaffold(dir);
  if (cloud) {
    const public_key_pem = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
    const res = await fetch(cloud.url + "/v1/enroll", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enrollment_token: "sbe_fake_hook", public_key_pem }) });
    writeFileSync(join(dir, "cloud.json"), JSON.stringify({ url: cloud.url, credential: (await res.json()).credential }));
  }
  return { home, dir };
}

/** The CLI as its own process. Not spawnSync: the stand-in workspace answers from this process's event loop. */
function uninstall(c, args = [], extraEnv = {}) {
  const env = { ...process.env, HOME: c.home, USERPROFILE: c.home, SCOPEBOND_HOME: c.dir, ...extraEnv };
  delete env.SCOPEBOND_HOOK_DIR;
  if (!(UNINSTALL_CALLER_ENV in extraEnv)) delete env[UNINSTALL_CALLER_ENV];
  const started = Date.now();
  return new Promise((resolve) => execFile(process.execPath, [cli, "uninstall", "--yes", ...args], { env, cwd: c.home, encoding: "utf8", timeout: 60_000 },
    (error, stdout, stderr) => resolve({ code: error ? error.code : 0, out: stdout + stderr, ms: Date.now() - started })));
}

test("uninstall: the workspace is told, the folder is named once, and the exit code is 0", async () => {
  const cloud = await startFakeCloud();
  try {
    const c = await computer(cloud);
    const r = await uninstall(c);
    assert.equal(r.code, 0, r.out);
    assert.equal(cloud.state().uninstalls.length, 1, "one notice");
    assert.equal(cloud.state().uninstalls[0].purge, false);
    assert.match(r.out, /told http:\/\/127\.0\.0\.1:\d+; the removal was not allowed there/);
    assert.equal(r.out.split(c.dir).length - 1, 1, `the Scopebond folder is named once (the user home is not also a project):\n${r.out}`);
    assert.ok(existsSync(join(c.dir, "policy.json")), "kept without --purge");
  } finally { await cloud.close(); }
});

test("uninstall: a workspace that could not be told is said, and the exit code says so; the removal still happens", async () => {
  const cloud = await startFakeCloud();
  try {
    const c = await computer(cloud);
    const settings = join(c.home, ".claude", "settings.json");
    mkdirSync(join(c.home, ".claude"), { recursive: true });
    writeFileSync(settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `node ${cli} claude` }] }] } }));
    cloud.fault("uninstall", { status: 500, times: 1 });
    const r = await uninstall(c);
    assert.equal(r.code, UNINSTALL_NOT_TOLD_EXIT, r.out);
    assert.equal(UNINSTALL_NOT_TOLD_EXIT, 75);
    assert.match(r.out, /could not tell http:\/\/127\.0\.0\.1:\d+ that Scopebond is being removed/);
    assert.equal(JSON.parse(readFileSync(settings, "utf8")).hooks.PreToolUse.length, 0, "the hook is still taken out");
  } finally { await cloud.close(); }
});

test("uninstall: a workspace that does not answer is given up on after a few seconds", async () => {
  const cloud = await startFakeCloud();
  try {
    const c = await computer(cloud);
    cloud.fault("uninstall", { delayMs: 20_000, times: 1 });
    const r = await uninstall(c);
    assert.equal(r.code, UNINSTALL_NOT_TOLD_EXIT, r.out);
    assert.ok(r.ms < 12_000, `bounded (${r.ms} ms)`);
    assert.match(r.out, /could not tell/);
  } finally { await cloud.close(); }
});

test("uninstall: a computer with no workspace connection says there was none to tell", async () => {
  const c = await computer(null);
  const r = await uninstall(c);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /not connected to a workspace, so there was none to tell/);
});

test("uninstall: a program running it for the person names the folder itself; --purge still removes it", async () => {
  const cloud = await startFakeCloud();
  try {
    const c = await computer(cloud);
    const kept = await uninstall(c, [], { [UNINSTALL_CALLER_ENV]: "agent" });
    assert.equal(kept.code, 0, kept.out);
    assert.ok(!kept.out.includes(c.dir), `the caller names the folder, not the hook:\n${kept.out}`);
    const purged = await uninstall(c, ["--purge"], { [UNINSTALL_CALLER_ENV]: "agent" });
    assert.equal(purged.code, 0, purged.out);
    assert.ok(!existsSync(c.dir), "--purge removes the folder");
    assert.ok(!purged.out.includes(c.dir), purged.out);
    assert.deepEqual(cloud.state().uninstalls.map((u) => u.purge), [false, true]);
  } finally { await cloud.close(); }
});

test("uninstallReportLine: what each answer says", () => {
  assert.equal(uninstallReportLine({ workspace: "https://w.example", told: true, authorized: true }), "✓ told https://w.example; the removal was allowed there");
  assert.match(uninstallReportLine({ workspace: "https://w.example", told: true, authorized: false }), /^! told https:\/\/w\.example; the removal was not allowed there/);
  assert.match(uninstallReportLine({ workspace: "https://w.example", told: false, authorized: null }), /^! could not tell https:\/\/w\.example/);
});
