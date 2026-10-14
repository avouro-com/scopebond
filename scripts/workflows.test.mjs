// The release workflows hold the publishing credentials (npm trusted publishing, the automation token, the signing session), so
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
const NPM_SECRET = /secrets\.(?:NPM_TOKEN\w*|\w*_NPM_TOKEN)\b/;
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
/** The step that publishes to npm, and the one job that holds it. */
const isPublish = (step) => /changesets\/action\/publish@/.test(step);
const publishJobOf = (release) => release.jobs.find((job) => job.steps.some(isPublish));
const workflowNames = () => readdirSync(workflowsDir).filter((name) => /\.ya?ml$/.test(name));

test("the release workflow grants nothing at the top and checks out without keeping a token", () => {
  const release = readWorkflow("release.yml");
  assert.match(release.top, /^permissions: \{\}$/m, "release.yml: top-level permissions are empty; each job asks for its own");
  for (const job of release.jobs) assert.match(job.header, /^ {4}permissions:/m, `release.yml ${job.name}: job-level permissions`);
  const checkouts = release.jobs.flatMap((job) => job.steps.filter(isCheckout));
  assert.ok(checkouts.length >= 1, "release.yml checks out the repository");
  for (const step of checkouts) assert.match(step, /persist-credentials: false/, "release.yml: checkout keeps no token in the git config");
});

test("npm publishing holds no npm token: trusted publishing (OIDC) only, in one job and one environment", () => {
  const release = readWorkflow("release.yml");
  assert.doesNotMatch(release.top, NPM_SECRET, "release.yml: no workflow-level npm token");
  for (const job of release.jobs) {
    const text = job.header + job.steps.join("\n");
    assert.doesNotMatch(text, NPM_SECRET, `release.yml ${job.name}: no npm token (trusted publishing only)`);
    assert.doesNotMatch(text, /NODE_AUTH_TOKEN/, `release.yml ${job.name}: no NODE_AUTH_TOKEN fallback`);
  }
  const job = publishJobOf(release);
  const publishSteps = job.steps.filter(isPublish);
  assert.equal(publishSteps.length, 1, "release.yml: exactly one step publishes");
  assert.doesNotMatch(publishSteps[0], /pnpm install|-r build|pnpm release|version:packages/, "release.yml: the publish step does not install or build");
  assert.doesNotMatch(job.header + job.steps.join("\n"), AUTOMATION_SECRET, "release.yml: the publish job has no automation token");
  for (const step of job.steps) assert.doesNotMatch(step, /secrets\./, "release.yml: the publish job's steps have no secrets");
  assert.match(job.header, /^ {4}environment:/m, "release.yml: the publish job runs in a named environment");
});

test("publishing runs only for the merged Version packages pull request with no changesets left", () => {
  const release = readWorkflow("release.yml");
  const publishJob = publishJobOf(release);
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
  const publishJob = publishJobOf(release);
  for (const job of release.jobs) {
    if (job === publishJob) assert.match(job.header, /id-token: write/, "release.yml: the publish job can use OIDC");
    else assert.doesNotMatch(job.header, /id-token: write/, `release.yml ${job.name}: no OIDC token outside the publish job`);
  }
  assert.match(publishJob.header, /name: npm-publish/, "release.yml: the trusted publisher's environment");
  const npm = publishJob.steps.join("\n").match(/npm install -g [^\n]*npm@(\d+)\.(\d+)\.(\d+)/);
  assert.ok(npm, "release.yml: the publish job pins its npm version");
  const [major, minor, patch] = npm.slice(1).map(Number);
  assert.ok(major > 11 || (major === 11 && (minor > 5 || (minor === 5 && patch >= 1))), "trusted publishing needs npm 11.5.1 or later");
  // setup-node's `registry-url` writes an .npmrc whose auth token is an unset ${NODE_AUTH_TOKEN}; OIDC needs none of it.
  for (const step of publishJob.steps) assert.doesNotMatch(step, /^\s+registry-url:/m, "release.yml: the publish job writes no token .npmrc");
  assert.equal(publishJob.header.match(/^ {6}name: (\S+)$/m)?.[1], "npm-publish", "release.yml: the publish job's environment is npm-publish");
  // The check masks every token before it prints anything about it.
  const checkScript = readFileSync(join(workflowsDir, "..", "..", "scripts", "check-npm-trusted-publishing.mjs"), "utf8");
  const order = (first, then) => {
    const [a, b] = [checkScript.indexOf(first), checkScript.indexOf(then)];
    assert.ok(a !== -1 && b !== -1 && a < b, `check-npm-trusted-publishing.mjs: ${first} comes before ${then}`);
  };
  order("mask(requestToken);", "fetch(url,");
  order("mask(idToken);", "claimsOf(idToken)");
  order("mask(body.token);", "npm accepts this job");
  assert.doesNotMatch(checkScript, /console\.(log|error)\([^)]*\b(idToken|requestToken|body\.token)\b/, "check-npm-trusted-publishing.mjs: prints no token");
  // npm's own OIDC failure is silent (it surfaces as E404), so the exchange is checked, with its reason, before publishing.
  const check = publishJob.steps.findIndex((step) => /node scripts\/check-npm-trusted-publishing\.mjs/.test(step));
  assert.ok(check !== -1 && check < publishJob.steps.findIndex(isPublish), "release.yml: trusted publishing is checked before the publish step");
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

test("the Version packages PR needs no stored token: the job's own token opens it and dispatches its required checks", () => {
  const release = readWorkflow("release.yml");
  const all = release.top + release.jobs.map((job) => job.header + job.steps.join("\n")).join("\n");
  assert.doesNotMatch(all, AUTOMATION_SECRET, "release.yml: no stored automation token");
  const versionJob = release.jobs.find((job) => job.steps.some((step) => /changesets\/action\/version@/.test(step)));
  assert.match(versionJob.steps.find((step) => /changesets\/action\/version@/.test(step)), /github-token: \$\{\{ github\.token \}\}/);
  const nativeJob = release.jobs.find((job) => job.steps.some((step) => /gh workflow run native-release\.yml/.test(step)));
  for (const job of release.jobs) {
    if (job === versionJob) assert.match(job.header, /actions: write/, "release.yml: the version job can dispatch the checks");
    else if (job === nativeJob) assert.match(job.header, /actions: write/, "release.yml: the native job can start the signed build");
    else assert.doesNotMatch(job.header, /actions: write/, `release.yml ${job.name}: no other job can start workflows`);
  }
  const dispatch = versionJob.steps.find((step) => /gh workflow run/.test(step));
  assert.ok(dispatch, "release.yml: a step starts the required checks");
  assert.match(dispatch, /if: steps\.mode\.outputs\.mode == 'version'/, "only when a Version packages PR was opened or updated");
  assert.match(dispatch, /--ref changeset-release\/main/, "only on the Version packages branch");
  const dispatched = dispatch.match(/for workflow in ([^;]+);/)?.[1].trim().split(/\s+/) ?? [];
  // Every workflow that produces a required check on main must be dispatched, and must accept a dispatch.
  assert.deepEqual(dispatched.sort(), ["ci.yml", "oss-guard.yml", "security-audit.yml"]);
  for (const name of dispatched) {
    assert.ok(onTriggers(readWorkflow(name).top).workflow_dispatch, `${name}: accepts the release workflow's dispatch`);
  }
});

test("a new agent on npm starts the signed Windows build on main, and that job can do nothing else", () => {
  const release = readWorkflow("release.yml");
  const native = release.jobs.find((job) => job.steps.some((step) => /gh workflow run native-release\.yml/.test(step)));
  assert.ok(native, "release.yml: a job starts native-release.yml");
  const publishJob = publishJobOf(release);
  assert.ok(native.header.split("\n").some((line) => line.trim() === `needs: ${publishJob.name}`), "only after the publish");
  assert.match(native.header, /if: contains\(needs\.publish\.outputs\.published-packages, '"@scopebond\/agent"'\)/, "only when the agent was published");
  assert.match(publishJob.header, /published-packages: \$\{\{ steps\.publish\.outputs\.published-packages \}\}/);
  // Its one permission starts workflows; it checks nothing out, holds no secret and runs in no environment.
  assert.equal(section(native.header, "permissions").trim().replace(/\s*#.*$/, ""), "actions: write");
  assert.doesNotMatch(native.header + native.steps.join("\n"), /secrets\.|^ {4}environment:|actions\/checkout@/m);
  assert.equal(native.steps.length, 1);
  const [step] = native.steps;
  assert.match(step, /gh workflow run native-release\.yml --ref main -f release=true -f version="\$version"/, "on main, for that version");
  assert.match(step, /PUBLISHED: \$\{\{ needs\.publish\.outputs\.published-packages \}\}/, "the published list reaches the script through env");
  assert.doesNotMatch(step.replace(/^ {8}env:[\s\S]*?(?=^ {8}run:)/m, ""), /\$\{\{/, "no expression inside the script");
  // The signed build keeps its approvals and checks the version it was asked for.
  const nativeRelease = readWorkflow("native-release.yml");
  assert.ok(onTriggers(nativeRelease.top).workflow_dispatch);
  assert.match(section(nativeRelease.top, "on"), /^ {6}version:/m, "native-release.yml takes the version");
  const build = nativeRelease.jobs.find((job) => job.name === "build");
  assert.match(build.steps.join("\n"), /WANTED: \$\{\{ inputs\.version \}\}/);
  assert.match(build.steps.join("\n"), /\$env:WANTED -ne \$v/, "the build fails when the commit's agent version is another");
  for (const name of ["sign", "sign-installer"]) {
    assert.match(nativeRelease.jobs.find((job) => job.name === name).header, /^ {4}environment: signing$/m, `${name} stays in the signing environment`);
  }
  assert.match(nativeRelease.jobs.find((job) => job.name === "release").steps.join("\n"), /--draft --prerelease/, "the release stays a draft pre-release");
});
