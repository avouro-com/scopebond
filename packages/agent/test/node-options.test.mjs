// NODE_OPTIONS (`--require=…`, `--import=…`) and NODE_REPL_EXTERNAL_MODULE make a Node.js program load code of someone else's
// choosing before its own. Any program running as the person can set them for every later sign-in, so the agent never hands
// them to a process it starts: it removes them from its own environment when it starts, and from a handover's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as agent from "../dist/index.js";

const dist = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist");

test("the variables are removed in any case, and nothing else is", () => {
  const { scrubNodeInjection, withoutNodeInjection } = agent;
  const env = { PATH: "x", NODE_OPTIONS: "--require=/tmp/p.js", node_repl_external_module: "/tmp/m.js", NODE_EXTRA_CA_CERTS: "/ca.pem" };
  const copy = withoutNodeInjection(env);
  assert.deepEqual(copy, { PATH: "x", NODE_EXTRA_CA_CERTS: "/ca.pem" });
  assert.equal(env.NODE_OPTIONS, "--require=/tmp/p.js", "a copy leaves the original as it was");
  assert.deepEqual(scrubNodeInjection(env).sort(), ["NODE_OPTIONS", "node_repl_external_module"]);
  assert.deepEqual(env, { PATH: "x", NODE_EXTRA_CA_CERTS: "/ca.pem" });
});

test("the updated agent is never started with them", () => {
  const plan = agent.handoverPlan({ dir: join(tmpdir(), "sb-x"), cli: "/npm/cli.js", pid: 1, execPath: "/node", platform: "darwin", launcherText: null,
    env: { PATH: "x", NODE_OPTIONS: "--require=/tmp/p.js", NODE_REPL_EXTERNAL_MODULE: "/tmp/m.js" } });
  assert.equal(plan.kind, "spawn");
  assert.equal(plan.env.NODE_OPTIONS, undefined);
  assert.equal(plan.env.NODE_REPL_EXTERNAL_MODULE, undefined);
  assert.equal(plan.env.PATH, "x");
});

test("the agent removes them from its own environment when it starts, so no child inherits them", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-node-options-"));
  try {
    const script = join(dir, "probe.mjs");
    // Set at run time, not in the probe's own environment, so the probe itself loads nothing.
    writeFileSync(script, [
      `process.env.NODE_OPTIONS = "--require=" + ${JSON.stringify(join(dir, "never.cjs"))};`,
      `process.env.NODE_REPL_EXTERNAL_MODULE = "x";`,
      `const { main } = await import(${JSON.stringify(pathToFileURL(join(dist, "cli-main.js")).href)});`,
      `await main(["help"]);`,
      `process.stderr.write("\\nPROBE " + JSON.stringify({ options: process.env.NODE_OPTIONS ?? null, repl: process.env.NODE_REPL_EXTERNAL_MODULE ?? null }) + "\\n");`,
    ].join("\n"));
    const env = { ...process.env, HOME: dir, USERPROFILE: dir, SCOPEBOND_HOME: join(dir, ".scopebond"), SCOPEBOND_AGENT_TRAY: "off" };
    delete env.NODE_OPTIONS;
    const r = spawnSync(process.execPath, [script], { encoding: "utf8", env, timeout: 60_000 });
    const line = r.stderr.split(/\r?\n/).find((l) => l.startsWith("PROBE "));
    assert.ok(line, r.stderr);
    assert.deepEqual(JSON.parse(line.slice(6)), { options: null, repl: null });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
