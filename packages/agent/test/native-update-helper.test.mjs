// The signed install's update path after the download: the helper (a copy of the signed executable, `update-helper`) closes
// the tray, waits for the agent, checks the installer again while holding it, runs msiexec with a verbose log, starts
// Scopebond again and checks the new agent answers; a version that did not install or start is recorded and not offered
// again for a day. Only the workspace's `native_agent` moves a signed install. Nothing here installs anything: msiexec,
// the tray and the agent are stand-ins, and every folder is a temporary one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  failedUpdate, installHelper, installerName, INSTALLER_CHECK_SCRIPT, INSTALL_RESULT, msiLogPath, noteUpdateOutcome, PUBLISHER, readUpdatePending, recordFailedUpdate,
  runUpdateHelper, takeInstallResult, UPDATE_HELPER_COMMAND, UPDATE_PENDING_MS, updateTarget, writeUpdatePending, helperInput,
} from "../dist/index.js";
import { workspaceProperty } from "../dist/update-helper.js";
import { trayModel } from "../dist/tray-model.js";
import { healthOf } from "../dist/health.js";

const VERSION = "9.9.9";
const home = () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-helper-home-"));
  mkdirSync(join(dir, "updates"), { recursive: true });
  return dir;
};

function inputFor(dir, over = {}) {
  const msi = join(dir, "updates", installerName(VERSION));
  writeFileSync(msi, "installer bytes");
  const plan = installHelper({ path: msi, version: VERSION, sha256: "ab".repeat(32), size: 15 }, 4242, null, { dir, tray: "D:\\Scopebond\\scopebond-tray.exe", previous: "9.9.8" });
  return { ...helperInput(plan.env), ...over };
}

/** Stand-ins that record the order the helper does things in. */
function fakeDeps({ check = { ok: true }, code = 0, answers = true, previous = { ok: false, reason: "no previous release here" }, workspace = null, codes = null } = {}) {
  const calls = [];
  const exits = codes ? [...codes] : null;
  return {
    calls,
    deps: {
      closeTray: async (tray) => { calls.push(`closeTray ${tray}`); },
      waitForExit: async (pid) => { calls.push(`waitForExit ${pid}`); },
      check: async () => { calls.push("check"); return check.ok ? { ok: true, release: () => calls.push("release") } : { ok: false, reason: check.reason }; },
      msiexec: async (args) => { calls.push(`msiexec ${args.join(" ")}`); return { code: exits ? exits.shift() : code, error: null }; },
      startAgain: () => { calls.push("startAgain"); },
      agentAnswers: async (_home, version) => { calls.push(`agentAnswers ${version}`); return typeof answers === "function" ? answers(version) : answers; },
      fetchPrevious: async (version) => { calls.push(`fetchPrevious ${version}`); return previous; },
      rememberedWorkspace: () => workspace,
      now: () => Date.parse("2026-10-11T12:00:00Z"),
    },
  };
}

test("the helper is a copy of the signed executable in the updates folder; every value reaches it as an environment value", () => {
  const dir = join("D:", "Users", "O'Brien $x", ".scopebond");
  const installer = { path: join(dir, "updates", installerName(VERSION)), version: VERSION, sha256: "ab".repeat(32), size: 1234 };
  const plan = installHelper(installer, 4242, join("D:", "launch.cmd"), { dir, tray: join("D:", "Apps", "scopebond-tray.exe"), previous: "9.9.8" });
  assert.equal(plan.program, join(dir, "updates", "scopebond-update-helper-4242.exe"), "a copy beside the installer, not the installed file");
  assert.deepEqual(plan.args, [UPDATE_HELPER_COMMAND], "one fixed argument: no script, no encoded command");
  assert.equal(plan.env.SB_LOG, msiLogPath(dir, VERSION));
  assert.equal(plan.env.SB_LOG, join(dir, "updates", `msi-${VERSION}.log`), "msiexec's verbose log goes in the updates folder");
  assert.equal(plan.env.SB_RESULT, join(dir, "updates", INSTALL_RESULT));
  assert.equal(plan.env.SB_PUBLISHER, PUBLISHER.source, "the same anchored publisher rule as the first check");
  assert.equal(plan.env.SB_HOME, dir);
  for (const value of [installer.path, installer.sha256, "1234", VERSION, "4242", "O'Brien"]) assert.ok(!INSTALLER_CHECK_SCRIPT.includes(value), `the check script carries ${value}`);
  assert.doesNotMatch(INSTALLER_CHECK_SCRIPT, /Invoke-Expression|iex |EncodedCommand|msiexec|\$\{/, "the check only checks; msiexec is started by the helper");
  assert.deepEqual(helperInput({ ...plan.env, SB_SIZE: "x" }), null, "an incomplete environment is refused");
});

test("in order: close the tray, wait, check holding the file, install with a verbose log, let go, start again, confirm", async () => {
  const dir = home();
  const input = inputFor(dir);
  const { calls, deps } = fakeDeps();
  const outcome = await runUpdateHelper(input, deps, 1_000);
  assert.equal(outcome.installed, true);
  assert.equal(outcome.started, true);
  assert.deepEqual(calls, [
    "closeTray D:\\Scopebond\\scopebond-tray.exe", "waitForExit 4242", "check",
    `msiexec /i ${input.msi} /qn /norestart /l*v ${msiLogPath(dir, VERSION)}`, "release", "startAgain", `agentAnswers ${VERSION}`,
  ]);
  const recorded = takeInstallResult(dir);
  assert.equal(recorded.installed, true);
  assert.equal(recorded.log, msiLogPath(dir, VERSION));
  assert.equal(failedUpdate(dir), null);
});

test("a check that fails installs nothing, records why, and still starts Scopebond again", async () => {
  const dir = home();
  const { calls, deps } = fakeDeps({ check: { ok: false, reason: "the installer's signature is not valid (NotSigned)" } });
  const outcome = await runUpdateHelper(inputFor(dir), deps, 1_000);
  assert.equal(outcome.installed, false);
  assert.ok(!calls.some((c) => c.startsWith("msiexec")), "msiexec never runs");
  assert.ok(calls.includes("startAgain"));
  assert.ok(!calls.some((c) => c.startsWith("agentAnswers")));
  assert.match(takeInstallResult(dir).reason, /signature is not valid/);
});

test("msiexec failing is recorded with its exit code and log; the next start records the version as failed", async () => {
  const dir = home();
  const { deps } = fakeDeps({ code: 1603 });
  const outcome = await runUpdateHelper(inputFor(dir), deps, 1_000);
  assert.equal(outcome.installed, false);
  assert.match(outcome.reason, /exit code 1603 \(log: .*msi-9\.9\.9\.log\)/);
  const lines = [];
  noteUpdateOutcome(dir, (l) => lines.push(l), "9.9.8");
  assert.equal(failedUpdate(dir)?.version, VERSION, "not tried again at once");
  assert.match(lines.join("\n"), /was not installed/);
});

test("installed but the new agent never answers: the version is recorded as failed (status and the tray say so)", async () => {
  const dir = home();
  const { deps } = fakeDeps({ answers: false });
  const outcome = await runUpdateHelper(inputFor(dir), deps, 1_000);
  assert.equal(outcome.installed, true);
  assert.equal(outcome.started, false);
  const failed = failedUpdate(dir, Date.parse("2026-10-11T12:01:00Z"));
  assert.equal(failed?.version, VERSION);
  assert.match(failed.reason, /did not start and answer/);
});

test("installed but the new agent never answers: it goes back to the previous signed version, the workspace kept", async () => {
  const dir = home();
  const input = inputFor(dir);
  const prevMsi = join(dir, "updates", installerName("9.9.8"));
  const { calls, deps } = fakeDeps({
    answers: (v) => v === "9.9.8",
    previous: { ok: true, path: prevMsi, version: "9.9.8", sha256: "cd".repeat(32), size: 20 },
    workspace: "https://cloud.scopebond.com",
  });
  const outcome = await runUpdateHelper(input, deps, 1_000);
  assert.equal(outcome.started, false);
  assert.equal(outcome.rolled_back_to, "9.9.8");
  assert.deepEqual(calls.slice(calls.indexOf(`agentAnswers ${VERSION}`)), [
    `agentAnswers ${VERSION}`, "fetchPrevious 9.9.8", "closeTray D:\\Scopebond\\scopebond-tray.exe",
    `msiexec /x ${input.msi} /qn /norestart ROLLBACK=1 /l*v ${msiLogPath(dir, `${VERSION}-rollback-remove`)}`,
    "check", `msiexec /i ${prevMsi} /qn /norestart WORKSPACE=https://cloud.scopebond.com /l*v ${msiLogPath(dir, "9.9.8-rollback")}`,
    "release", "startAgain", "agentAnswers 9.9.8",
  ], "the previous installer is fetched and checked before the new version is removed; the removal skips the agent's uninstall");
  const lines = [];
  noteUpdateOutcome(dir, (l) => lines.push(l), "9.9.8");
  assert.match(lines.join("\n"), /did not start, so Scopebond went back to 9\.9\.8/);
  assert.equal(failedUpdate(dir)?.version, VERSION, "the version that did not start is not tried again at once");
});

test("going back needs the previous release: without it nothing is removed and the failure says why", async () => {
  const dir = home();
  const { calls, deps } = fakeDeps({ answers: false });
  const outcome = await runUpdateHelper(inputFor(dir), deps, 1_000);
  assert.equal(outcome.rolled_back_to, null);
  assert.ok(!calls.some((c) => c.startsWith("msiexec /x")), "the installed version stays when there is nothing to go back to");
  assert.match(takeInstallResult(dir).reason, /going back to 9\.9\.8 did not work: no previous release here/);
});

test("a removal that fails leaves the new version and starts Scopebond again; no previous version means no rollback", async () => {
  const dir = home();
  const prevMsi = join(dir, "updates", installerName("9.9.8"));
  const { calls, deps } = fakeDeps({ answers: false, codes: [0, 1603], previous: { ok: true, path: prevMsi, version: "9.9.8", sha256: "cd".repeat(32), size: 20 } });
  await runUpdateHelper(inputFor(dir), deps, 1_000);
  assert.ok(!calls.some((c) => c.startsWith(`msiexec /i ${prevMsi}`)));
  assert.equal(calls.at(-1), "startAgain");
  assert.match(takeInstallResult(dir).reason, /removing 9\.9\.9 ended with exit code 1603/);

  const none = home();
  const { calls: noCalls, deps: noDeps } = fakeDeps({ answers: false });
  await runUpdateHelper(inputFor(none, { previous: "" }), noDeps, 1_000);
  assert.ok(!noCalls.some((c) => c.startsWith("fetchPrevious")), "an unknown previous version: nothing to go back to");
});

test("only an https workspace address reaches msiexec, never another property", () => {
  assert.equal(workspaceProperty("https://cloud.scopebond.com"), "WORKSPACE=https://cloud.scopebond.com");
  assert.equal(workspaceProperty("https://eu.scopebond.com:8443/w/x"), "WORKSPACE=https://eu.scopebond.com:8443/w/x");
  for (const bad of [null, "", "http://cloud.scopebond.com", "https://x.com PURGE=1", "https://x.com\" PURGE=\"1", "file:///C:/x"]) assert.equal(workspaceProperty(bad), null, String(bad));
});

test("what an agent hears at start: installed and running, installed but another version runs, or a helper that never finished", () => {
  const now = Date.parse("2026-10-11T12:00:00Z");
  const result = (dir, r) => writeFileSync(join(dir, "updates", INSTALL_RESULT), JSON.stringify({ at: "x", version: VERSION, exit_code: 0, reason: null, ...r }));
  const ok = home();
  result(ok, { installed: true });
  writeUpdatePending(ok, VERSION, now - 60_000);
  noteUpdateOutcome(ok, () => {}, VERSION, now);
  assert.equal(failedUpdate(ok, now), null);
  assert.equal(readUpdatePending(ok), null, "the handed-over update is settled");

  const other = home();
  result(other, { installed: true });
  noteUpdateOutcome(other, () => {}, "9.9.8", now);
  assert.match(failedUpdate(other, now)?.reason ?? "", /the agent that started is 9\.9\.8/);

  const underWay = home();
  writeUpdatePending(underWay, VERSION, now - 60_000);
  noteUpdateOutcome(underWay, () => {}, "9.9.8", now);
  assert.equal(failedUpdate(underWay, now), null, "still under way: nothing recorded yet");
  assert.ok(readUpdatePending(underWay));
  noteUpdateOutcome(underWay, () => {}, "9.9.8", now + UPDATE_PENDING_MS);
  assert.match(failedUpdate(underWay, now + UPDATE_PENDING_MS)?.reason ?? "", /helper did not finish/);
});

test("only native_agent moves a signed install; npm follows agent; no field (an older workspace) means no update", () => {
  const answer = (o) => ({ policy: "recommended", hook: null, agent: "0.7.0", native_agent: null, ...o });
  assert.equal(updateTarget(answer({}), "npm", "0.6.0"), "0.7.0");
  assert.equal(updateTarget(answer({}), "per-user", "0.6.0"), null, "an npm release is never the signed install's");
  assert.equal(updateTarget(answer({ native_agent: "0.6.5" }), "per-user", "0.6.0"), "0.6.5");
  assert.equal(updateTarget(answer({ native_agent: "0.6.0" }), "per-user", "0.6.0"), null, "not newer");
  assert.equal(updateTarget(answer({ native_agent: "0.6.5", policy: "hold" }), "per-user", "0.6.0"), null);
  assert.equal(updateTarget(null, "per-user", "0.6.0"), null);
});

const NOW = Date.parse("2026-10-07T12:00:00Z");
const status = {
  schema: "scopebond.status.v1", version: "0.21.0", state: "delivering",
  delivery: { connected: true, last_success_at: NOW - 60_000, last_attempt_at: NOW - 60_000, last_error: null, last_error_code: null, connection_refused_since: null, pending: 0, oldest_pending_age_s: null, gaps_by_reason: {}, queue_error: null },
  identity: { installation_id: "gw-1", generation: 1, key_kid: "key:1", credential_expires_at: null },
  config: { active: "C:/x", others: [], user_connection_shadowed: false }, agents: { claude: true, cursor: false, codex: false },
};
const tray = (version) => trayModel({
  status, health: healthOf(status, null, { kind: "per-user", platform: "win32" }), now: NOW, awakeSince: NOW - 3_600_000, working: null, rules: null, today: null,
  version: { agent: "0.6.0", hook: "0.21.0", policy: "recommended", recommendedAgent: null, recommendedHook: null, ...version },
  workspace: null, computerName: "PC",
});

test("the tray offers Update now only for a version this install can take and that has not just failed here", () => {
  assert.ok(!tray({}).actions.some((a) => a.id === "update_now"), "no signed build named: no Update now");
  assert.ok(tray({ recommendedAgent: "0.6.5" }).actions.some((a) => a.id === "update_now"));
  const failed = tray({ recommendedAgent: "0.6.5", failedUpdate: { version: "0.6.5", reason: "did not start" } });
  assert.ok(!failed.actions.some((a) => a.id === "update_now"), "a version that failed here is not offered again at once");
  assert.match(failed.rows.find((r) => r.label === "Version").value, /the update to 0\.6\.5 did not install/);
});

// The check itself, in Windows PowerShell: it refuses a changed or unsigned installer, and holds a good one so it cannot be
// changed until the helper lets go. A copy of this Node (signed by its own publisher) stands in for a signed installer.
test("on Windows, the check refuses a changed or unsigned installer and holds a good one until msiexec is done", { skip: process.platform !== "win32" && "Windows only", timeout: 300_000 }, async () => {
  const { systemHelperDeps } = await import("../dist/update-helper.js");
  const { authenticode } = await import("../dist/native-update.js");
  const dir = home();
  const digest = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
  const plain = join(dir, "updates", installerName(VERSION));
  writeFileSync(plain, "unsigned bytes");
  const base = { msi: plain, sha256: digest(plain), size: readFileSync(plain).length, publisher: PUBLISHER.source };
  assert.match((await systemHelperDeps.check({ ...base, size: base.size + 1 })).reason, /bytes, not the manifest's/);
  assert.match((await systemHelperDeps.check({ ...base, sha256: "00".repeat(32) })).reason, /SHA-256 is not the manifest's/);
  assert.match((await systemHelperDeps.check(base)).reason, /signature is not valid/);

  const signer = authenticode(process.execPath);
  if (!signer.valid) return; // an unsigned Node build: the signed half cannot be shown here
  const org = /(?:^|,\s*)O=([^,]+)/.exec(signer.subject)?.[1];
  assert.ok(org, signer.subject);
  const copy = join(dir, "updates", "signed.msi");
  copyFileSync(process.execPath, copy);
  const signed = { msi: copy, sha256: digest(copy), size: readFileSync(copy).length };
  assert.match((await systemHelperDeps.check({ ...signed, publisher: PUBLISHER.source })).reason, /not the expected publisher/);
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const held = await systemHelperDeps.check({ ...signed, publisher: `(^|,\\s*)O=${escape(org)}(,|$)` });
  assert.equal(held.ok, true, held.reason);
  assert.throws(() => writeFileSync(copy, "replaced"), /EBUSY|EPERM|EACCES/, "nobody can change it while it is held");
  held.release();
  let freed = false;
  for (let i = 0; i < 40 && !freed; i++) { try { writeFileSync(copy, "now it may change"); freed = true; } catch { await new Promise((r) => setTimeout(r, 250)); } }
  assert.ok(freed, "let go once msiexec is done");
  assert.ok(existsSync(copy));
});

test("a failed update is kept with its reason until it is tried again (after an hour for a first failure), then offered again", () => {
  const dir = home();
  const at = Date.parse("2026-10-11T12:00:00Z");
  recordFailedUpdate(dir, VERSION, at, "x".repeat(400));
  assert.equal(failedUpdate(dir, at + 1_000).reason.length, 300);
  assert.equal(failedUpdate(dir, at + 25 * 3_600_000), null);
});
