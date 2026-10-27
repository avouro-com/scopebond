// The default help lists the everyday commands; `help --advanced` adds the rest. `doctor --json` prints the same checks as
// one JSON document (scopebond.doctor.v1) for scripts and support, and exits as doctor does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const ADVANCED = ["budget", "delegation", "capabilities", "observations", "policy", "prune", "trust", "dedupe", "intel"];
const listed = (help) => new Set([...help.matchAll(/^ {2}([a-z]+) {2,}/gm)].map((m) => m[1]));

test("help: the default lists everyday commands and points to help --advanced, which lists the rest", () => {
  const help = execFileSync(process.execPath, [cli, "help"], { encoding: "utf8" });
  for (const name of ADVANCED) assert.ok(!listed(help).has(name), `${name} is not in the default help`);
  for (const name of ["init", "status", "doctor", "log", "rules"]) assert.ok(listed(help).has(name), `${name} is in the default help`);
  assert.match(help, /help --advanced` for more/);
  const advanced = execFileSync(process.execPath, [cli, "help", "--advanced"], { encoding: "utf8" });
  assert.match(advanced, /Advanced commands:/);
  for (const name of ADVANCED) assert.ok(listed(advanced).has(name), `${name} is in help --advanced`);
  assert.doesNotMatch(advanced, /no such command/);
  // An advanced command's own help still works.
  assert.match(execFileSync(process.execPath, [cli, "help", "trust"], { encoding: "utf8" }), /^scopebond-hook trust/);
  assert.match(execFileSync(process.execPath, [cli, "help", "intel"], { encoding: "utf8" }), /^scopebond-hook intel/);
});

test("doctor --json: one JSON document, scopebond.doctor.v1, every check named, failing ones with their fix", () => {
  const project = mkdtempSync(join(tmpdir(), "sb-hook-doctor-json-"));
  const env = { ...process.env, SCOPEBOND_HOOK_DIR: join(project, ".scopebond") };
  execFileSync(process.execPath, [cli, "init", "--no-install", "--yes"], { encoding: "utf8", cwd: project, env });
  const run = spawnSync(process.execPath, [cli, "doctor", "--json"], { encoding: "utf8", cwd: project, env });
  const report = JSON.parse(run.stdout);
  assert.equal(report.schema, "scopebond.doctor.v1");
  assert.ok(Array.isArray(report.checks) && report.checks.length > 0);
  for (const check of report.checks) {
    assert.equal(typeof check.name, "string");
    assert.equal(typeof check.ok, "boolean");
    assert.equal(typeof check.detail, "string");
    if (!check.ok) assert.equal(typeof check.fix, "string", `${check.name} says how to fix it`);
  }
  assert.deepEqual(report.checks.find((c) => c.name === "node"), { name: "node", ok: true, detail: process.versions.node });
  assert.equal(report.checks.find((c) => c.name === "config")?.ok, true);
  // No coding agent is wired here (--no-install), so doctor fails, and says so as a check and in the count.
  const agent = report.checks.find((c) => c.name === "coding agent");
  assert.equal(agent?.ok, false);
  assert.match(agent.fix, /no coding agent is configured/);
  assert.equal(report.problems, report.checks.filter((c) => !c.ok).length);
  assert.equal(run.status, 1);
  // The human output is unchanged.
  const human = spawnSync(process.execPath, [cli, "doctor"], { encoding: "utf8", cwd: project, env });
  assert.match(human.stdout, /^Scopebond doctor/);
  assert.match(human.stdout, /problem\(s\): .*no coding agent is configured/);
});
