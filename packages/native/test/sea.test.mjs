// The single executable decides exactly as the npm hook does, and starts quickly. The bundle check runs everywhere; the
// executable itself is built and run where SCOPEBOND_SEA=1 (the Windows CI job that builds it).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
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
