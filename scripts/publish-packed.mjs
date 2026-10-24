#!/usr/bin/env node
// Publishes the packed release tarballs to npm and creates their git tags and GitHub releases, using only Node's
// built-ins, npm and gh. It runs in the one job that can mint an npm trusted-publishing (OIDC) token, so that job
// installs no dependencies and runs no dependency code: the tarballs were built and packed in an earlier job without
// credentials, and this script only checks and uploads them.
//
// Input: the pack job's artifact (PACK_DIR): publish-plan.json and the tarballs it names.
//   { "version": 1, "plan": [[{ "kind": "publish", "name", "version", "access", "tag", "tarball": { "path", "integrity" } }]] }
// Stages are published in order (a package after the ones it depends on).
//
// - Every tarball's sha256 integrity is checked before anything is published; one mismatch publishes nothing.
// - A version already on npm is skipped, so a re-run after a partial failure publishes only what is missing.
// - npm publish runs with lifecycle scripts off and provenance on; it authenticates with OIDC only.
// - After publishing, each package in the plan gets the tag <name>@<version> on GITHUB_SHA and a GitHub release whose
//   notes are that version's section of the package's CHANGELOG.md. An existing release is left as it is.
// - Writes `published-packages` ([{ "name", "version" }]) and `published` (true/false) to GITHUB_OUTPUT.
//
// DRY_RUN=1 checks the plan and the tarballs and reports what would be published, without publishing or tagging.
// Exit code 1 on any problem.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REGISTRY = (process.env.SCOPEBOND_NPM_REGISTRY ?? "https://registry.npmjs.org").replace(/\/+$/, "");
const NAME = /^@scopebond\/[a-z0-9][a-z0-9._-]*$/;
// eslint-disable-next-line security/detect-unsafe-regex -- linear: anchored, every part bounded, and it runs on a short version string
const VERSION = /^\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[0-9A-Za-z.-]{1,64})?$/;
const TAG = /^[a-z][a-z0-9.-]*$/;
const INTEGRITY = /^sha256-[A-Za-z0-9+/]{43}=$/;
const isWindows = process.platform === "win32";

const fail = (message) => { throw new Error(message); };

/** The publish plan, checked field by field; anything unexpected is refused. */
export function readPlan(packDir) {
  const path = join(packDir, "publish-plan.json");
  if (!existsSync(path)) fail(`no publish-plan.json in ${packDir}`);
  const doc = JSON.parse(readFileSync(path, "utf8"));
  if (doc?.version !== 1 || !Array.isArray(doc.plan)) fail("publish-plan.json: unsupported format");
  const root = resolve(packDir);
  const stages = doc.plan.map((stage, s) => {
    if (!Array.isArray(stage)) fail(`publish-plan.json: stage ${s} is not a list`);
    return stage.map((item, i) => {
      const where = `publish-plan.json: stage ${s} item ${i}`;
      if (item?.kind !== "publish") fail(`${where}: unknown kind ${JSON.stringify(item?.kind)}`);
      if (typeof item.name !== "string" || !NAME.test(item.name)) fail(`${where}: not a @scopebond package name`);
      if (typeof item.version !== "string" || !VERSION.test(item.version)) fail(`${where}: invalid version`);
      if (item.access !== "public") fail(`${where}: access must be public`);
      if (typeof item.tag !== "string" || !TAG.test(item.tag)) fail(`${where}: invalid dist-tag`);
      const rel = item.tarball?.path;
      if (typeof rel !== "string" || isAbsolute(rel) || !/\.tgz$/.test(rel)) fail(`${where}: invalid tarball path`);
      const file = resolve(root, normalize(rel));
      if (!file.startsWith(root + sep)) fail(`${where}: tarball outside the pack directory`);
      if (typeof item.tarball.integrity !== "string" || !INTEGRITY.test(item.tarball.integrity)) fail(`${where}: invalid integrity`);
      return { name: item.name, version: item.version, tag: item.tag, file, integrity: item.tarball.integrity };
    });
  });
  if (!stages.flat().length) fail("publish-plan.json: nothing to publish");
  const ids = stages.flat().map((p) => `${p.name}@${p.version}`);
  if (new Set(ids).size !== ids.length) fail("publish-plan.json: a package appears twice");
  return stages;
}

/** Throws unless every tarball exists and matches its recorded sha256. */
export function checkTarballs(stages) {
  for (const p of stages.flat()) {
    if (!existsSync(p.file)) fail(`${p.name}@${p.version}: tarball missing`);
    const got = `sha256-${createHash("sha256").update(readFileSync(p.file)).digest("base64")}`;
    if (got !== p.integrity) fail(`${p.name}@${p.version}: tarball integrity does not match the plan`);
  }
}

/** Whether npm already has this exact version (true), lacks it (false); throws when the registry cannot be read. */
export async function onNpm(name, version, fetchImpl = fetch) {
  const url = `${REGISTRY}/${name.replaceAll("/", "%2f")}/${encodeURIComponent(version)}`;
  const res = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (res.status === 200) return true;
  if (res.status === 404) return false;
  fail(`${name}@${version}: the registry answered ${res.status}`);
}

/** This version's section of a CHANGELOG.md ("## <version>" up to the next "## "), or a one-line fallback. */
export function releaseNotes(changelog, version) {
  const lines = changelog.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${version}`);
  if (start === -1) return `Release ${version}.`;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^## /.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n").trim() || `Release ${version}.`;
}

/** packages/<dir> for a package name, from the checked-out workspace. */
function packageDir(root, name) {
  for (const entry of readdirSync(join(root, "packages"), { withFileTypes: true })) {
    const manifest = join(root, "packages", entry.name, "package.json");
    if (entry.isDirectory() && existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === name) return join(root, "packages", entry.name);
  }
  return null;
}

const run = (program, args) => execFileSync(isWindows ? `${program}.cmd` : program, args, { stdio: ["ignore", "inherit", "inherit"], shell: isWindows });
const quiet = (program, args) => {
  try { execFileSync(isWindows ? `${program}.cmd` : program, args, { stdio: "ignore", shell: isWindows }); return true; } catch { return false; }
};

export async function main({ packDir = process.env.PACK_DIR, root = process.cwd(), dryRun = process.env.DRY_RUN === "1", sha = process.env.GITHUB_SHA, output = process.env.GITHUB_OUTPUT, fetchImpl = fetch } = {}) {
  if (!packDir) fail("PACK_DIR is not set");
  const stages = readPlan(packDir);
  checkTarballs(stages);
  const published = [];
  for (const stage of stages) {
    for (const p of stage) {
      if (await onNpm(p.name, p.version, fetchImpl)) { console.log(`${p.name}@${p.version}: already on npm, skipped`); continue; }
      if (dryRun) { console.log(`${p.name}@${p.version}: would publish (dist-tag ${p.tag})`); published.push(p); continue; }
      console.log(`${p.name}@${p.version}: publishing (dist-tag ${p.tag})`);
      run("npm", ["publish", p.file, "--access", "public", "--tag", p.tag, "--provenance", "--ignore-scripts"]);
      published.push(p);
    }
  }
  if (!dryRun) {
    if (!/^[0-9a-f]{40}$/.test(sha ?? "")) fail("GITHUB_SHA is not a commit id; no tags or releases were created");
    const notesDir = mkdtempSync(join(tmpdir(), "release-notes-"));
    // Every package in the plan, not only the ones published by this run: a re-run after a failure between publishing and
    // tagging still creates the missing releases (the plan lists only versions this release adds).
    for (const p of stages.flat()) {
      const tag = `${p.name}@${p.version}`;
      if (quiet("gh", ["release", "view", tag])) { console.log(`${tag}: release exists, left as it is`); continue; }
      const dir = packageDir(root, p.name);
      const changelog = dir && existsSync(join(dir, "CHANGELOG.md")) ? readFileSync(join(dir, "CHANGELOG.md"), "utf8") : "";
      const notes = join(notesDir, `${p.name.replace(/[@/]/g, "_")}.md`);
      writeFileSync(notes, releaseNotes(changelog, p.version) + "\n");
      run("gh", ["release", "create", tag, "--target", sha, "--title", tag, "--notes-file", notes]);
    }
  }
  const list = JSON.stringify(published.map((p) => ({ name: p.name, version: p.version })));
  if (output) appendFileSync(output, `published=${published.length > 0}\npublished-packages=${list}\n`);
  console.log(`${dryRun ? "would publish" : "published"}: ${list}`);
  return published;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`::error::${error.message}`); process.exit(1); });
}
