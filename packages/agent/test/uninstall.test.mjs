// `scopebond-agent uninstall` on each path that runs it: from a terminal after an npm install, from the signed installer (the
// MSI's removal runs the same command), with --purge, and from the Settings entry's script. Each tells the workspace (the real
// hook against the shared stand-in workspace), says when the workspace could not be told (and shows it in the exit code),
// gives up on a workspace that does not answer within seconds, and ends with one sentence about the Scopebond folder.
// Autostart, the running agent and the Settings entry are stubbed: the real ones live in this computer's registry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeCloud } from "@scopebond/fake-cloud";
import { scaffold, UNINSTALL_NOT_TOLD_EXIT, UNINSTALL_CALLER_ENV } from "@scopebond/hook";
import { runUninstall, folderSentence, spawnHook, HOOK_UNINSTALL_TIMEOUT_MS } from "../dist/index.js";

/** A person's home with a Scopebond folder and the Scopebond hook in Claude Code's settings, connected to `cloud` (or not). */
async function computer(cloud) {
  const home = mkdtempSync(join(tmpdir(), "sb-agent-uninstall-"));
  const dir = join(home, ".scopebond");
  mkdirSync(dir, { recursive: true });
  scaffold(dir);
  mkdirSync(join(home, ".claude"), { recursive: true });
  const settings = join(home, ".claude", "settings.json");
  writeFileSync(settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "scopebond-agent hook claude" }] }] } }));
  if (cloud) {
    const public_key_pem = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
    const res = await fetch(cloud.url + "/v1/enroll", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enrollment_token: "sbe_fake_agent", public_key_pem }) });
    writeFileSync(join(dir, "cloud.json"), JSON.stringify({ url: cloud.url, credential: (await res.json()).credential }));
  }
  const env = { ...process.env, HOME: home, USERPROFILE: home, SCOPEBOND_HOME: dir };
  delete env[UNINSTALL_CALLER_ENV];
  delete env.SCOPEBOND_HOOK_DIR;
  return { home, dir, settings, env };
}

/** The uninstall with this computer's registry left alone; every line it says is collected. */
async function uninstall(c, o = {}) {
  const lines = [];
  const steps = [];
  const started = Date.now();
  const code = await runUninstall({
    dir: c.dir, purge: false, kind: "npm", me: "scopebond-agent", env: c.env, cwd: c.home, caller: undefined,
    say: (line) => lines.push(line),
    stopRunning: async () => { steps.push("stop"); return false; },
    disableAutostart: () => { steps.push("autostart off"); return "autostart was not on"; },
    removeAppsEntry: () => { steps.push("apps entry"); return null; },
    ...o,
  });
  return { code, lines, out: lines.join("\n"), last: lines.at(-1), steps, ms: Date.now() - started };
}

const hookEntries = (c) => JSON.parse(readFileSync(c.settings, "utf8")).hooks.PreToolUse.length;

test("npm: the workspace is told, the hook is taken out, and the last sentence names the folder and the purge command", async () => {
  const cloud = await startFakeCloud();
  try {
    const c = await computer(cloud);
    const r = await uninstall(c);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(r.steps, ["autostart off", "stop", "apps entry"]);
    assert.deepEqual(cloud.state().uninstalls.map((u) => u.purge), [false], "the workspace was told once");
    assert.match(r.out, /told http:\/\/127\.0\.0\.1:\d+; the removal was not allowed there/);
    assert.equal(hookEntries(c), 0, "the hook is out of Claude Code's settings");
    assert.ok(existsSync(join(c.dir, "policy.json")), "the folder stays");
    assert.equal(r.last, `Your Scopebond folder ${c.dir} stays (keys and records not yet sent). Delete it, or run \`scopebond-agent uninstall --purge\`, to remove everything.`);
    assert.equal(r.out.split(c.dir).length - 1, 1, `the folder is named once, last:\n${r.out}`);
  } finally { await cloud.close(); }
});

test("--purge: the workspace hears it is a purge, the folder goes, and the last sentence says so", async () => {
  const cloud = await startFakeCloud();
  try {
    const c = await computer(cloud);
    const r = await uninstall(c, { purge: true });
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(cloud.state().uninstalls.map((u) => u.purge), [true]);
    assert.ok(!existsSync(c.dir), "the folder is gone");
    assert.equal(r.last, `Your Scopebond folder ${c.dir} was removed, with its keys and the records not yet sent.`);
  } finally { await cloud.close(); }
});

test("the signed installer: the same notice, and the last sentence names the installer's purge option", async () => {
  const cloud = await startFakeCloud();
  try {
    for (const kind of ["per-user", "per-machine"]) {
      const c = await computer(cloud);
      const r = await uninstall(c, { kind, platform: "win32" });
      assert.equal(r.code, 0, r.out);
      assert.equal(r.last, `Your Scopebond folder ${c.dir} stays (keys and records not yet sent). Delete it, or run \`msiexec /x … PURGE=1\`, to remove everything.`);
    }
    // The macOS package: its removal script's purge option.
    const c = await computer(cloud);
    const r = await uninstall(c, { kind: "per-machine", platform: "darwin" });
    assert.equal(r.code, 0, r.out);
    assert.equal(r.last, `Your Scopebond folder ${c.dir} stays (keys and records not yet sent). Delete it, or run \`sudo "/Library/Application Support/Scopebond/uninstall.sh" --purge\`, to remove everything.`);
    assert.deepEqual(cloud.state().uninstalls.map((u) => u.purge), [false, false, false]);
  } finally { await cloud.close(); }
});

test("a workspace that refuses the notice: said, exit code 75, and everything else is still removed", async () => {
  const cloud = await startFakeCloud();
  try {
    const c = await computer(cloud);
    cloud.fault("uninstall", { status: 500, times: 1 });
    const r = await uninstall(c);
    assert.equal(r.code, UNINSTALL_NOT_TOLD_EXIT, r.out);
    assert.match(r.out, /could not tell http:\/\/127\.0\.0\.1:\d+ that Scopebond is being removed/);
    assert.equal(hookEntries(c), 0, "the hook is still taken out");
    assert.match(r.last, /^Your Scopebond folder .* stays/, "the folder sentence is still last");
  } finally { await cloud.close(); }
});

test("a workspace that does not answer is given up on within seconds, and said", async () => {
  const cloud = await startFakeCloud();
  try {
    const c = await computer(cloud);
    cloud.fault("uninstall", { delayMs: 30_000, times: 1 });
    const r = await uninstall(c);
    assert.equal(r.code, UNINSTALL_NOT_TOLD_EXIT, r.out);
    assert.ok(r.ms < 15_000, `bounded (${r.ms} ms)`);
    assert.match(r.out, /could not tell/);
  } finally { await cloud.close(); }
});

test("a computer with no workspace connection says there was none to tell", async () => {
  const c = await computer(null);
  const r = await uninstall(c);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /not connected to a workspace, so there was none to tell/);
  assert.match(r.last, /^Your Scopebond folder .* stays/);
});

test("run from the Settings entry's script: the script says the folder sentence, not the agent", async () => {
  const cloud = await startFakeCloud();
  try {
    const c = await computer(cloud);
    const r = await uninstall(c, { caller: "apps-entry" });
    assert.equal(r.code, 0, r.out);
    assert.equal(cloud.state().uninstalls.length, 1);
    assert.ok(!r.out.includes(c.dir), r.out);
  } finally { await cloud.close(); }
});

test("a hook that cannot start: the agent tells the workspace itself and says the hook may still be in the settings", async () => {
  const cloud = await startFakeCloud();
  try {
    const c = await computer(cloud);
    const r = await uninstall(c, { runHook: async () => ({ status: null, error: new Error("spawn ENOENT"), output: "" }) });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /could not run the hook's uninstall \(spawn ENOENT\)/i);
    assert.match(r.out, /scopebond-agent uninstall/);
    assert.deepEqual(cloud.state().uninstalls.map((u) => u.purge), [false], "the workspace was told by the agent");
    assert.match(r.out, /told http:\/\/127\.0\.0\.1:\d+/);
    assert.match(r.last, /^Your Scopebond folder .* stays/);
  } finally { await cloud.close(); }
});

test("a hook that does not finish in time is stopped and said; one that fails is said with its exit code", async () => {
  const c = await computer(null);
  let given = null;
  const slow = await uninstall(c, { runHook: async (args, env, cwd, timeoutMs) => { given = { args, caller: env[UNINSTALL_CALLER_ENV], home: env.SCOPEBOND_HOME, cwd, timeoutMs }; return { status: null, signal: "SIGTERM", timedOut: true, output: "" }; } });
  assert.deepEqual(given, { args: ["uninstall", "--yes"], caller: "agent", home: c.dir, cwd: c.home, timeoutMs: HOOK_UNINSTALL_TIMEOUT_MS });
  assert.ok(HOOK_UNINSTALL_TIMEOUT_MS <= 30_000, "a short time limit");
  assert.equal(slow.code, 1, slow.out);
  assert.match(slow.out, /did not finish within 30 s/);
  const failed = await uninstall(c, { runHook: async () => ({ status: 2, output: "something went wrong\n" }) });
  assert.equal(failed.code, 2, failed.out);
  assert.match(failed.out, /something went wrong/);
  assert.match(failed.out, /stopped with exit code 2/);
  assert.match(failed.last, /^Your Scopebond folder .* stays/);
});

test("spawnHook gives up on a hook past its time limit", async () => {
  const c = await computer(null);
  // `hook` with no arguments in a process that never ends: a script that waits stands in for a hung hook.
  const started = Date.now();
  const run = await spawnHook(["--eval-never"], c.env, c.home, 300, () => [process.execPath, ["-e", "setTimeout(() => {}, 60000)"]]);
  assert.equal(run.timedOut, true);
  assert.ok(Date.now() - started < 10_000);
});

test("folderSentence: each case in one plain sentence", () => {
  assert.equal(folderSentence("/h/.scopebond", { exists: true, purged: false, kind: "npm", me: "scopebond-agent.cmd" }),
    "Your Scopebond folder /h/.scopebond stays (keys and records not yet sent). Delete it, or run `scopebond-agent.cmd uninstall --purge`, to remove everything.");
  assert.equal(folderSentence("/h/.scopebond", { exists: true, purged: false, kind: "per-user", me: "scopebond-agent", platform: "win32" }),
    "Your Scopebond folder /h/.scopebond stays (keys and records not yet sent). Delete it, or run `msiexec /x … PURGE=1`, to remove everything.");
  // On a Mac: the package's removal script, never msiexec; the executable run from anywhere else names nothing to run.
  assert.equal(folderSentence("/h/.scopebond", { exists: true, purged: false, kind: "per-machine", me: "scopebond-agent", platform: "darwin" }),
    "Your Scopebond folder /h/.scopebond stays (keys and records not yet sent). Delete it, or run `sudo \"/Library/Application Support/Scopebond/uninstall.sh\" --purge`, to remove everything.");
  assert.equal(folderSentence("/h/.scopebond", { exists: true, purged: false, kind: "per-user", me: "scopebond-agent", platform: "darwin" }),
    "Your Scopebond folder /h/.scopebond stays (keys and records not yet sent). Delete it to remove everything.");
  assert.equal(folderSentence("/h/.scopebond", { exists: true, purged: false, kind: null, me: "x" }),
    "Your Scopebond folder /h/.scopebond stays (keys and records not yet sent). Delete it to remove everything.");
  assert.equal(folderSentence("/h/.scopebond", { exists: false, purged: true, kind: "npm", me: "x" }),
    "Your Scopebond folder /h/.scopebond was removed, with its keys and the records not yet sent.");
  assert.equal(folderSentence("/h/.scopebond", { exists: false, purged: false, kind: "npm", me: "x" }), "No Scopebond folder is left at /h/.scopebond.");
});

test("the command line: uninstall from npm says the folder sentence last and tells the workspace", { skip: process.platform === "win32" && "it changes this user's registry (autostart, Settings entry); the steps are covered above" }, async () => {
  const cloud = await startFakeCloud();
  try {
    const c = await computer(cloud);
    const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
    const r = await new Promise((resolve) => execFile(process.execPath, [cli, "uninstall"], { env: { ...c.env, SCOPEBOND_AGENT_TRAY: "off" }, cwd: c.home, encoding: "utf8", timeout: 60_000 },
      (error, stdout, stderr) => resolve({ code: error ? error.code : 0, out: stdout + stderr })));
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(cloud.state().uninstalls.map((u) => u.purge), [false]);
    assert.equal(r.out.trim().split("\n").at(-1), `Your Scopebond folder ${c.dir} stays (keys and records not yet sent). Delete it, or run \`scopebond-agent uninstall --purge\`, to remove everything.`);
  } finally { await cloud.close(); }
});
