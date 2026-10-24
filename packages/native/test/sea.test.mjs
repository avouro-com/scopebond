// The single executable decides exactly as the npm hook does, and starts quickly. The bundle check runs everywhere; the
// executable itself is built and run where SCOPEBOND_SEA=1 (the Windows and macOS CI jobs that build it).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle, buildSea } from "../build-sea.mjs";
import { readVersionInfo } from "../stamp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const hookCli = join(here, "..", "..", "hook", "dist", "cli.js");
const enabled = process.env.SCOPEBOND_SEA === "1";
/** The ceiling the CI job enforces on a shared runner; the target on a person's computer is 150 ms (measured 161 ms on a
 *  laptop where the npm hook takes 356 ms). The median is printed either way. */
const CEILING_MS = Number(process.env.SCOPEBOND_SEA_CEILING_MS ?? 300);

test("the agent and the hook bundle into one file with nothing left to load at run time", async () => {
  const file = await bundle();
  const code = readFileSync(file, "utf8");
  assert.doesNotMatch(code, /\bimport\(\s*["'`]/, "no real dynamic import");
  assert.match(code, /var __sbUrl = require\("node:url"\)\.pathToFileURL\(process\.execPath\)\.href;/);
  assert.doesNotMatch(code, /__SCOPEBOND_HOOK_VERSION__|__SCOPEBOND_AGENT_VERSION__/, "versions are fixed at build time");
});

test("the single executable decides a Claude Code call exactly as the npm hook does, and starts quickly", { skip: !enabled && "set SCOPEBOND_SEA=1 to build and run the executable" }, async () => {
  const exe = await buildSea();
  assert.ok(existsSync(exe));
  const home = mkdtempSync(join(tmpdir(), "sb-sea-"));
  const project = join(home, "proj");
  mkdirSync(project);
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData"), LOCALAPPDATA: join(home, "Local"),
    SCOPEBOND_HOME: join(home, ".sbhome"), SCOPEBOND_OBSERVATIONS_HEARTBEAT: "off", SCOPEBOND_HOOK_DIR: join(project, ".scopebond"),
  };
  const init = spawnSync(exe, ["hook", "init", "--claude", "--yes"], { cwd: project, env, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  const event = (tool, input) => JSON.stringify({ hook_event_name: "PreToolUse", session_id: "sea", tool_name: tool, tool_input: input, cwd: project });
  const decide = (viaExe, input, runEnv = env) => {
    const [program, args] = viaExe ? [exe, ["hook", "claude"]] : [process.execPath, [hookCli, "claude"]];
    const started = performance.now();
    const run = spawnSync(program, args, { input, env: runEnv, cwd: project, encoding: "utf8" });
    return { ms: performance.now() - started, status: run.status, decision: run.stdout ? JSON.parse(run.stdout).hookSpecificOutput?.permissionDecision ?? null : null, stderr: run.stderr };
  };
  const cases = [
    ["Write", { file_path: join(project, ".scopebond", "policy.json"), content: "{}" }],
    ["Read", { file_path: "README.md" }],
    ["Bash", { command: "git status" }],
    ["Bash", { command: "rm -rf /" }],
  ];
  for (const [tool, input] of cases) {
    const a = decide(true, event(tool, input));
    const b = decide(false, event(tool, input));
    assert.deepEqual({ status: a.status, decision: a.decision }, { status: b.status, decision: b.decision }, `${tool} ${JSON.stringify(input)}: ${a.stderr}`);
  }
  assert.equal(decide(true, event(...cases[0])).decision, "deny", "Scopebond's own folder stays protected");
  const log = spawnSync(exe, ["hook", "log"], { cwd: project, env, encoding: "utf8" });
  assert.match(log.stdout, /receipt\(s\)/, "receipts are written to the store");
  // Warm starts: the first runs pay for the operating system's first look at a new file. Measured on the project's own
  // setup, the same way on every run (a user-level install below adds a second home the hook also looks at).
  // On a shared runner another job can slow a whole round of calls down (once a median of 357 ms where the rounds around
  // it measured under 200 ms). That noise only ever adds time, so a round over the ceiling is measured again, up to three
  // times, and the fastest median counts: a real slowdown fails every round.
  const warmMedian = (runEnv) => {
    let best = Infinity;
    for (let round = 0; round < 3 && best >= CEILING_MS; round++) {
      const times = [];
      for (let i = 0; i < 22; i++) times.push(decide(true, event("Read", { file_path: "README.md" }), runEnv).ms);
      best = Math.min(best, times.slice(2).sort((x, y) => x - y)[10]);
    }
    return best;
  };
  const median = warmMedian(env);
  console.log(`single executable: median warm hook call ${median.toFixed(0)} ms`);
  assert.ok(median < CEILING_MS, `median ${median.toFixed(0)} ms`);
  // Installed for the user, the coding agent's settings name the executable itself: no Node, npm or npx.
  const install = spawnSync(exe, ["hook", "install", "--claude", "--yes"], { cwd: home, env: { ...env, SCOPEBOND_HOOK_DIR: "" }, encoding: "utf8" });
  assert.equal(install.status, 0, install.stdout + install.stderr);
  const settings = readFileSync(join(home, ".claude", "settings.json"), "utf8");
  // On Windows the path is written unquoted with forward slashes (short names for any folder a shell would misread), the
  // form cmd.exe, PowerShell and Git Bash all start; elsewhere it is quoted.
  const command = JSON.parse(settings).hooks.PreToolUse[0].hooks[0].command;
  assert.ok(command === `"${exe}" hook claude` || (process.platform === "win32" && /^[A-Za-z]:\/\S+\/scopebond-agent\.exe hook claude$/.test(command)), settings);
  const doctor = spawnSync(exe, ["hook", "doctor"], { cwd: home, env: { ...env, SCOPEBOND_HOOK_DIR: "" }, encoding: "utf8" });
  assert.doesNotMatch(doctor.stdout, /cannot start|could not start/i, doctor.stdout);
  // With the user-level install beside the project's own setup (the hook finds the project's folder itself, no pinned
  // folder), a call costs what it cost before: the second home adds no work per call. Once (2026-10-07) a run measured
  // 284 ms here against 156 ms; the npm hook measures the same in both setups (289 and 293 ms on a laptop).
  const besideUser = warmMedian({ ...env, SCOPEBOND_HOOK_DIR: "" });
  console.log(`single executable beside a user-level install: median warm hook call ${besideUser.toFixed(0)} ms`);
  assert.ok(besideUser < CEILING_MS, `median beside a user-level install ${besideUser.toFixed(0)} ms`);
  assert.ok(besideUser <= median * 1.2 + 25, `beside a user-level install ${besideUser.toFixed(0)} ms against ${median.toFixed(0)} ms`);
});

test("the single executable says it is the Scopebond Agent at this release, and still runs once stamped", { skip: (!enabled || process.platform !== "win32") && "set SCOPEBOND_SEA=1 on Windows to build and run the executable" }, async () => {
  const built = join(here, "..", "build", "scopebond-agent.exe");
  const exe = existsSync(built) ? built : await buildSea();
  const agent = JSON.parse(readFileSync(join(here, "..", "..", "agent", "package.json"), "utf8")).version;
  const info = readVersionInfo(exe);
  assert.equal(info.fileVersion, `${agent}.0`, "the agent's version, not Node's");
  assert.equal(info.productVersion, `${agent}.0`);
  assert.equal(info.strings.FileDescription, "Scopebond Agent", "the name Task Manager shows");
  assert.equal(info.strings.ProductName, "Scopebond");
  assert.equal(info.strings.CompanyName, "Avouro LLC");
  assert.equal(info.strings.OriginalFilename, "scopebond-agent.exe");
  assert.ok(info.icons >= 1, "an icon");
  assert.ok(info.seaBlob, "the application blob is still in the file");
  const run = spawnSync(exe, ["--version"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.stdout.startsWith(`agent/${agent} hook/`), run.stdout);
  assert.doesNotMatch(run.stderr, /SingleExecutableApplication|experimental/i, "it starts as the application, not as plain Node");
  assert.ok(existsSync(join(here, "..", "build", "scopebond.ico")), "the icon the installer uses is written beside it");
});

test("on macOS the single executable carries a valid (ad-hoc) signature, so Apple silicon lets it run", { skip: (!enabled || process.platform !== "darwin") && "set SCOPEBOND_SEA=1 on macOS to build and run the executable" }, async () => {
  const built = join(here, "..", "build", "scopebond-agent");
  const exe = existsSync(built) ? built : await buildSea();
  const verify = spawnSync("codesign", ["--verify", "--strict", exe], { encoding: "utf8" });
  assert.equal(verify.status, 0, verify.stderr);
  const agent = JSON.parse(readFileSync(join(here, "..", "..", "agent", "package.json"), "utf8")).version;
  const run = spawnSync(exe, ["--version"], { encoding: "utf8" });
  assert.equal(run.status, 0, `exit ${run.status} ${run.signal ?? ""} ${run.stderr}`);
  assert.ok(run.stdout.startsWith(`agent/${agent} hook/`), run.stdout);
});

test("inside the single executable: a signed plugin loads and fills the slot; an unverifiable engine bundle never runs", { skip: !enabled && "set SCOPEBOND_SEA=1 to build and run the executable" }, async () => {
  const built = join(here, "..", "build", process.platform === "win32" ? "scopebond-agent.exe" : "scopebond-agent");
  const exe = existsSync(built) ? built : await buildSea();
  const home = mkdtempSync(join(tmpdir(), "sb-sea-slot-"));
  const project = join(home, "proj");
  mkdirSync(project);
  const sbHome = join(home, ".sbhome");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keyEntry = { key_id: "pol_sea_test", public_key: publicKey.export({ type: "spki", format: "pem" }).toString(), not_before: "2026-01-01T00:00:00Z", not_after: "2030-01-01T00:00:00Z" };
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData"), LOCALAPPDATA: join(home, "Local"),
    SCOPEBOND_HOME: sbHome, SCOPEBOND_OBSERVATIONS_HEARTBEAT: "off", SCOPEBOND_HOOK_DIR: join(project, ".scopebond"),
    SCOPEBOND_POLICY_KEYS_JSON: JSON.stringify([keyEntry]),
  };
  assert.equal(spawnSync(exe, ["hook", "init", "--claude", "--yes"], { cwd: project, env, encoding: "utf8" }).status, 0);
  // The plugin: loaded by the executable through Node's default loader (the executable's own code cannot import a file).
  const source = Buffer.from('export function inspect(action) { return { pattern_id: "' + "c".repeat(64) + '", slot: Buffer.from(action.action_type).toString("base64") }; }\n');
  const sha256 = createHash("sha256").update(source).digest("hex");
  mkdirSync(join(sbHome, "intel", "current"), { recursive: true });
  writeFileSync(join(sbHome, "intel", "current", "intel.mjs"), source);
  writeFileSync(join(sbHome, "intel", "current", "manifest.json"), JSON.stringify({ version: "1.0.0", sha256, signature: sign(null, Buffer.from(`scopebond:component/intel/v1\n${sha256}`), privateKey).toString("base64"), key_id: "pol_sea_test" }));
  // An engine bundle no updater key signed, named as current: the executable must not run it.
  mkdirSync(join(sbHome, "engine", "99.0.0"), { recursive: true });
  writeFileSync(join(sbHome, "engine", "99.0.0", "scopebond-hook.cjs"), 'module.exports.run = async () => { process.stdout.write("hijacked"); };\n');
  writeFileSync(join(sbHome, "engine", "99.0.0", "manifest.json"), "{}");
  writeFileSync(join(sbHome, "engine", "99.0.0", "manifest.json.sig"), "AAAA");
  writeFileSync(join(sbHome, "engine", "current.json"), JSON.stringify({ version: "99.0.0", at: Date.now(), previous: null }));
  const input = JSON.stringify({ hook_event_name: "PreToolUse", session_id: "sea-slot", tool_name: "Bash", tool_input: { command: "git status" }, cwd: project });
  const run = spawnSync(exe, ["hook", "claude"], { input, env, cwd: project, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.doesNotMatch(run.stdout, /hijacked/);
  assert.match(readFileSync(join(sbHome, "engine", "start-failures.log"), "utf8"), /99\.0\.0/, "the refusal is recorded");
  const { openReceiptStore } = await import(new URL("../../gateway/dist/node.js", import.meta.url).href);
  const { store } = openReceiptStore({ db: join(project, ".scopebond", "receipts.db") });
  const receipts = await Promise.resolve(store.list());
  await Promise.resolve(store.close?.());
  assert.ok(receipts.length > 0 && receipts.every((r) => r.payload.pattern_id === "c".repeat(64)), "every receipt carries the plugin's pattern id");
  // A candidate that does not verify fails the check instead of passing on the engine inside.
  const candidate = spawnSync(exe, ["hook", "packs", "test", "--all", "--json"], { cwd: project, env: { ...env, SCOPEBOND_ENGINE_CANDIDATE: "99.0.0" }, encoding: "utf8" });
  assert.equal(candidate.status, 3, candidate.stdout + candidate.stderr);
  assert.match(candidate.stderr, /candidate engine 99\.0\.0/);
});
