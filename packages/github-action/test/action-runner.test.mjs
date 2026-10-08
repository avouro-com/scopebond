// What code the composite action runs, and from where. The check step must run a version pinned
// by the action itself (its own package.json unless the `version` input says otherwise), install
// it outside the checked-out workspace so a workspace node_modules or .npmrc cannot choose the
// code, and hand inputs to the script through env rather than template expansion.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, "..");
const actionYml = readFileSync(join(pkgDir, "action.yml"), "utf8");
const pkgVersion = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).version;
const GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";
const BASH = process.platform === "win32" && existsSync(GIT_BASH) ? GIT_BASH : "bash";
const fwd = (p) => p.replace(/\\/g, "/");

/** The `run:` script of a composite step (literal `|` block, or a folded `>` block joined with spaces). */
function stepScript(name) {
  const lines = actionYml.split(/\r?\n/);
  const step = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  const runAt = lines.findIndex((l, i) => i > step && /^\s+run: [|>]/.test(l));
  const folded = lines[runAt].trim() === "run: >";
  const body = [];
  for (let i = runAt + 1; i < lines.length && (/^ {8}/.test(lines[i]) || lines[i].trim() === ""); i++) body.push(lines[i].replace(/^ {8}/, ""));
  return folded ? body.join(" ") + "\n" : body.join("\n") + "\n";
}
const checkStep = () => {
  const lines = actionYml.split(/\r?\n/);
  const step = lines.findIndex((l) => l.trim() === "- name: Scopebond policy check");
  return lines.slice(step).join("\n");
};

test("the action never runs npx, expands no inputs inside a run script, and pins the CLI to the action's own version by default", () => {
  assert.doesNotMatch(actionYml, /\bnpx\b/);
  assert.doesNotMatch(actionYml, /default: "latest"/);
  for (const name of ["Determine the changed paths", "Scopebond policy check"]) {
    assert.doesNotMatch(stepScript(name), /\$\{\{/, `${name}: inputs reach the script through env, never template expansion`);
  }
  assert.match(checkStep(), /working-directory: \$\{\{ runner\.temp \}\}/);
  assert.match(checkStep(), /SCOPEBOND_POLICY: \$\{\{ inputs\.policy \}\}/);
  assert.match(checkStep(), /GITHUB_ACTION_PATH/);
});

/** Run the check step's script with a stub `npm` that "installs" a fixture CLI into the prefix. */
function runCheckStep({ version = "", policy = "scopebond.policy.json" } = {}) {
  // Long-form path: on Windows the temp dir may be an 8.3 short name that a child process reports in full.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "sb-action-npm-")));
  const ws = join(root, "workspace"); const runnerTemp = join(root, "runner-temp"); const bin = join(root, "bin");
  for (const d of [ws, runnerTemp, bin]) mkdirSync(d);
  // A checked-out workspace that carries its own copy of the package and its own registry.
  const wsPkg = join(ws, "node_modules", "@scopebond", "github-action");
  mkdirSync(join(wsPkg, "dist"), { recursive: true });
  writeFileSync(join(wsPkg, "package.json"), JSON.stringify({ name: "@scopebond/github-action", version: pkgVersion, bin: { "scopebond-verify-pr": "dist/cli.js" } }));
  writeFileSync(join(wsPkg, "dist", "cli.js"), "console.log('WORKSPACE-CODE-RAN');\n");
  writeFileSync(join(ws, "package.json"), JSON.stringify({ name: "ws", version: "1.0.0" }));
  writeFileSync(join(ws, ".npmrc"), "registry=http://127.0.0.1:4873/\n");
  // The stub npm records where and how it was run, then installs the fixture CLI into --prefix.
  const log = join(root, "npm.log");
  writeFileSync(join(root, "npm.mjs"), `
    import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    const args = process.argv.slice(2);
    appendFileSync(${JSON.stringify(log)}, JSON.stringify({ cwd: process.cwd(), args }) + "\\n");
    const prefix = args[args.indexOf("--prefix") + 1];
    const dir = join(prefix, "node_modules", "@scopebond", "github-action", "dist");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "cli.js"), "console.log('PINNED-CLI-RAN ' + JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2), policy: process.env.SCOPEBOND_POLICY }));\\n");
  `);
  writeFileSync(join(bin, "npm"), `#!/bin/sh\nexec node "${fwd(join(root, "npm.mjs"))}" "$@"\n`, { mode: 0o755 });
  writeFileSync(join(bin, "npx"), `#!/bin/sh\necho NPX-RAN\nexit 1\n`, { mode: 0o755 });
  const env = {
    ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? process.env.Path ?? ""}`,
    RUNNER_TEMP: fwd(runnerTemp), GITHUB_WORKSPACE: fwd(ws), GITHUB_ACTION_PATH: fwd(pkgDir),
    SCOPEBOND_POLICY: policy, SCOPEBOND_ACTION_VERSION: version, SCOPEBOND_POLICY_SOURCE: "base",
  };
  delete env.Path;
  const r = spawnSync(BASH, ["-c", stepScript("Scopebond policy check")], { cwd: runnerTemp, env, encoding: "utf8" });
  const npmCalls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { r, npmCalls, ws, runnerTemp };
}
const norm = (p) => fwd(existsSync(p) ? realpathSync.native(p) : p).replace(/\/+$/, "").toLowerCase();
const same = (a, b) => norm(a) === norm(b);

test("the check step installs the action's own version outside the workspace and runs it from the workspace", () => {
  const { r, npmCalls, ws, runnerTemp } = runCheckStep();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /WORKSPACE-CODE-RAN|NPX-RAN/);
  assert.equal(npmCalls.length, 1);
  const [{ cwd, args }] = npmCalls;
  assert.ok(!same(cwd, ws) && same(cwd, runnerTemp), `npm ran in ${cwd}`);
  assert.ok(args.includes(`@scopebond/github-action@${pkgVersion}`), `pinned to the package's own version: ${args.join(" ")}`);
  assert.ok(args.includes("--ignore-scripts"));
  const prefix = args[args.indexOf("--prefix") + 1];
  assert.ok(prefix && fwd(prefix).startsWith(fwd(runnerTemp)), `installed under the runner temp dir: ${prefix}`);
  const ran = JSON.parse(r.stdout.slice(r.stdout.indexOf("PINNED-CLI-RAN ") + 15).split("\n")[0]);
  assert.ok(same(ran.cwd, ws), `the CLI runs from the workspace: ${ran.cwd}`);
});

test("inputs reach the check step as data: an explicit version is used and a hostile policy value is not executed", () => {
  const hostile = 'p.json"; echo INJECTED; "';
  const { r, npmCalls } = runCheckStep({ version: "0.5.7", policy: hostile });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /^INJECTED/m);
  assert.ok(npmCalls[0].args.includes("@scopebond/github-action@0.5.7"));
  const ran = JSON.parse(r.stdout.slice(r.stdout.indexOf("PINNED-CLI-RAN ") + 15).split("\n")[0]);
  assert.equal(ran.policy, hostile);
  assert.equal(ran.argv[ran.argv.indexOf("--policy") + 1], hostile);
});

test("an invalid version input fails closed before anything is installed", () => {
  for (const version of ["1.0.0 && echo x", "../x", "1.0.0\n::error::x"]) {
    const { r, npmCalls } = runCheckStep({ version });
    assert.notEqual(r.status, 0, version);
    assert.equal(npmCalls.length, 0, version);
    assert.doesNotMatch(r.stdout + r.stderr, /^::/m);
  }
});
