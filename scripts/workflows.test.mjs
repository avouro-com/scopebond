// The release workflows hold the publishing credentials (the npm token, the automation token, the signing session), so
// their shape is locked here: credentials only in the step that uses them, publishing only from the merged
// "Version packages" pull request, and no build-time or tool-restore code running beside a credential it does not need.
//
// The workflows are read as text with a small indentation reader (GitHub's own layout: jobs at two spaces, job keys at
// four, steps at six), so the test needs no YAML package.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const workflowsDir = join(dirname(fileURLToPath(import.meta.url)), "..", ".github", "workflows");
const NPM_SECRET = /secrets\.NPM_TOKEN\w*/;
const AUTOMATION_SECRET = /secrets\.PERSONAL_ACCESS_TOKEN/;

const indentOf = (line) => line.length - line.trimStart().length;

/** A workflow as top-level text, and each job's header (keys before `steps:`) and steps, comments removed. */
function readWorkflow(name) {
  const lines = readFileSync(join(workflowsDir, name), "utf8").replace(/\r\n/g, "\n").split("\n")
    .filter((line) => !/^\s*#/.test(line));
  const top = [];
  const jobs = new Map();
  let inJobs = false;
  let job = null;
  let inSteps = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    const indent = indentOf(line);
    if (indent === 0) {
      inJobs = line.startsWith("jobs:");
      job = null;
      if (!inJobs) top.push(line);
      continue;
    }
    if (!inJobs) { top.push(line); continue; }
    if (indent === 2) {
      job = { name: line.trim().replace(/:$/, ""), header: [], steps: [] };
      jobs.set(job.name, job);
      inSteps = false;
      continue;
    }
    if (!job) continue;
    if (indent === 4) {
      inSteps = line.trim() === "steps:";
      if (!inSteps) job.header.push(line);
      continue;
    }
    if (inSteps && indent === 6 && line.trimStart().startsWith("- ")) { job.steps.push([line]); continue; }
    if (inSteps && job.steps.length) job.steps[job.steps.length - 1].push(line);
    else job.header.push(line);
  }
  return {
    top: top.join("\n"),
    jobs: [...jobs.values()].map((j) => ({ name: j.name, header: j.header.join("\n"), steps: j.steps.map((s) => s.join("\n")) })),
  };
}

/** The lines under `key:` inside a block of text (one level deeper than the key). */
function section(text, key) {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => line.trim() === `${key}:`);
  if (at === -1) return "";
  const base = indentOf(lines[at]);
  const out = [];
  for (const line of lines.slice(at + 1)) {
    if (indentOf(line) <= base) break;
    out.push(line);
  }
  return out.join("\n");
}

/** The trigger names under the top-level `on:` key. */
function onTriggers(top) {
  return Object.fromEntries(section(top, "on").split("\n").filter((line) => indentOf(line) === 2)
    .map((line) => [line.trim().replace(/:.*$/, ""), true]));
}

const isCheckout = (step) => /uses:\s*actions\/checkout@/.test(step);
const workflowNames = () => readdirSync(workflowsDir).filter((name) => /\.ya?ml$/.test(name));

test("the release workflow grants nothing at the top and checks out without keeping a token", () => {
  const release = readWorkflow("release.yml");
  assert.match(release.top, /^permissions: \{\}$/m, "release.yml: top-level permissions are empty; each job asks for its own");
  for (const job of release.jobs) assert.match(job.header, /^ {4}permissions:/m, `release.yml ${job.name}: job-level permissions`);
  const checkouts = release.jobs.flatMap((job) => job.steps.filter(isCheckout));
  assert.ok(checkouts.length >= 1, "release.yml checks out the repository");
  for (const step of checkouts) assert.match(step, /persist-credentials: false/, "release.yml: checkout keeps no token in the git config");
});

test("the npm token reaches only the publish step, never install, build or the job's environment", () => {
  const release = readWorkflow("release.yml");
  assert.doesNotMatch(release.top, NPM_SECRET, "release.yml: no workflow-level npm token");
  const holders = release.jobs.flatMap((job) => job.steps.filter((step) => NPM_SECRET.test(step)).map((step) => ({ job, step })));
  assert.equal(holders.length, 1, "release.yml: exactly one step has the npm token");
  const [{ job, step }] = holders;
  assert.doesNotMatch(job.header, NPM_SECRET, `release.yml ${job.name}: no job-level npm token`);
  assert.match(section(step, "env"), NPM_SECRET, "release.yml: the npm token is in the publish step's env");
  assert.doesNotMatch(step, /pnpm install|-r build|pnpm release|version:packages/, "release.yml: the publish step does not install or build");
  assert.doesNotMatch(job.header + job.steps.join("\n"), AUTOMATION_SECRET, "release.yml: the publish job has no automation token");
  for (const other of job.steps) {
    if (other !== step) assert.doesNotMatch(other, /secrets\./, "release.yml: the publish job's other steps have no secrets");
  }
  assert.match(job.header, /^ {4}environment:/m, "release.yml: the publish job runs in a named environment");
});

test("publishing runs only for the merged Version packages pull request with no changesets left", () => {
  const release = readWorkflow("release.yml");
  const publishJob = release.jobs.find((job) => job.steps.some((step) => NPM_SECRET.test(step)));
  const condition = publishJob.header.match(/^ {4}if: (.*)$/m)?.[1] ?? "";
  // select-mode answers "publish" only when no changesets are pending and some version is missing from npm.
  assert.match(condition, /needs\.version\.outputs\.mode == 'publish' && /, "release.yml: no publish while changesets are pending");
  // A push publishes only as the Version packages merge; the one other way in is a maintainer's manual run on main.
  const merge = condition.replace(/^.*?&& /, "");
  assert.equal(merge, "(needs.check.outputs.versionMerge == 'true' || github.event_name == 'workflow_dispatch')",
    "release.yml: publish only for the Version packages merge (or a manual re-run)");
  assert.deepEqual(Object.keys(onTriggers(release.top)).sort(), ["push", "workflow_dispatch"], "release.yml: no other trigger reaches publish");
  const pack = release.jobs.find((job) => job.steps.some((step) => /changesets\/action\/pack@/.test(step)));
  assert.ok(pack, "release.yml: a job packs the planned packages");
  assert.equal(pack.header.match(/^ {4}if: (.*)$/m)?.[1], condition, "release.yml: packing runs under the same condition");
  assert.ok(publishJob.header.includes("- pack") || /needs: \[[^\]]*\bpack\b/.test(publishJob.header), "release.yml: publish takes the packed tarballs");
  const versionJob = release.jobs.find((job) => job.steps.some((step) => /versionMerge=/.test(step)));
  assert.ok(versionJob, "release.yml: a step works out whether this push is the Version packages merge");
  const check = versionJob.steps.find((step) => /versionMerge=/.test(step));
  assert.match(check, /changeset-release\/main/, "the check names the Version packages branch");
  assert.match(check, /merge_commit_sha/, "the check ties the pull request to this exact commit");
  assert.doesNotMatch(check, AUTOMATION_SECRET, "the check reads with the workflow token only");
  // The step holding the automation token opens the Version packages pull request and publishes nothing.
  for (const job of release.jobs) {
    for (const step of job.steps.filter((s) => AUTOMATION_SECRET.test(s))) {
      assert.doesNotMatch(step, /^\s+publish(-script)?:/m, "release.yml: the version step has no publish command");
      assert.doesNotMatch(step, NPM_SECRET, "release.yml: the version step has no npm token");
    }
  }
});

test("npm trusted publishing: only the publish job can ask for an OIDC token, with an npm that supports it", () => {
  const release = readWorkflow("release.yml");
  const publishJob = release.jobs.find((job) => job.steps.some((step) => NPM_SECRET.test(step)));
  for (const job of release.jobs) {
    if (job === publishJob) assert.match(job.header, /id-token: write/, "release.yml: the publish job can use OIDC");
    else assert.doesNotMatch(job.header, /id-token: write/, `release.yml ${job.name}: no OIDC token outside the publish job`);
  }
  assert.match(publishJob.header, /name: npm-publish/, "release.yml: the trusted publisher's environment");
  const npm = publishJob.steps.join("\n").match(/npm install -g [^\n]*npm@(\d+)\.(\d+)\.(\d+)/);
  assert.ok(npm, "release.yml: the publish job pins its npm version");
  const [major, minor, patch] = npm.slice(1).map(Number);
  assert.ok(major > 11 || (major === 11 && (minor > 5 || (minor === 5 && patch >= 1))), "trusted publishing needs npm 11.5.1 or later");
  const build = release.jobs.filter((job) => job.steps.some((step) => /-r build/.test(step)));
  for (const job of build) assert.doesNotMatch(job.header + job.steps.join("\n"), /secrets\.|^ {4}environment:/m, `release.yml ${job.name}: the build has no secrets`);
});

test("release installs run no dependency scripts and restore no shared cache", () => {
  const release = readWorkflow("release.yml");
  const steps = release.jobs.flatMap((job) => job.steps);
  const installs = steps.filter((step) => /pnpm install/.test(step));
  assert.ok(installs.length >= 1);
  for (const step of installs) {
    assert.match(step, /--frozen-lockfile/, "release.yml: installs from the lockfile");
    assert.match(step, /--ignore-scripts/, "release.yml: installs run no dependency scripts");
  }
  for (const step of steps) assert.doesNotMatch(step, /^\s+cache:/m, "release.yml: no dependency cache in the release jobs");
});

test("only the release workflow can publish to npm, and no manual publish runs from an arbitrary ref", () => {
  for (const name of workflowNames()) {
    if (name === "release.yml") continue;
    const text = readFileSync(join(workflowsDir, name), "utf8");
    assert.doesNotMatch(text, NPM_SECRET, `${name}: npm tokens belong to the release workflow only`);
    assert.doesNotMatch(text, /changeset publish/, `${name}: publishes nothing`);
  }
  assert.equal(existsSync(join(workflowsDir, "publish.yml")), false, "the manual publish workflow is gone");
});

test("native signing: no job that can sign runs the installer tools, and the installer job holds no signing token", () => {
  const native = readWorkflow("native-release.yml");
  const signing = native.jobs.filter((job) => job.steps.some((step) => /uses:\s*azure\/login@/.test(step)));
  assert.ok(signing.length >= 1, "native-release.yml signs in to Azure");
  for (const job of signing) {
    for (const step of job.steps) {
      assert.doesNotMatch(step, /build-msi\.mjs|dotnet tool|wix (extension|build)|pnpm install|npm (install|ci)/,
        `native-release.yml ${job.name}: no build tool or dependency install runs in a job that can sign`);
    }
  }
  const installer = native.jobs.filter((job) => job.steps.some((step) => /build-msi\.mjs/.test(step)));
  assert.ok(installer.length >= 1, "native-release.yml builds the installer");
  for (const job of installer) {
    assert.doesNotMatch(job.header, /^ {4}environment:/m, `native-release.yml ${job.name}: the installer build runs in no environment`);
    assert.doesNotMatch(job.header, /id-token: write/, `native-release.yml ${job.name}: the installer build cannot ask for an OIDC token`);
    assert.doesNotMatch(job.steps.join("\n"), /secrets\./, `native-release.yml ${job.name}: the installer build has no secrets`);
  }
  for (const step of native.jobs.flatMap((job) => job.steps.filter(isCheckout))) {
    assert.match(step, /persist-credentials: false/, "native-release.yml: checkout keeps no token in the git config");
  }
});

test("native signing: the signed update manifest names the commit it was built from", () => {
  const native = readWorkflow("native-release.yml");
  const manifest = native.jobs.flatMap((job) => job.steps).find((step) => /manifest\.mjs/.test(step));
  assert.ok(manifest, "native-release.yml writes the update manifest");
  assert.match(manifest, /github\.sha/, "the manifest step passes the commit");
});

test("no workflow runs wrangler unpinned or with a job-wide Cloudflare token", () => {
  for (const name of workflowNames()) {
    const workflow = readWorkflow(name);
    assert.doesNotMatch(section(workflow.top, "env"), /secrets\.CLOUDFLARE/, `${name}: no workflow-level Cloudflare token`);
    for (const job of workflow.jobs) {
      assert.doesNotMatch(section(job.header, "env"), /secrets\.CLOUDFLARE/, `${name} ${job.name}: no job-level Cloudflare token`);
      for (const step of job.steps.filter((s) => /wrangler/.test(s))) {
        assert.doesNotMatch(step, /\b(npx|dlx)\b[^\n]*wrangler/, `${name} ${job.name}: wrangler runs from the lockfile, not npx`);
        if (/\b(npm|pnpm) (install|i|add|ci)\b/.test(step)) assert.match(step, /--ignore-scripts/, `${name} ${job.name}: wrangler installs without scripts`);
      }
    }
  }
});
