// How long one hook call takes, end to end, as a coding agent sees it: start Node, run the installed program
// (`dist/cli.js claude`), read a PreToolUse event on stdin, decide, sign the receipt and exit. Agents run the hook on every
// tool call, so this is the delay a person feels on each one.
//
//   node scripts/bench-hook.mjs [--runs 40] [--warmup 5] [--cli dist/cli.js]... [--harness claude] [--no-git] [--json]
//
// Give --cli more than once to compare builds (an older checkout's dist/cli.js, say): their runs take turns, so a busy
// computer slows each of them alike.
// Everything happens in a new temporary folder: the project (a git repository with an `origin` remote, as an agent's
// working folder usually is, unless --no-git), its policy (scaffolded by `init --no-install`), and a home folder of its
// own (HOME, USERPROFILE and SCOPEBOND_HOME all point there), so nothing on this computer is read or changed.
// Build the package first (`pnpm run build`: tsc, then the command-line bundle).

import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const options = (name) => args.flatMap((arg, at) => (arg === `--${name}` && args[at + 1] !== undefined ? [args[at + 1]] : []));
const option = (name, fallback) => options(name)[0] ?? fallback;
const runs = Number(option("runs", "40"));
const warmup = Number(option("warmup", "5"));
const clis = (options("cli").length ? options("cli") : [join(here, "..", "dist", "cli.js")]).map((file) => resolve(file));
const harness = option("harness", "claude");
const asJson = args.includes("--json");

const root = realpathSync(mkdtempSync(join(tmpdir(), "sb-hook-bench-")));
const project = join(root, "project");
const home = join(root, "home");
mkdirSync(project, { recursive: true });
mkdirSync(home, { recursive: true });
const dir = join(project, ".scopebond");
const env = {
  ...process.env,
  HOME: home, USERPROFILE: home, SCOPEBOND_HOME: join(home, ".scopebond"), SCOPEBOND_HOOK_DIR: dir,
  // No connection and no update checks: only the local decision is timed.
  SCOPEBOND_HOOK_FLUSH_MS: "0",
};

if (!args.includes("--no-git")) {
  const git = (...gitArgs) => execFileSync("git", ["-C", project, ...gitArgs], { env, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("remote", "add", "origin", "https://github.com/example/project.git");
}
execFileSync(process.execPath, [clis[0], "init", "--no-install", "--yes"], { cwd: project, env, stdio: "ignore" });

const events = {
  claude: (i) => ({ session_id: "bench", hook_event_name: "PreToolUse", cwd: project, tool_name: "Bash", tool_input: { command: "git status" }, tool_use_id: `toolu_bench_${i}` }),
  codex: (i) => ({ session_id: "bench", hook_event_name: "PreToolUse", cwd: project, tool_name: "Bash", tool_input: { command: "git status" }, tool_use_id: `call_bench_${i}` }),
  cursor: (i) => ({ hook_event_name: "beforeShellExecution", command: "git status", cwd: project, conversation_id: "bench", generation_id: `gen_${i}` }),
  copilot: (i) => ({ hook_event_name: "PreToolUse", cwd: project, session_id: "bench", tool_name: "bash", tool_input: { command: `git status # ${i}` } }),
};
if (!events[harness]) { console.error(`unknown harness: ${harness}`); process.exit(1); }

const times = clis.map(() => []);
for (let i = 0; i < warmup + runs; i++) {
  for (const [n, cli] of clis.entries()) {
    const input = JSON.stringify(events[harness](i * clis.length + n));
    const started = performance.now();
    const run = spawnSync(process.execPath, [cli, harness], { cwd: project, env, input, encoding: "utf8" });
    const ms = performance.now() - started;
    if (run.status !== 0 || /deny|failed closed/i.test(run.stdout)) {
      console.error(`${cli}: the hook did not allow the call (exit ${run.status}):\n${run.stdout}${run.stderr}`);
      process.exit(1);
    }
    if (i >= warmup) times[n].push(ms);
  }
}
const round = (ms) => Math.round(ms * 10) / 10;
for (const [n, cli] of clis.entries()) {
  const sorted = times[n].sort((a, b) => a - b);
  const quantile = (q) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
  const result = { cli, harness, runs, node: process.version, median_ms: round(quantile(0.5)), p95_ms: round(quantile(0.95)), min_ms: round(sorted[0]), max_ms: round(sorted[sorted.length - 1]) };
  if (asJson) console.log(JSON.stringify(result));
  else console.log(`${harness}${clis.length > 1 ? ` ${cli}` : ""}: median ${result.median_ms} ms, p95 ${result.p95_ms} ms (min ${result.min_ms}, max ${result.max_ms}; ${runs} runs after ${warmup} warm-up, Node ${process.version})`);
}
