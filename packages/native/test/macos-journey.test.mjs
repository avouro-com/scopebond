// The macOS journey from an npm install to the installer package, end to end on a clean Mac: the agent installed with npm
// and started at sign-in, a sign-in with a code against a stand-in workspace, then the package over it. The package's
// agent takes the npm install over (its LaunchAgent and the hook entries), a push to main is blocked through the hook
// command Claude Code runs and the record reaches the workspace, `doctor` is green, and the package's uninstall script
// leaves nothing of the package behind. It installs for every user and changes this person's settings, so it runs only
// where SCOPEBOND_MACOS_JOURNEY=1 says so: the macOS CI job, on a throwaway runner, after the package test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FIRST_SIGNIN_FILE, LABEL, MAC_PACKAGE_EXE, MIGRATED_FILE } from "@scopebond/agent";
import { buildPkg } from "../build-pkg.mjs";
import { packLinked } from "../../hook/test/pack-local.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const enabled = process.platform === "darwin" && process.env.SCOPEBOND_MACOS_JOURNEY === "1";
const UNINSTALL = "/Library/Application Support/Scopebond/uninstall.sh";
// spawnSync blocks the event loop, so a stuck child would outlast node:test's own timeout: every one here is bounded.
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 3 * 60_000, ...opts });
  return { code: r.error?.code === "ETIMEDOUT" ? "timeout" : r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};
const sudo = (args) => run("sudo", ["-n", ...args], { timeout: 5 * 60_000 });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (check, ms) => {
  for (const end = Date.now() + ms; !(await check());) {
    if (Date.now() > end) return false;
    await sleep(500);
  }
  return true;
};
/** The stand-in workspace as its own process: the commands below run with spawnSync, which would block one in this process. */
async function fakeCloud(t) {
  const urlFile = join(mkdtempSync(join(tmpdir(), "sb-fake-cloud-")), "url.txt");
  const child = spawn(process.execPath, [join(here, "..", "..", "hook", "test", "fake-cloud.mjs"), "--url-file", urlFile, "--auto-approve"], { stdio: "ignore" });
  t.after(() => child.kill());
  assert.ok(await waitFor(() => existsSync(urlFile) && readFileSync(urlFile, "utf8").trim(), 30_000), "the fake workspace did not start");
  const url = readFileSync(urlFile, "utf8").trim();
  return { url, state: async () => (await fetch(`${url}/__test/state`)).json() };
}
const loaded = (uid) => run("launchctl", ["print", `gui/${uid}/${LABEL}`]);
/** The first PreToolUse command in this person's Claude Code settings. */
const hookCommand = () => JSON.parse(readFileSync(join(homedir(), ".claude", "settings.json"), "utf8")).hooks?.PreToolUse?.[0]?.hooks?.[0]?.command ?? null;
/** Run a configured hook command the way Claude Code does: through the shell, the event on stdin. */
const hookEvent = (command, payload) => new Promise((resolve) => {
  const child = spawn("/bin/sh", ["-c", command], { stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
  child.on("close", (code) => { clearTimeout(timer); resolve({ code, out }); });
  child.stdin.end(payload);
});

test("macOS: from an npm install to the package, sign in, block and deliver, take over, uninstall", { skip: !enabled && "macOS CI only (SCOPEBOND_MACOS_JOURNEY=1): it installs on this computer", timeout: 20 * 60_000 }, async (t) => {
  assert.equal(sudo(["true"]).code, 0, "needs sudo without a password (a CI runner)");
  const uid = process.getuid();
  const sbHome = process.env.SCOPEBOND_HOME ?? join(homedir(), ".scopebond");
  mkdirSync(sbHome, { recursive: true });
  // An agent with no connection signs the computer in to Scopebond Cloud on its first start and opens the browser:
  // marked as done, so nothing on the runner ever reaches the real service.
  if (!existsSync(join(sbHome, FIRST_SIGNIN_FILE))) writeFileSync(join(sbHome, FIRST_SIGNIN_FILE), "{}\n");
  const cloud = await fakeCloud(t);
  const project = mkdtempSync(join(tmpdir(), "sb-macos-journey-"));
  const packed = packLinked(["@scopebond/hook", "@scopebond/agent"]);
  const hookPackage = `file:${packed.get("@scopebond/hook")}`;
  const npx = (args) => run("npx", ["-y", hookPackage, ...args], { cwd: project, timeout: 5 * 60_000 });

  // 1. The agent installed with npm and started at sign-in, as a person did before the package existed.
  const install = run("npm", ["install", "-g", packed.get("@scopebond/agent")], { timeout: 5 * 60_000 });
  assert.equal(install.code, 0, install.out);
  const npmAgent = join(run("npm", ["prefix", "-g"]).out.trim(), "bin", "scopebond-agent");
  assert.ok(existsSync(npmAgent), `npm put no scopebond-agent at ${npmAgent}`);
  const own = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

  // 2. Sign in with a code, as Claude Code's person would; the hook goes into the user-level Claude Code settings.
  const login = npx(["login", cloud.url, "--claude"]);
  assert.equal(login.code, 0, login.out);
  assert.equal((await cloud.state()).approved_codes.length, 1, login.out);
  assert.ok(existsSync(join(sbHome, "cloud.json")), `no cloud.json in ${sbHome}`);
  assert.ok(hookCommand(), "no PreToolUse hook in ~/.claude/settings.json");
  const on = run(npmAgent, ["autostart", "on"]);
  assert.equal(on.code, 0, on.out);
  assert.ok(existsSync(own), `autostart on wrote no ${own}`);

  // 3. The package over the npm install. Its agent takes over: the person's own LaunchAgent goes (the package's starts the
  // agent now), the hook entries name the package's executable, and the move is recorded.
  const pkg = buildPkg(join(here, "..", "build", "scopebond-agent"), { identity: null });
  const removed = () => sudo([UNINSTALL]);
  const installed = sudo(["installer", "-pkg", pkg, "-target", "/"]);
  if (installed.code !== 0) removed();
  assert.equal(installed.code, 0, installed.out);
  try {
    assert.ok(await waitFor(() => /state = running/.test(loaded(uid).out), 60_000), `the package's agent runs: ${loaded(uid).out}`);
    assert.ok(await waitFor(() => existsSync(join(sbHome, MIGRATED_FILE)), 60_000), `no ${MIGRATED_FILE}: ${readFileSync(join(sbHome, "agent.log"), "utf8").slice(-3000)}`);
    assert.ok(!existsSync(own), "the npm agent's own LaunchAgent is gone");
    assert.ok(await waitFor(() => hookCommand()?.includes(MAC_PACKAGE_EXE), 30_000), `the hook entries name ${MAC_PACKAGE_EXE}: ${hookCommand()}`);
    assert.ok(!hookCommand().includes(dirname(npmAgent)), `no hook entry names the npm copy: ${hookCommand()}`);

    // 4. A push to main through the configured command: blocked, and one record reaches the workspace.
    const enforce = run(MAC_PACKAGE_EXE, ["hook", "rules", "enforce", "protect-branches", "--yes"], { cwd: project });
    assert.equal(enforce.code, 0, enforce.out);
    const before = (await cloud.state()).ingested;
    const payload = JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push origin main" }, cwd: project });
    const blocked = await hookEvent(hookCommand(), payload);
    assert.equal(blocked.code, 2, `expected a block (exit 2): ${blocked.out}`);
    const flush = run(MAC_PACKAGE_EXE, ["hook", "flush"], { cwd: project });
    assert.ok(await waitFor(async () => (await cloud.state()).ingested > before, 15_000), `nothing delivered. flush: ${flush.out}`);
    const state = await cloud.state();
    assert.equal(state.ingested - before, 1);
    assert.equal(state.ingested_results.at(-1), "deny");

    // 5. doctor is green on the package's install.
    const doctor = run(MAC_PACKAGE_EXE, ["hook", "doctor"], { cwd: project });
    assert.equal(doctor.code, 0, doctor.out);
  } catch (error) { removed(); throw error; }

  // 6. The uninstall script: the package is gone; the Scopebond folder stays without --purge.
  const uninstall = removed();
  assert.ok(uninstall.code === 0 || uninstall.code === 75, `exit ${uninstall.code}: ${uninstall.out}`);
  for (const file of [MAC_PACKAGE_EXE, `/Library/LaunchAgents/${LABEL}.plist`, dirname(UNINSTALL)]) assert.ok(!existsSync(file), `removed: ${file}`);
  assert.ok(await waitFor(() => loaded(uid).code !== 0, 15_000), "launchd no longer has the agent");
  assert.ok(existsSync(join(sbHome, "cloud.json")), "the Scopebond folder stays without --purge");
  run("npm", ["uninstall", "-g", "@scopebond/agent"]);
});
